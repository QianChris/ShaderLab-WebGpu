import { schemaRegistry } from '../../src/core/ecs/SchemaRegistry';
import { uniformLayouts } from '../../src/core/render/UniformLayout';
import { systemRegistry } from '../../src/core/ecs/SystemRegistry';
import { PipelineLoader } from '../../src/core/render/PipelineLoader';
import { resourceManager } from '../../src/core/render/ResourceManager';
import { gpuResourceRegistry } from '../../src/core/render/GpuResourceRegistry';
import { atomNamespaces } from '../../src/core/render/valueResolver';

/**
 * Reset module singletons to a clean state between tests.
 * Uses owner='test' for scoping; call in afterEach.
 */
export function resetRegistries(): void {
    schemaRegistry.removeOwner('test');
    schemaRegistry.removeOwner('plugin:test');
    schemaRegistry.resetStrings();
    uniformLayouts.removeOwner('test');
    uniformLayouts.removeOwner('plugin:test');
    systemRegistry.removeDefsByOwner('test');
    systemRegistry.removeDefsByOwner('plugin:test');
    systemRegistry.removeSystemsByOwner('test');
    systemRegistry.removeSystemsByOwner('plugin:test');
    resourceManager.exitApp('test');
    resourceManager.exitApp('plugin:test');
    gpuResourceRegistry.clear();
    PipelineLoader.removeVirtualsByPrefix('test:');
    PipelineLoader.removeInputsByOwner('test');
    PipelineLoader.removeInputsByOwner('plugin:test');
    PipelineLoader.removeBlendPresetsByOwner('test');
    PipelineLoader.removeBlendPresetsByOwner('plugin:test');
    // Clean test atoms from global namespaces
    for (const ns of Object.keys(atomNamespaces)) {
        if (ns !== 'builtin' && ns !== 'transform' && ns !== 'tag') {
            delete atomNamespaces[ns];
        }
    }
}
