import type { AppHost } from '../../host/AppHost';
import type { UILayer } from '../UILayer';
import type { Command } from '../../editor/commands/Command';
import { EditorCommandBus } from '../../editor/EditorCommandBus';
import { EditorInputManager } from '../../editor/input/EditorInputManager';
import { EditorPanel } from '../../editor/EditorPanel';
import { PipelinePanel } from '../../editor/PipelinePanel';
import { mountVuePanel, type VuePanelDef } from '../vue';
import AssetViewPanel from '../vue/panels/AssetViewPanel.vue';
import ScriptEditorPanel from '../vue/panels/ScriptEditorPanel.vue';
import WgslEditorPanel from '../vue/panels/WgslEditorPanel.vue';
import PipelineNodeEditor from '../vue/panels/PipelineNodeEditor.vue';

/**
 * Editor UI layer: owns the whole editor experience (top toolbar, tab shell,
 * command bus, input manager / tools, panels). Mounted ONLY by the editor
 * entry (main.ts). All state changes flow through the command bus; the layer
 * itself never writes to the engine. App-switch reloads the editor state for
 * the new app.
 */
export class EditorUILayer implements UILayer {
    id = 'editor';
    private commandBus?: EditorCommandBus;
    private inputManager?: EditorInputManager;
    private panels: { editor?: EditorPanel; pipeline?: PipelinePanel } = {};
    /** Vue panel definitions mounted as sidebar tabs (mixed with the native
     *  DOM tabs). The Asset view is NOT here — it lives below the viewport. */
    private readonly vuePanels: VuePanelDef[] = [
        { id: 'scripts', label: 'Scripts', component: ScriptEditorPanel },
        { id: 'shaders', label: 'Shaders', component: WgslEditorPanel },
        { id: 'nodes', label: 'Nodes', component: PipelineNodeEditor },
    ];
    /** Asset view mounts below the viewport (not a sidebar tab). */
    private readonly assetPanel: VuePanelDef = { id: 'assets', label: 'Assets', component: AssetViewPanel };
    private vueUnmounts: (() => void)[] = [];
    private host?: AppHost;
    private unsubscribePick?: () => void;
    private unsubscribeChanged?: () => void;
    private undoBtn?: HTMLButtonElement;
    private redoBtn?: HTMLButtonElement;
    private resizer?: HTMLElement;
    private assetResizer?: HTMLElement;
    private sidebar?: HTMLElement;
    private assetBottom?: HTMLElement;
    /** Document-level delegated tab handler (registered once in the ctor). Works
     *  even if mount() throws before wiring per-button handlers. */
    private docTabHandler: (ev: MouseEvent) => void;

    constructor() {
        // Document-level delegation is the LAST line of defense: as long as the
        // sidebar + .tab-btn exist in the DOM, this handler switches tabs no
        // matter what happens to per-button wiring. Registered here so it is
        // active before mount() even starts.
        this.docTabHandler = (ev: MouseEvent) => {
            if (!this.sidebar) return;
            const target = ev.target as HTMLElement | null;
            const btn = target?.closest?.('.tab-btn') as HTMLButtonElement | null;
            if (!btn) return;
            const tab = btn.dataset.tab;
            if (!tab) return;
            this.activateTab(tab);
        };
        document.addEventListener('click', this.docTabHandler);
    }

    async mount(container: HTMLElement, host: AppHost) {
        console.log('[EditorUILayer] mount() start');
        this.host = host;
        try {
            await this.mountInner(container, host);
            console.log('[EditorUILayer] mount() complete');
        } catch (err) {
            console.error('[EditorUILayer] mount() failed:', err);
        }
    }

    /** The actual mount work; wrapped so any failure is logged, not swallowed. */
    private async mountInner(container: HTMLElement, host: AppHost): Promise<void> {
        const toolbar = this.findOrCreate(container, 'toolbar');
        const sidebar = this.findOrCreate(container, 'sidebar');
        this.sidebar = sidebar;
        this.attachSidebarResizer(sidebar);
        this.attachAssetResizer();
        console.log('[EditorUILayer] mount: resizers ok, sidebar exists =', !!sidebar);

        // ── 1. Command bus (undo/redo + edit-mode gating) ──
        this.commandBus = new EditorCommandBus(host.engine);

        // ── 2. Top toolbar: undo / redo / open player ──
        toolbar.innerHTML = `
            <button class="tb-btn" id="btn-undo" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
            <button class="tb-btn" id="btn-redo" title="Redo (Ctrl+Y)" disabled>↷ Redo</button>
            <button class="tb-btn tb-btn-player" id="btn-player" title="Open this app in player mode">▶ Player</button>
            <span class="tb-title">ShaderLab Editor</span>
        `;
        this.undoBtn = toolbar.querySelector('#btn-undo') as HTMLButtonElement;
        this.redoBtn = toolbar.querySelector('#btn-redo') as HTMLButtonElement;
        this.undoBtn.onclick = () => this.commandBus?.undo();
        this.redoBtn.onclick = () => this.commandBus?.redo();

        const playerBtn = toolbar.querySelector('#btn-player') as HTMLButtonElement;
        playerBtn.onclick = () => this.openPlayer();

        // ── 3. Sidebar tab shell (was static markup in index.html) ──
        const tabButtons = [
            '<button class="tab-btn active" data-tab="scene">Scene</button>',
            '<button class="tab-btn" data-tab="pipeline">Pipeline</button>',
            ...this.vuePanels.map(p => `<button class="tab-btn" data-tab="${p.id}">${p.label}</button>`),
        ];
        sidebar.innerHTML = `
            <div id="tabs">${tabButtons.join('')}</div>
            <div id="tab-scene" class="tab-panel" style="display:flex;">
                <div id="editor"></div>
            </div>
            <div id="tab-pipeline" class="tab-panel" style="display:none;">
                <div id="pipeline-panel"></div>
            </div>
            ${this.vuePanels.map(p => `<div id="tab-${p.id}" class="tab-panel" style="display:none;"></div>`).join('')}
        `;
        const sceneContainer = sidebar.querySelector('#tab-scene') as HTMLElement;
        const pipelineContainer = sidebar.querySelector('#tab-pipeline') as HTMLElement;

        // ── 3b. Tab switching — wired BEFORE mounting Vue apps so the tabs are
        // always clickable even if a panel mount fails (a failed mount must not
        // leave the tab shell dead). ──
        this.wireTabs(sidebar);
        console.log('[EditorUILayer] mount: tabs wired, buttons =', sidebar.querySelectorAll('.tab-btn').length);

        // ── 3c. Mount the Vue sidebar tabs + the asset view below the viewport ──
        this.mountVuePanels(sidebar);
        this.mountAssetPanel();
        console.log('[EditorUILayer] mount: Vue panels mounted, unmount fns =', this.vueUnmounts.length);

        // ── 4. Input manager (tools/picking) — editor-only concern ──
        this.inputManager = new EditorInputManager(
            host.engine.scene,
            host.eventBus,
            <N,>(name: string): N | null => host.engine.systemRegistry.resolve({ name }) as unknown as N | null,
            () => host.engine.aspect(),
        );

        // ── 5. Panels (attach through the command bus; read-only core imports) ──
        const editorPanel = new EditorPanel(sceneContainer);
        const pipelinePanel = new PipelinePanel(pipelineContainer);
        editorPanel.attach(this.commandBus);
        pipelinePanel.attach(this.commandBus);
        editorPanel.render();
        pipelinePanel.render();
        this.panels = { editor: editorPanel, pipeline: pipelinePanel };

        // ── 6. Tab switching (shared helper; wired again at step 3b) ──

        // ── 7. App switching (Load-JSON-of-app.json + window.switchApp) ──
        editorPanel.onAppSwitch = (name: string) => this.switchApp(name);

        // ── 8. Load the current app's tools.json (engine no longer does this) ──
        const appName = host.engine.currentApp;
        if (appName) await this.loadToolsFor(appName);

        // ── 9. Wire 3D picking → scene-tree selection (event channel only) ──
        this.subscribePick();

        // ── 10. Toolbar button states follow the command bus ──
        this.unsubscribeChanged = host.eventBus.on('editor:changed', () => this.refreshToolbar());
        this.refreshToolbar();
    }

    /** Wire the sidebar drag handle (in #main) so the right panel width can be
     *  dragged between its min/max CSS bounds. The handle is the sidebar's LEFT
     *  edge, so dragging LEFT widens the sidebar (next = startWidth - dx).
     *  Pointer events + setPointerCapture keep the drag running outside the
     *  handle; body cursor/user-select are toggled so text selection doesn't
     *  fight the resize. After each move the engine resize() is called so the
     *  canvas backing store + viewport aspect track the new layout. */
    private attachSidebarResizer(sidebar: HTMLElement): void {
        const main = sidebar.parentElement;
        if (!main) return;
        const resizer = main.querySelector<HTMLElement>('#sidebar-resizer');
        if (!resizer) return;
        this.resizer = resizer;

        const onPointerDown = (e: PointerEvent) => {
            e.preventDefault();
            resizer.setPointerCapture(e.pointerId);
            resizer.classList.add('dragging');
            document.body.classList.add('sidebar-resizing');
            const startX = e.clientX;
            const startWidth = sidebar.getBoundingClientRect().width;

            const onMove = (ev: PointerEvent) => {
                const next = startWidth - (ev.clientX - startX);
                sidebar.style.width = `${Math.max(240, Math.min(640, next))}px`;
                this.host?.resize();
            };
            const onUp = (ev: PointerEvent) => {
                resizer.releasePointerCapture(ev.pointerId);
                resizer.classList.remove('dragging');
                document.body.classList.remove('sidebar-resizing');
                resizer.removeEventListener('pointermove', onMove);
                resizer.removeEventListener('pointerup', onUp);
                this.host?.resize();
            };
            resizer.addEventListener('pointermove', onMove);
            resizer.addEventListener('pointerup', onUp);
        };
        resizer.addEventListener('pointerdown', onPointerDown);
    }

    /** Wire the horizontal handle above the asset strip so the asset view height
     *  is draggable. The handle is the strip's TOP edge: dragging UP grows the
     *  strip (next = startHeight - dy). Resizes the canvas after each move. */
    private attachAssetResizer(): void {
        const bottom = document.getElementById('asset-bottom');
        if (!bottom) return;
        const resizer = document.getElementById('asset-resizer');
        if (!resizer) return;
        this.assetBottom = bottom;
        this.assetResizer = resizer;

        const onPointerDown = (e: PointerEvent) => {
            e.preventDefault();
            resizer.setPointerCapture(e.pointerId);
            resizer.classList.add('dragging');
            document.body.classList.add('asset-resizing');
            const startY = e.clientY;
            const startHeight = bottom.getBoundingClientRect().height;

            const onMove = (ev: PointerEvent) => {
                const next = startHeight - (ev.clientY - startY);
                bottom.style.height = `${Math.max(80, Math.min(480, next))}px`;
                this.host?.resize();
            };
            const onUp = (ev: PointerEvent) => {
                resizer.releasePointerCapture(ev.pointerId);
                resizer.classList.remove('dragging');
                document.body.classList.remove('asset-resizing');
                resizer.removeEventListener('pointermove', onMove);
                resizer.removeEventListener('pointerup', onUp);
                this.host?.resize();
            };
            resizer.addEventListener('pointermove', onMove);
            resizer.addEventListener('pointerup', onUp);
        };
        resizer.addEventListener('pointerdown', onPointerDown);
    }

    /** Wire sidebar tab buttons to show/hide their panel divs. Runs before Vue
     *  panels mount so the shell stays responsive regardless of panel health.
     *  Primary path is a document-level delegated click handler (registered in
     *  the constructor); this method additionally refreshes per-button state so
     *  the active highlight stays correct. When a panel becomes visible a window
     *  resize is dispatched so embedded editors (CodeMirror / vue-flow)
     *  re-measure their size in a visible box. */
    private wireTabs(sidebar: HTMLElement): void {
        const tabIds = ['scene', 'pipeline', ...this.vuePanels.map(p => p.id)];
        const buttons = sidebar.querySelectorAll<HTMLButtonElement>('.tab-btn');
        buttons.forEach(btn => {
            btn.onclick = () => {
                const tab = btn.dataset.tab ?? '';
                if (!tab) return;
                this.activateTab(tab);
            };
        });
        void tabIds;
    }

    /** Show the given tab panel + update button highlights. Shared by the
     *  document delegate and per-button handlers. */
    private activateTab(tab: string): void {
        if (!this.sidebar) return;
        const sidebar = this.sidebar;
        const tabIds = ['scene', 'pipeline', ...this.vuePanels.map(p => p.id)];
        const buttons = sidebar.querySelectorAll<HTMLButtonElement>('.tab-btn');
        buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        for (const id of tabIds) {
            const panel = sidebar.querySelector<HTMLElement>(`#tab-${id}`);
            if (panel) panel.style.display = tab === id ? 'flex' : 'none';
        }
        // Let CodeMirror/vue-flow re-measure now that the container is visible
        // (they size to 0 while display:none).
        window.dispatchEvent(new Event('resize'));
        if (this.host) this.host.resize();
    }

    /** Mount every Vue sidebar-tab panel into its tab container. A mount failure
     *  (component error) is caught so the rest of the editor still works. */
    private mountVuePanels(sidebar: HTMLElement): void {
        if (!this.host) return;
        for (const def of this.vuePanels) {
            const el = sidebar.querySelector<HTMLElement>(`#tab-${def.id}`);
            if (!el) continue;
            try {
                this.vueUnmounts.push(mountVuePanel(el, def.component, this.host));
            } catch (e) {
                console.error(`[EditorUILayer] failed to mount Vue panel '${def.id}':`, e);
            }
        }
    }

    /** Mount the Asset view into the strip below the viewport. */
    private mountAssetPanel(): void {
        if (!this.host) return;
        const el = document.getElementById('tab-assets');
        if (!el) return;
        try {
            this.vueUnmounts.push(mountVuePanel(el, this.assetPanel.component, this.host));
        } catch (e) {
            console.error('[EditorUILayer] failed to mount asset view:', e);
        }
    }

    /** Re-mount Vue panels after an app switch. The engine clears the event bus
     *  on unload, so each panel's subscriptions must be recreated. */
    private remountVuePanels(sidebar: HTMLElement): void {
        for (const un of this.vueUnmounts) un();
        this.vueUnmounts = [];
        this.wireTabs(sidebar);
        this.mountVuePanels(sidebar);
        this.mountAssetPanel();
    }

    /** Refresh undo/redo button enabled state (stack emptiness). */
    private refreshToolbar(): void {
        if (!this.undoBtn || !this.redoBtn || !this.commandBus) return;
        this.undoBtn.disabled = !this.commandBus.canUndo;
        this.redoBtn.disabled = !this.commandBus.canRedo;
    }

    /** Open the current app in player mode (no editor UI) in a new tab. */
    private openPlayer(): void {
        const appName = this.host?.engine.currentApp;
        if (!appName) return;
        window.open(`player.html?app=${appName}`, '_blank');
    }

    /** Find a child element by id or create it (robust to container variants). */
    private findOrCreate(container: HTMLElement, id: string): HTMLElement {
        return container.querySelector<HTMLElement>(`#${id}`)
            ?? (() => {
                const el = document.createElement('div');
                el.id = id;
                container.appendChild(el);
                return el;
            })();
    }

    /** Pick tools emit a 'pick' event ({ key, eid, ... }); highlight the entity.
     *  Re-subscribed on app switch (unloadCurrentApp clears the event bus). */
    private subscribePick(): void {
        if (!this.host || !this.panels.editor) return;
        this.unsubscribePick?.();
        this.unsubscribePick = this.host.eventBus.on('pick', (payload) => {
            const key = (payload as { key?: string })?.key;
            if (key) this.panels.editor?.select(key);
        });
    }

    /** Reload the editor for a different app: detach old tools, load the app,
     *  reload its tools.json + app UI and refresh both panels. Exposed for
     *  devtools (window.switchApp) and the panel's Load-JSON-of-app.json path. */
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
        this.remountVuePanels(this.sidebar!);
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
            console.warn('[EditorUILayer] failed to load tools:', e);
        }
    }

    unmount(): void {
        this.inputManager?.dispose();
        this.unsubscribePick?.();
        this.unsubscribeChanged?.();
        for (const un of this.vueUnmounts) un();
        this.vueUnmounts = [];
        document.removeEventListener('click', this.docTabHandler);
        this.commandBus = undefined;
        this.inputManager = undefined;
        this.panels = {};
        this.host = undefined;
        this.undoBtn = undefined;
        this.redoBtn = undefined;
        this.resizer = undefined;
        this.assetResizer = undefined;
        this.sidebar = undefined;
        this.assetBottom = undefined;
    }

    /** AppHost routes host.dispatch() here while the editor layer is mounted. */
    dispatch(cmd: Command): boolean {
        return this.commandBus?.dispatch(cmd) ?? false;
    }
}
