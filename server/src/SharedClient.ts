import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { discoverLocalSessions, localSessionDirectory, registerJoinedSession } from "./LocalDiscovery";
import { LocalUserProfile, type ProfileSettings, type SavedServer } from "./LocalUserProfile";
import { SCOPE_PROTOCOL_VERSION } from "./protocol";
import { readDataChange, SessionDataStore } from "./SessionData";
import type { ActivityState, Capability, ClientPresence, JoinRequest, JoinResult, NetworkMessage, ParticipantKind, ScopeGrant, ServerInfo, UserDataChange, UserDataSnapshot, UserProfileState } from "./protocol";
import { User } from "./User";

export interface SharedClientOptions {
    url: string;
    ownerApp: string;
    sessionId?: string;
    username?: string;
    color?: string;
    participantKind?: ParticipantKind;
    password?: string;
    capabilities?: Capability[];
    identityKey?: string;
    scopeGrants?: readonly ScopeGrant[];
    profile?: LocalUserProfile;
}

export interface SharedClientEvents {
    joined: [JoinResult];
    rosterChanged: [];
    sessionDataChanged: [];
    userDataChanged: [number];
    message: [NetworkMessage];
    binary: [Buffer];
    connectionError: [Error];
    localError: [unknown];
    disconnected: [];
}

export class SharedClient extends EventEmitter<SharedClientEvents> {
    static readonly discoverSessions = discoverLocalSessions;
    readonly ownerApp: string;
    readonly profile?: LocalUserProfile;
    private readonly socket: WebSocket;
    private readonly roster = new Map<number, User>();
    private readonly data = new SessionDataStore();
    private serverInfo?: ServerInfo;
    private joinSent = false;
    private readonly admissionTimer: ReturnType<typeof setTimeout>;
    private heartbeatTimeout?: ReturnType<typeof setTimeout>;
    private connectionId?: number;
    private userId?: number;
    private grantedScopes: readonly number[] = [];

    constructor(private readonly options: SharedClientOptions) {
        super();
        this.ownerApp = options.ownerApp;
        this.profile = options.profile ?? (options.participantKind === "agent" ? undefined : new LocalUserProfile());
        this.socket = new WebSocket(options.url, { handshakeTimeout: 5_000, maxPayload: 1024 * 1024 });
        this.admissionTimer = setTimeout(() => {
            this.emit("connectionError", new Error("Timed out joining the session."));
            this.disconnectNow();
        }, 10_000);
        this.admissionTimer.unref();
        this.socket.on("message", (data, binary) => {
            if (binary) {
                if (this.connectionId !== undefined) {
                    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
                    this.emit("binary", bytes);
                }
                return;
            }
            try {
                this.receive(JSON.parse(data.toString()) as NetworkMessage);
            } catch (error) {
                this.fail(error);
            }
        });
        this.socket.on("error", error => this.emit("connectionError", error));
        this.socket.on("pong", () => this.armHeartbeat());
        this.socket.on("close", () => {
            clearTimeout(this.admissionTimer);
            clearTimeout(this.heartbeatTimeout);
            this.connectionId = undefined;
            this.userId = undefined;
            this.grantedScopes = [];
            for (const user of this.roster.values()) user.dataStore.clear();
            this.roster.clear();
            this.data.clear();
            this.emit("sessionDataChanged");
            this.emit("rosterChanged");
            this.emit("disconnected");
        });
    }

    get clientId(): number | undefined { return this.connectionId; }
    get users(): ReadonlyMap<number, User> { return this.roster; }
    get sessionData(): ReadonlyMap<string, string> { return this.data.view; }
    get scopeIds(): readonly number[] { return this.grantedScopes; }
    get localUser(): User | undefined { return this.userId === undefined ? undefined : this.roster.get(this.userId); }
    get server(): SavedServer | undefined {
        const info = this.serverInfo;
        return info && { sessionId: info.sessionId, name: info.name, url: this.socket.url };
    }

    send(message: NetworkMessage): boolean {
        if (this.connectionId === undefined || this.socket.readyState !== WebSocket.OPEN) return false;
        this.socket.send(JSON.stringify(message));
        return true;
    }

    sendBinary(bytes: Buffer): boolean {
        if (this.connectionId === undefined || this.socket.readyState !== WebSocket.OPEN) return false;
        this.socket.send(bytes, { binary: true });
        return true;
    }

    setSessionData(key: string, value: string | null): boolean {
        return this.send({ type: "session.data.set", route: "server", data: { key, value } });
    }

    async setUserData(key: string, value: string | null): Promise<boolean> {
        if (this.connectionId === undefined) return false;
        await this.profile?.setPublicData(key, value);
        return this.send({ type: "user.data.set", route: "server", data: { key, value } });
    }

    setActivity(state: ActivityState): boolean {
        return this.send({ type: "activity.update", route: "server", data: { state } });
    }

    async updateProfile(changes: { [K in keyof ProfileSettings]?: string | null }): Promise<void> {
        if (!this.profile) throw new Error("This connection has no local profile.");
        await this.profile.update(changes);
        const username = changes.username?.trim();
        const color = changes.color;
        if (username !== undefined || color !== undefined) {
            this.send({ type: "user.profile.update", route: "server", data: { username, color } });
        }
    }

    close(): void {
        this.socket.close();
    }

    disconnectNow(): void {
        this.socket.terminate();
    }

    private armHeartbeat(): void {
        if (this.connectionId === undefined) return;
        // If a socket goes half-open, force close so the coordinator can rejoin the same session.
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => this.disconnectNow(), 30_000);
        this.heartbeatTimeout.unref();
    }

    private async requestJoin(): Promise<void> {
        const info = this.serverInfo;
        if (!info) return;
        if (this.options.scopeGrants?.length && info.scopeProtocolVersion !== SCOPE_PROTOCOL_VERSION) {
            throw new Error("This server uses an incompatible workspace scope protocol.");
        }

        const [settings, key, userData] = await Promise.all([
            this.profile?.read(),
            this.options.identityKey ?? this.profile?.identityKeyFor(info.sessionId),
            this.profile?.readPublicData()
        ]);
        if (this.socket.readyState !== WebSocket.OPEN) return;

        const username = this.options.username ?? settings?.username ?? "Test Developer";
        const data: JoinRequest = {
            username, displayName: username, ownerApp: this.ownerApp, participantKind: this.options.participantKind,
            color: this.options.color ?? settings?.color, password: this.options.password,
            capabilities: this.options.capabilities, identityKey: key, scopeGrants: this.options.scopeGrants,
            userData: userData?.length ? userData : undefined
        };
        this.joinSent = true;
        this.socket.send(JSON.stringify({ type: "session.join", route: "server", data }));
    }

    private receive(message: NetworkMessage): void {
        if (!message || typeof message.type !== "string") return;

        if (message.type === "session.info" && message.route === "sender" && !this.serverInfo) {
            const info = message.data as ServerInfo | undefined;
            if (!info || typeof info.sessionId !== "string" ||
                (this.options.sessionId && info.sessionId !== this.options.sessionId)) {
                this.fail(new Error("The selected session changed. Run discovery again."));
                return;
            }
            this.serverInfo = info;
            void this.requestJoin().catch(error => this.fail(error));
        } else if (message.type === "session.joinResult" && message.route === "sender" && this.joinSent && this.connectionId === undefined) {
            const result = message.data as JoinResult | undefined;
            if (!result?.accepted || result.clientId === undefined || result.userId === undefined) {
                this.fail(new Error("Join rejected: " + (result?.reason ?? "Invalid join result.")));
                return;
            }
            clearTimeout(this.admissionTimer);
            this.connectionId = result.clientId;
            this.userId = result.userId;
            this.armHeartbeat();
            this.grantedScopes = result.scopeIds ?? [];
            if (result.sessionData !== undefined && this.data.load(result.sessionData)) this.emit("sessionDataChanged");
            const server = this.server;
            if (server) {
                const report = (error: unknown): void => { this.emit("localError", error); };
                void registerJoinedSession(this.socket, server.sessionId, localSessionDirectory(), report).catch(report);
                void this.profile?.recordVisit(server).catch(report);
            }
            this.emit("joined", result);
        } else if (this.connectionId !== undefined) {
            this.updateRoster(message);
            this.updateStringData(message);
        }

        this.emit("message", message);
    }

    private updateRoster(message: NetworkMessage): void {
        if (message.type === "presence.list" && Array.isArray(message.data)) {
            this.roster.clear();
            for (let i = 0; i < message.data.length; i++) this.addMember(message.data[i] as ClientPresence);
        } else if (message.type === "presence.join") {
            this.addMember(message.data as ClientPresence);
        } else if (message.type === "presence.leave") {
            const { clientId, userId } = message.data as Pick<ClientPresence, "clientId" | "userId">;
            const user = this.roster.get(userId);
            user?.removeClient(clientId);
            if (user?.clients.size === 0) {
                user.dataStore.clear();
                this.roster.delete(userId);
            }
        } else if (message.type === "activity.state") {
            const { userId, state } = message.data as { userId: number; state: ActivityState };
            const user = this.roster.get(userId);
            if (user) user.activity = state;
        } else if (message.type === "user.profile") {
            const { userId, username, color } = message.data as UserProfileState;
            const user = this.roster.get(userId);
            if (user) {
                user.username = username;
                user.color = color;
            }
        } else {
            return;
        }

        this.emit("rosterChanged");
    }

    private updateStringData(message: NetworkMessage): void {
        if (message.type === "session.data.changed") {
            const change = readDataChange(message.data);
            if (change && this.data.set(change.key, change.value)) this.emit("sessionDataChanged");
        } else if (message.type === "user.data.snapshot") {
            const data = message.data as UserDataSnapshot | undefined;
            if (data && this.roster.get(data.userId)?.dataStore.load(data.entries)) this.emit("userDataChanged", data.userId);
        } else if (message.type === "user.data.changed") {
            const data = message.data as UserDataChange | undefined;
            const change = readDataChange(data);
            if (data && change && this.roster.get(data.userId)?.dataStore.set(change.key, change.value)) this.emit("userDataChanged", data.userId);
        }
    }

    private addMember(member: ClientPresence): void {
        let user = this.roster.get(member.userId);
        if (!user) {
            user = User.fromPresence(member);
            this.roster.set(user.userId, user);
        }
        user.addClient({ clientId: member.clientId, ownerApp: member.ownerApp ?? "unknown", capabilities: member.capabilities });
    }

    private fail(error: unknown): void {
        const failure = new Error(error instanceof Error ? error.message : String(error));
        failure.name = "SessionJoinError";
        this.emit("connectionError", failure);
        this.disconnectNow();
    }
}
