import { schemaRegistry } from '../../src/ecs/SchemaRegistry';
import { uniformLayouts } from '../../src/render/UniformLayout';
import { systemRegistry } from '../../src/ecs/SystemRegistry';
import { PipelineLoader } from '../../src/render/PipelineLoader';
import { resourceManager } from '../../src/render/ResourceManager';
import { atomNamespaces } from '../../src/render/valueResolver';

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
