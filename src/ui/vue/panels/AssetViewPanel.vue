<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';
import { PipelineLoader } from '../../../core/render/PipelineLoader';

const host = useHost();
const rm = host.engine.resourceManager;
const rg = host.engine.renderGraph;

/** Category → entries. Column 1 shows these types; column 2 shows the items
 *  of the selected type; column 3 is the preview of the selected item. */
const categories = computed<Array<{ type: string; items: string[] }>>(() => {
    const pipelineEntries = rg.getPipelineEntries()
        .map(e => `${e.name} (${e.pipeline})`);
    return [
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
    ].filter(c => c.items.length > 0);
});

const selectedType = ref('');
const selectedEntry = ref('');

const entriesOfSelectedType = computed(() => {
    const cat = categories.value.find(c => c.type === selectedType.value);
    return cat ? cat.items : [];
});

// ── Resizable column widths (CSS px via inline style) ──
const col1Width = ref(140);
const col2Width = ref(200);
const MIN_W = 80;

function startResize(e: PointerEvent): void {
    const handle = (e.target as HTMLElement).closest('.asset-col-resizer') as HTMLElement | null;
    if (!handle) return;
    const col = handle.dataset.col === '1' ? 'col1' : 'col2';
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('asset-resizing-cols');
    const startX = e.clientX;
    const vars = getComputedStyle(document.documentElement);
    const c1 = parseFloat(vars.getPropertyValue('--asset-col1') || '140');
    const c2 = parseFloat(vars.getPropertyValue('--asset-col2') || '200');

    const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (col === 'col1') {
            document.documentElement.style.setProperty('--asset-col1', `${Math.max(MIN_W, c1 + dx)}px`);
        } else {
            document.documentElement.style.setProperty('--asset-col2', `${Math.max(MIN_W, c2 + dx)}px`);
        }
    };
    const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.classList.remove('dragging');
        document.body.classList.remove('asset-resizing-cols');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
}

useEditorEvent('editor:changed', () => {
    selectedEntry.value = '';
});

function selectType(type: string): void {
    selectedType.value = type;
    selectedEntry.value = '';
}

function selectEntry(entry: string): void {
    selectedEntry.value = entry;
    host.eventBus.emit('asset:selected', { type: selectedType.value, name: entry });
}

/** Basic preview metadata shown in column 3 (per-type, where cheap to derive). */
const previewInfo = computed(() => {
    if (!selectedType.value || !selectedEntry.value) return null;
    const type = selectedType.value;
    const entry = selectedEntry.value;
    const isPipeline = type === 'Render Pipelines' || type === 'Compute Pipelines';
    if (isPipeline && PipelineLoader.getConfig(entry)) {
        const cfg = PipelineLoader.getConfig(entry);
        return {
            kind: 'pipeline',
            details: [
                `name: ${cfg?.name ?? entry}`,
                `vertex: ${cfg?.vertex?.shader ?? '—'}`,
                `fragment: ${cfg?.fragment ? cfg.fragment.shader : '—'}`,
                `bindLayout: ${(cfg?.bindLayout ?? []).join(', ') || '—'}`,
            ],
        };
    }
    return { kind: 'todo', details: ['Preview not yet implemented'] };
});
</script>

<template>
    <div class="asset-panel vue-panel" @pointerdown="startResize">
        <div class="asset-cols">
            <!-- Column 1: type -->
            <div class="asset-col" style="width: var(--asset-col1)">
                <div class="asset-col-head">Type</div>
                <div class="asset-col-body">
                    <div v-for="c in categories" :key="c.type"
                         :class="['asset-item', { active: selectedType === c.type }]"
                         @click="selectType(c.type)">
                        <span class="it-name">{{ c.type }}</span>
                        <span class="it-count">{{ c.items.length }}</span>
                    </div>
                    <div v-if="categories.length === 0" class="asset-empty">No assets</div>
                </div>
            </div>
            <div class="asset-col-resizer" data-col="1" title="Drag to resize"></div>

            <!-- Column 2: entries of the selected type -->
            <div class="asset-col" style="width: var(--asset-col2)">
                <div class="asset-col-head">Entry{{ selectedType ? ` — ${selectedType}` : '' }}</div>
                <div class="asset-col-body">
                    <div v-for="item in entriesOfSelectedType" :key="item"
                         :class="['asset-item', { active: selectedType && selectedEntry === item }]"
                         @click="selectEntry(item)">
                        <span class="it-name" :title="item">{{ item }}</span>
                    </div>
                    <div v-if="selectedType && entriesOfSelectedType.length === 0" class="asset-empty">No entries</div>
                    <div v-if="!selectedType" class="asset-empty">Select a type</div>
                </div>
            </div>
            <div class="asset-col-resizer" data-col="2" title="Drag to resize"></div>

            <!-- Column 3: preview -->
            <div class="asset-col asset-col-preview">
                <div class="asset-col-head">Preview</div>
                <div class="asset-col-body">
                    <div v-if="previewInfo && previewInfo.kind === 'pipeline'" class="preview-box">
                        <div v-for="line in previewInfo.details" :key="line" class="preview-line">{{ line }}</div>
                    </div>
                    <div v-else-if="selectedType && selectedEntry" class="preview-box preview-todo">
                        <div class="preview-line">{{ selectedEntry }}</div>
                        <div class="preview-todo-text">Preview not yet implemented</div>
                    </div>
                    <div v-else class="asset-empty">Select an entry</div>
                </div>
            </div>
        </div>
    </div>
</template>

<style>
/* Column widths are stored on :root as CSS variables so the columns and their
   drag handles (which live in different subtrees) stay perfectly in sync. */
:root { --asset-col1: 140px; --asset-col2: 200px; }

.asset-panel { display: flex; height: 100%; min-height: 0; }
.asset-cols { display: flex; width: 100%; height: 100%; min-height: 0; }
.asset-col {
    display: flex; flex-direction: column; min-height: 0; min-width: 0;
    flex-shrink: 0;
}
.asset-col-preview { flex: 1; min-width: 120px; }
.asset-col-head {
    padding: 4px 8px; background: #1a1a1a; color: #8899aa; font-size: 10px;
    text-transform: uppercase; font-weight: 600; flex-shrink: 0;
    border-bottom: 1px solid #333; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis;
}
.asset-col-body { flex: 1; overflow-y: auto; min-height: 0; }

.asset-item {
    display: flex; align-items: center; gap: 6px; padding: 3px 8px;
    cursor: pointer; font-size: 11px; color: #ccc;
    white-space: nowrap; overflow: hidden;
}
.asset-item:hover { background: #1e2d44; }
.asset-item.active { background: #1a4d8f; color: #fff; }
.it-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.it-count {
    flex-shrink: 0; font-size: 9px; color: #8899aa; background: #24344f;
    border-radius: 8px; padding: 0 5px; line-height: 14px;
}
.asset-item.active .it-count { background: #2f63a8; color: #fff; }

/* Column drag handles */
.asset-col-resizer {
    width: 5px; height: 100%; flex-shrink: 0; cursor: col-resize;
    background: #2a3a5c; position: relative; z-index: 2;
}
.asset-col-resizer:hover, .asset-col-resizer.dragging { background: #4a8fc7; }
body.asset-resizing-cols { cursor: col-resize; user-select: none; }
body.asset-resizing-cols .asset-col { pointer-events: none; }

.preview-box { padding: 10px; font-size: 11px; color: #ccc; }
.preview-line {
    font-family: monospace; word-break: break-all; padding: 2px 0;
    color: #7ec8e3;
}
.preview-todo-text { color: #556; font-style: italic; font-size: 10px; margin-top: 6px; }
.asset-empty { padding: 14px; color: #667; font-size: 11px; font-style: italic; }
</style>
