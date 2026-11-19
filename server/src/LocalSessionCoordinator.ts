import type { EventEmitter } from "node:events";
import { parseEndpoint } from "./LocalDiscovery";
import type { SavedServer } from "./LocalUserProfile";
import { isOwnerApp } from "./protocol";
import type { ActivityState, JoinResult, NetworkMessage, ParticipantKind, UserClient } from "./protocol";
import { SharedClient, type SharedClientEvents, type SharedClientOptions } from "./SharedClient";

export type LocalJoinOptions = Omit<SharedClientOptions, "url" | "profile"> & { url?: string };
export type LocalSessionState = {
    phase: "idle" | "joining" | "active" | "leaving";
    app: "idle" | "joining" | "joined" | "reconnecting";
    server?: SavedServer;
};

export interface LocalRosterUser {
    userId: number;
    username: string;
    color?: string;
    activity: ActivityState;
    participantKind: ParticipantKind;
    clients: UserClient[];
}

export type LocalSessionEvent =
    | { type: "state"; state: LocalSessionState }
    | { type: "joined"; result: JoinResult }
    | { type: "message"; message: NetworkMessage }
    | { type: "roster"; users: LocalRosterUser[] }
    | { type: "binary"; data: string }
    | { type: "problem"; reason: string };

type Notify = (event: LocalSessionEvent) => void;
type Connection = Pick<SharedClient, "disconnectNow" | "send" | "sendBinary" | "setUserData" | "server" | "users"> & Pick<EventEmitter<SharedClientEvents>, "on">;

interface ActiveSession {
    server?: SavedServer;
    password?: string;
}

interface AppConnection {
    appId?: number;
    options: SharedClientOptions;
    connection?: Connection;
    retry?: ReturnType<typeof setTimeout>;
    failures: number;
    everJoined: boolean;
    joined: boolean;
    closing: boolean;
}

export interface LocalSessionApp {
    join(options: LocalJoinOptions): void;
    leave(): void;
    send(message: NetworkMessage): boolean;
    sendBinary(data: Buffer): boolean;
    setUserData(key: string, value: string | null): Promise<boolean>;
    close(): void;
}

export class LocalSessionCoordinator {
    private readonly apps = new Map<number, Notify>();
    private readonly connections = new Set<AppConnection>();
    private readonly appConnections = new Map<number, AppConnection>();
    private nextAppId = 1;
    private session?: ActiveSession;
    private leaving = false;

    constructor(
        private readonly connect: (options: SharedClientOptions) => Connection = options => new SharedClient(options),
        private readonly delays: readonly number[] = [250, 500, 1000, 2000, 4000]
    ) {}

    get appCount(): number { return this.apps.size; }

    attach(notify: Notify): LocalSessionApp {
        const id = this.nextAppId++;
        this.apps.set(id, notify);
        notify({ type: "state", state: this.state(id) });

        const getConnection = (): Connection | undefined => {
            const slot = this.appConnections.get(id);
            return slot?.joined && !slot.closing ? slot.connection : undefined;
        };
        return {
            join: options => this.join(id, options),
            leave: () => { if (this.apps.has(id)) this.leave(); },
            send: message => getConnection()?.send(message) ?? false,
            sendBinary: data => getConnection()?.sendBinary(data) ?? false,
            setUserData: (key, value) => getConnection()?.setUserData(key, value) ?? Promise.resolve(false),
            close: () => this.detach(id)
        };
    }

    leave(): void {
        if (!this.session || this.leaving) return;
        // Mark the session as leaving before touching any socket. Late join events cannot reclaim it.
        this.leaving = true;
        this.publish();
        for (const slot of Array.from(this.connections)) this.stop(slot);
    }

    private state(appId: number): LocalSessionState {
        const slot = this.appConnections.get(appId);
        return {
            phase: this.leaving ? "leaving" : this.session?.server ? "active" : this.session ? "joining" : "idle",
            app: !slot || slot.closing ? "idle" : slot.joined ? "joined" : slot.everJoined ? "reconnecting" : "joining",
            server: this.session?.server
        };
    }

    private publish(): void {
        for (const [appId, notify] of this.apps) notify({ type: "state", state: this.state(appId) });
    }

    private join(id: number, options: LocalJoinOptions): void {
        if (!this.apps.has(id)) return;
        if (!isOwnerApp(options.ownerApp)) throw new Error("Invalid owner app.");
        if (this.leaving || this.appConnections.has(id)) throw new Error("This app already has a join in progress or must wait for the session to close.");
        if (this.session && !this.session.server) throw new Error("Another app is opening a session. Wait for that join to finish.");

        const endpoint = options.url === undefined ? undefined : parseEndpoint(options.url);
        if (options.url !== undefined && !endpoint) throw new Error("Enter a valid WebSocket server address.");
        const current = this.session?.server;
        if (current && ((endpoint && endpoint.url !== current.url) || (options.sessionId && options.sessionId !== current.sessionId))) {
            throw new Error("Leave the current session before joining a different server.");
        }

        const url = current?.url ?? endpoint?.url;
        if (!url) throw new Error("Join using a server address, a favorite, or a recently visited server.");
        // Reserve the endpoint synchronously so two local apps cannot race to different servers.
        this.session ??= { password: options.password };
        const slot: AppConnection = {
            appId: id, options: { ...options, url, sessionId: current?.sessionId ?? options.sessionId, password: options.password ?? this.session.password },
            failures: 0, everJoined: false, joined: false, closing: false
        };
        this.connections.add(slot);
        this.appConnections.set(id, slot);
        this.publish();
        this.open(slot);
    }

    private open(slot: AppConnection): void {
        let connection: Connection;
        try {
            connection = this.connect(slot.options);
        } catch (error) {
            this.report(slot, error);
            this.finish(slot);
            return;
        }
        slot.connection = connection;
        let permanent = false;

        connection.on("joined", result => {
            if (slot.closing) return;
            const server = connection.server;
            const endpoint = parseEndpoint(server?.url);
            if (!server || !endpoint || !this.session) {
                this.report(slot, "Invalid server session information.");
                this.stop(slot);
                return;
            }
            this.session.server ??= { ...server, url: endpoint.url };
            slot.options.sessionId = this.session.server.sessionId;
            slot.everJoined = true;
            slot.joined = true;
            slot.failures = 0;
            this.notify(slot, { type: "joined", result });

            // An open app can keep the last transport alive while deciding whether to join.
            // Once a real app is connected again, that temporary transport can close.
            if (slot.appId !== undefined) {
                for (const other of Array.from(this.connections)) {
                    if (other.appId === undefined) this.stop(other);
                }
            }
            this.publish();
        });
        connection.on("rosterChanged", () => {
            if (slot.appId === undefined || slot.closing) return;
            const users = Array.from(connection.users.values(), user => ({
                userId: user.userId, username: user.username, color: user.color, activity: user.activity,
                participantKind: user.participantKind, clients: Array.from(user.clients.values())
            }));
            this.notify(slot, { type: "roster", users });
        });
        connection.on("message", message => this.notify(slot, { type: "message", message }));
        connection.on("binary", bytes => this.notify(slot, { type: "binary", data: bytes.toString("base64") }));
        connection.on("localError", error => this.report(slot, error));
        connection.on("connectionError", error => {
            permanent ||= error instanceof Error && error.name === "SessionJoinError";
            this.report(slot, error);
        });
        connection.on("disconnected", () => {
            slot.connection = undefined;
            slot.joined = false;
            const delay = this.delays[slot.failures];
            if (!slot.closing && slot.everJoined && !permanent && this.apps.size > 0 && delay !== undefined) {
                slot.failures++;
                this.publish();
                slot.retry = setTimeout(() => {
                    slot.retry = undefined;
                    this.open(slot);
                }, delay);
            } else {
                this.finish(slot);
            }
        });
    }

    private notify(slot: AppConnection, event: LocalSessionEvent): void {
        if (!slot.closing && slot.appId !== undefined) this.apps.get(slot.appId)?.(event);
    }

    private report(slot: AppConnection, error: unknown): void {
        this.notify(slot, { type: "problem", reason: error instanceof Error ? error.message : String(error) });
    }

    private detach(id: number): void {
        if (!this.apps.delete(id)) return;
        const slot = this.appConnections.get(id);
        this.appConnections.delete(id);
        if (!this.apps.size) {
            this.leave();
        } else if (slot) {
            slot.appId = undefined;
            const hasAnotherLive = Array.from(this.connections).some(other => other !== slot && !other.closing && other.everJoined);
            if (!slot.everJoined || !this.session?.server || hasAnotherLive) this.stop(slot);
            else this.publish();
        }
    }

    private stop(slot: AppConnection): void {
        if (slot.closing) return;
        slot.closing = true;
        clearTimeout(slot.retry);
        if (slot.connection) slot.connection.disconnectNow();
        else this.finish(slot);
    }

    private finish(slot: AppConnection): void {
        this.connections.delete(slot);
        if (slot.appId !== undefined) this.appConnections.delete(slot.appId);
        if (this.connections.size === 0) {
            this.session = undefined;
            this.leaving = false;
        }
        this.publish();
    }
}
