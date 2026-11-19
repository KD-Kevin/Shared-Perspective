import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { LocalSessionCoordinator, type LocalSessionEvent, type LocalSessionState } from "../src/LocalSessionCoordinator";
import type { SavedServer } from "../src/LocalUserProfile";
import type { SharedClientEvents, SharedClientOptions } from "../src/SharedClient";
import type { User } from "../src/User";

class Remote extends EventEmitter<SharedClientEvents> {
    server: SavedServer | undefined;
    readonly users = new Map<number, User>();
    readonly send = vi.fn(() => true);
    readonly sendBinary = vi.fn(() => true);
    readonly setUserData = vi.fn(async () => true);
    readonly disconnectNow = vi.fn();

    constructor(readonly options: SharedClientOptions) { super(); }

    accept(id = "session-a"): void {
        this.server = { url: this.options.url, sessionId: id, name: "Team" };
        this.emit("joined", { accepted: true, clientId: 1, userId: 1 });
    }

    disconnect(): void { this.emit("disconnected"); }
}

function setup() {
    const remotes: Remote[] = [];
    const coordinator = new LocalSessionCoordinator(options => {
        const remote = new Remote(options);
        remotes.push(remote);
        return remote;
    }, [20, 40]);
    const app = () => {
        const events: LocalSessionEvent[] = [];
        let state: LocalSessionState;
        const handle = coordinator.attach(event => {
            events.push(event);
            if (event.type === "state") state = event.state;
        });
        return { ...handle, events, get state() { return state; } };
    };
    return { remotes, app };
}

afterEach(() => vi.useRealTimers());

it("reserves one session, joins other apps without an address, and does not pass workspace grants to them", () => {
    const { remotes, app } = setup();
    const code = app();
    const unity = app();
    code.join({ ownerApp: "vscode", url: "ws://server-a:8080", password: "private", scopeGrants: [{ scopeId: 5, token: "scope-token" }] });
    expect(unity.state.phase).toBe("joining");
    expect(() => unity.join({ ownerApp: "unity", url: "ws://server-b:8080" })).toThrow(/opening/);
    remotes[0].accept();
    expect(() => unity.join({ ownerApp: "unity", url: "ws://server-b:8080" })).toThrow(/current session/);
    unity.join({ ownerApp: "unity" });
    expect(remotes[1].options).toMatchObject({ url: "ws://server-a:8080", sessionId: "session-a", password: "private" });
    expect(remotes[1].options.scopeGrants).toBeUndefined();
    expect(JSON.stringify(unity.events)).not.toContain("private");
    remotes[1].accept();

    code.close();
    expect(remotes[0].disconnectNow).toHaveBeenCalledOnce();
    expect(remotes[1].disconnectNow).not.toHaveBeenCalled();
    remotes[0].disconnect();
    expect(unity.state.app).toBe("joined");

    unity.close();
    expect(remotes[1].disconnectNow).toHaveBeenCalledOnce();
    remotes[1].disconnect();
    expect(app().state.phase).toBe("idle");
});

it("holds the last connection while another app remains open and closes it after handoff", () => {
    const { remotes, app } = setup();
    const code = app();
    const unity = app();
    code.join({ ownerApp: "vscode", url: "ws://server-a:8080" });
    remotes[0].accept();
    code.close();
    expect(remotes[0].disconnectNow).not.toHaveBeenCalled();
    expect(unity.state).toMatchObject({ phase: "active", app: "idle" });

    unity.join({ ownerApp: "unity" });
    expect(remotes[0].disconnectNow).not.toHaveBeenCalled();
    remotes[1].accept();
    expect(remotes[0].disconnectNow).toHaveBeenCalledOnce();
    expect(unity.state.app).toBe("joined");
});

it("allows an unjoined app to leave all and prevents late messages from reviving a session", () => {
    const { remotes, app } = setup();
    const code = app();
    const unity = app();
    const rider = app();
    code.join({ ownerApp: "vscode", url: "ws://server-a:8080" });
    remotes[0].accept();
    unity.join({ ownerApp: "unity" });
    rider.leave();

    expect(rider.state.phase).toBe("leaving");
    expect(() => rider.join({ ownerApp: "rider", url: "ws://server-b:8080" })).toThrow(/wait/);
    remotes[1].accept();
    expect(unity.events.some(event => event.type === "joined")).toBe(false);
    expect(remotes[0].disconnectNow).toHaveBeenCalledOnce();
    expect(remotes[1].disconnectNow).toHaveBeenCalledOnce();
    remotes[0].disconnect();
    expect(rider.state.phase).toBe("leaving");
    remotes[1].disconnect();
    expect(rider.state.phase).toBe("idle");
    rider.join({ ownerApp: "rider", url: "ws://server-b:8080" });
    expect(remotes[2].options.url).toBe("ws://server-b:8080");
});

it("reconnects only to the pinned session and cancels retry on manual leave", async () => {
    vi.useFakeTimers();
    const { remotes, app } = setup();
    const code = app();
    const rider = app();
    code.join({ ownerApp: "vscode", url: "ws://server-a:8080" });
    remotes[0].accept();
    remotes[0].disconnect();
    expect(code.state).toMatchObject({ phase: "active", app: "reconnecting" });
    await vi.advanceTimersByTimeAsync(20);
    expect(remotes[1].options.sessionId).toBe("session-a");
    remotes[1].disconnect();
    rider.leave();
    expect(rider.state.phase).toBe("idle");
    await vi.advanceTimersByTimeAsync(100);
    expect(remotes).toHaveLength(2);
});

it("releases a failed first join and stops retries on a permanent join error", async () => {
    vi.useFakeTimers();
    const { remotes, app } = setup();
    const code = app();
    code.join({ ownerApp: "vscode", url: "ws://server-a:8080" });
    remotes[0].disconnect();
    expect(code.state.phase).toBe("idle");
    code.join({ ownerApp: "vscode", url: "ws://server-b:8080" });
    remotes[1].accept();
    remotes[1].disconnect();
    await vi.advanceTimersByTimeAsync(20);
    const error = new Error("The selected session changed.");
    error.name = "SessionJoinError";
    remotes[2].emit("connectionError", error);
    remotes[2].disconnect();
    await vi.advanceTimersByTimeAsync(100);
    expect(remotes).toHaveLength(3);
    expect(code.state.phase).toBe("idle");
});

it("auto-leaves if the last registered app never joined and closes while holding the session", () => {
    const { remotes, app } = setup();
    const code = app();
    const rider = app();
    code.join({ ownerApp: "vscode", url: "ws://server-a:8080" });
    remotes[0].accept();
    code.close();
    expect(rider.state.phase).toBe("active");
    rider.close();
    expect(remotes[0].disconnectNow).toHaveBeenCalledOnce();
    remotes[0].disconnect();
    expect(app().state.phase).toBe("idle");
});
