
import { describe, expect, it } from "vitest";
import { resolveActivity, ACTIVITY_TIMEOUT_MS } from "../src/ActivityResolver";

describe("ActivityResolver", () => {
    const now = 100000;

    it("returns idle when all clients are idle", () => {
        const activities = [
            { state: "idle" as const, updatedAt: now },
            { state: "idle" as const, updatedAt: now }
        ];

        expect(resolveActivity(activities, now)).toBe("idle");
    });

    it("reports engine activity even when the IDE is idle", () => {
        const activities = [
            { state: "idle" as const, updatedAt: now },
            { state: "engine" as const, updatedAt: now }
        ];

        expect(resolveActivity(activities, now)).toBe("engine");
    });

    it("uses the most recent active workspace", () => {
        const activities = [
            { state: "engine" as const, updatedAt: now - 1000 },
            { state: "ide" as const, updatedAt: now }
        ];

        expect(resolveActivity(activities, now)).toBe("ide");
    });

    it("prioritizes chatting over other activity", () => {
        const activities = [
            { state: "engine" as const, updatedAt: now },
            { state: "chat" as const, updatedAt: now - 1000 }
        ];

        expect(resolveActivity(activities, now)).toBe("chat");
    });

    it("ignores expired reports", () => {
        const activities = [
            { state: "ide" as const, updatedAt: now - ACTIVITY_TIMEOUT_MS }
        ];

        expect(resolveActivity(activities, now)).toBe("idle");
    });
});
