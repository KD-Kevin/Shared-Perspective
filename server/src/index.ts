import { readFileSync } from "node:fs";
import { SharedServer } from "./SharedServer";

const port = Number(process.env.PORT ?? 8080);
const name = process.env.SERVER_NAME ?? "Shared Perspective Session";
const password = process.env.SERVER_PASSWORD ?? "";

if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid server port.");

const scopesFile = process.env.SHARED_PERSPECTIVE_SCOPES_FILE;
const workspaceScopes: unknown = scopesFile ? JSON.parse(readFileSync(scopesFile, "utf8")) : undefined;
const server = new SharedServer({ port, name, password, workspaceScopes });

function stop(): void {
    void server.close().catch(error => {
        console.error("Server shutdown failed:", error);
        process.exitCode = 1;
    });
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

void server.ready.then(() => {
    console.log(`${name} listening on port ${server.port}.`);
}).catch(error => {
    console.error("Server startup failed:", error);
    process.exitCode = 1;
    stop();
});
