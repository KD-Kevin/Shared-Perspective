import type { ActivityState, ClientPresence, ParticipantKind, UserClient } from "./protocol";
import { SessionDataStore } from "./SessionData";

export class User {
    private readonly connections = new Map<number, UserClient>();
    readonly dataStore = new SessionDataStore();

    constructor(readonly userId: number, public username: string, readonly participantKind: ParticipantKind = "human", public color?: string, public activity: ActivityState = "idle") {}

    get data(): ReadonlyMap<string, string> { return this.dataStore.view; }

    get clients(): ReadonlyMap<number, UserClient> {
        return this.connections;
    }

    getClientsByApp(ownerApp: string): UserClient[] {
        return Array.from(this.connections.values()).filter(client => client.ownerApp === ownerApp);
    }

    addClient(client: UserClient): void {
        this.connections.set(client.clientId, client);
    }

    removeClient(clientId: number): void {
        this.connections.delete(clientId);
    }

    static fromPresence(member: ClientPresence): User {
        return new User(member.userId, member.username ?? member.displayName, member.participantKind, member.color, member.activity);
    }
}
