import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { dirname, join } from "node:path";
import { localSessionDirectory, parseEndpoint } from "./LocalDiscovery";
import { isUserColor, isUsername } from "./protocol";
import type { StringDataEntries } from "./protocol";
import { SessionDataStore } from "./SessionData";

const pendingPublicData = new Map<string, Promise<void>>();

export type PreferenceValue = string | number | boolean | null | PreferenceValue[] | { [key: string]: PreferenceValue };

export interface ProfileSettings {
    username?: string;
    color?: string;
    favoriteColor?: string;
}

export interface SavedServer {
    url: string;
    name: string;
    sessionId: string;
}

export interface VisitedServer extends SavedServer {
    visitedAt: number;
}

function serverRecord(value: SavedServer): SavedServer {
    const endpoint = parseEndpoint(value.url);
    if (!endpoint) throw new Error("Invalid server URL.");
    return { url: endpoint.url, name: value.name, sessionId: value.sessionId };
}

function fileMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readValue(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (fileMissing(error)) return undefined;
        throw error;
    }
}

async function writeValue(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
        await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function readIdentity(path: string): Promise<string | undefined> {
    for (let i = 0; i < 40; i++) {
        try {
            const secret = await readValue(path);
            if (secret === undefined) return undefined;
            if (typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret)) return secret;
            break;
        } catch (error) {
            // Another process can have opened the file exclusively and still be writing it.
            if (!(error instanceof SyntaxError)) throw error;
            await setTimeout(25);
        }
    }
    throw new Error("Invalid or incomplete local identity file.");
}

async function createIdentity(path: string, secret: string): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
        const file = await open(path, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(secret), "utf8");
        } catch (error) {
            await file.close();
            await rm(path, { force: true });
            throw error;
        }
        await file.close();
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    }
}

export class LocalUserProfile {
    constructor(private readonly directory = process.env.SHARED_PERSPECTIVE_PROFILE_DIR ?? join(dirname(localSessionDirectory()), "profile")) {}

    async identityKeyFor(sessionId: string): Promise<string> {
        const path = join(this.directory, "identity.json");
        let secret = await readIdentity(path);
        if (secret === undefined) {
            const candidate = randomBytes(32).toString("hex");
            secret = await createIdentity(path, candidate) ? candidate : await readIdentity(path);
        }
        if (secret === undefined) throw new Error("Local identity file disappeared.");
        return createHmac("sha256", Buffer.from(secret, "hex")).update(sessionId).digest("hex");
    }

    async read(): Promise<ProfileSettings> {
        const [username, color, favoriteColor] = await Promise.all([
            readValue(join(this.directory, "username.json")),
            readValue(join(this.directory, "color.json")),
            readValue(join(this.directory, "favoriteColor.json"))
        ]);
        return {
            username: isUsername(username) ? username : undefined,
            color: isUserColor(color) ? color : undefined,
            favoriteColor: isUserColor(favoriteColor) ? favoriteColor : undefined
        };
    }

    async update(changes: { [K in keyof ProfileSettings]?: string | null }): Promise<void> {
        const username = changes.username?.trim() ?? changes.username;
        const { color, favoriteColor } = changes;
        if (username != null && !isUsername(username)) throw new Error("Invalid username.");
        if ((color != null && !isUserColor(color)) || (favoriteColor != null && !isUserColor(favoriteColor))) {
            throw new Error("Colors must use #RRGGBB.");
        }

        const writes: Promise<void>[] = [];
        if (username !== undefined) writes.push(this.updateValue("username.json", username));
        if (color !== undefined) writes.push(this.updateValue("color.json", color));
        if (favoriteColor !== undefined) writes.push(this.updateValue("favoriteColor.json", favoriteColor));
        await Promise.all(writes);
    }

    async readPublicData(): Promise<StringDataEntries> {
        const entries = await readValue(join(this.directory, "public-user-data.json"));
        if (entries === undefined) return [];
        const store = new SessionDataStore();
        if (!store.load(entries)) throw new Error("Invalid saved public user data.");
        return store.snapshot();
    }

    setPublicData(key: string, value: string | null): Promise<void> {
        const path = join(this.directory, "public-user-data.json");
        // All Windows adapters use the same coordinator. Queue read/modify/write operations for its shared profile.
        const previous = pendingPublicData.get(path) ?? Promise.resolve();
        const update = previous.catch(() => undefined).then(async () => {
            const store = new SessionDataStore();
            store.load(await this.readPublicData());
            if (!store.set(key, value)) throw new Error("Invalid user data key, value, or storage limit exceeded.");
            if (store.view.size) await writeValue(path, store.snapshot());
            else await rm(path, { force: true });
        });
        pendingPublicData.set(path, update);
        const clear = (): void => { if (pendingPublicData.get(path) === update) pendingPublicData.delete(path); };
        void update.then(clear, clear);
        return update;
    }

    async getPreference(key: string): Promise<PreferenceValue | undefined> {
        return await readValue(this.preferencePath(key)) as PreferenceValue | undefined;
    }

    async setPreference(key: string, value: PreferenceValue | undefined): Promise<void> {
        const path = this.preferencePath(key);
        if (value === undefined) await rm(path, { force: true });
        else await writeValue(path, value);
    }

    async recordVisit(server: SavedServer): Promise<void> {
        const record = serverRecord(server);
        await writeValue(this.serverPath("visited", record.url), { ...record, visitedAt: Date.now() });
    }

    async setFavoriteServer(server: SavedServer, favorite: boolean): Promise<void> {
        const record = serverRecord(server);
        const path = this.serverPath("favorites", record.url);
        if (favorite) await writeValue(path, record);
        else await rm(path, { force: true });
    }

    async getVisitedServers(): Promise<VisitedServer[]> {
        const records = await this.readServers<VisitedServer>("visited");
        return records.filter(record => Number.isSafeInteger(record.visitedAt)).sort((a, b) => b.visitedAt - a.visitedAt);
    }

    async getFavoriteServers(): Promise<SavedServer[]> {
        return await this.readServers<SavedServer>("favorites");
    }

    private serverPath(category: "visited" | "favorites", url: string): string {
        const filename = createHash("sha256").update(url).digest("hex") + ".json";
        return join(this.directory, category, filename);
    }

    private async readServers<T extends SavedServer>(category: "visited" | "favorites"): Promise<T[]> {
        const directory = join(this.directory, category);
        let names: string[];
        try {
            names = await readdir(directory);
        } catch (error) {
            if (fileMissing(error)) return [];
            throw error;
        }
        const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}[.]json$/.test(name)).map(name => readValue(join(directory, name))));
        return records.filter((value): value is T => {
            const record = value as Partial<SavedServer> | undefined;
            return typeof record?.name === "string" && typeof record.sessionId === "string" && parseEndpoint(record.url) !== undefined;
        });
    }

    private async updateValue(name: string, value: string | null): Promise<void> {
        const path = join(this.directory, name);
        if (value === null) await rm(path, { force: true });
        else await writeValue(path, value);
    }

    private preferencePath(key: string): string {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key)) throw new Error("Invalid preference key.");
        return join(this.directory, "preferences", Buffer.from(key, "utf8").toString("hex") + ".json");
    }
}
