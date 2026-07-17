/**
 * std140 uniform block layout, data-driven from uniform-layouts.json.
 *
 * Given a named list of members, computes each member's float offset following
 * WGSL uniform (std140) alignment rules, so the renderer can write fields by
 * name instead of hard-coded array indices.
 */

export type UniformMemberType =
    | 'f32' | 'i32' | 'u32'
    | 'vec2f' | 'vec3f' | 'vec4f'
    | 'mat3x3f' | 'mat4x4f';

export interface UniformMemberDecl {
    name: string;
    type: UniformMemberType;
}

export type UniformLayoutDecls = Record<string, UniformMemberDecl[]>;

interface TypeInfo {
    align: number;   // bytes
    size: number;    // bytes
}

const TYPE_INFO: Record<UniformMemberType, TypeInfo> = {
    f32:     { align: 4,  size: 4 },
    i32:     { align: 4,  size: 4 },
    u32:     { align: 4,  size: 4 },
    vec2f:   { align: 8,  size: 8 },
    vec3f:   { align: 16, size: 12 },
    vec4f:   { align: 16, size: 16 },
    mat3x3f: { align: 16, size: 48 },   // 3 columns, each vec3 padded to 16
    mat4x4f: { align: 16, size: 64 },
};

function alignUp(offset: number, align: number): number {
    return Math.ceil(offset / align) * align;
}

interface MemberOffset {
    type: UniformMemberType;
    byteOffset: number;
    floatOffset: number;
}

export class UniformLayout {
    /** Total block size in bytes, rounded up to a 16-byte boundary. */
    readonly byteSize: number;
    /** Total block size in floats. */
    readonly floatCount: number;

    private members = new Map<string, MemberOffset>();

    constructor(decls: UniformMemberDecl[]) {
        let offset = 0;
        for (const m of decls) {
            const info = TYPE_INFO[m.type];
            offset = alignUp(offset, info.align);
            this.members.set(m.name, { type: m.type, byteOffset: offset, floatOffset: offset / 4 });
            offset += info.size;
        }
        this.byteSize = alignUp(offset, 16);
        this.floatCount = this.byteSize / 4;
    }

    /** Float index of a member within the block (throws if unknown). */
    floatOffsetOf(name: string): number {
        const m = this.members.get(name);
        if (!m) throw new Error(`Uniform member '${name}' not declared`);
        return m.floatOffset;
    }

    /** Whether a member is declared in this layout. */
    has(name: string): boolean {
        return this.members.has(name);
    }

    /** Allocate a zeroed Float32Array sized for this block. */
    createBuffer(): Float32Array {
        return new Float32Array(this.floatCount);
    }

    /** Write a scalar or vector/matrix component array into a member slot. */
    write(buf: Float32Array, name: string, value: number | ArrayLike<number>): void {
        const base = this.floatOffsetOf(name);
        if (typeof value === 'number') {
            buf[base] = value;
        } else {
            buf.set(value, base);
        }
    }

    /** Write a u32 value into a member slot (via a Uint32Array view of the same buffer). */
    writeU32(buf: Uint32Array, name: string, value: number): void {
        const base = this.floatOffsetOf(name);
        buf[base] = value >>> 0;
    }
}

export class UniformLayoutRegistry {
    private layouts = new Map<string, UniformLayout>();

    load(decls: UniformLayoutDecls): void {
        for (const [name, members] of Object.entries(decls)) {
            this.layouts.set(name, new UniformLayout(members));
        }
    }

    has(name: string): boolean {
        return this.layouts.has(name);
    }

    get(name: string): UniformLayout {
        const layout = this.layouts.get(name);
        if (!layout) throw new Error(`Uniform layout '${name}' not found`);
        return layout;
    }
}

export const uniformLayouts = new UniformLayoutRegistry();
