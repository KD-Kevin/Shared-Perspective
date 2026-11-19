export type MessageRoute = "server" | "sender" | "others" | "all" | "target";
export const SCOPED_CAPABILITIES = ["code", "engine.unity", "engine.unreal", "engine.godot", "gamestyle.multiplayer"] as const;
export type ScopedCapability = typeof SCOPED_CAPABILITIES[number];
export type Capability = "chat" | "activity" | ScopedCapability;
export const SCOPE_PROTOCOL_VERSION = 1;
export type ActivityState = "idle" | "ide" | "engine" | "chat";
export type ParticipantKind = "human" | "agent";

export interface NetworkMessage {
    type: string;
    route: MessageRoute;
    targetClientId?: number;
    scopeId?: number;
    sourceClientId?: number;
    sourceUserId?: number;
    requestId?: number;
    data?: unknown;
}

export interface ServerInfo {
    sessionId: string;
    name: string;
    passwordRequired: boolean;
    clientCount: number;
    scopeProtocolVersion?: number;
}

export interface ScopeGrant {
    scopeId: number;
    token: string;
}

export interface JoinRequest {
    displayName?: string;
    username?: string;
    ownerApp?: string;
    participantKind?: ParticipantKind;
    color?: string;
    password?: string;
    capabilities?: Capability[];
    identityKey?: string;
    scopeGrants?: readonly ScopeGrant[];
    userData?: StringDataEntries;
}

export interface JoinResult {
    accepted: boolean;
    clientId?: number;
    userId?: number;
    scopeIds?: number[];
    sessionData?: StringDataEntries;
    reason?: string;
}

export type StringDataEntries = [string, string][];

export interface StringDataChange {
    key: string;
    value: string | null;
}

export interface UserDataChange extends StringDataChange {
    userId: number;
}

export interface UserDataSnapshot {
    userId: number;
    entries: StringDataEntries;
}

export interface UserClient {
    clientId: number;
    ownerApp: string;
    capabilities: readonly Capability[];
}

export interface ClientPresence extends Omit<UserClient, "ownerApp"> {
    userId: number;
    displayName: string;
    username?: string;
    ownerApp?: string;
    color?: string;
    participantKind?: ParticipantKind;
    activity?: ActivityState;
}

export interface UserProfileUpdate {
    username?: string;
    color?: string | null;
}

export interface UserProfileState {
    userId: number;
    username: string;
    color?: string;
}

export function isUsername(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 64;
}

export function isUserColor(value: unknown): value is string {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function isOwnerApp(value: unknown): value is string {
    return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function isScopeId(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xFFFFFFFF;
}

// v2 uses a 32-bit scope ID so the JSON and binary routes address the same workspace.
export const BINARY_VERSION = 2;
export const BINARY_HEADER_SIZE = 14;

export enum BinaryRoute {
    Others = 1,
    All = 2,
    Target = 3
}
