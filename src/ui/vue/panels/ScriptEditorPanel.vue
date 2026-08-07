<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import CodeEditor from '../components/CodeEditor.vue';
import {
    ReloadSystemScriptCommand,
    ReloadGameplayScriptCommand,
    ReloadRenderScriptCommand,
} from '../../../editor/commands/ScriptCommands';

const host = useHost();

/** Script kinds the panel can edit. */
type ScriptKind = 'gameplay' | 'system' | 'render';

interface ScriptRef {
    kind: ScriptKind;
    name: string;
    /** Path used to fetch the original source (also the reload key). */
    path: string;
    /** Resolved URL for fetching the original source. */
    url: string;
}

const sourceCache = ref<Record<string, string>>({});
const selected = ref<ScriptRef | null>(null);
const saving = ref(false);
const errorMsg = ref('');
/** Editor-created scripts not yet referenced by scene/systems.json (so they
 *  don't appear in the engine-derived list). Merged into the displayed list so
 *  the user can immediately edit them; registration into app config is a
 *  separate step (Phase 2.4). */
const newScripts = ref<ScriptRef[]>([]);

/** Collect every script a user can edit:
 *  1. Gameplay scripts — unique ScriptComponent.script values across the scene.
 *  2. System scripts — systems.json entries whose def has a script `source`.
 *  3. Render scripts — render.json `renderScripts` entries. */
const scripts = computed<ScriptRef[]>(() => {
    const engine = host.engine;
    const appBase = `${host.engineConfig.appsRoot}/${engine.currentApp}`;
    const out: ScriptRef[] = [];
    const seen = new Set<string>();

    // 1. Gameplay scripts from scene entities.
    for (const [, eid] of engine.scene.entityKeyMap) {
        const path = engine.scene.getField(eid, 'ScriptComponent', 'script') as string | undefined;
        if (!path) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({ kind: 'gameplay', name: path, path, url: path.startsWith('/') ? path : `${appBase}/${path}` });
    }

    // 2. System script entries (systems.json source: "path.js").
    for (const name of engine.systemRegistry.getScriptSystemEntries()) {
        const src = engine.systemRegistry.getScriptSource(name);
        if (!src) continue;
        if (seen.has(src)) continue;
        seen.add(src);
        out.push({ kind: 'system', name: `${name} (${src})`, path: src, url: src.startsWith('/') ? src : `${appBase}/${src}` });
    }

    // 3. Render escape-hatch scripts (render.json renderScripts).
    for (const file of engine.renderGraph.getScriptFiles()) {
        const url = `${host.engineConfig.dataRoot}/${host.engineConfig.renderScriptsSubdir}/${file}`;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ kind: 'render', name: file, path: file, url });
    }

    return [...out, ...newScripts.value];
});

/** Create a new script from a template: fetch the boilerplate, write it to
 *  projectFS, and open it immediately (sourceCache pre-seeded so select skips
 *  the fetch — the file may not exist at the real URL until registered). */
async function newScript(): Promise<void> {
    const kindStr = prompt('Script kind (gameplay / render):', 'gameplay');
    if (!kindStr) return;
    if (kindStr !== 'gameplay' && kindStr !== 'render') { errorMsg.value = 'Invalid kind'; return; }
    const kind = kindStr as ScriptKind;
    const name = prompt('Script name (without extension):', 'myScript');
    if (!name) return;
    const engine = host.engine;
    const appBase = `${host.engineConfig.appsRoot}/${engine.currentApp}`;
    const templatePath = kind === 'gameplay' ? '/common/templates/gameplay.js' : '/common/templates/render.js';
    const path = `scripts/${name}.js`;
    const url = `${appBase}/${path}`;
    try {
        const resp = await fetch(templatePath);
        if (!resp.ok) throw new Error(`template HTTP ${resp.status}`);
        const content = await resp.text();
        await host.projectFS.writeFile(`apps/${engine.currentApp}/${path}`, content);
        sourceCache.value[url] = content;
        const ref: ScriptRef = { kind, name: path, path, url };
        if (!newScripts.value.some(r => r.url === url)) newScripts.value = [...newScripts.value, ref];
        await select(ref);
        // In-memory registration so the script is immediately usable:
        //  - render: register exported hooks (<name>.value / .geometry) so
        //    pipelines can reference them without an app reload.
        //  - gameplay: hint the user to set ScriptComponent.script on an entity
        //    (registration = an entity reference; can't auto-pick a target).
        if (kind === 'render') {
            host.dispatch(new ReloadRenderScriptCommand(path, content, ''));
            errorMsg.value = `Registered in-memory. To persist across reload, add "${path}" to render.json renderScripts.`;
        } else {
            errorMsg.value = `Created. Set ScriptComponent.script = "${path}" on an entity to use it.`;
        }
    } catch (e) {
        errorMsg.value = `New script failed: ${e}`;
    }
}

async function select(ref: ScriptRef): Promise<void> {
    selected.value = ref;
    errorMsg.value = '';
    if (sourceCache.value[ref.url]) return;
    try {
        const resp = await fetch(`${ref.url}?t=${Date.now()}`);
        const ct = resp.headers.get('content-type') ?? '';
        // Guard against the Vite SPA fallback (200 + text/html for unknown
        // paths) and other non-JS responses — a script editor must never
        // show the page's HTML as source.
        if (!resp.ok || (!ct.includes('javascript') && !ct.includes('text/plain') && !ct.includes('module'))) {
            sourceCache.value[ref.url] = `// failed to load: HTTP ${resp.status} (${ref.url})`;
            errorMsg.value = `Failed to load ${ref.name} (HTTP ${resp.status})`;
            return;
        }
        sourceCache.value[ref.url] = await resp.text();
    } catch (e) {
        sourceCache.value[ref.url] = `// failed to load: ${e}`;
        errorMsg.value = String(e);
    }
}

function onSave(code: string): void {
    if (!selected.value) return;
    const ref = selected.value;
    const prev = sourceCache.value[ref.url] ?? '';
    sourceCache.value[ref.url] = code;
    errorMsg.value = '';
    try {
        if (ref.kind === 'gameplay') {
            host.dispatch(new ReloadGameplayScriptCommand(ref.path, code, prev));
        } else if (ref.kind === 'system') {
            host.dispatch(new ReloadSystemScriptCommand(ref.path, code, prev));
        } else {
            host.dispatch(new ReloadRenderScriptCommand(ref.path, code, prev));
        }
        saving.value = true;
        setTimeout(() => { saving.value = false; }, 600);
    } catch (e) {
        errorMsg.value = String(e);
    }
    // Persist to disk (best-effort; the reload is in-memory either way).
    void persist(ref.path, code);
}

async function persist(path: string, code: string): Promise<void> {
    try {
        await host.projectFS.writeFile(path, code);
    } catch (e) {
        // Don't clobber the reload's status; surface a separate hint.
        errorMsg.value = errorMsg.value ? `${errorMsg.value} | disk save failed` : `disk save failed: ${e}`;
    }
}

function dirty(): boolean {
    if (!selected.value) return false;
    return !!sourceCache.value[selected.value.url];
}
</script>

<template>
    <div class="script-panel vue-panel">
        <div class="file-tree">
            <div class="tree-title">Scripts <button class="tree-new-btn" @click="newScript" title="New script from template">+ New</button></div>
            <div v-for="s in scripts" :key="s.url"
                 :class="['tree-item', { active: selected?.url === s.url }]"
                 @click="select(s)">
                <div class="ref">{{ s.name }}</div>
                <div class="meta">{{ s.kind }}</div>
            </div>
            <div v-if="scripts.length === 0" class="tree-empty">No editable scripts</div>
        </div>
        <div class="editor-wrap">
            <div class="editor-toolbar">
                <span v-if="selected" class="ed-title">{{ selected.name }}</span>
                <span v-if="saving" class="save-hint">saved ✓</span>
                <span v-if="errorMsg" class="save-hint error">{{ errorMsg }}</span>
            </div>
            <CodeEditor v-if="selected"
                        :key="selected.url"
                        :model-value="sourceCache[selected.url] ?? ''"
                        language="js"
                        @save="onSave" />
            <div v-else class="empty">Select a script — Ctrl+S saves &amp; hot-reloads</div>
        </div>
    </div>
</template>

<style>
.script-panel { display: flex; height: 100%; min-height: 0; }
.file-tree { width: 200px; overflow-y: auto; border-right: 1px solid #333; flex-shrink: 0; }
.tree-title { padding: 6px; font-weight: bold; color: #888; background: #1a1a1a; font-size: 11px; }
.tree-item { padding: 4px 10px; cursor: pointer; color: #ccc; font-size: 12px; }
.tree-item:hover { background: #2a2a2a; }
.tree-item.active { background: #1a4d8f; color: #fff; }
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
.editor-toolbar .ed-title { color: #7ec8e3; font-size: 11px; }
.save-hint { color: #7fd8a8; font-size: 10px; margin-left: auto; }
.save-hint.error { color: #ff6b6b; }
.empty { padding: 20px; color: #667; }
</style>
