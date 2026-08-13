import type { AppHost } from '../../host/AppHost';
import type { Command } from '../../editor/commands/Command';
import { EditorCommandBus } from '../../editor/EditorCommandBus';
import { EditorInputManager } from '../../editor/input/EditorInputManager';
import { EditorPanel } from '../../editor/EditorPanel';
import { PipelinePanel } from '../../editor/PipelinePanel';
import { ViewportCameraController } from '../../editor/input/ViewportCameraController';
import { TransformGizmoTool } from '../../editor/input/TransformGizmoTool';
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
    private viewportController?: ViewportCameraController;
    private gizmoTool?: TransformGizmoTool;
    private recorder: MediaRecorder | null = null;
    private recordChunks: Blob[] = [];
    private editorCamActive = true;
    private panels: { editor?: EditorPanel; pipeline?: PipelinePanel } = {};
    private vueUnmounts: (() => void)[] = [];
    private unsubscribePick?: () => void;
    private unsubscribeChanged?: () => void;
    private undoBtn?: HTMLButtonElement;
    private redoBtn?: HTMLButtonElement;
    private dirtyDot?: HTMLElement;

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
        this.commandBus.projectFS = host.projectFS;

        // ── 2. Toolbar button handlers (markup is owned by the layout). ──
        this.undoBtn = handles.toolbar.querySelector('#btn-undo') as HTMLButtonElement;
        this.redoBtn = handles.toolbar.querySelector('#btn-redo') as HTMLButtonElement;
        this.dirtyDot = handles.toolbar.querySelector('#tb-dirty') ?? undefined;
        this.undoBtn.onclick = () => this.commandBus?.undo();
        this.redoBtn.onclick = () => this.commandBus?.redo();
        const playerBtn = handles.toolbar.querySelector('#btn-player') as HTMLButtonElement;
        playerBtn.onclick = () => this.openPlayer();
        const camToggleBtn = handles.toolbar.querySelector('#btn-cam-toggle') as HTMLButtonElement;
        camToggleBtn.onclick = () => this.toggleEditorCamera(camToggleBtn);
        const camResetBtn = handles.toolbar.querySelector('#btn-cam-reset') as HTMLButtonElement;
        camResetBtn.onclick = () => this.viewportController?.reset();
        const camFocusBtn = handles.toolbar.querySelector('#btn-cam-focus') as HTMLButtonElement;
        camFocusBtn.onclick = () => this.focusOnSelected();
        const captureBtn = handles.toolbar.querySelector('#btn-capture') as HTMLButtonElement;
        captureBtn.onclick = () => { void this.capturePng(captureBtn); };
        const recordBtn = handles.toolbar.querySelector('#btn-record') as HTMLButtonElement;
        recordBtn.onclick = () => this.toggleRecording(recordBtn);
        const connectBtn = handles.toolbar.querySelector('#btn-connect') as HTMLButtonElement;
        connectBtn.onclick = () => this.connectFolder();
        const themeBtn = handles.toolbar.querySelector('#btn-theme') as HTMLButtonElement;
        themeBtn.onclick = () => this.toggleTheme();
        // Restore persisted theme.
        if (localStorage.getItem('shaderlab-theme') === 'light') {
            document.body.classList.add('theme-light');
            themeBtn.textContent = '☀';
        }

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

        // ── 4b. Viewport camera controller — editor-only orbit/pan/zoom.
        //     Installs a provider the engine reads each frame; player mode
        //     never mounts this layer, so editorView stays null there. ──
        this.viewportController = new ViewportCameraController(host.engine.canvas);
        host.engine.setEditorViewProvider(() => this.viewportController?.getCameraView() ?? null);

        // ── 4c. Transform gizmo — editor-only pick + move/rotate/scale drag.
        //     Subscribes to 'pick' to stay in sync with physics PickTool. ──
        this.gizmoTool = new TransformGizmoTool(
            host.engine.canvas,
            host.engine,
            this.commandBus,
            host.eventBus,
        );
        this.gizmoTool.attach();

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

    /** Refresh undo/redo button enabled state (stack emptiness) + dirty dot. */
    refreshToolbar(): void {
        if (!this.undoBtn || !this.redoBtn || !this.commandBus) return;
        this.undoBtn.disabled = !this.commandBus.canUndo;
        this.redoBtn.disabled = !this.commandBus.canRedo;
        if (this.dirtyDot) this.dirtyDot.textContent = this.commandBus.dirty ? '●' : '';
    }

    /** Prompt the user to connect a real project folder (Chrome File System
     *  Access API). On success saves write real files; otherwise the default
     *  IndexedDB backend still persists in-browser. */
    private async connectFolder(): Promise<void> {
        const ok = await this.host.connectProjectFolder();
        if (ok && this.commandBus) this.commandBus.projectFS = this.host.projectFS;
        if (ok) console.log('[EditorOrchestrator] project folder connected');
    }

    /** Toggle the light/dark chrome theme. Persisted to localStorage. */
    private toggleTheme(): void {
        const btn = this.handles.toolbar.querySelector('#btn-theme') as HTMLButtonElement | null;
        const isLight = document.body.classList.toggle('theme-light');
        localStorage.setItem('shaderlab-theme', isLight ? 'light' : 'dark');
        if (btn) btn.textContent = isLight ? '☀' : '🌙';
    }

    /** AppHost routes host.dispatch() here while the editor layer is mounted. */
    dispatch(cmd: Command): boolean {
        return this.commandBus?.dispatch(cmd) ?? false;
    }

    /** Undo/redo — exposed so any panel can wire Ctrl+Z/Y via host.undo(). */
    undo(): void { this.commandBus?.undo(); }
    redo(): void { this.commandBus?.redo(); }

    /** Open the current app in player mode (no editor UI) in a new tab. */
    private openPlayer(): void {
        const appName = this.host.engine.currentApp;
        if (!appName) return;
        window.open(`player.html?app=${appName}`, '_blank');
    }

    /** Toggle between the editor viewport camera (ViewportCameraController)
     *  and any active scene Camera. When the editor camera is off, the engine
     *  falls back to scene.getActiveCameras (player-style framing). */
    private toggleEditorCamera(btn: HTMLButtonElement): void {
        this.editorCamActive = !this.editorCamActive;
        if (this.editorCamActive) {
            this.host.engine.setEditorViewProvider(() => this.viewportController?.getCameraView() ?? null);
            btn.textContent = 'Cam: Editor';
        } else {
            this.host.engine.setEditorViewProvider(null);
            btn.textContent = 'Cam: Scene';
        }
    }

    /** Frame the editor camera on the gizmo's currently selected entity. */
    private focusOnSelected(): void {
        const t = this.gizmoTool?.getFocusTarget();
        if (!t) return;
        this.viewportController?.frameAround(t.x, t.y, t.z, t.distance);
    }

    /** Capture the next rendered frame as a PNG and trigger a download. */
    private async capturePng(btn: HTMLButtonElement): Promise<void> {
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '…';
        try {
            const blob = await this.host.engine.captureFrame();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const app = this.host.engine.currentApp ?? 'scene';
            a.download = `${app}_${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (e) {
            console.error('[EditorOrchestrator] capture failed:', e);
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    }

    /** Toggle WebM recording of the canvas via MediaRecorder. */
    private toggleRecording(btn: HTMLButtonElement): void {
        if (this.recorder) {
            this.recorder.stop();
            this.recorder = null;
            btn.style.color = '';
            btn.textContent = '⏺';
            return;
        }
        const canvas = this.host.engine.canvas;
        const stream = canvas.captureStream(60);
        const opts = { mimeType: 'video/webm;codecs=vp9' };
        let rec: MediaRecorder;
        try {
            rec = new MediaRecorder(stream, opts);
        } catch {
            try {
                rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
            } catch {
                rec = new MediaRecorder(stream);
            }
        }
        this.recordChunks = [];
        rec.ondataavailable = (e: BlobEvent) => {
            if (e.data.size > 0) this.recordChunks.push(e.data);
        };
        rec.onstop = () => {
            const blob = new Blob(this.recordChunks, { type: 'video/webm' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const app = this.host.engine.currentApp ?? 'scene';
            a.download = `${app}_${Date.now()}.webm`;
            a.click();
            URL.revokeObjectURL(a.href);
            stream.getTracks().forEach(t => t.stop());
        };
        rec.start(1000);
        this.recorder = rec;
        btn.style.color = '#ff5b5b';
        btn.textContent = '⏹';
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
        this.viewportController?.dispose();
        this.viewportController = undefined;
        this.gizmoTool?.dispose();
        this.gizmoTool = undefined;
        if (this.recorder) { this.recorder.stop(); this.recorder = null; }
        this.host.engine.setEditorViewProvider(null);
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
