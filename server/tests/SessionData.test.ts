import { expect, it } from "vitest";
import { SessionDataStore } from "../src/SessionData";

it("creates keys on first write, overwrites, and removes only the requested entry", () => {
    const store = new SessionDataStore();
    expect(store.view.get("mode")).toBeUndefined();
    expect(store.set("mode", "draft")).toBe(true);
    expect(store.set("mode", "")).toBe(true);
    expect(store.set("__proto__", "literal")).toBe(true);
    expect(store.snapshot()).toEqual([["mode", ""], ["__proto__", "literal"]]);
    expect(store.set("mode", null)).toBe(true);
    expect(store.snapshot()).toEqual([["__proto__", "literal"]]);
});

it("bounds escaped snapshot size and preserves the old state on failed changes", () => {
    const store = new SessionDataStore();
    const escaped = "\u0000".repeat(4096);
    expect(store.set("first", escaped)).toBe(true);
    expect(store.set("second", escaped)).toBe(false);
    expect(store.set("first", "Ã©".repeat(2049))).toBe(false);
    expect(store.load([["a", "first"], ["a", "second"]])).toBe(false);
    expect(store.load([[42, "invalid"]])).toBe(false);
    expect(store.view.get("first")).toBe(escaped);
    expect(store.set("first", null)).toBe(true);
    expect(store.set("second", escaped)).toBe(true);
    store.clear();
    expect(store.snapshot()).toEqual([]);
});
