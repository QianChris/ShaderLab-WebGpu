export type SlotName = string;

export interface SlotDef {
    location: number;
    format: GPUVertexFormat;
    stride: number;
    components: number;
}

export type VertexSlotDecls = Record<string, SlotDef>;

export const VERTEX_SLOTS: Record<SlotName, SlotDef> = {};

export const SLOT_ORDER: SlotName[] = [];

/** Slot name → owner tag ('engine' | 'plugin:<id>'). */
const SLOT_OWNERS = new Map<SlotName, string>();

export function loadVertexSlots(decls: VertexSlotDecls, owner = 'engine'): void {
    for (const [name, def] of Object.entries(decls)) {
        const existing = SLOT_OWNERS.get(name);
        if (existing !== undefined) {
            if (existing !== owner) {
                throw new Error(`Vertex slot '${name}' already declared by ${existing} (attempted by ${owner})`);
            }
            VERTEX_SLOTS[name] = def;   // same-owner reload → refresh decl
            continue;
        }
        const clash = Object.entries(VERTEX_SLOTS).find(([n, d]) => n !== name && d.location === def.location);
        if (clash) {
            throw new Error(`Vertex slot '${name}' location ${def.location} already used by slot '${clash[0]}'`);
        }
        SLOT_OWNERS.set(name, owner);
        VERTEX_SLOTS[name] = def;
        SLOT_ORDER.push(name);
    }
    SLOT_ORDER.sort((a, b) => VERTEX_SLOTS[a].location - VERTEX_SLOTS[b].location);
}

/** Remove every slot registered by `owner` (plugin unload). */
export function removeVertexSlotsByOwner(owner: string): void {
    for (const [name, o] of [...SLOT_OWNERS]) {
        if (o !== owner) continue;
        SLOT_OWNERS.delete(name);
        delete VERTEX_SLOTS[name];
        const i = SLOT_ORDER.indexOf(name);
        if (i >= 0) SLOT_ORDER.splice(i, 1);
    }
}

export function isSlotName(name: string): name is SlotName {
    return name in VERTEX_SLOTS;
}
