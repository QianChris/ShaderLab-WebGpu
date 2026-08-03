import { onMounted, onUnmounted } from 'vue';
import { useHost } from './useHost';

/**
 * Subscribe to an engine eventBus event for the lifetime of the component.
 * The event bus is cleared on app switch, so components that need to survive
 * an app reload should re-subscribe via the host's 'editor:changed' wiring
 * (EditorUILayer re-attaches panels); this hook covers the simple case where
 * the subscription is created when the panel is first mounted.
 */
export function useEditorEvent(type: string, handler: (payload: unknown) => void): void {
    const host = useHost();
    let unsub: (() => void) | undefined;
    onMounted(() => { unsub = host.eventBus.on(type, handler); });
    onUnmounted(() => unsub?.());
}
