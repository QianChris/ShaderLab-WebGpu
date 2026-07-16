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

export function loadVertexSlots(decls: VertexSlotDecls): void {
    for (const [name, def] of Object.entries(decls)) {
        VERTEX_SLOTS[name] = def;
        SLOT_ORDER.push(name);
    }
    SLOT_ORDER.sort((a, b) => VERTEX_SLOTS[a].location - VERTEX_SLOTS[b].location);
}

export function isSlotName(name: string): name is SlotName {
    return name in VERTEX_SLOTS;
}
