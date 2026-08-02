import type { EditorCommandBus } from './EditorCommandBus';
import { type PipelineEntry, type PipelineConfig, type RenderGraphData } from '../core/render/types';
import { PipelineLoader } from '../core/render/PipelineLoader';
import { ce, makeFloatField, makeSelect, makeCheckbox } from './dom';

const TOPOLOGY_OPTIONS: string[] = [
    'point-list', 'line-list', 'line-strip', 'triangle-list', 'triangle-strip',
];
const CULL_OPTIONS: string[] = ['none', 'front', 'back'];
const FRONT_FACE_OPTIONS: string[] = ['ccw', 'cw'];
const COMPARE_OPTIONS: string[] = [
    'never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always',
];

/**
 * Pipeline inspector. All state changes — entry toggles, parameter edits and
 * pipeline config edits — go through the EditorCommandBus so they are undoable
 * and never write to the render graph directly. Ctrl+Z / Ctrl+Y delegate to
 * the command bus's unified undo/redo.
 */
export class PipelinePanel {
    private panel: HTMLElement;
    private bus!: EditorCommandBus;
    private unsubscribe?: () => void;

    private get blendOptions(): string[] {
        return PipelineLoader.blendPresetNames.length > 0
            ? PipelineLoader.blendPresetNames
            : ['opaque', 'alpha', 'additive'];
    }

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(bus: EditorCommandBus): void {
        this.bus = bus;
        this.panel.tabIndex = 0;
        this.panel.addEventListener('keydown', (e) => {
            if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault();
                this.bus.undo();
            } else if (e.ctrlKey && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
                e.preventDefault();
                this.bus.redo();
            }
        });
        this.unsubscribe?.();
        this.unsubscribe = bus.engine.eventBus.on('editor:changed', () => this.render());
    }

    /** Dispatch a structural edit (enabled/params) as a live-sync patch. */
    private patchStructural(apply: (data: RenderGraphData) => void): void {
        const prev = JSON.stringify(this.bus.renderGraph.toData());
        const data = this.bus.renderGraph.toData();
        apply(data);
        this.bus.patchRenderGraph(data, prev);
        this.render();
    }

    /** Dispatch a pipeline config edit (topology/blend/cull/depth) + rebuild. */
    private patchConfig(entry: PipelineEntry, mutate: (config: PipelineConfig) => void): void {
        const config = PipelineLoader.getConfig(entry.pipeline);
        if (!config) return;
        const prev = JSON.stringify(config);
        mutate(config);
        this.bus.mutatePipelineConfig(entry.pipeline, JSON.stringify(config), prev);
        this.render();
    }

    render(): void {
        this.panel.innerHTML = '';

        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Render Pipeline'));
        this.panel.appendChild(head);

        const phases = this.bus.renderGraph.phases;
        const phaseNames = this.bus.renderGraph.getPhaseNames();
        for (const phase of phaseNames) {
            const section = ce('div', 'pp-phase');
            section.appendChild(ce('div', 'pp-phase-title', phase));

            const entries = phases[phase] ?? [];
            if (entries.length === 0) {
                section.appendChild(ce('div', 'pp-empty', '(empty)'));
            } else {
                for (const entry of entries) {
                    section.appendChild(this.renderEntry(entry));
                }
            }
            this.panel.appendChild(section);
        }
    }

    private renderEntry(entry: PipelineEntry): HTMLElement {
        const wrap = ce('div', 'pp-entry-wrap');

        const row = ce('div', 'pp-entry');
        const chk = ce('input') as HTMLInputElement;
        chk.type = 'checkbox';
        chk.checked = entry.enabled;
        chk.onchange = () => this.patchStructural(data => {
            for (const list of Object.values(data.phases)) {
                const target = (list ?? []).find(e => e.name === entry.name);
                if (target) target.enabled = chk.checked;
            }
        });
        row.appendChild(chk);
        row.appendChild(ce('span', 'pp-entry-name', entry.name));
        const config = PipelineLoader.getConfig(entry.pipeline);
        const badge = config?.renderer?.phase ?? entry.kind ?? '';
        row.appendChild(ce('span', 'pp-entry-kind', badge));
        wrap.appendChild(row);

        if (entry.params) {
            for (const [key, values] of Object.entries(entry.params)) {
                wrap.appendChild(this.renderParam(entry, key, values));
            }
        }

        if (config) {
            wrap.appendChild(this.renderConfig(entry, config));
        }
        return wrap;
    }

    private renderParam(entry: PipelineEntry, key: string, values: number[]): HTMLElement {
        const box = ce('div', 'pp-params');
        box.appendChild(ce('span', 'pp-param-label', key));
        values.forEach((v, i) => {
            const field = makeFloatField(v, newVal => this.patchStructural(data => {
                for (const list of Object.values(data.phases)) {
                    const target = (list ?? []).find(e => e.name === entry.name);
                    if (target && target.params?.[key]) target.params[key][i] = newVal;
                }
            }));
            box.appendChild(field.el);
        });
        return box;
    }

    private renderConfig(entry: PipelineEntry, config: PipelineConfig): HTMLElement {
        const box = ce('div', 'pp-config');
        const edit = (mutate: (c: PipelineConfig) => void): void => this.patchConfig(entry, mutate);

        // ── Primitive ──
        box.appendChild(this.field('topology', makeSelect(
            TOPOLOGY_OPTIONS, config.primitive.topology,
            v => edit(c => { c.primitive.topology = v as GPUPrimitiveTopology; }),
        )));
        box.appendChild(this.field('cullMode', makeSelect(
            CULL_OPTIONS, config.primitive.cullMode,
            v => edit(c => { c.primitive.cullMode = v as GPUCullMode; }),
        )));
        box.appendChild(this.field('frontFace', makeSelect(
            FRONT_FACE_OPTIONS, config.primitive.frontFace ?? 'ccw',
            v => edit(c => { c.primitive.frontFace = v as GPUFrontFace; }),
        )));

        // ── Blend ──
        const blendVal = typeof config.blend === 'string' ? config.blend : 'opaque';
        box.appendChild(this.field('blend', makeSelect(
            this.blendOptions, blendVal,
            v => edit(c => { c.blend = v as PipelineConfig['blend']; }),
        )));

        // ── Depth ──
        if (config.depthStencil) {
            const writeEnabled = config.depthStencil.depthWriteEnabled === true;
            box.appendChild(this.field('depthWrite', makeCheckbox(
                writeEnabled,
                v => edit(c => { if (c.depthStencil) c.depthStencil.depthWriteEnabled = v; }),
            )));
            const compare = (config.depthStencil.depthCompare as string) ?? 'less';
            box.appendChild(this.field('depthCompare', makeSelect(
                COMPARE_OPTIONS, compare,
                v => edit(c => { if (c.depthStencil) c.depthStencil.depthCompare = v as GPUCompareFunction; }),
            )));
        }

        return box;
    }

    private field(label: string, control: HTMLElement): HTMLElement {
        const row = ce('div', 'pp-config-row');
        row.appendChild(ce('span', 'pp-config-label', label));
        row.appendChild(control);
        return row;
    }
}
