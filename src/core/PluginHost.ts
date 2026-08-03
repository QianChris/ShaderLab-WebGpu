import { schemaRegistry } from './ecs/SchemaRegistry';
import { uniformLayouts } from './render/UniformLayout';
import { resourceManager } from './render/ResourceManager';
import { bufferRegistry } from './render/BufferRegistry';
import { systemRegistry } from './ecs/SystemRegistry';
import { PipelineLoader } from './render/PipelineLoader';
import { removeVertexSlotsByOwner, loadVertexSlots } from './render/vertexSlots';
import {
    meshGenerators, isPbrMeshData,
    registerMeshGenerator, unregisterMeshGenerator,
} from './render/Primitives';
import { registerToolType, unregisterToolType } from './tools/ToolRegistry';
import { atomNamespaces } from './render/valueResolver';
import type { RenderGraph } from './render/RenderGraph';
import type { EnginePlugin, MeshCatalogEntry } from './plugins/Plugin';
import type { IRenderer } from './render/types';

/** Tracks what a plugin registered through its ctx / declarations, so the
 *  open registries (tools, generators, atoms, phases) can be swept on unload. */
export interface PluginLedger {
    tools: string[];
    generators: string[];
    atoms: Array<[string, string]>;
    phases: string[];
}

/** Dependencies the PluginHostHelper needs from the Engine host. */
export interface PluginHostDeps {
    renderGraph: RenderGraph;
    attachments: Map<string, { obj: unknown; owner: string }>;
    pluginLedgers: Map<string, PluginLedger>;
    customRenderer: IRenderer | null;
    customRendererOwner: string | null;
    setAttachment(name: string, obj: unknown, owner: string): void;
    deleteAttachment(name: string): void;
    /** Restore the built-in renderer after a replacement renderer's owner is swept. */
    restoreBuiltinRenderer(): void;
}

/**
 * Extracted from Engine: applies plugin declaration fields into engine
 * registries and sweeps them on unload. Keeping this logic in a dedicated
 * class makes the plugin registration lifecycle independently testable
 * and shrinks the Engine God Class.
 */
export class PluginHostHelper {
    constructor(private deps: PluginHostDeps) {}

    /** Get or create the ledger for a plugin owner. */
    ledgerFor(owner: string): PluginLedger {
        let ledger = this.deps.pluginLedgers.get(owner);
        if (!ledger) {
            ledger = { tools: [], generators: [], atoms: [], phases: [] };
            this.deps.pluginLedgers.set(owner, ledger);
        }
        return ledger;
    }

    /** One name, all three hook namespaces (mirrors RenderScriptLoader.loadAll). */
    registerRenderHook(name: string, fn: unknown, owner: string): void {
        this.deps.renderGraph.registerValueScript(name, fn as never, owner);
        this.deps.renderGraph.registerGeometryHook(name, fn as never, owner);
        this.deps.renderGraph.registerComputeHook(name, fn as never, owner);
    }

    /** Merge a plugin's declaration fields into the engine registries. */
    applyDeclarations(id: string, plugin: EnginePlugin, owner: string): void {
        const ledger = this.ledgerFor(owner);
        if (plugin.components) schemaRegistry.registerDefs(plugin.components, owner);
        if (plugin.uniformLayouts) uniformLayouts.load(plugin.uniformLayouts, owner);
        if (plugin.vertexSlots) loadVertexSlots(plugin.vertexSlots, owner);
        if (plugin.vertexInputs) PipelineLoader.mergeVertexInputs(plugin.vertexInputs, owner);
        if (plugin.bindLayouts) resourceManager.loadBindLayouts(plugin.bindLayouts);
        if (plugin.samplers) resourceManager.loadSamplers(plugin.samplers);
        if (plugin.blendPresets) PipelineLoader.mergeBlendPresets(plugin.blendPresets, owner);
        if (plugin.fallbackTextures) resourceManager.loadFallbackTextures(plugin.fallbackTextures);
        if (plugin.vboPresets) resourceManager.loadVboPresets(plugin.vboPresets);
        if (plugin.renderTargets) {
            resourceManager.loadRenderTargets(plugin.renderTargets);
            this.deps.renderGraph.mergeRenderTargets(plugin.renderTargets);
        }
        if (plugin.phases) {
            this.deps.renderGraph.addPhases(plugin.phases);
            for (const p of plugin.phases) ledger.phases.push(p.name);
        }
        if (plugin.meshes) this.registerMeshCatalog(plugin.meshes);
        if (plugin.systemDefs) {
            for (const def of plugin.systemDefs) systemRegistry.addDef(def, owner);
        }
        if (plugin.pipelines) {
            for (const [key, config] of Object.entries(plugin.pipelines)) {
                PipelineLoader.registerVirtualConfig(key.includes(':') ? key : `${id}:${key}`, config);
            }
        }
        if (plugin.shaders) {
            for (const [key, src] of Object.entries(plugin.shaders)) {
                PipelineLoader.registerVirtualShader(key.includes(':') ? key : `${id}:${key}`, src);
            }
        }
        if (plugin.renderHooks) {
            for (const [name, fn] of Object.entries(plugin.renderHooks)) this.registerRenderHook(name, fn, owner);
        }
        if (plugin.meshGenerators) {
            for (const [name, fn] of Object.entries(plugin.meshGenerators)) {
                registerMeshGenerator(name, fn);
                ledger.generators.push(name);
            }
        }
        if (plugin.toolTypes) {
            for (const [name, factory] of Object.entries(plugin.toolTypes)) {
                registerToolType(name, factory);
                ledger.tools.push(name);
            }
        }
        if (plugin.valueAtoms) {
            for (const [ns, atoms] of Object.entries(plugin.valueAtoms)) {
                atomNamespaces[ns] = { ...(atomNamespaces[ns] ?? {}), ...atoms };
                for (const name of Object.keys(atoms)) ledger.atoms.push([ns, name]);
            }
        }
    }

    /** Release everything a plugin registered (called on plugin unload). */
    sweepOwner(owner: string): void {
        resourceManager.exitApp(owner);
        bufferRegistry.exitApp(owner);
        systemRegistry.removeDefsByOwner(owner);
        systemRegistry.removeSystemsByOwner(owner);
        schemaRegistry.removeOwner(owner);
        uniformLayouts.removeOwner(owner);
        removeVertexSlotsByOwner(owner);
        PipelineLoader.removeVirtualsByPrefix(owner.replace(/^plugin:/, '') + ':');
        PipelineLoader.removeInputsByOwner(owner);
        PipelineLoader.removeBlendPresetsByOwner(owner);
        this.deps.renderGraph.removeHooksByOwner(owner);
        this.deps.renderGraph.removePhaseBehaviorsByOwner(owner);
        if (this.deps.customRendererOwner === owner) {
            this.deps.restoreBuiltinRenderer();
        }
        for (const [name, entry] of this.deps.attachments) {
            if (entry.owner === owner) this.deps.deleteAttachment(name);
        }
        const ledger = this.deps.pluginLedgers.get(owner);
        if (ledger) {
            for (const t of ledger.tools) unregisterToolType(t);
            for (const g of ledger.generators) unregisterMeshGenerator(g);
            for (const [ns, name] of ledger.atoms) {
                if (atomNamespaces[ns]) delete atomNamespaces[ns][name];
            }
            if (ledger.phases.length > 0) this.deps.renderGraph.removePhases(ledger.phases);
            this.deps.pluginLedgers.delete(owner);
        }
    }

    /** Build meshes from a catalog (meshes.json or a plugin `meshes` field). */
    registerMeshCatalog(entries: MeshCatalogEntry[]): void {
        for (const entry of entries) {
            const gen = meshGenerators[entry.generator];
            if (!gen) {
                throw new Error(
                    `Mesh catalog entry '${entry.name}' references unknown generator '${entry.generator}' ` +
                    `(available: ${Object.keys(meshGenerators).join(', ')})`,
                );
            }
            const data = gen(entry.params ?? {});
            if (isPbrMeshData(data)) {
                resourceManager.registerPbrMesh(entry.name, data);
            } else {
                resourceManager.registerMesh(entry.name, data);
            }
        }
    }
}
