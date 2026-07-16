import type { Engine } from '../Engine';
import { schemaRegistry } from '../ecs/SchemaRegistry';
import { ce, makeFloatField, makeSelect } from './dom';

export class EditorPanel {
    private panel: HTMLElement;
    private engine!: Engine;
    private selected = '';
    private syncers: (() => void)[] = [];
    private syncTimer = 0;
    private lastEntityCount = -1;
    /** Called when loadJSON receives an app.json manifest; main.ts wires this to
     *  engine.loadApp + panel refresh so glTF / render graph / tools all reload. */
    onAppSwitch?: (name: string) => Promise<void>;

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(engine: Engine): void {
        this.engine = engine;
        if (this.syncTimer === 0) {
            this.syncTimer = window.setInterval(() => {
                // Rebuild entity list when entities are added/removed by scripts
                // (e.g. demo2's ball spawner) — syncers alone only update field values.
                const count = this.engine.scene.entityKeyMap.size;
                if (count !== this.lastEntityCount) {
                    this.lastEntityCount = count;
                    this.render();
                    return;
                }
                for (const sync of this.syncers) sync();
            }, 100);
        }
    }

    render(): void {
        this.panel.innerHTML = '';
        this.syncers = [];
        const scene = this.engine.scene;
        this.lastEntityCount = scene.entityKeyMap.size;

        // ── Header ──
        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Scene Editor'));
        const btns = ce('div', 'editor-btn-row');
        btns.appendChild(this.btn('Save JSON', () => this.saveJSON()));
        btns.appendChild(this.btn('Load JSON', () => this.loadJSON()));
        head.appendChild(btns);
        this.panel.appendChild(head);

        // ── Entity list ──
        const list = ce('div', 'ed-ent-list');
        const listHead = ce('div', 'ed-ent-list-head');
        listHead.appendChild(ce('span', '', 'Entities'));
        const ab = ce('div', 'ed-ent-list-actions');
        ab.appendChild(this.btn('+', () => this.addEntity()));
        ab.appendChild(this.btn('✕', () => { if (this.selected) { scene.removeEntity(this.selected); this.selected = ''; this.render(); } }));
        listHead.appendChild(ab);
        list.appendChild(listHead);

        const rows = ce('div', 'ed-ent-rows');
        for (const { key } of scene.getAllEntities()) {
            const row = ce('div', `ed-ent-row ${this.selected === key ? 'ed-ent-sel' : ''}`);
            const name = scene.getField(scene.entityKeyMap.get(key)!, 'NameComponent', 'name') as string ?? key;
            row.appendChild(ce('span', 'ed-ent-name', name));
            row.onclick = () => { this.selected = key; this.render(); };
            rows.appendChild(row);
        }
        list.appendChild(rows);

        if (!this.selected && scene.entityKeyMap.size > 0) {
            this.selected = [...scene.entityKeyMap.keys()][0];
        }
        this.panel.appendChild(list);

        // ── Selected entity detail ──
        if (this.selected && scene.entityKeyMap.has(this.selected)) {
            const eid = scene.entityKeyMap.get(this.selected)!;
            const detail = this.renderDetail(eid);
            this.panel.appendChild(detail);
        }
    }

    private renderDetail(eid: number): HTMLElement {
        const scene = this.engine.scene;
        const wrap = ce('div', 'ed-detail');

        const hdr = ce('div', 'ed-detail-head');
        const name = scene.getField(eid, 'NameComponent', 'name') as string ?? this.selected;
        hdr.appendChild(ce('span', '', `Components — ${name}`));
        wrap.appendChild(hdr);

        const compNames = scene.componentNames
            .filter(compName => {
                const def = schemaRegistry.getDef(compName);
                return def && Object.keys(def.fields).length > 0;
            })
            .sort((a, b) => Number(scene.hasComponent(eid, b)) - Number(scene.hasComponent(eid, a)));

        for (const compName of compNames) {
            const def = schemaRegistry.getDef(compName)!;

            const hasComp = scene.hasComponent(eid, compName);
            const locked = schemaRegistry.mandatory.has(compName);

            const compDiv = ce('div', `ed-comp ${hasComp ? '' : 'ed-comp-off'}`);
            const compHead = ce('div', 'ed-comp-head');

            if (locked) {
                compHead.appendChild(ce('span', 'ed-lock', '🔒'));
            } else {
                const chk = ce('input') as HTMLInputElement;
                chk.type = 'checkbox'; chk.checked = hasComp;
                chk.onchange = () => { scene.toggleComponent(eid, compName, chk.checked); this.render(); };
                compHead.appendChild(chk);
            }
            compHead.appendChild(ce('span', '', compName));
            compDiv.appendChild(compHead);

            if (hasComp) {
                const grid = ce('div', 'ed-fields');
                for (const [fieldName, fd] of Object.entries(def.fields)) {
                    grid.appendChild(this.renderField(eid, compName, fieldName, fd));
                }
                compDiv.appendChild(grid);
            }
            wrap.appendChild(compDiv);
        }
        return wrap;
    }

    private renderField(eid: number, compName: string, field: string, fd: { type: string; default: unknown; options?: string[] }): HTMLElement {
        const scene = this.engine.scene;
        const row = ce('div', 'ed-field-row');
        row.appendChild(ce('label', 'ed-field-label', field));

        const val = scene.getField(eid, compName, field);
        const numInputs = ce('div', 'ed-field-inputs');

        if (fd.type === 'string' && fd.options) {
            const sel = makeSelect(fd.options, (val as string) ?? String(fd.default), v => scene.setField(eid, compName, field, v));
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field) as string | undefined;
                if (cur != null) sel.value = cur;
            });
            numInputs.appendChild(sel);
        } else if (fd.type === 'string') {
            const inp = this.makeInput('text', val as string, v => scene.setField(eid, compName, field, v));
            numInputs.appendChild(inp);
        } else if (fd.type === 'bool') {
            const chk = ce('input', 'ed-check') as HTMLInputElement;
            chk.type = 'checkbox';
            chk.checked = Number(val ?? fd.default) === 1;
            chk.onchange = () => scene.setField(eid, compName, field, chk.checked ? 1 : 0);
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field);
                if (cur != null) chk.checked = Number(cur) === 1;
            });
            numInputs.appendChild(chk);
        } else if (fd.type === 'f32' || fd.type === 'u32') {
            const defVal = (fd.default as number[]) ?? [0];
            const v = val != null ? Number(val) : defVal[0] ?? 0;
            const el = makeFloatField(v, newVal => {
                scene.setField(eid, compName, field, newVal);
            });
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field);
                if (cur != null) el.setValue(Number(cur));
            });
            numInputs.appendChild(el.el);
        } else if (fd.type === 'vec2' || fd.type === 'vec3' || fd.type === 'vec4') {
            const count = parseInt(fd.type[3]);
            const arr = (Array.isArray(val) ? val : (fd.default as number[])) as number[];
            for (let i = 0; i < count; i++) {
                const el = makeFloatField(arr[i] ?? 0, newVal => {
                    const a = [...(scene.getField(eid, compName, field) as number[] ?? (fd.default as number[]))];
                    for (let j = 0; j < count; j++) a[j] = a[j] ?? 0;
                    a[i] = newVal;
                    scene.setField(eid, compName, field, a);
                });
                this.syncers.push(() => {
                    const cur = scene.getField(eid, compName, field) as number[] | undefined;
                    if (cur?.[i] != null) el.setValue(cur[i]);
                });
                numInputs.appendChild(el.el);
            }
        }
        row.appendChild(numInputs);
        return row;
    }

    private makeInput(type: string, val: string, onChange: (v: string) => void): HTMLInputElement {
        const inp = ce('input', 'ed-input') as HTMLInputElement;
        inp.type = type; inp.value = val;
        inp.onchange = () => onChange(inp.value);
        return inp;
    }

    private btn(text: string, cb: () => void): HTMLButtonElement {
        const b = ce('button', 'editor-btn', text);
        b.onclick = cb; return b as HTMLButtonElement;
    }

    private addEntity(): void {
        const name = prompt('Entity name:', 'NewEntity');
        if (!name) return;
        this.engine.scene.createEntity(name, {});
        this.selected = name;
        this.render();
    }

    private saveJSON(): void {
        const json = { entities: this.engine.scene.toJSON() };
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'scene.json'; a.click();
    }

    private loadJSON(): void {
        const input = ce('input') as HTMLInputElement;
        input.type = 'file'; input.accept = '.json';
        input.onchange = async () => {
            const file = input.files?.[0]; if (!file) return;
            const json = JSON.parse(await file.text()) as Record<string, unknown>;
            // App manifest (has gltf/render/scene-as-string) → full app reload,
            // which re-loads glTF models, render graph and tools via loadApp.
            const isAppManifest = !!json.gltf || !!json.render
                || (typeof json.scene === 'string');
            if (isAppManifest) {
                const name = json.name as string | undefined;
                if (!name) { alert('app manifest missing "name" field'); return; }
                if (this.onAppSwitch) {
                    await this.onAppSwitch(name);
                } else {
                    await this.engine.loadApp(name);
                }
            } else {
                // Scene entity data → reload entities in place (no glTF / render graph).
                for (const k of [...this.engine.scene.entityKeyMap.keys()]) {
                    this.engine.scene.removeEntity(k);
                }
                this.engine.loadSceneData((json.entities ?? json) as import('../ecs/Scene').SceneData);
            }
            this.selected = '';
            this.render();
        };
        input.click();
    }
}
