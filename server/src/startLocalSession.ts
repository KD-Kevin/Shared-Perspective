import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { LocalSessionConnection } from "./LocalSessionIpc";

function missing(error: unknown): boolean {
    const { code } = error as NodeJS.ErrnoException;
    return code === "ENOENT" || code === "ECONNREFUSED";
}

export async function openLocalSession(): Promise<LocalSessionConnection> {
    try {
        return await LocalSessionConnection.open();
    } catch (error) {
        if (!missing(error)) throw error;
    }

    const env = { ...process.env };
    delete env.SERVER_PASSWORD;
    const service = spawn(process.execPath, [...process.execArgv, join(__dirname, "local-session.ts")], {
        detached: true, windowsHide: true, stdio: "ignore", env
    });
    let launchError: Error | undefined;
    service.on("error", error => { launchError = error; });
    service.unref();

    for (let attempt = 0; attempt < 40; attempt++) {
        await setTimeout(100);
        if (launchError) throw launchError;
        try {
            return await LocalSessionConnection.open();
        } catch (error) {
            if (!missing(error)) throw error;
        }
    }
    throw new Error("Could not start the local session coordinator. Run npm run coordinator for diagnostics.");
}
