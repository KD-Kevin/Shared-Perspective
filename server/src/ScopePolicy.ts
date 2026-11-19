import { createHash, timingSafeEqual } from "node:crypto";
import { isScopeId, SCOPED_CAPABILITIES } from "./protocol";
import type { Capability, ScopedCapability } from "./protocol";

export interface WorkspaceScope {
    scopeId: number;
    token: string;
    capabilities: readonly ScopedCapability[];
}

export type ScopeAccess = ReadonlyMap<number, ReadonlySet<ScopedCapability>>;

const TOKEN = /^[a-zA-Z0-9_-]{32,128}$/;
const MAX_SCOPES_PER_CLIENT = 32;

function isToken(value: unknown): value is string {
    return typeof value === "string" && TOKEN.test(value);
}

function tokenDigest(token: string): Buffer {
    return createHash("sha256").update(token).digest();
}

export class ScopePolicy {
    private readonly definitions = new Map<number, { digest: Buffer; capabilities: ReadonlySet<ScopedCapability> }[]>();

    constructor(scopes: unknown = []) {
        if (!Array.isArray(scopes)) throw new Error("Workspace scopes must be an array.");
        const tokens = new Set<string>();

        for (let index = 0; index < scopes.length; index++) {
            const definition = scopes[index] as Partial<WorkspaceScope> | null;
            if (!definition || !isScopeId(definition.scopeId) || !isToken(definition.token) ||
                !Array.isArray(definition.capabilities) || !definition.capabilities.length ||
                !definition.capabilities.every(value => SCOPED_CAPABILITIES.includes(value)) ||
                tokens.has(definition.token)) {
                throw new Error("Invalid workspace scope definition at index " + index + ".");
            }
            tokens.add(definition.token);
            const entry = { digest: tokenDigest(definition.token), capabilities: new Set(definition.capabilities) };
            const existing = this.definitions.get(definition.scopeId);
            if (existing) existing.push(entry);
            else this.definitions.set(definition.scopeId, [entry]);
        }
    }

    authorize(requested: unknown, capabilities: readonly Capability[]): ScopeAccess | undefined {
        const access = new Map<number, ReadonlySet<ScopedCapability>>();
        if (requested === undefined) return access;
        if (!Array.isArray(requested) || requested.length > MAX_SCOPES_PER_CLIENT) return undefined;

        // A capability describes what the adapter understands. Only a host-issued grant authorizes project traffic.
        for (let index = 0; index < requested.length; index++) {
            const request = requested[index] as Partial<WorkspaceScope> | null;
            if (!request || !isScopeId(request.scopeId) || !isToken(request.token) || access.has(request.scopeId)) return undefined;

            const digest = tokenDigest(request.token);
            const grant = this.definitions.get(request.scopeId)?.find(entry => timingSafeEqual(entry.digest, digest));
            if (!grant) return undefined;

            const allowed = new Set<ScopedCapability>();
            for (const capability of grant.capabilities) {
                if (capabilities.includes(capability)) allowed.add(capability);
            }
            if (!allowed.size) return undefined;
            access.set(request.scopeId, allowed);
        }
        return access;
    }
}
