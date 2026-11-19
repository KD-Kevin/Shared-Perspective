import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { discoverLocalSessions, registerJoinedSession } from "../src/LocalDiscovery";
import { SharedServer } from "../src/SharedServer";
import type { NetworkMessage } from "../src/protocol";

it("discovers a live password-protected session and reports joined clients", async ({ skip }) => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-live-"));
    const server = new SharedServer({ port: 0, name: "Live session", password: "secret", discoveryDirectory: directory });

    try {
        await server.ready;
        const url = `ws://127.0.0.1:${server.port}`;
        const client = new WebSocket(url, { handshakeTimeout: 1_000 });

        try {
            await once(client, "open");
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EACCES" || code === "EPERM") skip("This environment denies TCP loopback connections.");
            throw error;
        }

        const response = new Promise<NetworkMessage>(resolve => {
            client.on("message", raw => {
                const message = JSON.parse(raw.toString()) as NetworkMessage;
                if (message.type === "session.joinResult") resolve(message);
            });
        });
        client.send(JSON.stringify({
            type: "session.join", route: "server", data: {
                displayName: "Unity editor", password: "secret", capabilities: ["chat", "activity", "engine.unity"]
            }
        }));
        expect((await response).data).toEqual({ accepted: true, clientId: 1, userId: 1 });
        expect(await discoverLocalSessions(directory)).toEqual([{
            sessionId: server.sessionId, name: "Live session", passwordRequired: true, clientCount: 1, port: server.port, url
        }]);
    } finally {
        try {
            await server.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    expect(await discoverLocalSessions(directory)).toEqual([]);
});

it("shares joined sessions across local clients and ignores expired records while the server stays online", async ({ skip }) => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-guests-"));
    const guestDirectory = join(directory, "guest");
    const server = new SharedServer({ port: 0, name: "Teammate", password: "secret", discoveryDirectory: join(directory, "host") });

    const connect = async (url: string, displayName: string): Promise<WebSocket> => {
        const client = new WebSocket(url);
        let info: NetworkMessage;
        try {
            const [raw] = await once(client, "message");
            info = JSON.parse(raw.toString()) as NetworkMessage;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EACCES" || code === "EPERM") skip("This environment denies TCP loopback connections.");
            throw error;
        }
        expect(info.type).toBe("session.info");
        const result = once(client, "message");
        client.send(JSON.stringify({
            type: "session.join", route: "server", data: { displayName, password: "secret" }
        }));
        const [raw] = await result;
        expect(JSON.parse(raw.toString())).toMatchObject({ type: "session.joinResult", data: { accepted: true } });
        return client;
    };

    const register = (client: WebSocket): Promise<void> =>
        registerJoinedSession(client, server.sessionId, guestDirectory, error => expect.unreachable(String(error)));

    try {
        await server.ready;
        expect(await discoverLocalSessions(guestDirectory)).toEqual([]);

        const url = "ws://localhost:" + server.port;
        const ide = await connect(url, "IDE");
        await register(ide);
        const results = await discoverLocalSessions(guestDirectory);
        expect(results).toEqual([{
            sessionId: server.sessionId, name: "Teammate", passwordRequired: true, clientCount: 1, port: server.port, url
        }]);

        const editor = await connect(results[0].url, "Unity");
        await register(editor);
        expect(await discoverLocalSessions(guestDirectory)).toEqual([{ ...results[0], clientCount: 2 }]);

        const closed = once(ide, "close");
        ide.close();
        await closed;
        await expect.poll(async () => (await readdir(guestDirectory)).length).toBe(1);
        expect(await discoverLocalSessions(guestDirectory)).toEqual([{ ...results[0], clientCount: 1 }]);

        const [remaining] = await readdir(guestDirectory);
        const path = join(guestDirectory, remaining);
        const record = JSON.parse(await readFile(path, "utf8"));
        expect(Object.keys(record).sort()).toEqual(["connectionId", "expiresAt", "sessionId", "url", "version"]);
        await writeFile(path, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
        expect(await discoverLocalSessions(guestDirectory)).toEqual([]);
    } finally {
        await server.close();
        await expect.poll(async () => (await readdir(guestDirectory).catch(() => [])).length).toBe(0);
        await rm(directory, { recursive: true, force: true });
    }
});

it("publishes a per-connection record, renews it on pong, and removes it on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-registry-"));
    const sessionId = "00000000-0000-0000-0000-000000000001";
    const socket = Object.assign(new EventEmitter(), { url: "ws://teammate:9000", readyState: WebSocket.OPEN });
    const readRecord = async (path: string) => JSON.parse(await readFile(path, "utf8"));
    const errors: unknown[] = [];

    try {
        await registerJoinedSession(socket as unknown as WebSocket, sessionId, directory, error => errors.push(error));
        const names = await readdir(directory);
        expect(names).toHaveLength(1);

        const path = join(directory, names[0]);
        const record = await readRecord(path);
        expect(names[0]).toBe("joined-" + record.connectionId + ".json");
        expect(record).toEqual({
            version: 1, connectionId: expect.any(String), sessionId, url: socket.url, expiresAt: expect.any(Number)
        });
        expect(record.expiresAt).toBeGreaterThan(Date.now());

        await writeFile(path, JSON.stringify({ ...record, expiresAt: 0 }));
        expect(await discoverLocalSessions(directory)).toEqual([]);
        socket.emit("pong");
        await expect.poll(async () => (await readRecord(path)).expiresAt).toBeGreaterThan(Date.now());
    } finally {
        socket.emit("close");
        await expect.poll(async () => (await readdir(directory)).length).toBe(0);
        await rm(directory, { recursive: true, force: true });
    }

    expect(errors).toEqual([]);
});
