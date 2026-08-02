<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';
import { PipelineLoader } from '../../../core/render/PipelineLoader';

const host = useHost();
const rm = host.engine.resourceManager;
const rg = host.engine.renderGraph;

const categories = computed(() => {
    const pipelineNames = rg.getPipelineEntries().map(e => `${e.name} (${e.pipeline})`);
    return [
        { name: 'Meshes', items: rm.getMeshNames() },
        { name: 'Textures', items: rm.getTextureNames() },
        { name: 'Render Targets', items: rm.getRenderTargetNames() },
        { name: 'Color Targets', items: rm.getColorTargetNames() },
        { name: 'Depth Targets', items: rm.getDepthTargetNames() },
        { name: 'Uniform Buffers', items: rm.getUniformNames() },
        { name: 'Storage Buffers', items: rm.getStorageNames() },
        { name: 'Bind Layouts', items: rm.getBindLayoutNames() },
        { name: 'Samplers', items: rm.getSamplerNames() },
        { name: 'VBO Presets', items: rm.getNamedVboNames() },
        { name: 'Render Pipelines', items: PipelineLoader.listPipelineNames() },
        { name: 'Compute Pipelines', items: PipelineLoader.listComputePipelineNames() },
        { name: 'Shaders', items: PipelineLoader.listShaderKeys() },
        { name: 'Pipeline Entries', items: pipelineNames },
    ].filter(c => c.items.length > 0);
});

const selected = ref<{ cat: string; name: string } | null>(null);

useEditorEvent('editor:changed', () => {
    selected.value = null;
});

function select(cat: string, name: string) {
    selected.value = { cat, name };
    host.eventBus.emit('asset:selected', { type: cat, name });
}
</script>

<template>
    <div class="asset-panel vue-panel">
        <div class="asset-tree">
            <div v-for="cat in categories" :key="cat.name" class="cat">
                <div class="cat-name">{{ cat.name }} ({{ cat.items.length }})</div>
                <div v-for="item in cat.items" :key="item"
                     :class="['item', { active: selected?.cat === cat.name && selected?.name === item }]"
                     @click="select(cat.name, item)">
                    {{ item }}
                </div>
            </div>
        </div>
        <div class="asset-detail">
            <div v-if="selected">
                <h4>{{ selected.cat }} — {{ selected.name }}</h4>
                <p class="asset-hint">Read-only listing. Inspect details in the Pipeline / Shaders tabs.</p>
            </div>
            <div v-else class="empty">Select an asset</div>
        </div>
    </div>
</template>

<style>
.asset-panel { display: flex; height: 100%; min-height: 0; }
.asset-tree { width: 220px; overflow-y: auto; border-right: 1px solid #333; flex-shrink: 0; }
.cat-name { padding: 4px 8px; font-weight: bold; background: #222; color: #aaa; font-size: 11px; }
.item { padding: 3px 12px; cursor: pointer; color: #ccc; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item:hover { background: #333; }
.item.active { background: #1a4d8f; color: #fff; }
.asset-detail { flex: 1; padding: 12px; color: #ccc; min-width: 0; }
.asset-detail h4 { color: #7ec8e3; font-size: 12px; margin-bottom: 8px; word-break: break-all; }
.asset-hint { color: #667; font-size: 11px; }
.empty { opacity: 0.5; }
</style>
