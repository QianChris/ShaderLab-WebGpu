export type GpuResourceKind = 'buffer' | 'sampler' | 'texture';

interface GpuResourceBase {
    kind: GpuResourceKind;
}

export interface GpuBufferResource extends GpuResourceBase {
    kind: 'buffer';
    buffer: GPUBuffer;
    offset?: number;
    size?: number;
    /** Destroy the buffer when it is replaced, unregistered, or its owner is swept. */
    owned?: boolean;
}

export interface GpuSamplerResource extends GpuResourceBase {
    kind: 'sampler';
    sampler: GPUSampler;
}

export interface GpuTextureResource extends GpuResourceBase {
    kind: 'texture';
    /** Register either a texture (the registry creates one stable view) or a borrowed view. */
    texture?: GPUTexture;
    view?: GPUTextureView;
    viewDescriptor?: GPUTextureViewDescriptor;
    /** Only valid with `texture`; borrowed views never own their source texture. */
    owned?: boolean;
}

export type GpuResourceDescriptor = GpuBufferResource | GpuSamplerResource | GpuTextureResource;
export type GpuResourceSet = Readonly<Record<string, GpuResourceDescriptor>>;

interface GpuResourceEntry {
    owner: string;
    kind: GpuResourceKind;
    resource: GPUBindingResource;
    identity: object;
    destroy?: () => void;
}

interface RegisteredGpuResourceSet {
    name: string;
    owner: string;
    resourceNames: readonly string[];
}

/**
 * Owner-aware registry for GPU resources shared across pipelines and plugins.
 * Pipeline declarations consume entries through `resource:<name>` without
 * knowing which plugin created the underlying WebGPU object.
 */
export class GpuResourceRegistry {
    private entries = new Map<string, GpuResourceEntry>();
    private sets = new Map<string, RegisteredGpuResourceSet>();

    registerSet(setName: string, resources: GpuResourceSet, owner: string): void {
        this.assertName(setName, 'set');
        const setKey = this.setKey(setName, owner);
        if (this.sets.has(setKey)) {
            throw new Error(`GPU resource set '${setName}' is already registered by ${owner}`);
        }
        const names = Object.keys(resources);
        this.assertSetNotEmpty(names);
        for (const name of names) {
            this.assertName(name, 'resource');
            const existing = this.entries.get(name);
            if (existing) {
                throw new Error(`GPU resource '${name}' already registered by ${existing.owner}`);
            }
        }

        const prepared = names.map((name) => [
            name,
            this.makeEntry(resources[name], owner),
        ] as const);
        for (const [name, entry] of prepared) this.entries.set(name, entry);
        this.sets.set(setKey, { name: setName, owner, resourceNames: names });
    }

    replaceSet(setName: string, resources: GpuResourceSet, owner: string): void {
        this.assertName(setName, 'set');
        const registeredSet = this.sets.get(this.setKey(setName, owner));
        if (!registeredSet) {
            throw new Error(`GPU resource set '${setName}' is not registered by ${owner}`);
        }
        const names = Object.keys(resources);
        this.assertSetNotEmpty(names);
        this.assertSameMembers(registeredSet, names);
        const previous: GpuResourceEntry[] = [];
        for (const name of names) {
            this.assertName(name, 'resource');
            const existing = this.entries.get(name);
            if (!existing) throw new Error(`GPU resource '${name}' is not registered`);
            if (existing.owner !== owner) {
                throw new Error(`GPU resource '${name}' is owned by ${existing.owner}, not ${owner}`);
            }
            previous.push(existing);
        }

        // Build every view/binding before exposing any replacement.
        const prepared = names.map((name) => [
            name,
            this.makeEntry(resources[name], owner),
        ] as const);
        for (const [name, entry] of prepared) this.entries.set(name, entry);
        for (let i = 0; i < previous.length; i++) {
            this.destroyReplaced(previous[i], prepared[i][1]);
        }
    }

    unregisterSet(setName: string, owner: string): void {
        this.assertName(setName, 'set');
        const setKey = this.setKey(setName, owner);
        const registeredSet = this.sets.get(setKey);
        if (!registeredSet) {
            throw new Error(`GPU resource set '${setName}' is not registered by ${owner}`);
        }
        const previous: GpuResourceEntry[] = [];
        for (const name of registeredSet.resourceNames) {
            const existing = this.entries.get(name);
            if (!existing) throw new Error(`GPU resource '${name}' is not registered`);
            if (existing.owner !== owner) {
                throw new Error(`GPU resource '${name}' is owned by ${existing.owner}, not ${owner}`);
            }
            previous.push(existing);
        }
        for (const name of registeredSet.resourceNames) this.entries.delete(name);
        this.sets.delete(setKey);
        for (const entry of previous) entry.destroy?.();
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    resolve(name: string, expectedKind?: GpuResourceKind): GPUBindingResource {
        const entry = this.entries.get(name);
        if (!entry) throw new Error(`GPU resource '${name}' is not registered`);
        if (expectedKind && entry.kind !== expectedKind) {
            throw new Error(
                `GPU resource '${name}' is ${entry.kind}, but the bind layout expects ${expectedKind}`,
            );
        }
        return entry.resource;
    }

    names(): string[] {
        return [...this.entries.keys()];
    }

    clear(): void {
        for (const entry of this.entries.values()) entry.destroy?.();
        this.entries.clear();
        this.sets.clear();
    }

    removeOwner(owner: string): void {
        const ownedSets = [...this.sets.values()].filter(set => set.owner === owner);
        for (const set of ownedSets) this.unregisterSet(set.name, owner);

        for (const entry of this.entries.values()) {
            if (entry.owner === owner) {
                throw new Error(`GPU resource owner '${owner}' has an ungrouped resource`);
            }
        }
    }

    private assertName(name: string, subject: 'resource' | 'set'): void {
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(name)) {
            throw new Error(
                `GPU resource ${subject} name '${name}' must be lowercase ASCII segments ` +
                `separated by '.' or '-'`,
            );
        }
    }

    private assertSetNotEmpty(names: readonly string[]): void {
        if (names.length === 0) throw new Error(`GPU resource set must not be empty`);
    }

    private assertSameMembers(set: RegisteredGpuResourceSet, names: readonly string[]): void {
        const nextNames = new Set(names);
        const missing = set.resourceNames.filter(name => !nextNames.has(name));
        const unexpected = names.filter(name => !set.resourceNames.includes(name));
        if (missing.length === 0 && unexpected.length === 0) return;
        throw new Error(
            `GPU resource set '${set.name}' must keep the same members; ` +
            `missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
        );
    }

    private setKey(setName: string, owner: string): string {
        return `${owner}\0${setName}`;
    }

    private makeEntry(descriptor: GpuResourceDescriptor, owner: string): GpuResourceEntry {
        if (descriptor.kind === 'buffer') {
            const binding: GPUBufferBinding = { buffer: descriptor.buffer };
            if (descriptor.offset !== undefined) binding.offset = descriptor.offset;
            if (descriptor.size !== undefined) binding.size = descriptor.size;
            return {
                owner,
                kind: 'buffer',
                resource: binding,
                identity: descriptor.buffer,
                destroy: descriptor.owned ? () => descriptor.buffer.destroy() : undefined,
            };
        }
        if (descriptor.kind === 'sampler') {
            return {
                owner,
                kind: 'sampler',
                resource: descriptor.sampler,
                identity: descriptor.sampler,
            };
        }

        const hasTexture = descriptor.texture !== undefined;
        const hasView = descriptor.view !== undefined;
        if (hasTexture === hasView) {
            throw new Error(`GPU texture resource must provide exactly one of 'texture' or 'view'`);
        }
        if (descriptor.owned && !descriptor.texture) {
            throw new Error(`A borrowed GPUTextureView cannot be registered as owned`);
        }
        const view = descriptor.view ?? descriptor.texture!.createView(descriptor.viewDescriptor);
        return {
            owner,
            kind: 'texture',
            resource: view,
            identity: descriptor.texture ?? descriptor.view!,
            destroy: descriptor.owned ? () => descriptor.texture!.destroy() : undefined,
        };
    }

    private destroyReplaced(previous: GpuResourceEntry, replacement: GpuResourceEntry): void {
        if (previous.identity !== replacement.identity) previous.destroy?.();
    }
}

export const gpuResourceRegistry = new GpuResourceRegistry();
