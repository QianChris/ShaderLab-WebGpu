export type EventHandler = (payload: unknown) => void;

export class EventBus {
    private handlers = new Map<string, Set<EventHandler>>();

    on(type: string, handler: EventHandler): () => void {
        let set = this.handlers.get(type);
        if (!set) { set = new Set(); this.handlers.set(type, set); }
        set.add(handler);
        return () => set!.delete(handler);
    }

    emit(type: string, payload?: unknown): void {
        const set = this.handlers.get(type);
        if (!set) return;
        for (const h of set) h(payload);
    }

    /** Remove all handlers (call when the scene is reset so stale script handlers don't linger). */
    clear(): void {
        this.handlers.clear();
    }
}
