import type { StringDataChange, StringDataEntries } from "./protocol";

const MAX_ENTRIES = 64;
const MAX_KEY_BYTES = 128;
const MAX_VALUE_BYTES = 4096;
const MAX_SNAPSHOT_BYTES = 32 * 1024;

export function readDataChange(value: unknown): StringDataChange | undefined {
    const change = value as Partial<StringDataChange> | null | undefined;
    if (typeof change?.key !== "string" || !change.key.trim() || Buffer.byteLength(change.key) > MAX_KEY_BYTES ||
        (change.value !== null && (typeof change.value !== "string" || Buffer.byteLength(change.value) > MAX_VALUE_BYTES))) return undefined;
    return { key: change.key, value: change.value };
}

function entryBytes(key: string, value: string): number {
    return Buffer.byteLength(JSON.stringify([key, value])) + 1;
}

export class SessionDataStore {
    private readonly values = new Map<string, string>();
    private bytes = 1;

    get view(): ReadonlyMap<string, string> { return this.values; }

    snapshot(): StringDataEntries { return Array.from(this.values); }

    clear(): void {
        this.values.clear();
        this.bytes = 1;
    }

    load(entries: unknown): boolean {
        if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return false;
        const next = new SessionDataStore();
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== "string" || next.values.has(entry[0]) ||
                !next.set(entry[0], entry[1])) return false;
        }
        this.clear();
        for (const [key, value] of next.values) this.values.set(key, value);
        this.bytes = next.bytes;
        return true;
    }

    set(key: string, value: string | null): boolean {
        if (!readDataChange({ key, value })) return false;
        const previous = this.values.get(key);
        const previousBytes = previous === undefined ? 0 : entryBytes(key, previous);
        if (value === null) {
            this.values.delete(key);
            this.bytes -= previousBytes;
            return true;
        }

        // Bound the serialized snapshot as well as the individual strings so it fits in a join.
        const bytes = this.bytes - previousBytes + entryBytes(key, value);
        if (bytes > MAX_SNAPSHOT_BYTES || (previous === undefined && this.values.size >= MAX_ENTRIES)) return false;
        this.values.set(key, value);
        this.bytes = bytes;
        return true;
    }
}
