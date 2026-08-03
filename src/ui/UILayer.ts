import type { AppHost } from '../host/AppHost';

/** A mountable UI layer. Layers are the only place UI code lives; they receive
 *  the AppHost (and through it the engine) on mount and must tear everything
 *  down in unmount(). State changes go through host.dispatch(), notifications
 *  through host.eventBus.emit(). */
export interface UILayer {
    id: string;
    mount(container: HTMLElement, host: AppHost): void | Promise<void>;
    unmount(): void;
}
