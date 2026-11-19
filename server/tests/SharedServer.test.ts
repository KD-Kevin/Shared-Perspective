import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLocalSessions } from "../src/LocalDiscovery";
import { SharedServer } from "../src/SharedServer";
import type { ServerInfo } from "../src/protocol";

const replies = vi.hoisted(() => new Map<string, ServerInfo>());

// The server binds real sockets. Simulate only the client probes so these assertions also run
// in environments that restrict TCP connections to loopback.
vi.mock("ws", async importOriginal => {
    const original = await importOriginal<typeof import("ws")>();
    const { EventEmitter } = await import("node:events");

    return {
        ...original,
        default: class extends EventEmitter {
            constructor(url: string) {
                super();
                queueMicrotask(() => {
                    const info = replies.get(url);
                    if (info) this.emit("message", JSON.stringify({ type: "session.info", route: "sender", data: info }), false);
                    else this.emit("error", new Error("Connection refused."));
                });
            }

            terminate(): void {}
        }
    };
});

describe("local session discovery", () => {
    let directory: string;
    const servers: SharedServer[] = [];

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "shared-perspective-tests-"));
    });

    afterEach(async () => {
        try {
            await Promise.all(servers.splice(0).map(server => server.close()));
        } finally {
            replies.clear();
            await rm(directory, { recursive: true, force: true });
        }
    });

    async function start(name: string, password = ""): Promise<SharedServer> {
        const server = new SharedServer({ port: 0, name, password, discoveryDirectory: directory });
        servers.push(server);
        await server.ready;
        return server;
    }

    function reply(server: SharedServer, name: string, passwordRequired = false): void {
        replies.set(`ws://127.0.0.1:${server.port}`, { sessionId: server.sessionId, name, passwordRequired, clientCount: 2 });
    }

    it("returns an empty list when no registry exists", async () => {
        expect(await discoverLocalSessions(join(directory, "missing"))).toEqual([]);
    });

    it("publishes the bound ports for multiple independent servers and reads live metadata", async () => {
        const [first, second] = await Promise.all([start("Code session", "secret"), start("Scene session")]);
        reply(first, "Code session", true);
        reply(second, "Scene session");

        const firstRecord = await readFile(join(directory, `${first.sessionId}.json`), "utf8");
        expect(JSON.parse(firstRecord)).toEqual({ version: 1, sessionId: first.sessionId, port: first.port });
        expect(second.port).not.toBe(first.port);

        const sessions = await discoverLocalSessions(directory);
        expect(sessions).toHaveLength(2);
        expect(sessions).toContainEqual({
            sessionId: first.sessionId, name: "Code session", passwordRequired: true, clientCount: 2,
            port: first.port, url: `ws://127.0.0.1:${first.port}`
        });
        expect(sessions).toContainEqual(expect.objectContaining({ sessionId: second.sessionId, name: "Scene session" }));
    });

    it("ignores invalid records, unreachable ports, and a record whose port now serves another session", async () => {
        const current = await start("Current session");
        const dead = await start("Stopped responding");
        reply(current, "Current session");
        const staleId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const badId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        await Promise.all([
            writeFile(join(directory, `${staleId}.json`), JSON.stringify({ version: 1, sessionId: staleId, port: current.port })),
            writeFile(join(directory, `${badId}.json`), "{ malformed"),
            writeFile(join(directory, `${badId}.json.tmp`), JSON.stringify({ version: 1, sessionId: badId, port: current.port }))
        ]);

        const sessions = await discoverLocalSessions(directory);
        expect(sessions.map(session => session.sessionId)).toEqual([current.sessionId]);
        expect(sessions.some(session => session.sessionId === dead.sessionId)).toBe(false);
    });

    it("removes only its own registration on repeated close calls", async () => {
        const [first, second] = await Promise.all([start("First session"), start("Second session")]);

        await Promise.all([first.close(), first.close()]);
        expect(await readdir(directory)).toEqual([`${second.sessionId}.json`]);
    });

    it("does not leave a record when stopped during startup", async () => {
        const server = new SharedServer({ port: 0, name: "Starting session", password: "", discoveryDirectory: directory });
        servers.push(server);

        await server.close();
        expect(await readdir(directory)).toEqual([]);
    });
});
