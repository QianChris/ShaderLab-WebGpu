import type { Engine } from '../Engine';
import { type PipelineEntry, type PipelineConfig } from '../render/types';
import { PipelineLoader } from '../render/PipelineLoader';
import { ce, makeFloatField, makeSelect, makeCheckbox } from './dom';

const TOPOLOGY_OPTIONS: string[] = [
    'point-list', 'line-list', 'line-strip', 'triangle-list', 'triangle-strip',
];
const CULL_OPTIONS: string[] = ['none', 'front', 'back'];
const FRONT_FACE_OPTIONS: string[] = ['ccw', 'cw'];
const COMPARE_OPTIONS: string[] = [
    'never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always',
];
const BLEND_OPTIONS: string[] = ['opaque', 'alpha', 'additive'];

export class PipelinePanel {
    private panel: HTMLElement;
    private engine!: Engine;

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(engine: Engine): void { this.engine = engine; }

    render(): void {
        this.panel.innerHTML = '';

        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Render Pipeline'));
        this.panel.appendChild(head);

        const phases = this.engine.renderGraph.phases;
        const phaseNames = this.engine.renderGraph.getPhaseNames();
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
        chk.onchange = () => { entry.enabled = chk.checked; };
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
            const field = makeFloatField(v, newVal => { values[i] = newVal; });
            box.appendChild(field.el);
        });
        return box;
    }

    private renderConfig(entry: PipelineEntry, config: PipelineConfig): HTMLElement {
        const box = ce('div', 'pp-config');
        const recompile = (): void => {
            this.engine.renderGraph.rebuildPipeline(this.engine.device, entry.pipeline);
        };

        // ── Primitive ──
        box.appendChild(this.field('topology', makeSelect(
            TOPOLOGY_OPTIONS, config.primitive.topology,
            v => { config.primitive.topology = v as GPUPrimitiveTopology; recompile(); },
        )));
        box.appendChild(this.field('cullMode', makeSelect(
            CULL_OPTIONS, config.primitive.cullMode,
            v => { config.primitive.cullMode = v as GPUCullMode; recompile(); },
        )));
        box.appendChild(this.field('frontFace', makeSelect(
            FRONT_FACE_OPTIONS, config.primitive.frontFace ?? 'ccw',
            v => { config.primitive.frontFace = v as GPUFrontFace; recompile(); },
        )));

        // ── Blend ──
        const blendVal = typeof config.blend === 'string' ? config.blend : 'opaque';
        box.appendChild(this.field('blend', makeSelect(
            BLEND_OPTIONS, blendVal,
            v => { config.blend = v as PipelineConfig['blend']; recompile(); },
        )));

        // ── Depth ──
        if (config.depthStencil) {
            const ds = config.depthStencil;
            const writeEnabled = ds.depthWriteEnabled === true;
            box.appendChild(this.field('depthWrite', makeCheckbox(
                writeEnabled,
                v => { ds.depthWriteEnabled = v; recompile(); },
            )));
            const compare = (ds.depthCompare as string) ?? 'less';
            box.appendChild(this.field('depthCompare', makeSelect(
                COMPARE_OPTIONS, compare,
                v => { ds.depthCompare = v as GPUCompareFunction; recompile(); },
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
