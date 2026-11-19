import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { NetworkMessage, ServerInfo } from "./protocol";

const VERSION = 1;
const PROBE_TIMEOUT_MS = 1_000;
const HEARTBEAT_MS = 10_000;
const LEASE_MS = 30_000;
const UUID_PATTERN = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
const SESSION_ID = new RegExp(`^${UUID_PATTERN}$`);
const HOST_FILE = new RegExp(`^(${UUID_PATTERN})[.]json$`);
const JOINED_FILE = new RegExp(`^joined-(${UUID_PATTERN})[.]json$`);

export interface LocalSession extends ServerInfo {
    port: number;
    url: string;
}

interface Candidate {
    sessionId: string;
    url: string;
    port: number;
    hosted: boolean;
}

export function localSessionDirectory(): string {
    const dataDirectory = process.platform === "win32"
        ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
        : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

    return process.env.SHARED_PERSPECTIVE_DISCOVERY_DIR || join(dataDirectory, "Shared Perspective", "sessions");
}

async function publishRecord(directory: string, name: string, data: object): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, name);
    const temporary = path + "." + randomUUID() + ".tmp";

    try {
        await writeFile(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
            try {
                await rename(temporary, path);
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                // Windows may temporarily block replacement while another adapter reads this record.
                if (process.platform !== "win32" || attempt === 4 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
                await delay(10 * (attempt + 1));
            }
        }
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }

    return path;
}

export function publishLocalSession(directory: string, sessionId: string, port: number): Promise<string> {
    return publishRecord(directory, sessionId + ".json", { version: VERSION, sessionId, port });
}

export function parseEndpoint(value: unknown): { url: string; port: number } | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const endpoint = new URL(value);
        if ((endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") || endpoint.username || endpoint.password ||
            endpoint.search || endpoint.hash || endpoint.port === "0") return undefined;

        return {
            url: endpoint.pathname === "/" ? endpoint.origin : endpoint.href,
            port: Number(endpoint.port || (endpoint.protocol === "wss:" ? 443 : 80))
        };
    } catch {
        return undefined;
    }
}

// Call after an accepted join. Each socket owns its record and refreshes it only after a pong.
export async function registerJoinedSession(socket: WebSocket, sessionId: string, directory: string, onError: (error: unknown) => void): Promise<void> {
    const endpoint = parseEndpoint(socket.url);
    if (!SESSION_ID.test(sessionId) || !endpoint) throw new Error("Invalid session ID or discovery endpoint.");
    if (socket.readyState !== WebSocket.OPEN) return;

    const connectionId = randomUUID();
    const name = "joined-" + connectionId + ".json";
    const write = () => publishRecord(directory, name, {
        version: VERSION, connectionId, sessionId, url: endpoint.url, expiresAt: Date.now() + LEASE_MS
    });

    let pending: Promise<string> | undefined;
    const renew = (): void => {
        if (pending || socket.readyState !== WebSocket.OPEN) return;
        pending = write();
        void pending.catch(onError).finally(() => { pending = undefined; });
    };

    const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();

    socket.on("pong", renew);
    socket.once("close", () => {
        clearInterval(heartbeat);
        socket.off("pong", renew);
        void Promise.resolve(pending).catch(() => undefined)
            .then(() => rm(join(directory, name), { force: true }))
            .catch(onError);
    });

    pending = write();
    try {
        await pending;
    } finally {
        pending = undefined;
    }
}

export async function discoverLocalSessions(directory = localSessionDirectory()): Promise<LocalSession[]> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }

    const records = await Promise.all(names.map(name => readCandidate(directory, name)));
    const candidates = records.filter(record => record !== undefined).sort((a, b) => Number(b.hosted) - Number(a.hosted));
    const endpoints = new Set<string>();
    const probes: Promise<LocalSession | undefined>[] = [];

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const key = candidate.sessionId + " " + candidate.url;
        if (endpoints.has(key)) continue;
        endpoints.add(key);
        probes.push(probeSession(candidate));
    }

    const sessions = new Map<string, LocalSession>();
    for (const session of await Promise.all(probes)) {
        if (session && !sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
    }

    return Array.from(sessions.values()).sort((a, b) => a.port - b.port);
}

async function readCandidate(directory: string, name: string): Promise<Candidate | undefined> {
    const host = HOST_FILE.exec(name);
    const joined = JOINED_FILE.exec(name);
    if (!host && !joined) return undefined;

    let record: { version?: unknown; sessionId?: unknown; port?: unknown; connectionId?: unknown; url?: unknown; expiresAt?: unknown } | null;
    try {
        record = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
        return undefined;
    }

    if (record?.version !== VERSION || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)) return undefined;
    if (host) {
        const port = record.port;
        if (record.sessionId !== host[1] || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
        return { sessionId: record.sessionId, port, url: "ws://127.0.0.1:" + port, hosted: true };
    }

    const now = Date.now();
    const expiresAt = record.expiresAt;
    if (record.connectionId !== joined?.[1] || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now || expiresAt > now + LEASE_MS) return undefined;

    const endpoint = parseEndpoint(record.url);
    return endpoint && { sessionId: record.sessionId, ...endpoint, hosted: false };
}

function probeSession({ sessionId, url, port }: Candidate): Promise<LocalSession | undefined> {
    return new Promise(resolve => {
        const socket = new WebSocket(url, { handshakeTimeout: PROBE_TIMEOUT_MS, maxPayload: 65_536, followRedirects: false });
        const finish = (info?: ServerInfo): void => {
            clearTimeout(timeout);
            resolve(info && { ...info, port, url });
            socket.terminate();
        };
        const timeout = setTimeout(finish, PROBE_TIMEOUT_MS);

        socket.on("error", () => finish());
        socket.once("close", () => {
            clearTimeout(timeout);
            resolve(undefined);
        });
        socket.once("message", (raw, isBinary) => {
            if (isBinary) return finish();

            let message: Partial<NetworkMessage> | null;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return finish();
            }

            const info = message?.data as Partial<ServerInfo> | undefined;
            if (message?.type !== "session.info" || message.route !== "sender" || info?.sessionId !== sessionId ||
                typeof info.name !== "string" || typeof info.passwordRequired !== "boolean" ||
                typeof info.clientCount !== "number" || !Number.isSafeInteger(info.clientCount) || info.clientCount < 0) return finish();

            finish({ sessionId, name: info.name, passwordRequired: info.passwordRequired, clientCount: info.clientCount });
        });
    });
}
