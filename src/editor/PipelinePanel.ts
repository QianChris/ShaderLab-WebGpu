import type { EditorHost } from './EditorHost';
import { type PipelineEntry, type PipelineConfig } from '../core/render/types';
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

export class PipelinePanel {
    private panel: HTMLElement;
    private host!: EditorHost;
    /** Undo/redo stacks: JSON snapshots of render graph data (phases + params). */
    private history: string[] = [];
    private future: string[] = [];
    private readonly MAX_HISTORY = 50;

    private get blendOptions(): string[] {
        return PipelineLoader.blendPresetNames.length > 0
            ? PipelineLoader.blendPresetNames
            : ['opaque', 'alpha', 'additive'];
    }

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(host: EditorHost): void {
        this.host = host;
        this.panel.tabIndex = 0;
        this.panel.addEventListener('keydown', (e) => {
            if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            } else if (e.ctrlKey && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
                e.preventDefault();
                this.redo();
            }
        });
    }

    /** Snapshot the current render graph state before a mutation (for undo). */
    private snapshot(): void {
        const data = JSON.stringify(this.host.renderGraph.toData());
        this.history.push(data);
        if (this.history.length > this.MAX_HISTORY) this.history.shift();
        this.future.length = 0;
    }

    private undo(): void {
        if (this.history.length === 0) return;
        const current = JSON.stringify(this.host.renderGraph.toData());
        this.future.push(current);
        const prev = this.history.pop()!;
        this.host.renderGraph.fromData(JSON.parse(prev));
        this.render();
    }

    private redo(): void {
        if (this.future.length === 0) return;
        const current = JSON.stringify(this.host.renderGraph.toData());
        this.history.push(current);
        const next = this.future.pop()!;
        this.host.renderGraph.fromData(JSON.parse(next));
        this.render();
    }

    render(): void {
        this.panel.innerHTML = '';

        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Render Pipeline'));
        this.panel.appendChild(head);

        const phases = this.host.renderGraph.phases;
        const phaseNames = this.host.renderGraph.getPhaseNames();
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
        chk.onchange = () => { this.snapshot(); entry.enabled = chk.checked; };
        row.appendChild(chk);
        row.appendChild(ce('span', 'pp-entry-name', entry.name));
        const config = PipelineLoader.getConfig(entry.pipeline);
        const badge = config?.renderer?.phase ?? entry.kind ?? '';
        row.appendChild(ce('span', 'pp-entry-kind', badge));
        wrap.appendChild(row);

        if (entry.params) {
            for (const [key, values] of Object.entries(entry.params)) {
                wrap.appendChild(this.renderParam(key, values));
            }
        }

        if (config) {
            wrap.appendChild(this.renderConfig(entry, config));
        }
        return wrap;
    }

    private renderParam(key: string, values: number[]): HTMLElement {
        const box = ce('div', 'pp-params');
        box.appendChild(ce('span', 'pp-param-label', key));
        values.forEach((v, i) => {
            const field = makeFloatField(v, newVal => { this.snapshot(); values[i] = newVal; });
            box.appendChild(field.el);
        });
        return box;
    }

    private renderConfig(entry: PipelineEntry, config: PipelineConfig): HTMLElement {
        const box = ce('div', 'pp-config');
        const recompile = (): void => {
            this.host.renderGraph.rebuildPipeline(this.host.engine.device, entry.pipeline);
        };

        // ── Primitive ──
        box.appendChild(this.field('topology', makeSelect(
            TOPOLOGY_OPTIONS, config.primitive.topology,
            v => { this.snapshot(); config.primitive.topology = v as GPUPrimitiveTopology; recompile(); },
        )));
        box.appendChild(this.field('cullMode', makeSelect(
            CULL_OPTIONS, config.primitive.cullMode,
            v => { this.snapshot(); config.primitive.cullMode = v as GPUCullMode; recompile(); },
        )));
        box.appendChild(this.field('frontFace', makeSelect(
            FRONT_FACE_OPTIONS, config.primitive.frontFace ?? 'ccw',
            v => { this.snapshot(); config.primitive.frontFace = v as GPUFrontFace; recompile(); },
        )));

        // ── Blend ──
        const blendVal = typeof config.blend === 'string' ? config.blend : 'opaque';
        box.appendChild(this.field('blend', makeSelect(
            this.blendOptions, blendVal,
            v => { this.snapshot(); config.blend = v as PipelineConfig['blend']; recompile(); },
        )));

        // ── Depth ──
        if (config.depthStencil) {
            const ds = config.depthStencil;
            const writeEnabled = ds.depthWriteEnabled === true;
            box.appendChild(this.field('depthWrite', makeCheckbox(
                writeEnabled,
                v => { this.snapshot(); ds.depthWriteEnabled = v; recompile(); },
            )));
            const compare = (ds.depthCompare as string) ?? 'less';
            box.appendChild(this.field('depthCompare', makeSelect(
                COMPARE_OPTIONS, compare,
                v => { this.snapshot(); ds.depthCompare = v as GPUCompareFunction; recompile(); },
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
