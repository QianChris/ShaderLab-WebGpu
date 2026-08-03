import { Engine } from '../core/Engine';
import { EventBus } from '../core/events/EventBus';
import { UIManager } from './UIManager';
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
    private uiLayers: UILayer[] = [];
    private uiContainer: HTMLElement;
    private uiManager: UIManager;
    private editorLayer?: { dispatch(cmd: Command): boolean };

    constructor(canvas: HTMLCanvasElement, uiContainer: HTMLElement) {
        this.engine = new Engine(canvas);
        this.uiContainer = uiContainer;
        this.uiManager = new UIManager(uiContainer);
    }

    async init(): Promise<void> { await this.engine.init(); }
    async loadApp(name: string): Promise<void> { await this.engine.loadApp(name); }
    startLoop(): void { this.engine.startLoop(); }
    resize(): void { this.engine.resize(); }
    get engineConfig() { return this.engine.engineConfig; }

    // Read-only proxies (UI layer queries).
    get scene() { return this.engine.scene; }
    get renderGraph() { return this.engine.renderGraph; }
    /** Live delegate: Engine.eventBus is created in init(), so it must be read
     *  after init() — a field copied in the constructor would be undefined. */
    get eventBus(): EventBus { return this.engine.eventBus; }

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
        this.uiManager.unmountAll();
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

    /** Load the app's custom UI scripts (app.json `ui` field). Delegated to
     *  UIManager; the public signature is unchanged so main.ts / player.ts /
     *  EditorOrchestrator.switchApp keep calling host.loadAppUI(base). */
    async loadAppUI(appBase: string): Promise<void> {
        await this.uiManager.loadAppUI(appBase, this);
    }
}
