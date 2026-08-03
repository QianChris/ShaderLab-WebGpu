<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';
import { PipelineLoader } from '../../../core/render/PipelineLoader';
import { PreviewManager, type PreviewResult } from '../../../core/render/PreviewManager';

const host = useHost();
const rm = host.engine.resourceManager;
const rg = host.engine.renderGraph;
const previewMgr = new PreviewManager(host.engine.device, rm);

/** Category → entries. Column 1 shows these types; column 2 shows the items
 *  of the selected type; column 3 is the preview of the selected item. */
const categories = computed<Array<{ type: string; kind: PreviewKind | null; items: string[] }>>(() => {
    const pipelineEntries = rg.getPipelineEntries()
        .map(e => `${e.name} (${e.pipeline})`);
    return [
        { type: 'Meshes', kind: 'mesh', items: rm.getMeshNames() },
        { type: 'Textures', kind: 'texture', items: rm.getTextureNames() },
        { type: 'Render Targets', kind: null, items: rm.getRenderTargetNames() },
        { type: 'Color Targets', kind: null, items: rm.getColorTargetNames() },
        { type: 'Depth Targets', kind: null, items: rm.getDepthTargetNames() },
        { type: 'Uniform Buffers', kind: null, items: rm.getUniformNames() },
        { type: 'Storage Buffers', kind: null, items: rm.getStorageNames() },
        { type: 'Bind Layouts', kind: null, items: rm.getBindLayoutNames() },
        { type: 'Samplers', kind: null, items: rm.getSamplerNames() },
        { type: 'VBO Presets', kind: null, items: rm.getNamedVboNames() },
        { type: 'Render Pipelines', kind: 'pipeline', items: PipelineLoader.listPipelineNames() },
        { type: 'Compute Pipelines', kind: 'pipeline', items: PipelineLoader.listComputePipelineNames() },
        { type: 'Shaders', kind: 'shader', items: PipelineLoader.listShaderKeys() },
        { type: 'Pipeline Entries', kind: null, items: pipelineEntries },
    ].filter(c => c.items.length > 0);
});

type PreviewKind = 'mesh' | 'texture' | 'shader' | 'pipeline';

const selectedType = ref('');
const selectedEntry = ref('');
const viewMode = ref<'list' | 'icon'>('list');
const preview = ref<PreviewResult | null>(null);
const previewLoading = ref(false);
/** Icon-view thumbnails: entry → preview result, fetched when icon mode is
 *  active for the selected type. */
const iconPreviews = ref<Record<string, PreviewResult>>({});

const selectedKind = computed<PreviewKind | null>(() =>
    categories.value.find(c => c.type === selectedType.value)?.kind ?? null);

const entriesOfSelectedType = computed(() => {
    const cat = categories.value.find(c => c.type === selectedType.value);
    return cat ? cat.items : [];
});

// ── Resizable column widths (CSS px via inline style) ──────────────
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
    preview.value = null;
    iconPreviews.value = {};
});

function selectType(type: string): void {
    selectedType.value = type;
    selectedEntry.value = '';
    preview.value = null;
    iconPreviews.value = {};
    if (viewMode.value === 'icon') loadIconPreviews();
}

function selectEntry(entry: string): void {
    selectedEntry.value = entry;
    host.eventBus.emit('asset:selected', { type: selectedType.value, name: entry });
    loadPreview();
}

async function loadPreview(): Promise<void> {
    const kind = selectedKind.value;
    if (!kind || !selectedEntry.value) { preview.value = null; return; }
    previewLoading.value = true;
    try {
        preview.value = await previewMgr.getPreview(kind, selectedEntry.value);
    } finally {
        previewLoading.value = false;
    }
}

/** Fetch thumbnails for every entry of the selected type (icon view). Skips
 *  types with no preview kind (render targets / buffers show name-only cards). */
async function loadIconPreviews(): Promise<void> {
    const kind = selectedKind.value;
    if (!kind) { iconPreviews.value = {}; return; }
    const entries = entriesOfSelectedType.value;
    const results = await Promise.all(
        entries.map(e => previewMgr.getPreview(kind, e).then(r => [e, r] as const)),
    );
    const map: Record<string, PreviewResult> = {};
    for (const [e, r] of results) map[e] = r;
    iconPreviews.value = map;
}

function toggleView(mode: 'list' | 'icon'): void {
    viewMode.value = mode;
    if (mode === 'icon' && selectedType.value && Object.keys(iconPreviews.value).length === 0) {
        loadIconPreviews();
    }
}

// Re-fetch the preview when the app remounts the panel (PreviewManager is new).
watch(selectedEntry, () => { if (selectedEntry.value) loadPreview(); });
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
                <div class="asset-col-head">
                    <span>Entry{{ selectedType ? ` — ${selectedType}` : '' }}</span>
                    <span class="view-toggle" v-if="selectedType">
                        <button :class="{ on: viewMode === 'list' }" @click="toggleView('list')" title="List view">☰</button>
                        <button :class="{ on: viewMode === 'icon' }" @click="toggleView('icon')" title="Icon view">▦</button>
                    </span>
                </div>
                <div class="asset-col-body">
                    <!-- List view -->
                    <template v-if="viewMode === 'list'">
                        <div v-for="item in entriesOfSelectedType" :key="item"
                             :class="['asset-item', { active: selectedType && selectedEntry === item }]"
                             @click="selectEntry(item)">
                            <span class="it-name" :title="item">{{ item }}</span>
                        </div>
                    </template>
                    <!-- Icon view: card grid with thumbnails -->
                    <template v-else>
                        <div class="icon-grid">
                            <div v-for="item in entriesOfSelectedType" :key="item"
                                 :class="['icon-card', { active: selectedEntry === item }]"
                                 @click="selectEntry(item)">
                                <div class="icon-thumb">
                                    <img v-if="iconPreviews[item]?.kind === 'image'"
                                         :src="iconPreviews[item]!.url" alt="" />
                                    <pre v-else-if="iconPreviews[item]?.kind === 'text'">{{ iconPreviews[item]!.text?.[0] }}</pre>
                                    <span v-else class="icon-placeholder">?</span>
                                </div>
                                <div class="icon-name" :title="item">{{ item }}</div>
                            </div>
                        </div>
                    </template>
                    <div v-if="selectedType && entriesOfSelectedType.length === 0" class="asset-empty">No entries</div>
                    <div v-if="!selectedType" class="asset-empty">Select a type</div>
                </div>
            </div>
            <div class="asset-col-resizer" data-col="2" title="Drag to resize"></div>

            <!-- Column 3: preview -->
            <div class="asset-col asset-col-preview">
                <div class="asset-col-head">Preview</div>
                <div class="asset-col-body">
                    <div v-if="previewLoading" class="preview-box preview-todo">
                        <div class="preview-line">Loading…</div>
                    </div>
                    <div v-else-if="preview && preview.kind === 'image'" class="preview-box">
                        <img :src="preview.url" alt="preview" class="preview-image" />
                    </div>
                    <div v-else-if="preview && preview.kind === 'text'" class="preview-box">
                        <pre v-for="(line, i) in preview.text" :key="i" class="preview-line">{{ line }}</pre>
                    </div>
                    <div v-else-if="selectedType && selectedEntry && !selectedKind" class="preview-box preview-todo">
                        <div class="preview-line">{{ selectedEntry }}</div>
                        <div class="preview-todo-text">No preview for this type</div>
                    </div>
                    <div v-else class="asset-empty">Select an entry</div>
                </div>
            </div>
        </div>
    </div>
</template>

<style>
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
    text-overflow: ellipsis; display: flex; justify-content: space-between; align-items: center;
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

.view-toggle { display: flex; gap: 2px; }
.view-toggle button {
    background: #24344f; color: #8899aa; border: 1px solid #2a3a5c;
    border-radius: 3px; font-size: 11px; cursor: pointer; padding: 0 4px; line-height: 14px;
}
.view-toggle button.on { background: #1a4d8f; color: #fff; }

.icon-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
    gap: 4px; padding: 4px;
}
.icon-card {
    background: #0d1b33; border: 1px solid #2a3a5c; border-radius: 4px;
    cursor: pointer; overflow: hidden; display: flex; flex-direction: column;
}
.icon-card:hover { border-color: #4a8fc7; }
.icon-card.active { border-color: #4a8fc7; background: #14233f; }
.icon-thumb {
    width: 100%; height: 56px; display: flex; align-items: center; justify-content: center;
    background: #111; overflow: hidden;
}
.icon-thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.icon-thumb pre { font-size: 8px; color: #567; margin: 0; overflow: hidden; max-width: 100%; white-space: nowrap; }
.icon-placeholder { color: #445; font-size: 16px; }
.icon-name {
    font-size: 9px; color: #aab; padding: 2px 3px; text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Column drag handles */
.asset-col-resizer {
    width: 5px; height: 100%; flex-shrink: 0; cursor: col-resize;
    background: #2a3a5c; position: relative; z-index: 2;
}
.asset-col-resizer:hover, .asset-col-resizer.dragging { background: #4a8fc7; }
body.asset-resizing-cols { cursor: col-resize; user-select: none; }
body.asset-resizing-cols .asset-col { pointer-events: none; }

.preview-box { padding: 10px; font-size: 11px; color: #ccc; display:flex; flex-direction:column; align-items:center; }
.preview-image { max-width: 100%; max-height: 200px; object-fit: contain; border: 1px solid #2a3a5c; border-radius: 3px; }
.preview-line {
    font-family: monospace; word-break: break-all; padding: 2px 0;
    color: #7ec8e3; white-space: pre-wrap; margin: 0;
}
.preview-todo-text { color: #556; font-style: italic; font-size: 10px; margin-top: 6px; }
.asset-empty { padding: 14px; color: #667; font-size: 11px; font-style: italic; }
</style>
