import type { AppHost } from './AppHost';

/**
 * Owns the app-specific UI layers (dynamic UI scripts loaded from an app's
 * `app.json` `ui` field). Each entry is a Blob-imported module exporting a
 * `mount(container, host) => unmount` function. Extracted from AppHost so the
 * host stays focused on engine + layer mounting; app UI loading is its own
 * concern.
 *
 * The host is passed into loadAppUI (not the constructor) so the UIManager can
 * be constructed before the host is fully initialized, and so there is no
 * circular `this` capture at construction time.
 */
export class UIManager {
    private appUILayers: Array<{ id: string; unmount: () => void }> = [];

    constructor(private readonly uiContainer: HTMLElement) {}

    /** Load the app's custom UI (ui-config.json) referenced by app.json's `ui`
     *  field. Unmounts any previously loaded app UI first. Each config entry
     *  points to a script whose default export is
     *  `mount(container, host) => unmount`. */
    async loadAppUI(appBase: string, host: AppHost): Promise<void> {
        for (const layer of this.appUILayers) layer.unmount();
        this.appUILayers = [];

        const manifestResp = await fetch(`${appBase}/app.json`);
        if (!manifestResp.ok) return;
        const manifest = await manifestResp.json() as { ui?: string };
        if (!manifest.ui) return;

        const configs = await fetch(`${appBase}/${manifest.ui}`).then(r => r.json()) as AppUIConfig[];
        for (const cfg of configs) {
            const container = (cfg.container ? document.querySelector<HTMLElement>(cfg.container) : null)
                ?? this.createContainer(cfg.id);
            const mod = await this.loadUIScript(`${appBase}/${cfg.source}`);
            const unmount = mod.mount(container, host);
            this.appUILayers.push({ id: cfg.id, unmount });
        }
    }

    /** Unmount every app UI layer (e.g. on host teardown). */
    unmountAll(): void {
        for (const layer of this.appUILayers) layer.unmount();
        this.appUILayers = [];
    }

    private createContainer(id: string): HTMLElement {
        const el = document.createElement('div');
        el.id = `ui-${id}`;
        this.uiContainer.appendChild(el);
        return el;
    }

    /** Fetch a UI script source, wrap it in a Blob URL (so bare-import / TS
     *  syntax that Vite would normally transform is instead served raw), and
     *  dynamically import it. The Blob URL is revoked after import so the
     *  module is pinned in memory but the URL doesn't leak. */
    private async loadUIScript(url: string): Promise<{ mount: (container: HTMLElement, host: AppHost) => () => void }> {
        const resp = await fetch(`${url}?t=${Date.now()}`);
        if (!resp.ok) throw new Error(`UI script not found: ${url}`);
        const src = await resp.text();
        const blob = new Blob([src], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const mod = await import(/* @vite-ignore */ blobUrl);
            return mod.default ?? mod;
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }
}

interface AppUIConfig {
    id: string;
    source: string;
    container?: string;
}
