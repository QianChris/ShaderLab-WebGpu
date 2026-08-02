import type { AppHost } from '../../host/AppHost';
import type { UILayer } from '../UILayer';
import type { Command } from '../../editor/commands/Command';
import { EditorCommandBus } from '../../editor/EditorCommandBus';
import { EditorInputManager } from '../../editor/input/EditorInputManager';
import { EditorPanel } from '../../editor/EditorPanel';
import { PipelinePanel } from '../../editor/PipelinePanel';

/**
 * Editor UI layer: owns the whole editor experience (tab shell, command bus,
 * input manager / tools, panels). Mounted ONLY by the editor entry (main.ts).
 * All state changes flow through the command bus; the layer itself never
 * writes to the engine. App-switch reloads the editor state for the new app.
 */
export class EditorUILayer implements UILayer {
    id = 'editor';
    private commandBus?: EditorCommandBus;
    private inputManager?: EditorInputManager;
    private panels: { editor?: EditorPanel; pipeline?: PipelinePanel } = {};
    private host?: AppHost;
    private unsubscribePick?: () => void;

    async mount(container: HTMLElement, host: AppHost) {
        this.host = host;

        // ── 1. Build the editor tab shell (was static markup in index.html) ──
        container.innerHTML = `
            <div id="tabs">
                <button class="tab-btn active" data-tab="scene">Scene</button>
                <button class="tab-btn" data-tab="pipeline">Pipeline</button>
            </div>
            <div id="tab-scene" class="tab-panel" style="display:flex;">
                <div id="editor"></div>
            </div>
            <div id="tab-pipeline" class="tab-panel" style="display:none;">
                <div id="pipeline-panel"></div>
            </div>
        `;
        const sceneContainer = container.querySelector('#tab-scene') as HTMLElement;
        const pipelineContainer = container.querySelector('#tab-pipeline') as HTMLElement;

        // ── 2. Command bus (undo/redo + edit-mode gating) ──
        this.commandBus = new EditorCommandBus(host.engine);

        // ── 3. Input manager (tools/picking) — editor-only concern ──
        this.inputManager = new EditorInputManager(
            host.engine.scene,
            host.eventBus,
            <N,>(name: string): N | null => host.engine.systemRegistry.resolve({ name }) as unknown as N | null,
            () => host.engine.aspect(),
        );

        // ── 4. Panels (attach through the command bus; read-only core imports) ──
        const editorPanel = new EditorPanel(sceneContainer);
        const pipelinePanel = new PipelinePanel(pipelineContainer);
        editorPanel.attach(this.commandBus);
        pipelinePanel.attach(this.commandBus);
        editorPanel.render();
        pipelinePanel.render();
        this.panels = { editor: editorPanel, pipeline: pipelinePanel };

        // ── 5. Tab switching ──
        const buttons = container.querySelectorAll<HTMLButtonElement>('.tab-btn');
        buttons.forEach(btn => {
            btn.onclick = () => {
                const tab = btn.dataset.tab;
                buttons.forEach(b => b.classList.toggle('active', b === btn));
                sceneContainer.style.display = tab === 'scene' ? 'flex' : 'none';
                pipelineContainer.style.display = tab === 'pipeline' ? 'flex' : 'none';
            };
        });

        // ── 6. App switching (Load-JSON-of-app.json + window.switchApp) ──
        editorPanel.onAppSwitch = (name: string) => this.switchApp(name);

        // ── 7. Load the current app's tools.json (engine no longer does this) ──
        const appName = host.engine.currentApp;
        if (appName) await this.loadToolsFor(appName);

        // ── 8. Wire 3D picking → scene-tree selection (event channel only) ──
        this.subscribePick();
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
        this.panels.editor?.render();
        this.panels.pipeline?.render();
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
        this.commandBus = undefined;
        this.inputManager = undefined;
        this.panels = {};
        this.host = undefined;
    }

    /** AppHost routes host.dispatch() here while the editor layer is mounted. */
    dispatch(cmd: Command): boolean {
        return this.commandBus?.dispatch(cmd) ?? false;
    }
}
