/** DOM containers created by EditorLayout.build(), consumed by EditorOrchestrator
 *  to mount panels into. */
export interface EditorLayoutHandles {
    toolbar: HTMLElement;
    sidebar: HTMLElement;
    sceneContainer: HTMLElement;
    pipelineContainer: HTMLElement;
}

/** A tab spec for the sidebar shell: id + label only (the component is wired by
 *  the orchestrator, which owns the VuePanelDef list). */
export interface LayoutTabSpec {
    id: string;
    label: string;
}

/**
 * Pure DOM framework for the editor: builds the toolbar, sidebar tab shell and
 * drag resizers, and owns tab switching. Has NO knowledge of the command bus,
 * panels or Vue — it only creates containers and wires DOM-level interaction
 * (resizers, tab show/hide). The orchestrator mounts panels into the returned
 * handles and wires behavioral callbacks.
 *
 * A document-level delegated click handler is registered in the constructor so
 * tab switching keeps working even if the orchestrator's per-button wiring
 * fails — the shell must never die from a panel-mount failure.
 */
export class EditorLayout {
    private toolbar?: HTMLElement;
    private sidebar?: HTMLElement;
    private resizer?: HTMLElement;
    private assetResizer?: HTMLElement;
    private assetBottom?: HTMLElement;
    private readonly tabs: LayoutTabSpec[];
    private readonly onResize: () => void;
    private docTabHandler: (ev: MouseEvent) => void;

    constructor(tabs: LayoutTabSpec[], onResize: () => void) {
        this.tabs = tabs;
        this.onResize = onResize;
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

    /** Build the toolbar + sidebar tab shell into `container`. Returns handles
     *  for the orchestrator to mount panels into. Idempotent on the container. */
    build(container: HTMLElement): EditorLayoutHandles {
        const toolbar = this.findOrCreate(container, 'toolbar');
        const sidebar = this.findOrCreate(container, 'sidebar');
        this.toolbar = toolbar;
        this.sidebar = sidebar;
        this.attachSidebarResizer(sidebar);
        this.attachAssetResizer();

        // ── Toolbar (static markup; the orchestrator wires button handlers). ──
        toolbar.innerHTML = `
            <button class="tb-btn" id="btn-undo" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
            <button class="tb-btn" id="btn-redo" title="Redo (Ctrl+Y)" disabled>↷ Redo</button>
            <button class="tb-btn tb-btn-player" id="btn-player" title="Open this app in player mode">▶ Player</button>
            <button class="tb-btn" id="btn-connect" title="Connect a project folder to save files to disk">📁 Connect</button>
            <button class="tb-btn" id="btn-theme" title="Toggle light/dark theme">🌙</button>
            <span class="tb-dirty" id="tb-dirty" title="Unsaved changes"></span>
            <span class="tb-title">ShaderLab Editor</span>
        `;

        // ── Sidebar tab shell ──
        const tabButtons = [
            '<button class="tab-btn active" data-tab="scene">Scene</button>',
            '<button class="tab-btn" data-tab="pipeline">Pipeline</button>',
            ...this.tabs.map(t => `<button class="tab-btn" data-tab="${t.id}">${t.label}</button>`),
        ];
        sidebar.innerHTML = `
            <div id="tabs">${tabButtons.join('')}</div>
            <div id="tab-scene" class="tab-panel" style="display:flex;">
                <div id="editor"></div>
            </div>
            <div id="tab-pipeline" class="tab-panel" style="display:none;">
                <div id="pipeline-panel"></div>
            </div>
            ${this.tabs.map(t => `<div id="tab-${t.id}" class="tab-panel" style="display:none;"></div>`).join('')}
        `;

        // Wire per-button handlers (in addition to the document delegate so the
        // active highlight refreshes correctly).
        this.wireTabs(sidebar);

        return {
            toolbar,
            sidebar,
            sceneContainer: sidebar.querySelector<HTMLElement>('#tab-scene')!,
            pipelineContainer: sidebar.querySelector<HTMLElement>('#tab-pipeline')!,
        };
    }

    /** Show the given tab panel + update button highlights. Shared by the
     *  document delegate and per-button handlers. Dispatches a window resize so
     *  embedded editors (CodeMirror / vue-flow) re-measure in a visible box. */
    activateTab(tab: string): void {
        if (!this.sidebar) return;
        const sidebar = this.sidebar;
        const tabIds = ['scene', 'pipeline', ...this.tabs.map(t => t.id)];
        const buttons = sidebar.querySelectorAll<HTMLButtonElement>('.tab-btn');
        buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        for (const id of tabIds) {
            const panel = sidebar.querySelector<HTMLElement>(`#tab-${id}`);
            if (panel) panel.style.display = tab === id ? 'flex' : 'none';
        }
        window.dispatchEvent(new Event('resize'));
        this.onResize();
    }

    /** Remove the document-level delegated click handler. */
    unmount(): void {
        document.removeEventListener('click', this.docTabHandler);
        this.toolbar = undefined;
        this.sidebar = undefined;
        this.resizer = undefined;
        this.assetResizer = undefined;
        this.assetBottom = undefined;
    }

    private findOrCreate(container: HTMLElement, id: string): HTMLElement {
        return container.querySelector<HTMLElement>(`#${id}`)
            ?? (() => {
                const el = document.createElement('div');
                el.id = id;
                container.appendChild(el);
                return el;
            })();
    }

    /** Wire the sidebar drag handle (in #main) so the right panel width can be
     *  dragged between its min/max CSS bounds. The handle is the sidebar's LEFT
     *  edge, so dragging LEFT widens the sidebar (next = startWidth - dx). */
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
                this.onResize();
            };
            const onUp = (ev: PointerEvent) => {
                resizer.releasePointerCapture(ev.pointerId);
                resizer.classList.remove('dragging');
                document.body.classList.remove('sidebar-resizing');
                resizer.removeEventListener('pointermove', onMove);
                resizer.removeEventListener('pointerup', onUp);
                this.onResize();
            };
            resizer.addEventListener('pointermove', onMove);
            resizer.addEventListener('pointerup', onUp);
        };
        resizer.addEventListener('pointerdown', onPointerDown);
    }

    /** Wire the horizontal handle above the asset strip so the asset view height
     *  is draggable. The handle is the strip's TOP edge: dragging UP grows the
     *  strip (next = startHeight - dy). */
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
                this.onResize();
            };
            const onUp = (ev: PointerEvent) => {
                resizer.releasePointerCapture(e.pointerId);
                resizer.classList.remove('dragging');
                document.body.classList.remove('asset-resizing');
                resizer.removeEventListener('pointermove', onMove);
                resizer.removeEventListener('pointerup', onUp);
                this.onResize();
            };
            resizer.addEventListener('pointermove', onMove);
            resizer.addEventListener('pointerup', onUp);
        };
        resizer.addEventListener('pointerdown', onPointerDown);
    }

    private wireTabs(sidebar: HTMLElement): void {
        const buttons = sidebar.querySelectorAll<HTMLButtonElement>('.tab-btn');
        buttons.forEach(btn => {
            btn.onclick = () => {
                const tab = btn.dataset.tab ?? '';
                if (!tab) return;
                this.activateTab(tab);
            };
        });
    }
}
