import { createApp, type Component } from 'vue';
import { HOST_KEY } from './composables/useHost';
import type { AppHost } from '../../host/AppHost';

/** A Vue editor panel definition: a tab button + a panel div + a root component. */
export interface VuePanelDef {
    /** Tab button label (matches the CSS .tab-btn styling). */
    label: string;
    /** Panel container id (mounted as `#tab-<id>` inside the tab shell). */
    id: string;
    component: Component;
}

/** Mount a Vue component into `el`, providing the AppHost. Returns an unmount fn. */
export function mountVuePanel(el: HTMLElement, component: Component, host: AppHost): () => void {
    const app = createApp(component);
    app.provide(HOST_KEY, host);
    app.mount(el);
    return () => app.unmount();
}
