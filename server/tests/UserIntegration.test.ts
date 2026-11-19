import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Server } from "node:net";
import { LocalSessionConnection, listenLocalSession } from "../src/LocalSessionIpc";
import { LocalUserProfile } from "../src/LocalUserProfile";
import { BINARY_HEADER_SIZE, BINARY_VERSION, BinaryRoute } from "../src/protocol";
import type { NetworkMessage } from "../src/protocol";
import { SharedClient } from "../src/SharedClient";
import { SharedServer } from "../src/SharedServer";

const transport = vi.hoisted(() => ({ accept: undefined as ((socket: EventEmitter) => void) | undefined }));

vi.mock("ws", async importOriginal => {
    const original = await importOriginal<typeof import("ws")>();
    const { EventEmitter } = await import("node:events");

    return {
        ...original,
        default: class extends EventEmitter {
            static readonly OPEN = 1;
            private readonly peer = new EventEmitter();
            readyState = 1;

            constructor(readonly url: string) {
                super();
                Object.assign(this.peer, {
                    readyState: 1,
                    send: (data: string | Buffer, options?: { binary?: boolean }) =>
                        queueMicrotask(() => this.emit("message", Buffer.from(data), options?.binary === true)),
                    terminate: () => this.close()
                });
                queueMicrotask(() => transport.accept?.(this.peer));
            }

            send(data: string | Buffer, options?: { binary?: boolean }): void {
                queueMicrotask(() => this.peer.emit("message", Buffer.from(data), options?.binary === true));
            }

            ping(): void { this.emit("pong"); }
            terminate(): void { this.close(); }

            close(): void {
                if (this.readyState !== 1) return;
                this.readyState = 3;
                Object.assign(this.peer, { readyState: 3 });
                this.peer.emit("close");
                this.emit("close");
            }
        }
    };
});

it("shares one public user across apps and keeps preferences and server bookmarks local", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-user-"));
    const registry = join(directory, "sessions");
    vi.stubEnv("SHARED_PERSPECTIVE_DISCOVERY_DIR", registry);

    const profile = new LocalUserProfile(join(directory, "profile"));
    const secondProfile = new LocalUserProfile(join(directory, "profile"));
    const server = new SharedServer({ port: 0, name: "Project", password: "", discoveryDirectory: registry });
    const clients: SharedClient[] = [];
    const errors: unknown[] = [];
    const events: NetworkMessage[] = [];
    transport.accept = socket => Reflect.get(server, "server").emit("connection", socket);

    try {
        await server.ready;
        const keys = await Promise.all([profile.identityKeyFor(server.sessionId), secondProfile.identityKeyFor(server.sessionId)]);
        expect(keys[0]).toBe(keys[1]);
        expect(await profile.identityKeyFor("a-different-session")).not.toBe(keys[0]);
        await profile.update({ username: "Kevin", color: "#112233", favoriteColor: "#445566" });
        await secondProfile.setPreference("editor.hints", { enabled: true });
        expect(await profile.getPreference("editor.hints")).toEqual({ enabled: true });

        const url = "ws://localhost:" + server.port;
        const create = (options: Omit<ConstructorParameters<typeof SharedClient>[0], "url">): SharedClient => {
            const client = new SharedClient({ ...options, url });
            clients.push(client);
            client.on("connectionError", error => errors.push(error));
            client.on("localError", error => errors.push(error));
            client.on("message", message => events.push(message));
            return client;
        };

        const unity = create({ ownerApp: "unity", profile, capabilities: ["activity", "chat"] });
        await expect.poll(() => unity.localUser?.username).toBe("Kevin");
        unity.setActivity("engine");

        const studio = create({ ownerApp: "visual-studio", profile: secondProfile, username: "Ignored second name", capabilities: ["activity", "chat"] });
        await expect.poll(() => studio.localUser?.clients.size).toBe(2);
        expect(studio.localUser?.userId).toBe(unity.localUser?.userId);
        expect(studio.clientId).not.toBe(unity.clientId);
        expect(studio.localUser?.username).toBe("Kevin");
        expect(studio.localUser?.activity).toBe("engine");
        expect(studio.localUser?.getClientsByApp("unity")).toMatchObject([{ clientId: unity.clientId }]);

        const agent = create({ ownerApp: "code-together", participantKind: "agent", username: "Assistant", capabilities: ["chat"] });
        await expect.poll(() => agent.localUser?.participantKind).toBe("agent");
        expect(agent.localUser?.userId).not.toBe(unity.localUser?.userId);
        expect(agent.users.get(unity.localUser!.userId)?.color).toBe("#112233");

        await studio.updateProfile({ color: "#abcdef", favoriteColor: "#654321" });
        await expect.poll(() => unity.localUser?.color).toBe("#abcdef");
        expect(await profile.read()).toEqual({ username: "Kevin", color: "#abcdef", favoriteColor: "#654321" });
        expect(JSON.stringify(events)).not.toContain("favoriteColor");
        expect(JSON.stringify(events)).not.toContain(keys[0]);

        studio.send({ type: "chat.message", route: "others", data: { text: "Hello" }, sourceUserId: 999 });
        await expect.poll(() => events.find(message => message.type === "chat.message")).toMatchObject({
            sourceUserId: unity.localUser!.userId, sourceClientId: studio.clientId
        });

        await expect.poll(async () => (await profile.getVisitedServers())[0]?.url).toBe(url);
        await secondProfile.setFavoriteServer(studio.server!, true);
        expect(await profile.getFavoriteServers()).toEqual([{ url, sessionId: server.sessionId, name: "Project" }]);

        unity.close();
        await expect.poll(() => studio.localUser?.clients.size).toBe(1);
        expect(studio.localUser?.activity).toBe("idle");
        expect(errors).toEqual([]);
    } finally {
        for (const client of clients) client.close();
        await server.close();
        await expect.poll(async () => readdir(registry)).toEqual([]);
        transport.accept = undefined;
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});

it("isolates scoped Godot JSON and Game Style binary while sharing session chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-scopes-"));
    vi.stubEnv("SHARED_PERSPECTIVE_DISCOVERY_DIR", directory);
    const tokenA = "a".repeat(32);
    const tokenB = "b".repeat(32);
    const tokenGameStyle = "c".repeat(32);
    const scopeA = 70001;
    const scopeB = 70002;
    const server = new SharedServer({
        port: 0, name: "Scoped project", password: "", discoveryDirectory: directory,
        workspaceScopes: [
            { scopeId: scopeA, token: tokenA, capabilities: ["engine.godot", "engine.unity"] },
            { scopeId: scopeB, token: tokenB, capabilities: ["engine.godot", "gamestyle.multiplayer"] },
            { scopeId: scopeA, token: tokenGameStyle, capabilities: ["gamestyle.multiplayer"] }
        ]
    });
    const clients: SharedClient[] = [];
    const profile = new LocalUserProfile(join(directory, "profile"));
    transport.accept = socket => Reflect.get(server, "server").emit("connection", socket);

    try {
        await server.ready;
        function connect(ownerApp: string, capabilities: ConstructorParameters<typeof SharedClient>[0]["capabilities"],
            scopeGrants?: ConstructorParameters<typeof SharedClient>[0]["scopeGrants"]) {
            const client = new SharedClient({ url: "ws://localhost:" + server.port, ownerApp, capabilities, scopeGrants, profile });
            clients.push(client);
            const messages: NetworkMessage[] = [];
            const binary: Buffer[] = [];
            client.on("message", message => messages.push(message));
            client.on("binary", bytes => binary.push(bytes));
            return { client, messages, binary };
        }

        const godot = connect("godot", ["chat", "engine.godot"], [{ scopeId: scopeA, token: tokenA }]);
        const teammate = connect("godot", ["chat", "engine.godot"], [{ scopeId: scopeA, token: tokenA }]);
        const otherProject = connect("godot", ["chat", "engine.godot", "gamestyle.multiplayer"], [{ scopeId: scopeB, token: tokenB }]);
        const unity = connect("unity", ["chat", "engine.unity", "gamestyle.multiplayer"], [{ scopeId: scopeA, token: tokenA }]);
        const gameStyle = connect("game-style", ["chat", "gamestyle.multiplayer"], [{ scopeId: scopeA, token: tokenGameStyle }]);
        const gameStylePeer = connect("game-style", ["chat", "gamestyle.multiplayer"], [{ scopeId: scopeA, token: tokenGameStyle }]);
        const guest = connect("vscode", ["chat", "engine.godot"]);
        await expect.poll(() => clients.every(client => client.clientId !== undefined)).toBe(true);
        expect(godot.client.scopeIds).toEqual([scopeA]);
        expect(guest.client.scopeIds).toEqual([]);

        godot.client.send({ type: "engine.godot.cursor", route: "others", scopeId: scopeA, data: { x: 2 } });
        await expect.poll(() => teammate.messages.find(message => message.type === "engine.godot.cursor")).toMatchObject({
            scopeId: scopeA, sourceClientId: godot.client.clientId
        });
        for (const observer of [guest, otherProject, unity]) {
            expect(observer.messages.some(message => message.type === "engine.godot.cursor")).toBe(false);
        }

        godot.client.send({ type: "engine.godot.cursor", route: "target", scopeId: scopeA, targetClientId: otherProject.client.clientId, requestId: 8 });
        guest.client.send({ type: "engine.godot.cursor", route: "all", scopeId: scopeA, requestId: 9 });
        godot.client.send({ type: "engine.godot.cursor", route: "all", requestId: 10 });
        await expect.poll(() => godot.messages.filter(message => message.type === "session.error").map(message => message.requestId)).toEqual([8, 10]);
        await expect.poll(() => guest.messages.some(message => message.type === "session.error" && message.requestId === 9)).toBe(true);

        const payload = Buffer.alloc(BINARY_HEADER_SIZE + 1);
        payload.writeUInt8(BINARY_VERSION, 0);
        payload.writeUInt8(BinaryRoute.Others, 1);
        payload.writeUInt32LE(scopeA, 10);
        payload.writeUInt8(42, BINARY_HEADER_SIZE);
        unity.client.sendBinary(payload);
        await expect.poll(() => unity.messages.some(message => message.type === "session.error")).toBe(true);
        expect(gameStylePeer.binary).toHaveLength(0);

        gameStyle.client.sendBinary(payload);
        await expect.poll(() => gameStylePeer.binary.length).toBe(1);
        expect(gameStylePeer.binary[0].readUInt32LE(6)).toBe(gameStyle.client.clientId);
        expect(gameStylePeer.binary[0].readUInt32LE(10)).toBe(scopeA);
        expect(gameStylePeer.binary[0].readUInt8(BINARY_HEADER_SIZE)).toBe(42);
        expect(unity.binary).toHaveLength(0);
        expect(otherProject.binary).toHaveLength(0);

        godot.client.send({ type: "chat.message", route: "all", data: { text: "Session-wide" } });
        await expect.poll(() => guest.messages.find(message => message.type === "chat.message")?.data).toEqual({ text: "Session-wide" });
        expect(otherProject.messages.some(message => message.type === "chat.message")).toBe(true);
        expect(JSON.stringify(teammate.messages)).not.toContain(tokenA);
    } finally {
        for (const client of clients) client.close();
        await server.close();
        await expect.poll(async () => (await readdir(directory)).filter(name => name.endsWith(".json"))).toEqual([]);
        transport.accept = undefined;
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});

it("shares temporary session keys and restores only the owner's permanent public keys after everyone leaves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-session-data-"));
    const registry = join(directory, "sessions");
    vi.stubEnv("SHARED_PERSPECTIVE_DISCOVERY_DIR", registry);
    const firstProfile = new LocalUserProfile(join(directory, "first"));
    const secondProfile = new LocalUserProfile(join(directory, "second"));
    const server = new SharedServer({ port: 0, name: "Lobby", password: "", discoveryDirectory: registry });
    const clients: SharedClient[] = [];
    transport.accept = socket => Reflect.get(server, "server").emit("connection", socket);

    function connect(profile: LocalUserProfile, ownerApp: string): SharedClient {
        const client = new SharedClient({ ownerApp, url: "ws://localhost:" + server.port, profile });
        clients.push(client);
        return client;
    }

    try {
        await server.ready;
        await firstProfile.setPublicData("badge", "blue");
        const first = connect(firstProfile, "godot");
        await expect.poll(() => first.localUser?.data.get("badge")).toBe("blue");
        const firstId = first.localUser!.userId;
        expect(first.setSessionData("scene", "{\"id\":5}")).toBe(true);
        await expect.poll(() => first.sessionData.get("scene")).toBe("{\"id\":5}");

        const second = connect(secondProfile, "rider");
        await expect.poll(() => second.users.get(firstId)?.data.get("badge")).toBe("blue");
        expect(second.sessionData.get("scene")).toBe("{\"id\":5}");
        second.setSessionData("scene", "updated");
        await expect.poll(() => first.sessionData.get("scene")).toBe("updated");

        second.send({ type: "user.data.set", route: "server", data: { key: "badge", value: "spoof attempt", userId: firstId } });
        await expect.poll(() => second.localUser?.data.get("badge")).toBe("spoof attempt");
        expect(second.users.get(firstId)?.data.get("badge")).toBe("blue");

        await first.setUserData("badge", "gold");
        await expect.poll(() => second.users.get(firstId)?.data.get("badge")).toBe("gold");
        expect(await firstProfile.readPublicData()).toEqual([["badge", "gold"]]);
        const priorData = first.localUser!.data;
        first.close();
        expect(first.sessionData.size).toBe(0);
        expect(priorData.size).toBe(0);
        await expect.poll(() => second.users.has(firstId)).toBe(false);
        expect(second.sessionData.get("scene")).toBe("updated");

        second.setSessionData("scene", null);
        await expect.poll(() => second.sessionData.has("scene")).toBe(false);
        second.setSessionData("temporary", "clear me when empty");
        await expect.poll(() => second.sessionData.has("temporary")).toBe(true);
        second.close();

        const returned = connect(firstProfile, "godot");
        await expect.poll(() => returned.localUser?.data.get("badge")).toBe("gold");
        expect(returned.sessionData.size).toBe(0);
        await returned.setUserData("badge", null);
        await expect.poll(() => returned.localUser?.data.has("badge")).toBe(false);
        expect(await firstProfile.readPublicData()).toEqual([]);
    } finally {
        for (const client of clients) client.close();
        await server.close();
        await expect.poll(async () => readdir(registry)).toEqual([]);
        transport.accept = undefined;
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});

it.skipIf(process.platform !== "win32")("serves both string stores through the Windows adapter pipe", async ({ skip }) => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-ipc-data-"));
    const registry = join(directory, "sessions");
    const profileDirectory = join(directory, "profile");
    vi.stubEnv("SHARED_PERSPECTIVE_DISCOVERY_DIR", registry);
    vi.stubEnv("SHARED_PERSPECTIVE_PROFILE_DIR", profileDirectory);
    const server = new SharedServer({ port: 0, name: "IPC lobby", password: "", discoveryDirectory: registry });
    let pipe: Server | undefined;
    const clients: LocalSessionConnection[] = [];
    transport.accept = socket => Reflect.get(server, "server").emit("connection", socket);

    try {
        await server.ready;
        try {
            pipe = await listenLocalSession();
            clients.push(await LocalSessionConnection.open());
            clients.push(await LocalSessionConnection.open());
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EPERM" || code === "EACCES") skip("This environment blocks Windows named pipes.");
            throw error;
        }
        const [unity, code] = clients;
        let userId: number | undefined;
        unity.on("event", event => {
            if (event.type === "joined") userId = event.result.userId;
        });
        await unity.join({ ownerApp: "unity", url: "ws://localhost:" + server.port });
        await expect.poll(() => unity.state.app).toBe("joined");
        await unity.setSessionData("scene", "warehouse");
        await unity.setUserData("badge", "silver");
        await expect.poll(() => unity.getUserData(userId!)?.get("badge")).toBe("silver");

        await code.join({ ownerApp: "vscode" });
        await expect.poll(() => code.getUserData(userId!)?.get("badge")).toBe("silver");
        expect(code.sessionData.get("scene")).toBe("warehouse");

        await code.setUserData("badge", "gold");
        await expect.poll(() => unity.getUserData(userId!)?.get("badge")).toBe("gold");
        const userView = unity.getUserData(userId!)!;
        await code.leave();
        await expect.poll(() => unity.state.phase).toBe("idle");
        expect(unity.sessionData.size).toBe(0);
        expect(userView.size).toBe(0);
        expect(await new LocalUserProfile(profileDirectory).readPublicData()).toEqual([["badge", "gold"]]);
    } finally {
        for (const client of clients) {
            const closed = once(client, "closed");
            client.close();
            await closed;
        }
        if (pipe) {
            const coordinator = pipe;
            await new Promise<void>(resolve => coordinator.close(() => resolve()));
        }
        await server.close();
        await expect.poll(async () => readdir(registry)).toEqual([]);
        transport.accept = undefined;
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});
