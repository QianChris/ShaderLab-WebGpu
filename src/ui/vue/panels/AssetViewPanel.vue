<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';
import { PipelineLoader } from '../../../core/render/PipelineLoader';

const host = useHost();
const rm = host.engine.resourceManager;
const rg = host.engine.renderGraph;

/** Flatten every resource category into (type, entry) rows. The preview column
 *  is currently a placeholder — per-resource previews land in a later pass. */
const rows = computed<Array<{ type: string; entry: string }>>(() => {
    const pipelineEntries = rg.getPipelineEntries()
        .map(e => `${e.name} (${e.pipeline})`);
    const cats: Array<{ type: string; items: string[] }> = [
        { type: 'Meshes', items: rm.getMeshNames() },
        { type: 'Textures', items: rm.getTextureNames() },
        { type: 'Render Targets', items: rm.getRenderTargetNames() },
        { type: 'Color Targets', items: rm.getColorTargetNames() },
        { type: 'Depth Targets', items: rm.getDepthTargetNames() },
        { type: 'Uniform Buffers', items: rm.getUniformNames() },
        { type: 'Storage Buffers', items: rm.getStorageNames() },
        { type: 'Bind Layouts', items: rm.getBindLayoutNames() },
        { type: 'Samplers', items: rm.getSamplerNames() },
        { type: 'VBO Presets', items: rm.getNamedVboNames() },
        { type: 'Render Pipelines', items: PipelineLoader.listPipelineNames() },
        { type: 'Compute Pipelines', items: PipelineLoader.listComputePipelineNames() },
        { type: 'Shaders', items: PipelineLoader.listShaderKeys() },
        { type: 'Pipeline Entries', items: pipelineEntries },
    ];
    const out: Array<{ type: string; entry: string }> = [];
    for (const cat of cats) {
        for (const item of cat.items) out.push({ type: cat.type, entry: item });
    }
    return out;
});

const selected = ref<{ type: string; entry: string } | null>(null);
const filter = ref('');

const visibleRows = computed(() => {
    const q = filter.value.trim().toLowerCase();
    if (!q) return rows.value;
    return rows.value.filter(r =>
        r.type.toLowerCase().includes(q) || r.entry.toLowerCase().includes(q));
});

useEditorEvent('editor:changed', () => {
    selected.value = null;
});

function select(type: string, entry: string) {
    selected.value = { type, entry };
    host.eventBus.emit('asset:selected', { type, name: entry });
}
</script>

<template>
    <div class="asset-panel vue-panel">
        <div class="asset-head">
            <input v-model="filter" class="asset-filter" placeholder="Filter assets…" />
            <span class="asset-count">{{ visibleRows.length }} assets</span>
        </div>
        <div class="asset-table">
            <div class="asset-row asset-row-head">
                <div class="col-type">Type</div>
                <div class="col-entry">Entry</div>
                <div class="col-preview">Preview</div>
            </div>
            <div class="asset-body">
                <div v-for="r in visibleRows" :key="`${r.type}\u0000${r.entry}`"
                     :class="['asset-row', { active: selected?.type === r.type && selected?.entry === r.entry }]"
                     @click="select(r.type, r.entry)">
                    <div class="col-type">{{ r.type }}</div>
                    <div class="col-entry" :title="r.entry">{{ r.entry }}</div>
                    <div class="col-preview preview-todo">TODO</div>
                </div>
                <div v-if="visibleRows.length === 0" class="asset-empty">
                    No assets{{ filter ? ' match the filter' : '' }}
                </div>
            </div>
        </div>
    </div>
</template>

<style>
.asset-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.asset-head {
    padding: 6px 8px; border-bottom: 1px solid #333; display: flex; gap: 8px;
    align-items: center; flex-shrink: 0; background: #1a2744;
}
.asset-filter {
    flex: 1; background: #0d1b33; color: #ddd; border: 1px solid #2a3a5c;
    border-radius: 3px; padding: 3px 6px; font-size: 11px; font-family: monospace;
}
.asset-count { color: #8899aa; font-size: 10px; flex-shrink: 0; }
.asset-table { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.asset-row {
    display: flex; align-items: center; padding: 3px 8px; gap: 8px;
    border-bottom: 1px solid #1a2233; cursor: pointer; font-size: 11px;
}
.asset-row:hover { background: #1e2d44; }
.asset-row.active { background: #1a4d8f; color: #fff; }
.asset-row-head {
    background: #1a1a1a; color: #8899aa; font-weight: 600; font-size: 10px;
    text-transform: uppercase; cursor: default; flex-shrink: 0;
}
.asset-body { flex: 1; overflow-y: auto; min-height: 0; }
.col-type { width: 130px; flex-shrink: 0; color: #7ec8e3; }
.asset-row.active .col-type { color: #fff; }
.col-entry { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-preview { width: 90px; flex-shrink: 0; text-align: center; }
.preview-todo { color: #556; font-style: italic; font-size: 10px; }
.asset-empty { padding: 14px; color: #667; font-size: 11px; font-style: italic; }
</style>
