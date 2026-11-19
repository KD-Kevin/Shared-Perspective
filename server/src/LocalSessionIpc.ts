import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { LocalUserProfile } from "./LocalUserProfile";
import { LocalSessionCoordinator, type LocalJoinOptions, type LocalSessionApp, type LocalSessionEvent, type LocalSessionState } from "./LocalSessionCoordinator";
import type { NetworkMessage, UserDataChange, UserDataSnapshot } from "./protocol";
import { readDataChange, SessionDataStore } from "./SessionData";

const LOCAL_VERSION = 1;
const FRAME_LIMIT = 2 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;

async function credentials(): Promise<{ key: string; address: string }> {
    const key = await new LocalUserProfile().identityKeyFor("shared-perspective-local-session-v1");
    const suffix = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
    return { key, address: "\\\\.\\pipe\\shared-perspective-" + suffix };
}

function proof(key: string, role: "server" | "app", clientNonce: string, serverNonce: string): string {
    return createHmac("sha256", Buffer.from(key, "hex")).update(role + ":" + clientNonce + ":" + serverNonce).digest("hex");
}

function matches(value: unknown, expected: string): boolean {
    return typeof value === "string" && HEX.test(value) && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"));
}

function send(socket: Socket, message: object): void {
    if (socket.destroyed) return;
    const frame = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(frame) + socket.writableLength > FRAME_LIMIT) {
        socket.destroy(new Error("Local session IPC buffer limit exceeded."));
        return;
    }
    socket.write(frame);
}

function receive(socket: Socket, listener: (message: Record<string, unknown>) => void): void {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        pending += chunk;
        let end: number;
        while (!socket.destroyed && (end = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
                if (Buffer.byteLength(line) > FRAME_LIMIT) throw new Error("Local session IPC frame is too large.");
                const message: unknown = JSON.parse(line);
                if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid local session frame.");
                listener(message as Record<string, unknown>);
            } catch (error) {
                socket.destroy(error instanceof Error ? error : new Error(String(error)));
            }
        }
        if (Buffer.byteLength(pending) > FRAME_LIMIT) socket.destroy(new Error("Local session IPC frame is too large."));
    });
}

async function runRequest(app: LocalSessionApp, message: Record<string, unknown>): Promise<void> {
    switch (message.op) {
        case "join": {
            const options = message.options as LocalJoinOptions | undefined;
            if (!options || typeof options.ownerApp !== "string" ||
                (options.url !== undefined && typeof options.url !== "string") ||
                (options.sessionId !== undefined && typeof options.sessionId !== "string") ||
                (options.password !== undefined && typeof options.password !== "string")) throw new Error("Invalid join options.");
            // Only wire options pass through. Profile objects are owned by the coordinator.
            const { url, sessionId, ownerApp, username, color, participantKind, password, capabilities, identityKey, scopeGrants } = options;
            app.join({ url, sessionId, ownerApp, username, color, participantKind, password, capabilities, identityKey, scopeGrants });
            return;
        }
        case "leave":
            app.leave();
            return;
        case "send": {
            const outgoing = message.message as NetworkMessage | undefined;
            if (typeof outgoing?.type !== "string") throw new Error("Invalid session message.");
            if (outgoing.type === "user.data.set" && outgoing.route === "server") {
                const change = readDataChange(outgoing.data);
                if (!change) throw new Error("Invalid user data key or value.");
                // Persist through the shared profile before sending from this app's own connection.
                if (!await app.setUserData(change.key, change.value)) throw new Error("This app is not connected to the session.");
            } else if (!app.send(outgoing)) throw new Error("This app is not connected to the session.");
            return;
        }
        case "sendBinary":
            if (typeof message.data !== "string" || !app.sendBinary(Buffer.from(message.data, "base64"))) {
                throw new Error("This app is not connected to the session.");
            }
            return;
        default:
            throw new Error("Unknown local session operation.");
    }
}

export async function listenLocalSession(coordinator = new LocalSessionCoordinator()): Promise<Server> {
    if (process.platform !== "win32") throw new Error("The local session coordinator targets Windows.");
    const { address, key } = await credentials();
    let idle: ReturnType<typeof setTimeout>;
    const resetIdle = (): void => {
        clearTimeout(idle);
        if (coordinator.appCount === 0) idle = setTimeout(() => server.close(), 5_000);
    };
    const server = createServer(socket => {
        let app: LocalSessionApp | undefined;
        let clientNonce: string | undefined;
        let serverNonce: string | undefined;
        const timeout = setTimeout(() => socket.destroy(), 3_000);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
            clearTimeout(timeout);
            app?.close();
            resetIdle();
        });
        receive(socket, message => {
            if (!app) {
                // Mutual proof keeps session passwords and scope grants off unauthenticated local channels.
                if (!clientNonce && message.type === "hello" && message.version === LOCAL_VERSION &&
                    typeof message.nonce === "string" && HEX.test(message.nonce)) {
                    clientNonce = message.nonce;
                    serverNonce = randomBytes(32).toString("hex");
                    send(socket, { type: "hello", version: LOCAL_VERSION, nonce: serverNonce, proof: proof(key, "server", clientNonce, serverNonce) });
                    return;
                }
                if (clientNonce && serverNonce && message.type === "authenticate" &&
                    matches(message.proof, proof(key, "app", clientNonce, serverNonce))) {
                    clearTimeout(timeout);
                    app = coordinator.attach(event => send(socket, event));
                    resetIdle();
                    return;
                }
                throw new Error("Invalid coordinator handshake.");
            }
            if (!Number.isSafeInteger(message.id)) throw new Error("Invalid local request ID.");
            void runRequest(app, message).then(
                () => send(socket, { type: "result", id: message.id, ok: true }),
                error => send(socket, { type: "result", id: message.id, ok: false, reason: error instanceof Error ? error.message : String(error) })
            );
        });
    });

    server.on("close", () => clearTimeout(idle));
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => {
            server.off("error", reject);
            resetIdle();
            resolve(server);
        });
    });
}

interface IpcEvents {
    event: [LocalSessionEvent];
    closed: [Error | undefined];
    sessionDataChanged: [];
    userDataChanged: [number];
}

export class LocalSessionConnection extends EventEmitter<IpcEvents> {
    private sequence = 0;
    private ready = false;
    private failure?: Error;
    private current: LocalSessionState = { phase: "idle", app: "idle" };
    private readonly data = new SessionDataStore();
    private readonly userData = new Map<number, SessionDataStore>();
    private readonly requests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

    private constructor(private readonly socket: Socket, key: string) {
        super();
        const nonce = randomBytes(32).toString("hex");
        let authenticated = false;
        const timeout = setTimeout(() => socket.destroy(new Error("Local session IPC handshake timed out.")), 3_000);

        socket.on("error", error => { this.failure = error; });
        socket.on("close", () => {
            clearTimeout(timeout);
            const error = this.failure ?? new Error("Local session coordinator disconnected.");
            for (const request of this.requests.values()) request.reject(error);
            this.requests.clear();
            this.clearData();
            this.emit("closed", this.failure);
        });
        socket.on("connect", () => send(socket, { type: "hello", version: LOCAL_VERSION, nonce }));
        receive(socket, message => {
            if (!authenticated) {
                const peerNonce = message.nonce;
                if (message.type !== "hello" || message.version !== LOCAL_VERSION || typeof peerNonce !== "string" ||
                    !HEX.test(peerNonce) || !matches(message.proof, proof(key, "server", nonce, peerNonce))) {
                    throw new Error("Local session coordinator authentication failed.");
                }
                authenticated = true;
                send(socket, { type: "authenticate", proof: proof(key, "app", nonce, peerNonce) });
                return;
            }
            if (message.type === "result") {
                const id = message.id as number;
                const request = this.requests.get(id);
                this.requests.delete(id);
                if (message.ok) request?.resolve();
                else request?.reject(new Error(String(message.reason)));
                return;
            }
            const event = message as LocalSessionEvent;
            if (event.type === "state") {
                clearTimeout(timeout);
                this.ready = true;
                this.current = event.state;
                if (event.state.phase === "leaving" || event.state.app === "idle" || event.state.app === "reconnecting") this.clearData();
            } else if (event.type === "joined") {
                if (event.result.sessionData !== undefined && this.data.load(event.result.sessionData)) this.emit("sessionDataChanged");
            } else if (event.type === "roster") {
                const active = new Set(event.users.map(user => user.userId));
                for (const [userId, store] of this.userData) {
                    if (!active.has(userId)) {
                        store.clear();
                        this.userData.delete(userId);
                        this.emit("userDataChanged", userId);
                    }
                }
            } else if (event.type === "message") {
                this.updateStringData(event.message);
            }
            this.emit("event", event);
        });
    }

    static async open(): Promise<LocalSessionConnection> {
        if (process.platform !== "win32") throw new Error("The local session coordinator targets Windows.");
        const { address, key } = await credentials();
        const client = new LocalSessionConnection(createConnection(address), key);
        return new Promise((resolve, reject) => {
            const closed = (error: Error | undefined): void => reject(error ?? new Error("Local session coordinator disconnected."));
            const event = (): void => {
                if (!client.ready) return;
                client.off("event", event);
                client.off("closed", closed);
                resolve(client);
            };
            client.once("closed", closed);
            client.on("event", event);
        });
    }

    get state(): LocalSessionState { return this.current; }

    get sessionData(): ReadonlyMap<string, string> { return this.data.view; }

    getUserData(userId: number): ReadonlyMap<string, string> | undefined { return this.userData.get(userId)?.view; }

    setSessionData(key: string, value: string | null): Promise<void> {
        return this.send({ type: "session.data.set", route: "server", data: { key, value } });
    }

    setUserData(key: string, value: string | null): Promise<void> {
        return this.send({ type: "user.data.set", route: "server", data: { key, value } });
    }

    join(options: LocalJoinOptions): Promise<void> { return this.request({ op: "join", options }); }
    leave(): Promise<void> { return this.request({ op: "leave" }); }
    send(message: NetworkMessage): Promise<void> { return this.request({ op: "send", message }); }
    sendBinary(bytes: Buffer): Promise<void> { return this.request({ op: "sendBinary", data: bytes.toString("base64") }); }
    close(): void { this.socket.destroy(); }

    private clearData(): void {
        if (this.data.view.size) {
            this.data.clear();
            this.emit("sessionDataChanged");
        }
        const ids = Array.from(this.userData.keys());
        for (const store of this.userData.values()) store.clear();
        this.userData.clear();
        for (let i = 0; i < ids.length; i++) this.emit("userDataChanged", ids[i]);
    }

    private updateStringData(message: NetworkMessage): void {
        if (message.type === "session.data.changed") {
            const change = readDataChange(message.data);
            if (change && this.data.set(change.key, change.value)) this.emit("sessionDataChanged");
        } else if (message.type === "user.data.snapshot" || message.type === "user.data.changed") {
            const data = message.data as UserDataChange | UserDataSnapshot | undefined;
            if (!data || !Number.isSafeInteger(data.userId)) return;
            const store = this.userData.get(data.userId) ?? new SessionDataStore();
            const change = readDataChange(data);
            const updated = "entries" in data ? store.load(data.entries) : change && store.set(change.key, change.value);
            if (updated) {
                this.userData.set(data.userId, store);
                this.emit("userDataChanged", data.userId);
            }
        }
    }

    private request(data: object): Promise<void> {
        if (!this.ready || this.socket.destroyed) return Promise.reject(new Error("Local session coordinator is disconnected."));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.requests.set(id, { resolve, reject });
            try {
                send(this.socket, { id, ...data });
            } catch (error) {
                this.requests.delete(id);
                reject(error);
            }
        });
    }
}
