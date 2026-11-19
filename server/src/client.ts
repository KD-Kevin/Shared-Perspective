import readline from "node:readline";
import { isIP } from "node:net";
import { discoverLocalSessions } from "./LocalDiscovery";
import { LocalUserProfile, type SavedServer } from "./LocalUserProfile";
import type { LocalJoinOptions, LocalRosterUser, LocalSessionState } from "./LocalSessionCoordinator";
import { LocalSessionConnection } from "./LocalSessionIpc";
import { openLocalSession } from "./startLocalSession";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--discover")) {
        console.log(JSON.stringify(await discoverLocalSessions(), null, 2));
        return;
    }
    if (args.includes("--leave")) {
        const local = await LocalSessionConnection.open();
        try {
            await local.leave();
        } finally {
            local.close();
        }
        return;
    }

    const profile = new LocalUserProfile();
    const selection = args.indexOf("--session");
    const urlOption = args.indexOf("--url");
    let target: Pick<SavedServer, "url" | "sessionId"> | { url: string } | undefined;
    if (selection !== -1) {
        const session = (await discoverLocalSessions()).find(candidate => candidate.sessionId === args[selection + 1]);
        if (!session) throw new Error("The selected local session is unavailable.");
        target = session;
    } else if (urlOption !== -1) {
        if (!args[urlOption + 1]) throw new Error("Provide a WebSocket URL after --url.");
        target = { url: args[urlOption + 1] };
    } else if (process.env.HOST !== undefined || process.env.PORT !== undefined) {
        const host = process.env.HOST ?? "localhost";
        const port = Number(process.env.PORT ?? 8080);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid server port.");
        target = { url: `ws://${isIP(host) === 6 ? "[" + host + "]" : host}:${port}` };
    }
    const appOptions: LocalJoinOptions = {
        ownerApp: "terminal", username: process.env.CLIENT_NAME,
        password: process.env.SERVER_PASSWORD, capabilities: ["chat", "activity"]
    };

    const client = await openLocalSession();
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    let users: LocalRosterUser[] = [];
    let priorStatus = "";
    const showState = (state: LocalSessionState): void => {
        const status = state.phase + ":" + state.app + ":" + (state.server?.sessionId ?? "");
        if (priorStatus === status) return;
        priorStatus = status;
        if (state.phase === "idle") {
            users = [];
            console.log("Join via: join <ws://IP:port>, join favorite <number>, or join visited <number>.");
        } else if (state.phase === "active" && state.app === "idle") {
            console.log(`Current session: ${state.server?.name}. Type join to connect this app, or leave to disconnect all local apps.`);
        } else if (state.app === "reconnecting") {
            console.log("Reconnecting to the current session.");
        } else if (state.phase === "leaving") {
            console.log("Leaving the local session.");
        }
    };
    client.on("event", event => {
        switch (event.type) {
            case "state": showState(event.state); break;
            case "joined":
                console.log(`Joined as User ${event.result.userId}, Client ${event.result.clientId}.`);
                console.log("Commands: all, others, target, ping, users, leave, session-data, user-data, set-session-data, set-user-data, profile, username, color, favorite-color, pref, visited, favorites, favorite, unfavorite, exit");
                break;
            case "roster": users = event.users; break;
            case "problem": console.error(event.reason); break;
            case "message":
                if (event.message.type === "chat.message") {
                    const sender = users.find(user => user.userId === event.message.sourceUserId);
                    console.log(sender?.username ?? `Client ${event.message.sourceClientId}`, event.message.data);
                } else if (event.message.type === "session.error") {
                    console.error(event.message.data);
                } else if (event.message.type === "session.pong") {
                    console.log("Pong");
                }
                break;
        }
    });
    client.on("closed", error => {
        if (error) console.error(error.message);
        input.close();
    });
    input.on("close", () => client.close());

    input.on("line", line => {
        void runCommand(line).catch(error => console.error(error instanceof Error ? error.message : error));
    });

    showState(client.state);
    if (target) await client.join({ ...appOptions, ...target }).catch(error => console.error(error.message));

    async function runCommand(line: string): Promise<void> {
        const trimmed = line.trim();
        const separator = trimmed.search(/\s/);
        const command = separator === -1 ? trimmed : trimmed.slice(0, separator);
        const text = separator === -1 ? "" : trimmed.slice(separator).trimStart();
        const args = text ? text.split(/\s+/) : [];

        switch (command) {
            case "exit": input.close(); return;
            case "leave": await client.leave(); return;
            case "join": {
                let url = text || undefined;
                if (args[0] === "favorite" || args[0] === "visited") {
                    if (client.state.phase !== "idle") throw new Error("Leave the current session before selecting another server.");
                    const list = args[0] === "favorite" ? await profile.getFavoriteServers() : await profile.getVisitedServers();
                    const server = list[Number(args[1]) - 1];
                    if (!server) throw new Error("Select a server number from favorites or visited.");
                    url = server.url;
                }
                await client.join({ ...appOptions, url });
                return;
            }
            case "users":
                console.table(users.map(user => ({
                    userId: user.userId, username: user.username, kind: user.participantKind,
                    activity: user.activity, color: user.color,
                    apps: user.clients.map(app => app.ownerApp + ":" + app.clientId).join(", ")
                })));
                return;
            case "session-data": console.log(text ? client.sessionData.get(text) : client.sessionData); return;
            case "user-data": console.log(client.getUserData(Number(text))); return;
            case "set-session-data":
            case "set-user-data": {
                const key = args[0];
                if (!key) throw new Error("Provide a key followed by the string value.");
                const value = text.slice(key.length).trimStart();
                if (command === "set-session-data") await client.setSessionData(key, value);
                else await client.setUserData(key, value);
                return;
            }
            case "profile": console.log(await profile.read()); return;
            case "username":
            case "color":
            case "favorite-color": {
                const color = text === "clear" ? null : text;
                if (command === "favorite-color") {
                    await profile.update({ favoriteColor: color });
                    return;
                }
                const data = command === "username" ? { username: text } : { color };
                await profile.update(data);
                if (client.state.app === "joined") await client.send({ type: "user.profile.update", route: "server", data });
                return;
            }
            case "pref": {
                const key = args.shift();
                if (!key) throw new Error("Usage: pref <key> [JSON value]");
                if (args.length) await profile.setPreference(key, JSON.parse(text.slice(key.length).trimStart()));
                else console.log(await profile.getPreference(key));
                return;
            }
            case "visited":
            case "favorites": {
                const list = command === "visited" ? await profile.getVisitedServers() : await profile.getFavoriteServers();
                console.table(list.map((server, index) => ({ number: index + 1, ...server })));
                return;
            }
            case "favorite":
            case "unfavorite":
                if (client.state.server) await profile.setFavoriteServer(client.state.server, command === "favorite");
                return;
            case "ping":
                await client.send({ type: "session.ping", route: "server", requestId: 1 });
                return;
            case "target": {
                const targetClientId = Number(args.shift());
                if (!Number.isInteger(targetClientId) || targetClientId <= 0 || !args.length) throw new Error("Usage: target <clientId> <message>");
                await client.send({ type: "chat.message", route: "target", targetClientId, data: { text: args.join(" ") } });
                return;
            }
            case "all":
            case "others":
                await client.send({ type: "chat.message", route: command, data: { text } });
                return;
            default:
                console.log("Unknown command.");
        }
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
