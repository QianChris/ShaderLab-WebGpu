import type { EditorHost } from './EditorHost';
import { schemaRegistry } from '../ecs/SchemaRegistry';
import { ce, makeFloatField, makeSelect } from './dom';

export class EditorPanel {
    private panel: HTMLElement;
    private host!: EditorHost;
    private selected = '';
    private syncers: (() => void)[] = [];
    private lastEntityCount = -1;
    /** Scroll position of the entity list (preserved across re-renders). */
    private entityScrollTop = 0;
    /** Estimated entity row height in pixels (matches CSS ed-ent-row). */
    private readonly ROW_H = 28;
    /** Maximum visible rows in the entity list viewport. */
    private readonly VISIBLE_ROWS = 18;
    /** Called when loadJSON receives an app.json manifest; main.ts wires this to
     *  engine.loadApp + panel refresh so glTF / render graph / tools all reload. */
    onAppSwitch?: (name: string) => Promise<void>;

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(host: EditorHost): void {
        this.host = host;
        host.engine.eventBus.on('editor:changed', () => {
            const count = host.scene.entityKeyMap.size;
            if (count !== this.lastEntityCount) {
                this.lastEntityCount = count;
                this.render();
                return;
            }
            for (const sync of this.syncers) sync();
        });
    }

    render(): void {
        this.panel.innerHTML = '';
        this.syncers = [];
        const scene = this.host.scene;
        this.lastEntityCount = scene.entityKeyMap.size;

        // ── Header ──
        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Scene Editor'));
        const btns = ce('div', 'editor-btn-row');
        btns.appendChild(this.btn('Save JSON', () => this.saveJSON()));
        btns.appendChild(this.btn('Load JSON', () => this.loadJSON()));
        head.appendChild(btns);
        this.panel.appendChild(head);

        // ── Entity list (virtual scroll) ──
        const list = ce('div', 'ed-ent-list');
        const listHead = ce('div', 'ed-ent-list-head');
        listHead.appendChild(ce('span', '', 'Entities'));
        const ab = ce('div', 'ed-ent-list-actions');
        ab.appendChild(this.btn('+', () => this.addEntity()));
        ab.appendChild(this.btn('✕', () => { if (this.selected) { this.host.removeEntity(this.selected); this.selected = ''; this.render(); } }));
        listHead.appendChild(ab);
        list.appendChild(listHead);

        const allEntities = scene.getAllEntities();
        const total = allEntities.length;
        const rowsScroll = ce('div', 'ed-ent-rows');
        rowsScroll.style.maxHeight = `${this.ROW_H * this.VISIBLE_ROWS}px`;
        rowsScroll.style.overflowY = 'auto';
        rowsScroll.style.position = 'relative';
        rowsScroll.scrollTop = this.entityScrollTop;
        rowsScroll.onscroll = () => {
            this.entityScrollTop = rowsScroll.scrollTop;
            this.renderVisibleRows(content, allEntities);
        };

        // Content container sized to the full list height so the scrollbar
        // reflects the true entity count; only visible rows are in the DOM.
        const content = ce('div');
        content.style.height = `${total * this.ROW_H}px`;
        content.style.position = 'relative';
        this.renderVisibleRows(content, allEntities);
        rowsScroll.appendChild(content);
        list.appendChild(rowsScroll);

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

    /** Render only the entity rows visible in the scroll viewport (+ a small
     *  overscan buffer). Rows are absolutely positioned within the content
     *  container so the scrollbar reflects the true entity count without
     *  materializing a DOM node per entity. */
    private renderVisibleRows(content: HTMLElement, allEntities: { key: string }[]): void {
        content.innerHTML = '';
        const total = allEntities.length;
        const overscan = 5;
        const start = Math.max(0, Math.floor(this.entityScrollTop / this.ROW_H) - overscan);
        const end = Math.min(total, start + this.VISIBLE_ROWS + overscan * 2);
        for (let i = start; i < end; i++) {
            const { key } = allEntities[i];
            const row = ce('div', `ed-ent-row ${this.selected === key ? 'ed-ent-sel' : ''}`);
            row.style.position = 'absolute';
            row.style.top = `${i * this.ROW_H}px`;
            row.style.height = `${this.ROW_H}px`;
            row.style.width = '100%';
            row.style.boxSizing = 'border-box';
            const eid = this.host.scene.entityKeyMap.get(key);
            const name = eid != null
                ? (this.host.scene.getField(eid, 'NameComponent', 'name') as string ?? key)
                : key;
            row.appendChild(ce('span', 'ed-ent-name', name));
            row.onclick = () => { this.selected = key; this.render(); };
            content.appendChild(row);
        }
    }

    private renderDetail(eid: number): HTMLElement {
        const scene = this.host.scene;
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
                    grid.appendChild(this.renderField(this.selected, eid, compName, fieldName, fd));
                }
                compDiv.appendChild(grid);
            }
            wrap.appendChild(compDiv);
        }
        return wrap;
    }

    private renderField(entityKey: string, eid: number, compName: string, field: string, fd: { type: string; default: unknown; options?: string[] }): HTMLElement {
        const scene = this.host.scene;
        const row = ce('div', 'ed-field-row');
        row.appendChild(ce('label', 'ed-field-label', field));

        const val = scene.getField(eid, compName, field);
        const numInputs = ce('div', 'ed-field-inputs');

        if (fd.type === 'string' && fd.options) {
            const sel = makeSelect(fd.options, (val as string) ?? String(fd.default), v => this.host.setField(entityKey, compName, field, v));
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field) as string | undefined;
                if (cur != null) sel.value = cur;
            });
            numInputs.appendChild(sel);
        } else if (fd.type === 'string') {
            const inp = this.makeInput('text', val as string, v => this.host.setField(entityKey, compName, field, v));
            numInputs.appendChild(inp);
        } else if (fd.type === 'bool') {
            const chk = ce('input', 'ed-check') as HTMLInputElement;
            chk.type = 'checkbox';
            chk.checked = Number(val ?? fd.default) === 1;
            chk.onchange = () => this.host.setField(entityKey, compName, field, chk.checked ? 1 : 0);
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field);
                if (cur != null) chk.checked = Number(cur) === 1;
            });
            numInputs.appendChild(chk);
        } else if (fd.type === 'f32' || fd.type === 'u32') {
            const defVal = (fd.default as number[]) ?? [0];
            const v = val != null ? Number(val) : defVal[0] ?? 0;
            const el = makeFloatField(v, newVal => {
                this.host.setField(entityKey, compName, field, newVal);
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
                    this.host.setField(entityKey, compName, field, a);
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
        this.host.createEntity(name, {});
        this.selected = name;
        this.render();
    }

    private saveJSON(): void {
        const json = { entities: this.host.scene.toJSON() };
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
                    await this.host.engine.loadApp(name);
                }
            } else {
                // Scene entity data → reload entities in place (no glTF / render graph).
                for (const k of [...this.host.scene.entityKeyMap.keys()]) {
                    this.host.scene.removeEntity(k);
                }
                this.host.engine.loadSceneData((json.entities ?? json) as import('../ecs/Scene').SceneData);
            }
            this.selected = '';
            this.render();
        };
        input.click();
    }
}
