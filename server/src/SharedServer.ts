
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { ACTIVITY_TIMEOUT_MS, resolveActivity, type ClientActivity } from "./ActivityResolver";
import { localSessionDirectory, publishLocalSession } from "./LocalDiscovery";
import { BINARY_HEADER_SIZE, BINARY_VERSION, BinaryRoute, isOwnerApp, isScopeId, isUserColor, isUsername, SCOPED_CAPABILITIES, SCOPE_PROTOCOL_VERSION } from "./protocol";
import { ScopePolicy, type ScopeAccess } from "./ScopePolicy";
import { readDataChange, SessionDataStore } from "./SessionData";
import { User } from "./User";
import type { Capability, ClientPresence, JoinRequest, NetworkMessage, ScopedCapability, ServerInfo, UserClient, UserProfileState } from "./protocol";

export interface ServerOptions {
    port: number;
    name: string;
    password: string;
    discoveryDirectory?: string;
    workspaceScopes?: unknown;
}

// All information associated with one accepted connection.
interface ClientInfo {
    id: number;
    user: User;
    socket: WebSocket;
    presence: UserClient;
    capabilities: Set<Capability>;
    scopeAccess: ScopeAccess;
    activity: ClientActivity;
}

type RoutedCapability = "chat" | ScopedCapability;
const VALID_CAPABILITIES = new Set<Capability>(["chat", "activity", ...SCOPED_CAPABILITIES]);

const MAX_JSON_BYTES = 65536;
const MAX_CHAT_LENGTH = 4000;

function toBuffer(raw: RawData): Buffer {
    if (Buffer.isBuffer(raw)) return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw);
    return Buffer.from(raw);
}

// Compare password hashes to avoid a length-dependent comparison.
function passwordMatches(actual: string, expected: string): boolean {
    const a = createHash("sha256").update(actual).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

// Maps event namespaces to the capability required to send or receive them.
function requiredCapability(type: string): ScopedCapability | undefined {
    return SCOPED_CAPABILITIES.find(capability => type.startsWith(capability + "."));
}

function canRoute(client: ClientInfo, capability: RoutedCapability, scopeId: number | undefined): boolean {
    // Public session chat uses the client's capability. Collaboration traffic also needs scope membership.
    if (capability === "chat") return scopeId === undefined && client.capabilities.has("chat");
    return scopeId !== undefined && client.scopeAccess.get(scopeId)?.has(capability) === true;
}

export class SharedServer {
    readonly sessionId = randomUUID();
    // Ready means the WebSocket port is bound and other local apps can discover it.
    readonly ready: Promise<void>;

    private readonly server: WebSocketServer;
    private readonly scopePolicy: ScopePolicy;
    private registration?: Promise<string>;
    private closing?: Promise<void>;
    private readonly clients = new Map<number, ClientInfo>();
    private readonly clientIds = new Map<WebSocket, number>();
    private readonly pending = new Set<WebSocket>();
    private readonly userKeys = new Map<string, User>();
    private readonly data = new SessionDataStore();

    private nextClientId = 1;
    private nextUserId = 1;
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly options: ServerOptions) {
        this.scopePolicy = new ScopePolicy(options.workspaceScopes);
        this.server = new WebSocketServer({ port: options.port, maxPayload: 1024 * 1024 });

        this.server.on("connection", socket => this.onConnection(socket));

        this.ready = new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.once("close", () => reject(new Error("Server closed before it was ready.")));
            this.server.once("listening", () => {
                this.registration = publishLocalSession(options.discoveryDirectory ?? localSessionDirectory(), this.sessionId, this.port);
                this.registration.then(() => resolve(), reject);
            });
        });
        // Existing hosts can use the server without awaiting ready. Keep rejection handling opt-in.
        void this.ready.catch(() => {});
        this.server.on("error", error => console.error("Server error:", error.message));

        // Activity expires even when no new messages arrive.
        this.timer = setInterval(() => this.refreshActivity(), 5000);
    }

    // An actual bound port may differ when tests request port 0.
    get port(): number {
        const address = this.server.address();
        if (!address || typeof address === "string") return 0;
        return address.port;
    }

    get clientCount(): number {
        return this.clients.size;
    }

    private send(socket: WebSocket, message: NetworkMessage): void {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(message));
    }

    private error(socket: WebSocket, reason: string, requestId?: number): void {
        this.send(socket, { type: "session.error", route: "sender", requestId, data: { reason } });
    }

    private onConnection(socket: WebSocket): void {
        this.pending.add(socket);

        const info: ServerInfo = {
            sessionId: this.sessionId,
            name: this.options.name,
            passwordRequired: this.options.password.length > 0,
            clientCount: this.clients.size,
            scopeProtocolVersion: SCOPE_PROTOCOL_VERSION
        };

        this.send(socket, { type: "session.info", route: "sender", data: info });

        socket.on("message", (data, isBinary) => {
            if (isBinary) {
                this.handleBinary(socket, data);
                return;
            }

            const packet = toBuffer(data);
            if (packet.length > MAX_JSON_BYTES) {
                this.error(socket, "JSON message too large.");
                return;
            }

            let value: unknown;

            try {
                value = JSON.parse(packet.toString());
            } catch {
                this.error(socket, "Invalid JSON.");
                return;
            }

            if (!value || typeof value !== "object" || Array.isArray(value)) {
                this.error(socket, "Invalid message.");
                return;
            }

            const message = value as NetworkMessage;

            if (typeof message.type !== "string" || typeof message.route !== "string") {
                this.error(socket, "Missing message type or route.");
                return;
            }

            if (message.type === "session.join") {
                this.handleJoin(socket, message);
                return;
            }

            const client = this.getClient(socket);

            if (!client) {
                this.error(socket, "Join the session first.", message.requestId);
                return;
            }

            this.handleJSON(client, message);
        });

        socket.on("close", () => this.onDisconnect(socket));
        socket.on("error", error => console.warn("Client error:", error.message));
    }

    private getClient(socket: WebSocket): ClientInfo | undefined {
        const id = this.clientIds.get(socket);
        return id === undefined ? undefined : this.clients.get(id);
    }

    private handleJoin(socket: WebSocket, message: NetworkMessage): void {
        if (!this.pending.has(socket) || message.route !== "server") {
            this.error(socket, "Invalid join request.", message.requestId);
            return;
        }

        const request = message.data as JoinRequest | undefined;
        const requestedName = request?.username ?? request?.displayName;
        const name = typeof requestedName === "string" ? requestedName.trim() : "";
        const ownerApp = request?.ownerApp ?? "unknown";
        const color = request?.color;
        const participantKind = request?.participantKind ?? "human";

        // The original entry point allowed joins without capability negotiation and supported chat.
        const capabilities = request?.capabilities === undefined ? ["chat" as const] : request.capabilities;
        if (!request || !isUsername(name) || !isOwnerApp(ownerApp) || (color !== undefined && !isUserColor(color)) ||
            (participantKind !== "human" && participantKind !== "agent") || !Array.isArray(capabilities) ||
            capabilities.length > VALID_CAPABILITIES.size || !capabilities.every(c => VALID_CAPABILITIES.has(c))) {
            this.rejectJoin(socket, "Invalid client information.", message.requestId);
            return;
        }

        const password = request.password;
        if (this.options.password && (typeof password !== "string" || !passwordMatches(password, this.options.password))) {
            this.rejectJoin(socket, "Incorrect password.", message.requestId);
            return;
        }

        // A strong shared identity key can link multiple applications
        // belonging to the same developer. Never broadcast this key.
        const key = request.identityKey;
        if (key !== undefined && (typeof key !== "string" || !/^[a-fA-F0-9]{32,128}$/.test(key))) {
            this.rejectJoin(socket, "Invalid identity key.", message.requestId);
            return;
        }

        const scopeAccess = this.scopePolicy.authorize(request.scopeGrants, capabilities);
        if (!scopeAccess) {
            this.rejectJoin(socket, "Workspace scope access denied.", message.requestId);
            return;
        }

        const initialUserData = new SessionDataStore();
        if (request.userData !== undefined && !initialUserData.load(request.userData)) {
            this.rejectJoin(socket, "Invalid public user data.", message.requestId);
            return;
        }

        let user = key ? this.userKeys.get(key) : undefined;
        if (user && user.participantKind !== participantKind) {
            this.rejectJoin(socket, "Identity belongs to a different participant kind.", message.requestId);
            return;
        }
        if (this.nextClientId > 0xFFFFFFFF || (!user && this.nextUserId > 0xFFFFFFFF)) {
            this.rejectJoin(socket, "Client or user ID limit reached.", message.requestId);
            return;
        }

        if (!user) {
            user = new User(this.nextUserId++, name, participantKind, color);
            if (key) this.userKeys.set(key, user);
        }

        // A second app must not replace the profile of a user already active in the session.
        if (user.clients.size === 0 && initialUserData.view.size) user.dataStore.load(initialUserData.snapshot());

        const id = this.nextClientId++;
        const presence = { clientId: id, ownerApp, capabilities: Array.from(new Set(capabilities)) };
        const client: ClientInfo = {
            id, user, socket, presence,
            capabilities: new Set(presence.capabilities), scopeAccess,
            activity: { state: "idle", updatedAt: Date.now() }
        };

        user.addClient(presence);
        this.pending.delete(socket);
        this.clients.set(id, client);
        this.clientIds.set(socket, id);

        this.send(socket, {
            type: "session.joinResult", route: "sender", requestId: message.requestId,
            data: {
                accepted: true, clientId: id, userId: user.userId,
                scopeIds: scopeAccess.size ? Array.from(scopeAccess.keys()) : undefined,
                sessionData: this.data.view.size ? this.data.snapshot() : undefined
            }
        });

        const members = Array.from(this.clients.values(), member => this.describeClient(member));
        this.send(socket, { type: "presence.list", route: "sender", data: members });
        this.broadcast({ type: "presence.join", route: "others", data: this.describeClient(client) }, id);
        const describedUsers = new Set<number>();
        for (const active of this.clients.values()) {
            const owner = active.user;
            if (describedUsers.has(owner.userId) || !owner.data.size) continue;
            describedUsers.add(owner.userId);
            const data = { userId: owner.userId, entries: owner.dataStore.snapshot() };
            this.send(socket, { type: "user.data.snapshot", route: "sender", data });
            if (owner === user && user.clients.size === 1) this.broadcast({ type: "user.data.snapshot", route: "others", data }, id);
        }

        this.publishActivity(user, true);
        console.log(`${user.username} joined as Client ${id}, User ${user.userId}.`);
    }

    private describeClient(client: ClientInfo): ClientPresence {
        const { user } = client;
        return {
            ...client.presence, userId: user.userId, username: user.username, displayName: user.username,
            color: user.color, participantKind: user.participantKind, activity: user.activity
        };
    }

    private rejectJoin(socket: WebSocket, reason: string, requestId?: number): void {
        this.send(socket, {
            type: "session.joinResult", route: "sender", requestId,
            data: { accepted: false, reason }
        });
    }

    private handleJSON(client: ClientInfo, message: NetworkMessage): void {
        if (message.route === "server") {
            switch (message.type) {
                case "session.ping":
                    this.send(client.socket, {
                        type: "session.pong", route: "sender", requestId: message.requestId
                    });
                    return;

                case "activity.update":
                    this.updateActivity(client, message);
                    return;
                case "user.profile.update":
                    this.updateUserProfile(client, message);
                    return;
                case "session.data.set":
                case "user.data.set":
                    this.updateStringData(client, message);
                    return;

                default:
                    this.error(client.socket, "Unknown server request.", message.requestId);
                    return;
            }
        }

        // Only explicitly recognized routes may be used for delivery.
        if (!["sender", "others", "all", "target"].includes(message.route)) {
            this.error(client.socket, "Invalid route.", message.requestId);
            return;
        }

        let capability: RoutedCapability;
        const { scopeId } = message;

        if (message.type === "chat.message" || message.type === "chat.typing") {
            capability = "chat";

            if (message.type === "chat.message") {
                const text = (message.data as { text?: unknown } | null)?.text;
                if (typeof text !== "string" || !text.trim() || text.length > MAX_CHAT_LENGTH) {
                    this.error(client.socket, "Invalid chat message.", message.requestId);
                    return;
                }

                message.data = { text };
            } else {
                const typing = (message.data as { typing?: unknown } | null)?.typing;
                if (typeof typing !== "boolean") {
                    this.error(client.socket, "Invalid typing state.", message.requestId);
                    return;
                }

                message.data = { typing };
            }
        } else {
            const required = requiredCapability(message.type);

            if (!required) {
                this.error(client.socket, "Unknown message namespace.", message.requestId);
                return;
            }

            capability = required;
        }

        if ((capability !== "chat" && !isScopeId(scopeId)) || !canRoute(client, capability, scopeId)) {
            this.error(client.socket, "Message route not permitted.", message.requestId);
            return;
        }

        // Do not trust client-provided identity fields.
        const outgoing = {
            type: message.type,
            route: message.route,
            targetClientId: message.targetClientId,
            scopeId,
            requestId: message.requestId,
            data: message.data,
            sourceClientId: client.id,
            sourceUserId: client.user.userId
        };

        const transmit = (target: ClientInfo): void => {
            if (canRoute(target, capability, scopeId)) this.send(target.socket, outgoing);
        };

        switch (message.route) {
            case "sender":
                transmit(client);
                break;

            case "target": {
                const id = message.targetClientId;
                if (!Number.isInteger(id) || id === undefined || id < 1 || id > 0xFFFFFFFF) {
                    this.error(client.socket, "Invalid target ID.", message.requestId);
                    return;
                }

                const target = this.clients.get(id);
                if (!target || !canRoute(target, capability, scopeId)) {
                    this.error(client.socket, "Target unavailable.", message.requestId);
                    return;
                }

                transmit(target);
                break;
            }

            case "others":
            case "all":
                for (const target of this.clients.values()) {
                    if (message.route === "others" && target.id === client.id) continue;
                    transmit(target);
                }
                break;
        }
    }

    private updateStringData(client: ClientInfo, message: NetworkMessage): void {
        const change = readDataChange(message.data);
        const personal = message.type === "user.data.set";
        // Ownership comes from the admitted socket. A user ID in the request cannot select an owner.
        const store = personal ? client.user.dataStore : this.data;
        if (!change || !store.set(change.key, change.value)) {
            this.error(client.socket, "Invalid data key, value, or storage limit exceeded.", message.requestId);
            return;
        }

        this.broadcast({
            type: personal ? "user.data.changed" : "session.data.changed", route: "all",
            data: personal ? { ...change, userId: client.user.userId } : change
        });
    }

    private updateActivity(client: ClientInfo, message: NetworkMessage): void {
        if (!client.capabilities.has("activity")) {
            this.error(client.socket, "Missing activity capability.", message.requestId);
            return;
        }

        const state = (message.data as { state?: unknown } | null)?.state;

        if (state !== "idle" && state !== "ide" && state !== "engine" && state !== "chat") {
            this.error(client.socket, "Invalid activity state.", message.requestId);
            return;
        }

        client.activity = { state, updatedAt: Date.now() };
        this.publishActivity(client.user);
    }

    private updateUserProfile(client: ClientInfo, message: NetworkMessage): void {
        const { user } = client;
        const changes = message.data as { username?: unknown; color?: unknown } | undefined;
        const username = typeof changes?.username === "string" ? changes.username.trim() : changes?.username;
        const color = changes?.color;
        if ((username === undefined && color === undefined) || (username !== undefined && !isUsername(username)) ||
            (color !== undefined && color !== null && !isUserColor(color))) {
            this.error(client.socket, "Invalid user profile.", message.requestId);
            return;
        }

        if (username !== undefined) user.username = username;
        if (color !== undefined) user.color = color ?? undefined;
        const data: UserProfileState = { userId: user.userId, username: user.username, color: user.color };
        this.broadcast({ type: "user.profile", route: "all", data });
    }

    private publishActivity(user: User, force = false): void {
        const activities: ClientActivity[] = [];
        for (const id of user.clients.keys()) {
            const client = this.clients.get(id);
            if (client) activities.push(client.activity);
        }

        const state = resolveActivity(activities, Date.now());
        if (!force && state === user.activity) return;
        user.activity = state;
        this.broadcast({ type: "activity.state", route: "all", data: { userId: user.userId, state } });
    }

    private refreshActivity(): void {
        const now = Date.now();
        const changed = new Set<User>();

        for (const client of this.clients.values()) {
            if (client.activity.state === "idle" || now - client.activity.updatedAt < ACTIVITY_TIMEOUT_MS) continue;
            client.activity = { state: "idle", updatedAt: now };
            changed.add(client.user);
        }

        for (const user of changed) this.publishActivity(user);
    }

    private broadcast(message: NetworkMessage, exceptId?: number): void {
        for (const client of this.clients.values()) {
            if (client.id === exceptId) continue;
            this.send(client.socket, message);
        }
    }

    private handleBinary(socket: WebSocket, raw: RawData): void {
        const sender = this.getClient(socket);

        if (!sender || !sender.capabilities.has("gamestyle.multiplayer")) {
            this.error(socket, "Binary networking not permitted.");
            return;
        }

        const packet = toBuffer(raw);

        // Header: version u8, route u8, target u32, server-stamped source u32, scope u32. All u32 fields are little-endian.
        if (packet.length < BINARY_HEADER_SIZE || packet.readUInt8(0) !== BINARY_VERSION) {
            this.error(socket, "Invalid binary packet.");
            return;
        }

        const route = packet.readUInt8(1);
        const targetId = packet.readUInt32LE(2);
        const scopeId = packet.readUInt32LE(10);

        if (!canRoute(sender, "gamestyle.multiplayer", scopeId) || ![BinaryRoute.Others, BinaryRoute.All, BinaryRoute.Target].includes(route)) {
            this.error(socket, "Unsupported binary route or scope.");
            return;
        }

        // Stamp the authenticated connection's numeric ID into the header.
        // Copy because the received buffer should not be modified in place.
        const outgoing = Buffer.from(packet);
        outgoing.writeUInt32LE(sender.id, 6);

        if (route === BinaryRoute.Target) {
            const target = this.clients.get(targetId);
            if (!target || !canRoute(target, "gamestyle.multiplayer", scopeId)) {
                this.error(socket, "Binary target unavailable.");
                return;
            }

            if (target.socket.readyState === WebSocket.OPEN) target.socket.send(outgoing, { binary: true });
            return;
        }

        for (const client of this.clients.values()) {
            if (!canRoute(client, "gamestyle.multiplayer", scopeId)) continue;
            if (route === BinaryRoute.Others && client.id === sender.id) continue;
            if (client.socket.readyState === WebSocket.OPEN) client.socket.send(outgoing, { binary: true });
        }
    }

    private onDisconnect(socket: WebSocket): void {
        this.pending.delete(socket);

        const client = this.getClient(socket);
        if (!client) return;

        this.clients.delete(client.id);
        this.clientIds.delete(socket);

        const { user } = client;
        user.removeClient(client.id);
        if (user.clients.size === 0) user.dataStore.clear();
        if (this.clients.size === 0) this.data.clear();
        this.broadcast({ type: "presence.leave", route: "all", data: { clientId: client.id, userId: user.userId } });
        this.publishActivity(user);
        console.log(`${user.username} (${client.id}) disconnected.`);
    }

    close(): Promise<void> {
        return this.closing ??= this.shutdown();
    }

    private async shutdown(): Promise<void> {
        clearInterval(this.timer);
        this.data.clear();

        for (const socket of this.pending) socket.terminate();
        for (const client of this.clients.values()) client.socket.terminate();

        try {
            await new Promise<void>((resolve, reject) => {
                this.server.close(error => error ? reject(error) : resolve());
            });
        } finally {
            // If shutdown races startup, wait for the registry write before removing this server's file.
            const path = await this.registration?.catch(() => undefined);
            if (path) await rm(path, { force: true });
        }
    }
}