import { Engine } from '../core/Engine';
import { EventBus } from '../core/events/EventBus';
import type { Command, CommandContext } from '../editor/commands/Command';
import type { UILayer } from '../ui/UILayer';

/**
 * Unified host layer: owns the Engine and the UI layers mounted above it.
 *
 * The dependency direction is strictly downward — UI Layer → AppHost → Engine
 * Core. AppHost is the ONLY bridge between them:
 *   - state changes flow down via `dispatch(new Command())` (command channel)
 *   - notifications flow up via `eventBus.emit(...)` (event channel)
 *   - UI layers get read-only engine access through the engine's accessors
 *
 * In editor mode a mounted editor layer (id === 'editor') intercepts dispatch
 * to run the command bus (edit-mode gating + undo/redo). Without one (player
 * mode) commands execute directly against the engine, unstacked.
 */
export class AppHost {
    public engine: Engine;
    public eventBus: EventBus;
    private uiLayers: UILayer[] = [];
    private uiContainer: HTMLElement;
    private editorLayer?: { dispatch(cmd: Command): boolean };

    constructor(canvas: HTMLCanvasElement, uiContainer: HTMLElement) {
        this.engine = new Engine(canvas);
        this.eventBus = this.engine.eventBus;
        this.uiContainer = uiContainer;
    }

    async init(): Promise<void> { await this.engine.init(); }
    async loadApp(name: string): Promise<void> { await this.engine.loadApp(name); }
    startLoop(): void { this.engine.startLoop(); }
    resize(): void { this.engine.resize(); }
    get engineConfig() { return this.engine.engineConfig; }

    // Read-only proxies (UI layer queries).
    get scene() { return this.engine.scene; }
    get renderGraph() { return this.engine.renderGraph; }

    mountLayer(layer: UILayer, container?: HTMLElement): void {
        layer.mount(container ?? this.uiContainer, this);
        this.uiLayers.push(layer);
        if (layer.id === 'editor') {
            this.editorLayer = layer as unknown as { dispatch(cmd: Command): boolean };
        }
    }

    unmountAll(): void {
        for (const layer of this.uiLayers) layer.unmount();
        this.uiLayers = [];
        this.editorLayer = undefined;
    }

    dispatch(cmd: Command): boolean {
        if (this.editorLayer) {
            return this.editorLayer.dispatch(cmd);
        }
        // Runtime has no editor: execute directly, no undo stack.
        const ctx: CommandContext = { engine: this.engine };
        return cmd.execute(ctx);
    }

    async loadAppUI(appBase: string): Promise<void> {
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
            const unmount = mod.mount(container, this);
            this.appUILayers.push({ id: cfg.id, unmount });
        }
    }

    private appUILayers: Array<{ id: string; unmount: () => void }> = [];

    private createContainer(id: string): HTMLElement {
        const el = document.createElement('div');
        el.id = `ui-${id}`;
        this.uiContainer.appendChild(el);
        return el;
    }

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
