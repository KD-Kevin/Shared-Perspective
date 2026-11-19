import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { expect, it, vi } from "vitest";
import { listenLocalSession, LocalSessionConnection } from "../src/LocalSessionIpc";

it.skipIf(process.platform !== "win32")("registers independent apps through the Windows pipe and rejects missing join addresses", async ({ skip }) => {
    const directory = await mkdtemp(join(tmpdir(), "shared-perspective-ipc-"));
    vi.stubEnv("SHARED_PERSPECTIVE_PROFILE_DIR", directory);
    let server: Server | undefined;
    const clients: LocalSessionConnection[] = [];

    try {
        try {
            server = await listenLocalSession();
            clients.push(await LocalSessionConnection.open());
            clients.push(await LocalSessionConnection.open());
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EPERM" || code === "EACCES") skip("This environment blocks Windows named pipes.");
            throw error;
        }

        await expect(listenLocalSession()).rejects.toMatchObject({ code: "EADDRINUSE" });
        expect(clients.map(client => client.state.phase)).toEqual(["idle", "idle"]);
        await expect(clients[0].join({ ownerApp: "unity" })).rejects.toThrow(/server address/);
        await expect(clients[1].leave()).resolves.toBeUndefined();
    } finally {
        for (const client of clients) {
            const closed = once(client, "closed");
            client.close();
            await closed;
        }
        if (server) {
            const coordinator = server;
            await new Promise<void>(resolve => coordinator.close(() => resolve()));
        }
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});
