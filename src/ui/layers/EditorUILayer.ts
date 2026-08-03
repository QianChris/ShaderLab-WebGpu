import type { AppHost } from '../../host/AppHost';
import type { Command } from '../../editor/commands/Command';
import type { UILayer } from '../UILayer';
import type { VuePanelDef } from '../vue';
import AssetViewPanel from '../vue/panels/AssetViewPanel.vue';
import ScriptEditorPanel from '../vue/panels/ScriptEditorPanel.vue';
import WgslEditorPanel from '../vue/panels/WgslEditorPanel.vue';
import PipelineNodeEditor from '../vue/panels/PipelineNodeEditor.vue';
import { EditorLayout } from './EditorLayout';
import { EditorOrchestrator } from './EditorOrchestrator';

/**
 * Editor UI layer: a thin composition root over EditorLayout (DOM framework)
 * and EditorOrchestrator (behavior). Mounted ONLY by the editor entry
 * (main.ts). All state changes flow through the command bus; the layer itself
 * never writes to the engine. App-switch reloads the editor state for the new
 * app.
 *
 * Responsibilities kept here: owning the Vue panel definitions (the
 * composition root) and the mount/unmount lifecycle that wires the layout to
 * the orchestrator. Everything else is delegated.
 */
export class EditorUILayer implements UILayer {
    id = 'editor';
    private layout?: EditorLayout;
    private orchestrator?: EditorOrchestrator;
    private host?: AppHost;

    /** Vue panel definitions mounted as sidebar tabs. */
    private readonly vuePanels: VuePanelDef[] = [
        { id: 'scripts', label: 'Scripts', component: ScriptEditorPanel },
        { id: 'shaders', label: 'Shaders', component: WgslEditorPanel },
        { id: 'nodes', label: 'Nodes', component: PipelineNodeEditor },
    ];
    /** Asset view mounts below the viewport (not a sidebar tab). */
    private readonly assetPanel: VuePanelDef = { id: 'assets', label: 'Assets', component: AssetViewPanel };

    async mount(container: HTMLElement, host: AppHost): Promise<void> {
        this.host = host;
        // Layout owns the DOM framework (toolbar/sidebar/resizers/tabs).
        this.layout = new EditorLayout(
            this.vuePanels.map(p => ({ id: p.id, label: p.label })),
            () => host.resize(),
        );
        const handles = this.layout.build(container);

        // Orchestrator owns the behavior (command bus/panels/Vue mounting).
        this.orchestrator = new EditorOrchestrator(host, this.layout, handles, this.vuePanels, this.assetPanel);
        await this.orchestrator.init();
        // NOTE: main.ts calls host.loadAppUI(appName) AFTER mountLayer returns,
        // and owns the window.switchApp/engine/host devtools wiring + startLoop.
    }

    unmount(): void {
        this.orchestrator?.unmount();
        this.layout?.unmount();
        this.orchestrator = undefined;
        this.layout = undefined;
        this.host = undefined;
    }

    /** AppHost routes host.dispatch() here while the editor layer is mounted. */
    dispatch(cmd: Command): boolean {
        return this.orchestrator?.dispatch(cmd) ?? false;
    }

    /** Reload the editor for a different app (devtools / Load-JSON path). */
    async switchApp(name: string): Promise<void> {
        await this.orchestrator?.switchApp(name);
    }
}
