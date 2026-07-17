import { uniformLayouts } from './UniformLayout';
import { systemRegistry, type SystemBufferDecl } from '../ecs/SystemRegistry';

/** @deprecated use SystemBufferDecl from SystemRegistry — re-exported for back-compat. */
export type { SystemBufferDecl } from '../ecs/SystemRegistry';

const USAGE_FLAGS: Record<string, GPUBufferUsageFlags> = {
    uniform: GPUBufferUsage.UNIFORM,
    storage: GPUBufferUsage.STORAGE,
    vertex: GPUBufferUsage.VERTEX,
    index: GPUBufferUsage.INDEX,
    copy_src: GPUBufferUsage.COPY_SRC,
    copy_dst: GPUBufferUsage.COPY_DST,
    indirect: GPUBufferUsage.INDIRECT,
    'read-only-storage': GPUBufferUsage.STORAGE, // TS enum has no READ_ONLY_STORAGE; mapped below
};

const READ_ONLY_STORAGE = 0x00000080; // GPUBufferUsage.READ_ONLY_STORAGE (1 << 7)

/**
 * Module-singleton registry of named GPU buffers (UBOs + storage buffers)
 * declared by system defs. Replaces the implicit hardcoded UBO getters in
 * ResourceManager: a user can now declare `"buffers": [{"name":"mySsbo","size":4096}]`
 * in any system.json and reference it from bind-layouts.json via
 * `"resource": "mySsbo"` — no TS change required.
 *
 * Allocation: Engine.loadApp calls `allocateFor(activeSystems, appId, device)`
 * to allocate every app-scoped buffer declared by the active systems' defs;
 * `unloadCurrentApp` calls `exitApp(appId)` to release them. Common-scoped
 * buffers persist across app switches.
 *
 * Step 3 scope: only newly-declared buffers go through the registry. The four
 * legacy engine UBOs (camera/light/timeInput/pointShadowFaces) are migrated in
 * Step 4 (their ResourceManager getters will delegate here).
 */
class BufferRegistry {
    private buffers = new Map<string, GPUBuffer>();
    private owners = new Map<string, string>();

    /** Allocate every buffer declared by `systems`' defs.
     *  - `appId`: 'common' for engine-lifetime buffers (allocated once at init);
     *            any other string for app-scoped buffers (released on app switch).
     *  Idempotent: re-listing an already-allocated buffer is a no-op. */
    allocateFor(systems: { name: string }[], appId: string, device: GPUDevice): void {
        for (const entry of systems) {
            const def = systemRegistry.getDef(entry.name);
            if (!def) continue;
            // UBOs: name matches a uniform-layouts.json entry; layout = same name.
            for (const uboName of def.ubos ?? []) {
                this.ensure({
                    name: uboName,
                    layout: uboName,
                    scope: 'app',
                    usage: ['uniform', 'copy_dst'],
                }, appId, device);
            }
            // Storage / other buffers: explicit decl with size/layout/usage.
            for (const bufDecl of def.buffers ?? []) {
                this.ensure(bufDecl, appId, device);
            }
        }
    }

    /** Idempotent buffer allocation from a decl. Skips if already allocated. */
    private ensure(decl: SystemBufferDecl, appId: string, device: GPUDevice): void {
        if (this.buffers.has(decl.name)) return;
        const size = this.resolveSize(decl);
        if (size <= 0) throw new Error(`Buffer '${decl.name}' has zero size (need size|layout[+count])`);
        const usage = this.resolveUsage(decl);
        const buf = device.createBuffer({ label: decl.name, size, usage });
        this.buffers.set(decl.name, buf);
        this.owners.set(decl.name, decl.scope === 'common' ? 'common' : appId);
    }

    private resolveSize(decl: SystemBufferDecl): number {
        if (decl.size) return decl.size * (decl.count ?? 1);
        if (decl.layout) {
            const layout = uniformLayouts.get(decl.layout);
            return layout.byteSize * (decl.count ?? 1);
        }
        return 0;
    }

    private resolveUsage(decl: SystemBufferDecl): GPUBufferUsageFlags {
        const names = decl.usage ?? (decl.layout ? ['uniform', 'copy_dst'] : ['storage', 'copy_dst']);
        let flags = 0;
        for (const n of names) {
            if (n === 'read-only-storage') flags |= READ_ONLY_STORAGE;
            else flags |= USAGE_FLAGS[n] ?? 0;
        }
        return flags;
    }

    /** Get an allocated buffer by name (throws if not declared/allocated). */
    get(name: string): GPUBuffer {
        const buf = this.buffers.get(name);
        if (!buf) throw new Error(`Buffer '${name}' not declared in any system def`);
        return buf;
    }

    /** True if the named buffer is currently allocated. */
    has(name: string): boolean {
        return this.buffers.has(name);
    }

    /** Write data into a named buffer (queue.writeBuffer wrapper). */
    write(name: string, device: GPUDevice, data: BufferSource, offset = 0): void {
        device.queue.writeBuffer(this.get(name), offset, data);
    }

    /** Release all app-scoped buffers owned by `appId`. Common-scoped buffers stay. */
    exitApp(appId: string): void {
        for (const [name, owner] of this.owners) {
            if (owner !== appId) continue;
            this.buffers.get(name)?.destroy();
            this.buffers.delete(name);
            this.owners.delete(name);
        }
    }
}

export const bufferRegistry = new BufferRegistry();
