<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import CodeEditor from '../components/CodeEditor.vue';
import { HotReloadShaderCommand } from '../../../editor/commands/ShaderCommands';
import { PipelineLoader } from '../../../core/render/PipelineLoader';

const host = useHost();

const shaderList = computed(() => [...PipelineLoader.listShaderRefs(), ...newShaders.value.map(n => ({ ref: n, pipelines: [] as string[] }))]);
const selected = ref<{ ref: string; pipelines: string[] } | null>(null);
const sourceCache = ref<Record<string, string>>({});
const errorMsg = ref('');
const saving = ref(false);
/** Editor-created shaders not yet referenced by a pipeline. Merged into
 *  shaderList so they're immediately editable. */
const newShaders = ref<string[]>([]);

// Interface-change guard: any @group/@binding/location/builtin attribute or a
// top-level `fn <entrypoint>` line. Changing these requires a pipeline.json edit,
// so hot-reload is rejected to avoid a confusing half-applied shader.
const INTERFACE_RE = /@(group|binding|location|builtin)\b|^\s*fn\s+(vs_main|fs_main|cs_main|main)\s*\(/m;

function selectShader(ref: string, pipelines: string[]): void {
    selected.value = { ref, pipelines };
    errorMsg.value = '';
    if (sourceCache.value[ref]) return;
    const src = PipelineLoader.getShaderKeySource(ref);
    sourceCache.value[ref] = src ?? '// source not cached (reload the app to populate)';
}

/** Create a new WGSL shader from the template, write to projectFS, and open it
 *  immediately (sourceCache pre-seeded so selectShader skips the lookup — the
 *  shader isn't referenced by a pipeline yet). */
async function newShader(): Promise<void> {
    const name = prompt('Shader name (without extension):', 'myShader');
    if (!name) return;
    const engine = host.engine;
    const ref = `${host.engineConfig.appsRoot}/${engine.currentApp}/shaders/${name}.wgsl`;
    try {
        const resp = await fetch('/common/templates/shader.wgsl');
        if (!resp.ok) throw new Error(`template HTTP ${resp.status}`);
        const content = await resp.text();
        await host.projectFS.writeFile(`apps/${engine.currentApp}/shaders/${name}.wgsl`, content);
        sourceCache.value[ref] = content;
        if (!newShaders.value.includes(ref)) newShaders.value = [...newShaders.value, ref];
        selectShader(ref, []);
        errorMsg.value = `Created. Reference "${ref}" in a pipeline.json vertex/fragment shader field to use it.`;
    } catch (e) {
        errorMsg.value = `New shader failed: ${e}`;
    }
}

function onSave(code: string): void {
    const key = selected.value?.ref;
    if (!key) return;
    const prev = sourceCache.value[key] ?? '';
    const prevInterfaces = (prev.match(INTERFACE_RE) || []).sort().join(',');
    const nextInterfaces = (code.match(INTERFACE_RE) || []).sort().join(',');
    if (prevInterfaces !== nextInterfaces) {
        errorMsg.value = 'Interface change detected — modify pipeline.json and reload the app';
        return;
    }
    errorMsg.value = '';
    sourceCache.value[key] = code;
    try {
        host.dispatch(new HotReloadShaderCommand(key, code, prev));
        saving.value = true;
        setTimeout(() => { saving.value = false; }, 600);
    } catch (e) {
        errorMsg.value = String(e);
    }
    // Persist to disk (best-effort; shader keys may be plugin refs that can't
    // be written — the catch surfaces a hint without blocking the reload).
    void host.projectFS.writeFile(key, code).catch((e: unknown) => {
        errorMsg.value = errorMsg.value ? `${errorMsg.value} | disk save failed` : `disk save failed: ${e}`;
    });
}
</script>

<template>
    <div class="shader-panel vue-panel">
        <div class="file-tree">
            <div class="tree-title">Shaders <button class="tree-new-btn" @click="newShader" title="New shader from template">+ New</button></div>
            <div v-for="s in shaderList" :key="s.ref"
                 :class="['tree-item', { active: selected?.ref === s.ref }]"
                 @click="selectShader(s.ref, s.pipelines)">
                <div class="ref">{{ s.ref }}</div>
                <div class="meta">{{ s.pipelines.length }} pipeline(s)</div>
            </div>
            <div v-if="shaderList.length === 0" class="tree-empty">No shaders loaded</div>
        </div>
        <div class="editor-wrap">
            <div class="editor-toolbar">
                <span v-if="selected" class="ed-title">{{ selected.ref }}</span>
                <span v-if="saving" class="save-hint">saved ✓</span>
                <span v-if="errorMsg" class="save-hint error">{{ errorMsg }}</span>
            </div>
            <CodeEditor v-if="selected"
                        :key="selected.ref"
                        :model-value="sourceCache[selected.ref] ?? ''"
                        language="wgsl"
                        @save="onSave" />
            <div v-else class="empty">Select a shader — Ctrl+S hot-reloads algorithm changes only</div>
        </div>
    </div>
</template>

<style>
.shader-panel { display: flex; height: 100%; min-height: 0; }
.file-tree { width: 240px; overflow-y: auto; border-right: 1px solid #333; flex-shrink: 0; }
.tree-title { padding: 6px; font-weight: bold; color: #888; background: #1a1a1a; font-size: 11px; }
.tree-item { padding: 4px 10px; cursor: pointer; color: #ccc; font-size: 12px; }
.tree-item:hover { background: #2a2a2a; }
.tree-item.active { background: #1a4d8f; color: #fff; }
.ref { font-size: 11px; color: #ccc; word-break: break-all; }
.meta { font-size: 10px; color: #888; }
.tree-empty { padding: 12px; color: #667; font-size: 11px; font-style: italic; }
.tree-new-btn {
    float: right; font-size: 10px; background: #2a3a5c; color: #ccc;
    border: 1px solid #3a4a6c; border-radius: 3px; padding: 0 5px; cursor: pointer;
}
.tree-new-btn:hover { background: #3a4a6c; color: #fff; }
.editor-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.editor-toolbar {
    padding: 6px 10px; border-bottom: 1px solid #333; display: flex; gap: 10px;
    align-items: center; flex-shrink: 0; background: #1a2744;
}
.editor-toolbar .ed-title { color: #7ec8e3; font-size: 11px; word-break: break-all; }
.save-hint { color: #7fd8a8; font-size: 10px; margin-left: auto; }
.save-hint.error { color: #ff6b6b; }
.empty { padding: 20px; color: #667; }
</style>
