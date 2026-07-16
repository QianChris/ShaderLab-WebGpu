import { defineComponent, Types } from 'bitecs/legacy';

export interface FieldDef {
    type: string;
    default: unknown;
    options?: string[];
    role?: string;
}

export interface ComponentDef {
    name: string;
    mandatory?: boolean;
    fields: Record<string, FieldDef>;
}

const SCALAR_TYPE_MAP: Record<string, number> = {
    f32: Types.f32, i32: Types.i32, u32: Types.ui32, u8: Types.ui8, bool: Types.ui8,
};

const COMPOSITE_EXPAND: Record<string, string[]> = {
    vec2: ['x', 'y'],
    vec3: ['x', 'y', 'z'],
    vec4: ['x', 'y', 'z', 'w'],
};

type ExpandedField = { scalars: string[]; type: string; default: unknown; isString: boolean };

export class SchemaRegistry {
    defs: ComponentDef[] = [];
    comps = new Map<string, object>();
    nameMap = new Map<object, string>();
    mandatory = new Set<string>();

    expandMap = new Map<string, Map<string, ExpandedField>>();
    stringTables = new Map<string, string[]>();

    async load(url: string): Promise<void> {
        const resp = await fetch(url);
        const defs = await resp.json() as ComponentDef[];
        this.defs = [];
        this.register(defs);
    }

    /** Merge additional component definitions (e.g. app-specific) after the base set. */
    async loadMore(url: string): Promise<void> {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const defs = await resp.json() as ComponentDef[];
        this.register(defs);
    }

    private register(defs: ComponentDef[]): void {
        for (const def of defs) {
            if (this.comps.has(def.name)) continue;
            this.defs.push(def);
            if (def.mandatory) this.mandatory.add(def.name);

            const expandFields = new Map<string, ExpandedField>();
            const schema: Record<string, number> = {};

            for (const [logicalName, fd] of Object.entries(def.fields)) {
                if (fd.type === 'string') {
                    const sf = `_str_${logicalName}`;
                    schema[sf] = Types.ui32;
                    expandFields.set(logicalName, { scalars: [sf], type: 'string', default: fd.default, isString: true });
                    this.stringTables.set(`${def.name}.${logicalName}`, []);
                } else if (fd.type in COMPOSITE_EXPAND) {
                    const suffixes = COMPOSITE_EXPAND[fd.type];
                    const scalars = suffixes.map(s => `${logicalName}_${s}`);
                    for (const s of scalars) schema[s] = Types.f32;
                    expandFields.set(logicalName, { scalars, type: fd.type, default: fd.default, isString: false });
                } else {
                    schema[logicalName] = SCALAR_TYPE_MAP[fd.type] ?? Types.f32;
                    expandFields.set(logicalName, { scalars: [logicalName], type: fd.type, default: fd.default, isString: false });
                }
            }

            const comp = defineComponent(schema);
            this.comps.set(def.name, comp);
            this.nameMap.set(comp, def.name);
            this.expandMap.set(def.name, expandFields);
        }
    }

    get(name: string): object | undefined { return this.comps.get(name); }
    getName(comp: object): string | undefined { return this.nameMap.get(comp); }
    getDef(name: string): ComponentDef | undefined { return this.defs.find(d => d.name === name); }

    getStringTable(compName: string, field: string): string[] {
        return this.stringTables.get(`${compName}.${field}`) ?? [];
    }

    allocString(compName: string, field: string, value: string): number {
        const key = `${compName}.${field}`;
        let table = this.stringTables.get(key);
        if (!table) { table = []; this.stringTables.set(key, table); }
        table.push(value);
        return table.length - 1;
    }

    /** Clear every string table (call when the scene is reset so stale strings don't leak). */
    resetStrings(): void {
        for (const table of this.stringTables.values()) {
            table.length = 0;
        }
    }

    /* ── Composite read/write ─────────────────────── */

    getComposite(compName: string, comp: object, eid: number, field: string): unknown {
        const ef = this.expandMap.get(compName)?.get(field);
        if (!ef) return undefined;
        if (ef.isString) {
            const idx = (comp as any)[ef.scalars[0]]?.[eid];
            const table = this.stringTables.get(`${compName}.${field}`) ?? [];
            return idx != null ? (table[idx] ?? '') : '';
        }
        const arr = ef.scalars.map(s => (comp as any)[s]?.[eid] ?? 0);
        return arr;
    }

    setComposite(compName: string, comp: object, eid: number, field: string, value: unknown): void {
        const ef = this.expandMap.get(compName)?.get(field);
        if (!ef) return;
        if (ef.isString) {
            const raw = Array.isArray(value) ? value[0] : value;
            const idx = typeof raw === 'number' ? raw : this.allocString(compName, field, String(raw));
            (comp as any)[ef.scalars[0]][eid] = idx;
        } else {
            const vals = Array.isArray(value) ? value : [value];
            const n = Math.min(vals.length, ef.scalars.length);
            for (let i = 0; i < n; i++) (comp as any)[ef.scalars[i]][eid] = Number(vals[i]) ?? 0;
        }
    }

    /* ── Full read / apply ────────────────────────── */

    applyDefaults(compName: string, data: Record<string, unknown>): Record<string, unknown[]> {
        const def = this.getDef(compName);
        if (!def) return {};
        const result: Record<string, unknown[]> = {};
        for (const [key, fd] of Object.entries(def.fields)) {
            const ef = this.expandMap.get(compName)?.get(key);
            if (!ef) continue;
            const dVal = fd.default;
            const v = key in data ? data[key] : (Array.isArray(dVal) ? [...dVal] : dVal);
            if (ef.isString) {
                const s = String(v);
                result[key] = [this.allocString(compName, key, s)];
            } else if (Array.isArray(v)) {
                result[key] = v.map(Number);
            } else {
                result[key] = [Number(v)];
            }
        }
        return result;
    }

    setAllFields(compName: string, comp: object, eid: number, data: Record<string, unknown>): void {
        const applied = this.applyDefaults(compName, data);
        for (const [field, val] of Object.entries(applied)) {
            this.setComposite(compName, comp, eid, field, val);
        }
    }

    readAllFields(compName: string, comp: object, eid: number): Record<string, unknown> {
        const def = this.getDef(compName);
        if (!def) return {};
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(def.fields)) {
            result[key] = this.getComposite(compName, comp, eid, key);
        }
        return result;
    }

    getFieldDefs(compName: string): [string, FieldDef][] {
        const def = this.getDef(compName);
        return def ? Object.entries(def.fields) : [];
    }

    getFieldDefault(compName: string, field: string): unknown {
        return this.getDef(compName)?.fields[field]?.default;
    }

    /* ── Field roles (render tag metadata) ────────── */

    /** First field name in a component tagged with the given role, or undefined. */
    getFieldByRole(compName: string, role: string): string | undefined {
        const def = this.getDef(compName);
        if (!def) return undefined;
        for (const [name, fd] of Object.entries(def.fields)) {
            if (fd.role === role) return name;
        }
        return undefined;
    }

    /** A component is a render tag if any of its fields declares a role. */
    isRenderTag(compName: string): boolean {
        const def = this.getDef(compName);
        if (!def) return false;
        return Object.values(def.fields).some(fd => fd.role != null);
    }

    /* ── Scalar access for renderer ───────────────── */

    getScalar(comp: object, eid: number, scalarName: string): number {
        return (comp as any)[scalarName]?.[eid] ?? 0;
    }

    getScalarField(compName: string, comp: object, eid: number, field: string, index: number): number {
        const ef = this.expandMap.get(compName)?.get(field);
        if (!ef || index >= ef.scalars.length) return 0;
        return (comp as any)[ef.scalars[index]]?.[eid] ?? 0;
    }

    getScalarNames(compName: string, field: string): string[] {
        return this.expandMap.get(compName)?.get(field)?.scalars ?? [];
    }
}

export const schemaRegistry = new SchemaRegistry();
