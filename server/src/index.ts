import { readFileSync } from "node:fs";
import { SharedServer } from "./SharedServer";

const standalone = process.argv.includes("--standalone");
const mode = standalone ? "standalone" : "hosted";
const port = Number(process.env.PORT?.trim() || (standalone ? 8090 : 8080));
const name = process.env.SERVER_NAME?.trim() || (standalone ? "Shared Perspective Standalone" : "Shared Perspective Session");
const password = process.env.SERVER_PASSWORD ?? "";

if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid server port.");

const scopesFile = process.env.SHARED_PERSPECTIVE_SCOPES_FILE;
const workspaceScopes: unknown = scopesFile ? JSON.parse(readFileSync(scopesFile, "utf8")) : undefined;
const server = new SharedServer({ port, name, password, workspaceScopes, mode });

function stop(): void {
    void server.close().catch(error => {
        console.error("Server shutdown failed:", error);
        process.exitCode = 1;
    });
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

void server.ready.then(() => {
    console.log(`${name} listening on port ${server.port} (${mode}).`);
}).catch(error => {
    console.error("Server startup failed:", error);
    process.exitCode = 1;
    stop();
});
