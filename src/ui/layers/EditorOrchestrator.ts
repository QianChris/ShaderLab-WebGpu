import type { AppHost } from '../../host/AppHost';
import type { Command } from '../../editor/commands/Command';
import { EditorCommandBus } from '../../editor/EditorCommandBus';
import { EditorInputManager } from '../../editor/input/EditorInputManager';
import { EditorPanel } from '../../editor/EditorPanel';
import { PipelinePanel } from '../../editor/PipelinePanel';
import { mountVuePanel, type VuePanelDef } from '../vue';
import type { EditorLayout, EditorLayoutHandles } from './EditorLayout';

/**
 * Behavioral half of the editor: owns the command bus, input manager, native
 * panels, Vue panel mounting, 3D-pick subscription and app switching. Mounts
 * panels into the DOM containers provided by EditorLayout. State changes flow
 * through the command bus (write channel); notifications come up via the event
 * bus (read channel). The orchestrator never touches the DOM framework
 * directly except to query containers handed to it by the layout.
 */
export class EditorOrchestrator {
    private commandBus?: EditorCommandBus;
    private inputManager?: EditorInputManager;
    private panels: { editor?: EditorPanel; pipeline?: PipelinePanel } = {};
    private vueUnmounts: (() => void)[] = [];
    private unsubscribePick?: () => void;
    private unsubscribeChanged?: () => void;
    private undoBtn?: HTMLButtonElement;
    private redoBtn?: HTMLButtonElement;

    constructor(
        private readonly host: AppHost,
        private readonly layout: EditorLayout,
        private readonly handles: EditorLayoutHandles,
        private readonly vuePanels: VuePanelDef[],
        private readonly assetPanel: VuePanelDef,
    ) {}

    /** Wire the whole editor experience. Must run after EditorLayout.build(). */
    async init(): Promise<void> {
        const { host, handles } = this;
        // ── 1. Command bus (undo/redo + edit-mode gating) ──
        this.commandBus = new EditorCommandBus(host.engine);

        // ── 2. Toolbar button handlers (markup is owned by the layout). ──
        this.undoBtn = handles.toolbar.querySelector('#btn-undo') as HTMLButtonElement;
        this.redoBtn = handles.toolbar.querySelector('#btn-redo') as HTMLButtonElement;
        this.undoBtn.onclick = () => this.commandBus?.undo();
        this.redoBtn.onclick = () => this.commandBus?.redo();
        const playerBtn = handles.toolbar.querySelector('#btn-player') as HTMLButtonElement;
        playerBtn.onclick = () => this.openPlayer();

        // ── 3. Mount Vue sidebar tabs + the asset view below the viewport. ──
        this.mountVuePanels(handles.sidebar);
        this.mountAssetPanel();

        // ── 4. Input manager (tools/picking) — editor-only concern. ──
        this.inputManager = new EditorInputManager(
            host.engine.scene,
            host.eventBus,
            <N,>(name: string): N | null => host.engine.systemRegistry.resolve({ name }) as unknown as N | null,
            () => host.engine.aspect(),
        );

        // ── 5. Native DOM panels (attach through the command bus). ──
        const editorPanel = new EditorPanel(handles.sceneContainer);
        const pipelinePanel = new PipelinePanel(handles.pipelineContainer);
        editorPanel.attach(this.commandBus);
        pipelinePanel.attach(this.commandBus);
        editorPanel.render();
        pipelinePanel.render();
        this.panels = { editor: editorPanel, pipeline: pipelinePanel };

        // ── 6. App switching (Load-JSON-of-app.json + window.switchApp). ──
        editorPanel.onAppSwitch = (name: string) => this.switchApp(name);

        // ── 7. Load the current app's tools.json (engine no longer does this). ──
        const appName = host.engine.currentApp;
        if (appName) await this.loadToolsFor(appName);

        // ── 8. Wire 3D picking → scene-tree selection (event channel only). ──
        this.subscribePick();

        // ── 9. Toolbar button states follow the command bus. ──
        this.unsubscribeChanged = host.eventBus.on('editor:changed', () => this.refreshToolbar());
        this.refreshToolbar();
    }

    /** Re-mount Vue panels after an app switch. The engine clears the event bus
     *  on unload, so each panel's subscriptions must be recreated. */
    remountVuePanels(): void {
        for (const un of this.vueUnmounts) un();
        this.vueUnmounts = [];
        this.mountVuePanels(this.handles.sidebar);
        this.mountAssetPanel();
    }

    /** Refresh undo/redo button enabled state (stack emptiness). */
    refreshToolbar(): void {
        if (!this.undoBtn || !this.redoBtn || !this.commandBus) return;
        this.undoBtn.disabled = !this.commandBus.canUndo;
        this.redoBtn.disabled = !this.commandBus.canRedo;
    }

    /** AppHost routes host.dispatch() here while the editor layer is mounted. */
    dispatch(cmd: Command): boolean {
        return this.commandBus?.dispatch(cmd) ?? false;
    }

    /** Open the current app in player mode (no editor UI) in a new tab. */
    private openPlayer(): void {
        const appName = this.host.engine.currentApp;
        if (!appName) return;
        window.open(`player.html?app=${appName}`, '_blank');
    }

    /** Reload the editor for a different app: detach old tools, load the app,
     *  reload its tools.json + app UI and refresh both panels. */
    async switchApp(name: string): Promise<void> {
        if (!this.host) return;
        this.inputManager?.dispose();
        await this.host.loadApp(name);
        await this.host.loadAppUI(`${this.host.engineConfig.appsRoot}/${name}`);
        await this.loadToolsFor(name);
        // unloadCurrentApp clears the event bus → re-subscribe panel listeners.
        if (this.commandBus) {
            this.panels.editor?.attach(this.commandBus);
            this.panels.pipeline?.attach(this.commandBus);
        }
        this.remountVuePanels();
        this.unsubscribeChanged?.();
        this.unsubscribeChanged = this.host.eventBus.on('editor:changed', () => this.refreshToolbar());
        this.panels.editor?.render();
        this.panels.pipeline?.render();
        this.refreshToolbar();
        this.subscribePick();
    }

    /** Fetch the app manifest's tools.json and load it through the input manager. */
    private async loadToolsFor(appName: string): Promise<void> {
        if (!this.host || !this.inputManager) return;
        const base = `${this.host.engineConfig.appsRoot}/${appName}`;
        try {
            const manifestResp = await fetch(`${base}/app.json`);
            if (!manifestResp.ok) return;
            const manifest = await manifestResp.json() as { tools?: string };
            if (manifest.tools) {
                await this.inputManager.loadTools(base, manifest.tools);
            }
        } catch (e) {
            console.warn('[EditorOrchestrator] failed to load tools:', e);
        }
    }

    /** Mount every Vue sidebar-tab panel into its tab container. A mount failure
     *  (component error) is caught so the rest of the editor still works. */
    private mountVuePanels(sidebar: HTMLElement): void {
        for (const def of this.vuePanels) {
            const el = sidebar.querySelector<HTMLElement>(`#tab-${def.id}`);
            if (!el) continue;
            try {
                this.vueUnmounts.push(mountVuePanel(el, def.component, this.host));
            } catch (e) {
                console.error(`[EditorOrchestrator] failed to mount Vue panel '${def.id}':`, e);
            }
        }
    }

    /** Mount the Asset view into the strip below the viewport. */
    private mountAssetPanel(): void {
        const el = document.getElementById('tab-assets');
        if (!el) return;
        try {
            this.vueUnmounts.push(mountVuePanel(el, this.assetPanel.component, this.host));
        } catch (e) {
            console.error('[EditorOrchestrator] failed to mount asset view:', e);
        }
    }

    /** Pick tools emit a 'pick' event ({ key, eid, ... }); highlight the entity.
     *  Re-subscribed on app switch (unloadCurrentApp clears the event bus). */
    private subscribePick(): void {
        if (!this.panels.editor) return;
        this.unsubscribePick?.();
        this.unsubscribePick = this.host.eventBus.on('pick', (payload) => {
            const key = (payload as { key?: string })?.key;
            if (key) this.panels.editor?.select(key);
        });
    }

    unmount(): void {
        this.inputManager?.dispose();
        this.unsubscribePick?.();
        this.unsubscribeChanged?.();
        for (const un of this.vueUnmounts) un();
        this.vueUnmounts = [];
        this.commandBus = undefined;
        this.inputManager = undefined;
        this.panels = {};
        this.undoBtn = undefined;
        this.redoBtn = undefined;
    }
}
