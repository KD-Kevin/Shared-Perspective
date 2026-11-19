import type { ActivityState } from "./protocol";

export const ACTIVITY_TIMEOUT_MS = 30_000;

export interface ClientActivity {
    state: ActivityState;
    updatedAt: number;
}

export function resolveActivity(activities: readonly ClientActivity[], now: number): ActivityState {
    let state: ActivityState = "idle";
    let latest = -Infinity;

    for (let i = 0; i < activities.length; i++) {
        const activity = activities[i];
        if (activity.state === "idle" || now - activity.updatedAt >= ACTIVITY_TIMEOUT_MS) continue;

        // Chat takes priority across apps. For IDE and engine activity, use the latest active report.
        if (activity.state === "chat") return "chat";
        if (activity.updatedAt <= latest) continue;

        state = activity.state;
        latest = activity.updatedAt;
    }

    return state;
}
