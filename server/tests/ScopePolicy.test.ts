import { describe, expect, it } from "vitest";
import { ScopePolicy } from "../src/ScopePolicy";

const engineToken = "e".repeat(32);
const gameStyleToken = "g".repeat(32);
const scopes = [
    { scopeId: 70001, token: engineToken, capabilities: ["engine.unity", "engine.godot"] },
    { scopeId: 70001, token: gameStyleToken, capabilities: ["gamestyle.multiplayer"] }
];

describe("workspace scope policy", () => {
    it("separates the Unity and Game Style grants for one workspace", () => {
        const policy = new ScopePolicy(scopes);
        const joined = [{ scopeId: 70001, token: engineToken }];
        expect(policy.authorize(joined, ["engine.unity", "gamestyle.multiplayer"])?.get(70001)).toEqual(new Set(["engine.unity"]));
        expect(policy.authorize(joined, ["engine.godot"])?.get(70001)).toEqual(new Set(["engine.godot"]));
        expect(policy.authorize(joined, ["gamestyle.multiplayer"])).toBeUndefined();
    });

    it("denies unknown, malformed, mismatched and duplicate grants", () => {
        const policy = new ScopePolicy(scopes);
        const grant = { scopeId: 70001, token: engineToken };
        expect(policy.authorize(undefined, ["engine.unity"])?.size).toBe(0);
        for (const request of [null, [null], [{ ...grant, scopeId: 0 }], [{ ...grant, scopeId: 70002 }],
            [{ ...grant, token: "z".repeat(32) }], [grant, grant], Array.from({ length: 33 }, () => grant)]) {
            expect(policy.authorize(request, ["engine.unity"])).toBeUndefined();
        }
    });

    it("rejects invalid host policies and prevents a credential from granting two scopes", () => {
        expect(() => new ScopePolicy({})).toThrow();
        expect(() => new ScopePolicy([{ scopeId: 1, token: engineToken, capabilities: ["chat"] }])).toThrow();
        expect(() => new ScopePolicy([{ scopeId: -1, token: engineToken, capabilities: ["code"] }])).toThrow();
        expect(() => new ScopePolicy([...scopes, { scopeId: 70002, token: engineToken, capabilities: ["code"] }])).toThrow();
    });
});
