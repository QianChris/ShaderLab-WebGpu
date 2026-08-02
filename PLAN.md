# 编辑器 Vue 面板扩展计划（资源视图 / 脚本编辑器 / WGSL 编辑器 / Pipeline 节点编辑器）

**目标**：在现有 `EditorUILayer` 中渐进式引入 4 个 Vue 3 面板，使用 CodeMirror 6 作为统一代码编辑器，所有状态变更通过 `AppHost.dispatch(new Command())` 派发，Vue 组件对 `EditorCommandBus` 零感知。

**执行原则**：
- Vue 组件 **禁止** 直接调用 `scene.setField()`、`renderGraph.fromData()` 等写入方法
- Vue 组件 **禁止** 直接访问 `EditorCommandBus` 实例，统一走 `host.dispatch(cmd)`
- CodeMirror 6 统一处理 JS 与 WGSL，不引入 Monaco
- 新面板与旧原生 DOM 面板（Scene / Pipeline）在 Tab 系统中混合共存
- `PatchRenderGraphCommand` 仅限字段级微改（enabled/params）；结构性变更（增删节点、改 phase）使用独立命令

---

## 一、前置依赖与安装

在工程根目录执行：

```bash
npm install vue@next @vitejs/plugin-vue
npm install codemirror @codemirror/lang-javascript @codemirror/language @codemirror/state @codemirror/view @codemirror/commands
npm install @vue-flow/core @vue-flow/background @vue-flow/controls
```

修改 `vite.config.ts`（若尚未配置 Vue 插件）：

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
});
```

---

## 二、文件结构总览

```
src/
├── ui/
│   ├── vue/
│   │   ├── index.ts                    # Vue 面板挂载工厂
│   │   ├── composables/
│   │   │   ├── useHost.ts              # inject(AppHost)
│   │   │   ├── useSceneCommands.ts     # 基于 host.dispatch 的命令工厂
│   │   │   ├── useEditorEvent.ts     # 订阅 eventBus
│   │   │   └── useResourceStats.ts   # 轮询资源统计
│   │   ├── components/
│   │   │   ├── CodeEditor.vue          # CodeMirror 6 封装（JS/WGSL 切换）
│   │   │   └── AssetTree.vue           # 资源分类树
│   │   ├── panels/
│   │   │   ├── AssetViewPanel.vue
│   │   │   ├── ScriptEditorPanel.vue
│   │   │   ├── WgslEditorPanel.vue
│   │   │   └── PipelineNodeEditor.vue
│   │   └── nodeGraph/
│   │       ├── types.ts
│   │       ├── graphAdapter.ts
│   │       └── layout.ts
│   └── layers/
│       └── EditorUILayer.ts            # 修改：增加 Vue 面板 Tab 与挂载逻辑
├── core/
│   ├── ecs/SystemRegistry.ts           # 修改：增加脚本热重载接口
│   ├── render/
│   │   ├── PipelineLoader.ts           # 修改：增加 shader 热重载与反向索引
│   │   ├── RenderScriptLoader.ts       # 修改：增加内存文本加载接口
│   │   ├── RenderGraph.ts              # 修改：增加 pipeline entry 增删接口
│   │   └── ResourceManager.ts          # 修改：增加只读资源枚举接口
└── editor/commands/
    ├── ScriptCommands.ts               # 新增：ReloadSystemScriptCommand / ReloadRenderScriptCommand
    ├── ShaderCommands.ts               # 新增：HotReloadShaderCommand
    └── RenderGraphCommands.ts          # 修改：新增 Add/Remove/Move PipelineEntry 命令
```

---

## 三、Phase 0：Vue 基础设施（4-6 小时）

### 3.1 核心 Composables

**`src/ui/vue/composables/useHost.ts`**：

```ts
import { inject } from 'vue';
import type { AppHost } from '../../../host/AppHost';

export const HOST_KEY = Symbol('host');

export function useHost(): AppHost {
    const host = inject<AppHost>(HOST_KEY);
    if (!host) throw new Error('useHost() must be called inside a Vue editor panel');
    return host;
}
```

**`src/ui/vue/composables/useSceneCommands.ts`**（替代原 `useCommandBus`，对 `EditorCommandBus` 零感知）：

```ts
import { useHost } from './useHost';
import { SetFieldCommand } from '../../../editor/commands/SceneCommands';
import { ReloadSystemScriptCommand } from '../../../editor/commands/ScriptCommands';
import { HotReloadShaderCommand } from '../../../editor/commands/ShaderCommands';
import type { Command } from '../../../editor/commands/Command';

export function useSceneCommands() {
    const host = useHost();
    const dispatch = (cmd: Command) => host.dispatch(cmd);

    return {
        dispatch,
        setField(entityKey: string, comp: string, field: string, value: unknown) {
            return dispatch(new SetFieldCommand(entityKey, comp, field, value));
        },
        reloadSystemScript(entryName: string, nextSource: string, prevSource: string) {
            return dispatch(new ReloadSystemScriptCommand(entryName, nextSource, prevSource));
        },
        hotReloadShader(shaderKey: string, nextSource: string, prevSource: string) {
            return dispatch(new HotReloadShaderCommand(shaderKey, nextSource, prevSource));
        },
        // 后续根据面板需求扩展
    };
}
```

**`src/ui/vue/composables/useEditorEvent.ts`**：

```ts
import { onMounted, onUnmounted } from 'vue';
import { useHost } from './useHost';

export function useEditorEvent(type: string, handler: (payload: unknown) => void) {
    const host = useHost();
    let unsub: (() => void) | undefined;
    onMounted(() => { unsub = host.eventBus.on(type, handler); });
    onUnmounted(() => unsub?.());
}
```

### 3.2 CodeEditor.vue 封装

**`src/ui/vue/components/CodeEditor.vue`**：

```vue
<script setup lang="ts">
import { ref, shallowRef, watch, onMounted, onUnmounted, computed } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

const props = defineProps<{
    modelValue: string;
    language: 'js' | 'wgsl';
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'save', v: string): void }>();

const containerRef = ref<HTMLElement>();
const view = shallowRef<EditorView>();

const wgslParser: StreamParser<unknown> = {
    token(stream) {
        if (stream.match(/^(fn|struct|var|let|const|if|else|for|while|return|switch|case|default|break|continue)\b/)) return 'keyword';
        if (stream.match(/^@(?:builtin|location|group|binding|workgroup_size|stage|vertex|fragment|compute)\b/)) return 'attribute';
        if (stream.match(/^(f32|i32|u32|bool|vec2|vec3|vec4|mat2x2|mat3x3|mat4x4|array|ptr|texture_2d|sampler|texture_depth_2d)\b/)) return 'typeName';
        if (stream.match(/^[0-9]+(?:\.[0-9]+)?(?:f|i|u)?\b/)) return 'number';
        if (stream.match(/^\/\/.*/)) return 'comment';
        if (stream.match(/^\/\*.*?\*\//)) return 'comment';
        if (stream.eat(/[+\-*/=<>!&|]/)) return 'operator';
        if (stream.eat('"')) { while (!stream.eol() && stream.next() !== '"') {} return 'string'; }
        stream.next();
        return null;
    },
    startState() { return null; },
};
const wgslLang = StreamLanguage.define(wgslParser);

const extensions = computed(() => [
    basicSetup,
    props.language === 'js' ? javascript() : wgslLang,
    EditorView.updateListener.of((upd) => {
        if (upd.docChanged) emit('update:modelValue', upd.state.doc.toString());
    }),
    EditorView.domEventHandlers({
        keydown: (event) => {
            if (event.ctrlKey && event.key === 's') {
                event.preventDefault();
                emit('save', view.value?.state.doc.toString() ?? '');
                return true;
            }
        },
    }),
]);

onMounted(() => {
    if (!containerRef.value) return;
    view.value = new EditorView({
        doc: props.modelValue,
        extensions: extensions.value,
        parent: containerRef.value,
    });
});

watch(() => props.modelValue, (next) => {
    const cur = view.value?.state.doc.toString();
    if (view.value && cur !== next) {
        view.value.dispatch({ changes: { from: 0, to: cur!.length, insert: next } });
    }
});

watch(() => props.language, () => {
    view.value?.destroy();
    if (containerRef.value) {
        view.value = new EditorView({
            doc: props.modelValue,
            extensions: extensions.value,
            parent: containerRef.value,
        });
    }
});

onUnmounted(() => view.value?.destroy());
</script>

<template>
    <div ref="containerRef" class="code-editor" />
</template>

<style>
.code-editor { height: 100%; overflow: auto; }
.cm-editor { height: 100%; }
</style>
```

### 3.3 EditorUILayer 改造

修改 `src/ui/layers/EditorUILayer.ts`，在 `mount()` 中新增 Vue 面板 Tab 与挂载逻辑：

```ts
// 在 container.innerHTML 中追加：
/*
<button class="tab-btn" data-tab="assets">Assets</button>
<button class="tab-btn" data-tab="scripts">Scripts</button>
<button class="tab-btn" data-tab="shaders">Shaders</button>
<button class="tab-btn" data-tab="nodes">Nodes</button>
...
<div id="tab-assets"   class="tab-panel" style="display:none;"></div>
<div id="tab-scripts"  class="tab-panel" style="display:none;"></div>
<div id="tab-shaders"  class="tab-panel" style="display:none;"></div>
<div id="tab-nodes"    class="tab-panel" style="display:none;"></div>
*/

// 在 mount() 末尾，初始化 Vue 面板：
import { createApp } from 'vue';
import { HOST_KEY } from '../vue/composables/useHost';
import AssetViewPanel from '../vue/panels/AssetViewPanel.vue';
import ScriptEditorPanel from '../vue/panels/ScriptEditorPanel.vue';
import WgslEditorPanel from '../vue/panels/WgslEditorPanel.vue';
import PipelineNodeEditor from '../vue/panels/PipelineNodeEditor.vue';

const vuePanels = [
    { id: 'tab-assets', comp: AssetViewPanel },
    { id: 'tab-scripts', comp: ScriptEditorPanel },
    { id: 'tab-shaders', comp: WgslEditorPanel },
    { id: 'tab-nodes', comp: PipelineNodeEditor },
];

const apps: ReturnType<typeof createApp>[] = [];
for (const { id, comp } of vuePanels) {
    const el = container.querySelector(`#${id}`) as HTMLElement;
    if (!el) continue;
    const app = createApp(comp);
    app.provide(HOST_KEY, host);
    app.mount(el);
    apps.push(app);
}

// unmount() 中追加：
for (const app of apps) app.unmount();
```

**验收标准**：
- [ ] 新增 4 个 Tab 可正常切换
- [ ] Vue 面板内 `useHost()` 能正确获取 `AppHost`
- [ ] CodeEditor.vue 输入文本能正确 emit `update:modelValue` 和 `save`
- [ ] Vue 面板内无 `useCommandBus` 或 `editorLayer.commandBus` 的直接引用

---

## 四、Phase 1：资源视图（Asset View）（3-4 小时）

### 4.1 Core 侧：ResourceManager 新增只读接口

修改 `src/core/render/ResourceManager.ts`，新增以下方法（只读，无副作用）：

```ts
getMeshNames(): string[] { return [...this.meshGpu.keys()]; }
getTextureNames(): string[] { return [...this.textures.keys()]; }
getColorTargetNames(): string[] { return [...this.colorTargets.keys()]; }
getDepthTargetNames(): string[] { return [...this.depthTargets.keys()]; }
getUniformNames(): string[] { return [...this.uniformBuffers.keys()]; }
getStorageNames(): string[] { return [...this.storageBuffers.keys()]; }
```

修改 `src/core/render/RenderGraph.ts`，新增：

```ts
/** 获取当前已加载的所有 pipeline entry（只读） */
getPipelineEntries(): Array<{ name: string; pipeline: string; phase: string; enabled: boolean }> {
    const out: Array<{ name: string; pipeline: string; phase: string; enabled: boolean }> = [];
    for (const phase of this.phaseList) {
        for (const entry of this.phases[phase.name] ?? []) {
            out.push({ name: entry.name, pipeline: entry.pipeline, phase: phase.name, enabled: entry.enabled });
        }
    }
    return out;
}
```

### 4.2 Vue 面板：AssetViewPanel.vue

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';

const host = useHost();
const rm = host.engine.resourceManager;
const rg = host.engine.renderGraph;

const categories = computed(() => [
    { name: 'Meshes', items: rm.getMeshNames() },
    { name: 'Textures', items: rm.getTextureNames() },
    { name: 'Color Targets', items: rm.getColorTargetNames() },
    { name: 'Depth Targets', items: rm.getDepthTargetNames() },
    { name: 'Uniform Buffers', items: rm.getUniformNames() },
    { name: 'Storage Buffers', items: rm.getStorageNames() },
    { name: 'Pipelines', items: rg.getPipelineEntries().map(e => `${e.name} (${e.pipeline})`) },
]);

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
    <div class="asset-panel">
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
                <p>（后续可扩展展示 GPU 资源详情）</p>
            </div>
            <div v-else class="empty">Select an asset</div>
        </div>
    </div>
</template>

<style>
.asset-panel { display: flex; height: 100%; }
.asset-tree { width: 240px; overflow-y: auto; border-right: 1px solid #333; }
.cat-name { padding: 4px 8px; font-weight: bold; background: #222; color: #aaa; }
.item { padding: 3px 12px; cursor: pointer; color: #ccc; font-size: 12px; }
.item:hover { background: #333; }
.item.active { background: #1a4d8f; color: #fff; }
.asset-detail { flex: 1; padding: 12px; color: #ccc; }
.empty { opacity: 0.5; }
</style>
```

**验收标准**：
- [ ] 资源分类列表正确展示当前 App 的所有资源
- [ ] 切换 App 后列表自动刷新（通过 `editor:changed` 事件）
- [ ] 点击资源项 emit `asset:selected` 事件

---

## 五、Phase 2：脚本编辑器（Script Editor）（6-8 小时）

### 5.1 Core 侧：SystemRegistry 热重载

修改 `src/core/ecs/SystemRegistry.ts`，新增：

```ts
/** Hot-reload a script system by its entry name with new source code.
 *  The adapter's init() will be re-invoked lazily on the next update(). */
async reloadScriptByEntry(entryName: string, sourceCode: string): Promise<void> {
    const def = this.defs.get(entryName);
    if (!def?.source || def.source.startsWith('builtin:')) {
        throw new Error(`System '${entryName}' is not a script-loaded system`);
    }
    const old = this.scripts.get(def.source);
    old?.dispose?.();

    const blob = new Blob([sourceCode], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
        const mod = await import(/* @vite-ignore */ blobUrl);
        const systemMod = (mod.default ?? mod) as SystemScriptModule;
        this.scripts.set(def.source, new ScriptSystemAdapter(systemMod));
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

/** Get the script source path for a system entry (for display). */
getScriptSource(entryName: string): string | undefined {
    const def = this.defs.get(entryName);
    return def?.source && !def.source.startsWith('builtin:') ? def.source : undefined;
}

/** List all script-loaded system entries. */
getScriptSystemEntries(): string[] {
    return [...this.defs.entries()]
        .filter(([, d]) => d.source && !d.source.startsWith('builtin:'))
        .map(([name]) => name);
}
```

修改 `src/core/render/RenderScriptLoader.ts`，新增：

```ts
/** Load a render script from in-memory text instead of fetching.
 *  Used by the editor for hot-reload. */
async loadFromText(file: string, text: string): Promise<Record<string, AnyFn>> {
    const blob = new Blob([text], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
        const mod = await import(/* @vite-ignore */ blobUrl);
        const exports = (mod.default ?? mod) as Record<string, AnyFn>;
        this.loaded.set(file, exports);
        return exports;
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}
```

在 `src/core/render/RenderGraph.ts` 中新增代理：

```ts
private scriptLoader?: RenderScriptLoader;

async compile(...): Promise<void> {
    // ... 原有逻辑 ...
    if (this.scriptFiles.length > 0) {
        this.scriptLoader = new RenderScriptLoader(dataBase, this.scriptsSubdir);
        // ...
    }
}

async reloadRenderScript(file: string, source: string): Promise<void> {
    if (!this.scriptLoader) throw new Error('RenderScriptLoader not initialized');
    const exports = await this.scriptLoader.loadFromText(file, source);
    const baseName = file.replace(/^[^/]+\//, '').replace(/\.js$/, '');
    for (const [name, fn] of Object.entries(exports)) {
        if (typeof fn !== 'function') continue;
        const key = `${baseName}.${name}`;
        this.registerValueScript(key, fn as never, 'app');
        this.registerGeometryHook(key, fn as never, 'app');
        this.registerComputeHook(key, fn as never, 'app');
    }
}
```

### 5.2 新增命令

**`src/editor/commands/ScriptCommands.ts`**：

```ts
import type { Command, CommandContext } from './Command';

export class ReloadSystemScriptCommand implements Command {
    readonly type = 'reloadSystemScript';
    readonly description = 'reloadSystemScript';
    constructor(
        private entryName: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        ctx.engine.systemRegistry.reloadScriptByEntry(this.entryName, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.systemRegistry.reloadScriptByEntry(this.entryName, this.prevSource);
        return true;
    }
}

export class ReloadRenderScriptCommand implements Command {
    readonly type = 'reloadRenderScript';
    readonly description = 'reloadRenderScript';
    constructor(
        private file: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.reloadRenderScript(this.file, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.reloadRenderScript(this.file, this.prevSource);
        return true;
    }
}
```

### 5.3 Vue 面板：ScriptEditorPanel.vue

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useSceneCommands } from '../composables/useSceneCommands';
import CodeEditor from '../components/CodeEditor.vue';
import { ReloadSystemScriptCommand, ReloadRenderScriptCommand } from '../../../editor/commands/ScriptCommands';

const host = useHost();
const cmds = useSceneCommands();

const systemEntries = computed(() => host.engine.systemRegistry.getScriptSystemEntries());
const renderScriptFiles = computed(() => host.engine.renderGraph.scriptFiles); // 需暴露

const selectedEntry = ref<string>('');
const selectedFile = ref<string>('');
const activeTab = ref<'system' | 'render'>('system');

const sourceCache = ref<Record<string, string>>({});

async function selectSystem(name: string) {
    selectedEntry.value = name;
    activeTab.value = 'system';
    if (!sourceCache.value[name]) {
        const srcPath = host.engine.systemRegistry.getScriptSource(name);
        if (srcPath) {
            const url = srcPath.startsWith('/') ? srcPath : `${host.engine.engineConfig.appsRoot}/${host.engine.currentApp}/${srcPath}`;
            const resp = await fetch(url);
            sourceCache.value[name] = resp.ok ? await resp.text() : '// failed to load';
        }
    }
}

async function selectRender(file: string) {
    selectedFile.value = file;
    activeTab.value = 'render';
    if (!sourceCache.value[file]) {
        const url = `${host.engine.engineConfig.dataRoot}/${host.engine.renderGraph.scriptsSubdir}/${file}`;
        const resp = await fetch(url);
        sourceCache.value[file] = resp.ok ? await resp.text() : '// failed to load';
    }
}

function onSave(code: string) {
    if (activeTab.value === 'system' && selectedEntry.value) {
        const prev = sourceCache.value[selectedEntry.value] ?? '';
        sourceCache.value[selectedEntry.value] = code;
        cmds.dispatch(new ReloadSystemScriptCommand(selectedEntry.value, code, prev));
    } else if (activeTab.value === 'render' && selectedFile.value) {
        const prev = sourceCache.value[selectedFile.value] ?? '';
        sourceCache.value[selectedFile.value] = code;
        cmds.dispatch(new ReloadRenderScriptCommand(selectedFile.value, code, prev));
    }
}
</script>

<template>
    <div class="script-panel">
        <div class="file-tree">
            <div class="tree-title">System Scripts</div>
            <div v-for="e in systemEntries" :key="e" 
                 :class="['tree-item', { active: activeTab === 'system' && selectedEntry === e }]"
                 @click="selectSystem(e)">{{ e }}</div>
            <div class="tree-title" style="margin-top:12px">Render Scripts</div>
            <div v-for="f in renderScriptFiles" :key="f"
                 :class="['tree-item', { active: activeTab === 'render' && selectedFile === f }]"
                 @click="selectRender(f)">{{ f }}</div>
        </div>
        <div class="editor-wrap">
            <CodeEditor v-if="activeTab === 'system' && selectedEntry" 
                        :modelValue="sourceCache[selectedEntry] ?? ''" 
                        language="js"
                        @save="onSave" />
            <CodeEditor v-else-if="activeTab === 'render' && selectedFile"
                        :modelValue="sourceCache[selectedFile] ?? ''"
                        language="js"
                        @save="onSave" />
            <div v-else class="empty">Select a script</div>
        </div>
    </div>
</template>

<style>
.script-panel { display: flex; height: 100%; }
.file-tree { width: 200px; overflow-y: auto; border-right: 1px solid #333; }
.tree-title { padding: 6px; font-weight: bold; color: #888; background: #1a1a1a; }
.tree-item { padding: 4px 10px; cursor: pointer; color: #ccc; font-size: 12px; }
.tree-item:hover { background: #2a2a2a; }
.tree-item.active { background: #1a4d8f; color: #fff; }
.editor-wrap { flex: 1; display: flex; flex-direction: column; }
.empty { padding: 20px; color: #666; }
</style>
```

**验收标准**：
- [ ] 列出所有 script-loaded system entries 和 render script files
- [ ] 点击 entry 加载源码到 CodeEditor
- [ ] Ctrl+S 保存后，3D 场景行为立即变化（验证热重载）
- [ ] Undo 可恢复旧脚本行为
- [ ] Vue 面板内无 `commandBus` 直接引用，全部通过 `useSceneCommands` 走 `host.dispatch`

---

## 六、Phase 3：WGSL 编辑器（4-6 小时）

### 6.1 约束声明

WGSL 热重载**仅限算法修改**（函数体、数值常量、分支逻辑），**禁止修改接口结构**：
- 不得新增/删除 `@group`、`@binding`
- 不得修改 `fn` 的 entry point 名称（如 `vs_main`、`fs_main`）
- 不得修改 vertex buffer 的 `@location` 布局

保存时通过简单正则检查，若发现接口变更则拒绝热重载并提示用户：*"Interface change detected. Please modify pipeline.json and reload the app."*

### 6.2 Core 侧：PipelineLoader Shader 热重载

修改 `src/core/render/PipelineLoader.ts`，新增：

```ts
/** Reverse index: shader ref -> list of pipeline paths that use it. */
private static shaderToPipelines = new Map<string, string[]>();

/** List all shader refs currently loaded, with their referencing pipelines. */
static listShaderRefs(): Array<{ ref: string; pipelines: string[] }> {
    return [...this.shaderToPipelines.entries()].map(([ref, pipelines]) => ({ ref, pipelines }));
}

/** Hot-reload a shader module by its internal key. Returns affected pipeline paths.
 *  Throws if the new source fails shader module creation. */
static hotReloadShader(device: GPUDevice, shaderKey: string, newSrc: string): string[] {
    if (!this.shaderModules.has(shaderKey)) {
        throw new Error(`Shader '${shaderKey}' not loaded`);
    }
    // 预创建 module 验证语法（若失败会抛出，不会污染缓存）
    const newModule = device.createShaderModule({ label: shaderKey, code: newSrc });
    this.shaderModules.set(shaderKey, newModule);
    return this.shaderToPipelines.get(shaderKey) ?? [];
}

// 在 buildRender() / loadCompute() 中，编译 shader 后记录反向索引：
// this.shaderToPipelines.set(vsKey, [...(this.shaderToPipelines.get(vsKey) ?? []), configPath]);
```

修改 `src/core/render/RenderGraph.ts`，新增代理：

```ts
/** Rebuild all pipelines that reference the given shader key.
 *  If any rebuild fails (e.g. interface mismatch), the error is caught and
 *  logged, but other pipelines continue. The shader module itself is already
 *  replaced in PipelineLoader; if rebuild fails the old pipeline stays bound
 *  until the error is fixed. */
rebuildPipelineByShader(device: GPUDevice, shaderKey: string, newSrc: string): void {
    try {
        const affected = PipelineLoader.hotReloadShader(device, shaderKey, newSrc);
        for (const path of affected) {
            try {
                this.rebuildPipeline(device, path);
            } catch (e) {
                console.error(`[RenderGraph] rebuild pipeline '${path}' failed after shader reload:`, e);
            }
        }
    } catch (e) {
        console.error(`[RenderGraph] shader hot reload failed for '${shaderKey}':`, e);
        throw e; // 让命令层知道失败，不执行
    }
}
```

### 6.3 新增命令

**`src/editor/commands/ShaderCommands.ts`**：

```ts
import type { Command, CommandContext } from './Command';

export class HotReloadShaderCommand implements Command {
    readonly type = 'hotReloadShader';
    readonly description = 'hotReloadShader';
    constructor(
        private shaderKey: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.rebuildPipelineByShader(ctx.engine.device, this.shaderKey, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.rebuildPipelineByShader(ctx.engine.device, this.shaderKey, this.prevSource);
        return true;
    }
}
```

### 6.4 Vue 面板：WgslEditorPanel.vue

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useSceneCommands } from '../composables/useSceneCommands';
import CodeEditor from '../components/CodeEditor.vue';
import { HotReloadShaderCommand } from '../../../editor/commands/ShaderCommands';
import { PipelineLoader } from '../../../core/render/PipelineLoader';

const host = useHost();
const cmds = useSceneCommands();

const shaderList = computed(() => PipelineLoader.listShaderRefs());
const selectedShader = ref<string>('');

const sourceCache = ref<Record<string, string>>({});

// 接口变更检测正则
const INTERFACE_RE = /@(group|binding|location|builtin)\b|^\s*fn\s+(vs_main|fs_main|cs_main|main)\s*\(/m;

async function selectShader(ref: string) {
    selectedShader.value = ref;
    if (!sourceCache.value[ref]) {
        // 从 PipelineLoader 获取原始 source（需新增缓存）
        // 若未缓存，从 fetch 回读原始文件
        sourceCache.value[ref] = '// TODO: load original source';
    }
}

function onSave(code: string) {
    const key = selectedShader.value;
    // 简单接口变更检测：比较新旧代码中接口声明的数量和位置
    const prev = sourceCache.value[key] ?? '';
    const prevInterfaces = (prev.match(INTERFACE_RE) || []).sort().join(',');
    const nextInterfaces = (code.match(INTERFACE_RE) || []).sort().join(',');
    if (prevInterfaces !== nextInterfaces) {
        alert('Interface change detected. Please modify pipeline.json and reload the app.');
        return;
    }
    sourceCache.value[key] = code;
    cmds.dispatch(new HotReloadShaderCommand(key, code, prev));
}
</script>

<template>
    <div class="shader-panel">
        <div class="file-tree">
            <div class="tree-title">Shaders</div>
            <div v-for="s in shaderList" :key="s.ref"
                 :class="['tree-item', { active: selectedShader === s.ref }]"
                 @click="selectShader(s.ref)">
                <div class="ref">{{ s.ref }}</div>
                <div class="meta">{{ s.pipelines.length }} pipeline(s)</div>
            </div>
        </div>
        <div class="editor-wrap">
            <CodeEditor v-if="selectedShader"
                        :modelValue="sourceCache[selectedShader] ?? ''"
                        language="wgsl"
                        @save="onSave" />
            <div v-else class="empty">Select a shader</div>
        </div>
    </div>
</template>

<style>
.shader-panel { display: flex; height: 100%; }
.file-tree { width: 240px; overflow-y: auto; border-right: 1px solid #333; }
.ref { font-size: 12px; color: #ccc; }
.meta { font-size: 10px; color: #888; }
/* 复用 script-panel 样式 */
</style>
```

**注意**：WGSL 原始源码获取需要 `PipelineLoader` 缓存原始文本。在 `ensureShaderModule` 中增加：

```ts
private static shaderSourceCache = new Map<string, string>();

static getShaderSource(key: string): string | undefined {
    return this.shaderSourceCache.get(key);
}

private static async shaderSource(base: ShaderBase, shaderRef: string): Promise<string> {
    // ... 原有逻辑 ...
    const src = await this.shaderSource(base, shaderRef);
    this.shaderSourceCache.set(key, src); // 缓存原始文本
    return src;
}
```

**验收标准**：
- [ ] 列出所有被 pipeline 引用的 shader
- [ ] 修改 WGSL 算法后保存，关联 pipeline 自动重建，渲染效果变化
- [ ] 若修改 `@binding` / entry point 等接口，保存被拒绝并提示
- [ ] Undo 恢复旧 shader
- [ ] 单个 pipeline 重建失败不影响其他 pipeline

---

## 七、Phase 4：Pipeline 节点编辑器（Pipeline Node Editor）（16-24 小时）

### 7.1 设计约束

- **4A 只读**：先把当前 Render Graph 可视化出来，不可编辑，验证双向转换器
- **4B 编辑**：仅支持以下操作，**禁止**直接整体替换 `RenderGraphData`
  - 修改节点 `enabled` / `params` → 走 `PatchRenderGraphCommand`
  - 新增 PipelineEntry → 走 `AddPipelineEntryCommand`
  - 删除 PipelineEntry → 走 `RemovePipelineEntryCommand`
  - 移动节点到另一 phase → 走 `MovePipelineEntryCommand`

### 7.2 Core 侧：RenderGraph 增删接口

修改 `src/core/render/RenderGraph.ts`，新增安全入口：

```ts
/** Add a new pipeline entry to a phase. The pipeline must already be compiled.
 *  Returns the newly created PipelineDriver. */
addPipelineEntry(phaseName: string, entry: PipelineEntry): PipelineDriver {
    const phase = this.phases[phaseName];
    if (!phase) throw new Error(`Phase '${phaseName}' not found`);
    if (phase.some(e => e.name === entry.name)) {
        throw new Error(`Pipeline entry '${entry.name}' already exists in phase '${phaseName}'`);
    }
    phase.push(entry);
    
    // 若 pipeline 已编译，创建 driver
    const pipeline = this.pipelines.get(entry.pipeline);
    const config = PipelineLoader.getConfig(entry.pipeline);
    const decl = config?.renderer;
    if (!decl) throw new Error(`Pipeline '${entry.pipeline}' has no renderer decl`);
    
    const driver = new PipelineDriver(entry.pipeline, decl, entry, this.valueScripts, this.geometryHooks, this.computeHooks);
    driver.dataBase = this.dataBase;
    driver.aux = decl.aux ?? {};
    if (decl.query) {
        driver.query = defineQuery(decl.query.map(name => {
            const comp = schemaRegistry.get(name);
            if (!comp) throw new Error(`...`);
            return comp;
        }));
    }
    this.drivers.push(driver);
    return driver;
}

/** Remove a pipeline entry by name from all phases. */
removePipelineEntry(name: string): void {
    for (const phase of this.phaseList) {
        const list = this.phases[phase.name] ?? [];
        const idx = list.findIndex(e => e.name === name);
        if (idx >= 0) {
            list.splice(idx, 1);
            break;
        }
    }
    const dIdx = this.drivers.findIndex(d => d.entry.name === name);
    if (dIdx >= 0) {
        this.drivers[dIdx].dispose();
        this.drivers.splice(dIdx, 1);
    }
}

/** Move an entry from one phase to another. */
movePipelineEntry(name: string, toPhase: string): void {
    let entry: PipelineEntry | undefined;
    for (const phase of this.phaseList) {
        const list = this.phases[phase.name] ?? [];
        const idx = list.findIndex(e => e.name === name);
        if (idx >= 0) {
            entry = list.splice(idx, 1)[0];
            break;
        }
    }
    if (!entry) throw new Error(`Pipeline entry '${name}' not found`);
    const targetList = this.phases[toPhase] ?? [];
    targetList.push({ ...entry, phase: toPhase } as PipelineEntry);
}
```

### 7.3 新增命令

修改/扩展 `src/editor/commands/RenderGraphCommands.ts`：

```ts
export class PatchRenderGraphCommand implements Command {
    // ... 保持原有逻辑，但明确限制：
    // 仅更新 enabled 和 params，不处理增删改 phase ...
}

export class AddPipelineEntryCommand implements Command {
    readonly type = 'addPipelineEntry';
    readonly description = 'addPipelineEntry';
    private prevDriversJson?: string;
    constructor(
        private phaseName: string,
        private entry: PipelineEntry,
    ) {}

    execute(ctx: CommandContext): boolean {
        this.prevDriversJson = JSON.stringify(ctx.engine.renderGraph.toData());
        ctx.engine.renderGraph.addPipelineEntry(this.phaseName, this.entry);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        if (!this.prevDriversJson) return false;
        ctx.engine.renderGraph.removePipelineEntry(this.entry.name);
        return true;
    }
}

export class RemovePipelineEntryCommand implements Command {
    readonly type = 'removePipelineEntry';
    readonly description = 'removePipelineEntry';
    private backupEntry?: PipelineEntry;
    private backupPhase?: string;
    constructor(private name: string) {}

    execute(ctx: CommandContext): boolean {
        for (const phase of ctx.engine.renderGraph.getPhaseNames()) {
            const list = ctx.engine.renderGraph.phases[phase] ?? [];
            const target = list.find(e => e.name === this.name);
            if (target) {
                this.backupPhase = phase;
                this.backupEntry = { ...target };
                ctx.engine.renderGraph.removePipelineEntry(this.name);
                return true;
            }
        }
        return false;
    }

    undo(ctx: CommandContext): boolean {
        if (!this.backupEntry || !this.backupPhase) return false;
        ctx.engine.renderGraph.addPipelineEntry(this.backupPhase, this.backupEntry);
        return true;
    }
}

export class MovePipelineEntryCommand implements Command {
    readonly type = 'movePipelineEntry';
    readonly description = 'movePipelineEntry';
    private fromPhase?: string;
    constructor(private name: string, private toPhase: string) {}

    execute(ctx: CommandContext): boolean {
        for (const phase of ctx.engine.renderGraph.getPhaseNames()) {
            const list = ctx.engine.renderGraph.phases[phase] ?? [];
            if (list.some(e => e.name === this.name)) {
                this.fromPhase = phase;
                ctx.engine.renderGraph.movePipelineEntry(this.name, this.toPhase);
                return true;
            }
        }
        return false;
    }

    undo(ctx: CommandContext): boolean {
        if (!this.fromPhase) return false;
        ctx.engine.renderGraph.movePipelineEntry(this.name, this.fromPhase);
        return true;
    }
}
```

### 7.4 节点图数据模型与转换器

**`src/ui/vue/nodeGraph/types.ts`**：

```ts
export type NodeType = 'renderPass' | 'computePass' | 'resource';

export interface GraphNode {
    id: string;
    type: NodeType;
    label: string;
    data: {
        pipeline?: string;
        phase?: string;
        enabled?: boolean;
        targetColor?: string[];
        targetDepth?: string;
    };
    position: { x: number; y: number };
}

export interface GraphEdge {
    id: string;
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
}
```

**`src/ui/vue/nodeGraph/graphAdapter.ts`**：

```ts
import type { RenderGraphData, PipelineConfig } from '../../../core/render/types';
import type { GraphNode, GraphEdge } from './types';

export function renderGraphToNodes(
    data: RenderGraphData,
    configs: Map<string, PipelineConfig>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let y = 0;

    for (const phaseName of Object.keys(data.phases)) {
        const entries = data.phases[phaseName] ?? [];
        for (const entry of entries) {
            const config = configs.get(entry.pipeline);
            const decl = config?.renderer;
            const node: GraphNode = {
                id: `${phaseName}_${entry.name}`,
                type: entry.kind === 'compute' ? 'computePass' : 'renderPass',
                label: entry.name,
                data: {
                    pipeline: entry.pipeline,
                    phase: phaseName,
                    enabled: entry.enabled,
                    targetColor: typeof decl?.target?.color === 'string' 
                        ? [decl.target.color] 
                        : decl?.target?.color,
                    targetDepth: decl?.target?.depth,
                },
                position: { x: 200, y: y * 100 },
            };
            nodes.push(node);
            y++;
        }
    }

    // 资源节点
    const resourceNodes = new Map<string, GraphNode>();
    for (const n of nodes) {
        for (const c of n.data.targetColor ?? []) {
            if (c !== 'screen' && c !== 'scene' && !resourceNodes.has(c)) {
                const rn: GraphNode = { id: `res_${c}`, type: 'resource', label: c, data: {}, position: { x: 500, y: resourceNodes.size * 80 } };
                resourceNodes.set(c, rn);
            }
        }
    }
    nodes.push(...resourceNodes.values());

    for (const n of nodes) {
        if (n.type === 'renderPass' || n.type === 'computePass') {
            for (const c of n.data.targetColor ?? []) {
                edges.push({ id: `${n.id}_to_${c}`, source: n.id, sourceHandle: 'out', target: `res_${c}`, targetHandle: 'in' });
            }
        }
    }

    return { nodes, edges };
}
```

### 7.5 Vue Flow 面板

**`src/ui/vue/panels/PipelineNodeEditor.vue`**：

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';

import { useHost } from '../composables/useHost';
import { useSceneCommands } from '../composables/useSceneCommands';
import { renderGraphToNodes } from '../nodeGraph/graphAdapter';
import { PatchRenderGraphCommand, AddPipelineEntryCommand, RemovePipelineEntryCommand } from '../../../editor/commands/RenderGraphCommands';
import { PipelineLoader } from '../../../core/render/PipelineLoader';

const host = useHost();
const cmds = useSceneCommands();
const { addNodes, addEdges } = useVueFlow();

const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);

function loadGraph() {
    const data = host.engine.renderGraph.toData();
    const configs = new Map<string, any>();
    for (const phase of host.engine.renderGraph.getPhaseNames()) {
        for (const entry of host.engine.renderGraph.phases[phase] ?? []) {
            const c = PipelineLoader.getConfig(entry.pipeline);
            if (c) configs.set(entry.pipeline, c);
        }
    }
    const graph = renderGraphToNodes(data, configs);
    nodes.value = graph.nodes.map(n => ({
        id: n.id,
        type: 'default',
        label: n.label,
        position: n.position,
        data: n.data,
    }));
    edges.value = graph.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
    }));
}

loadGraph();

import { useEditorEvent } from '../composables/useEditorEvent';
useEditorEvent('editor:changed', () => loadGraph());

// 4B：应用字段级变更（enabled/params）
function applyParams() {
    const prev = JSON.stringify(host.engine.renderGraph.toData());
    const nextData = host.engine.renderGraph.toData();
    // 将 nodes 中的 enabled 同步回 nextData
    for (const n of nodes.value) {
        if (n.data?.phase && n.data?.enabled !== undefined) {
            const list = nextData.phases[n.data.phase] ?? [];
            const target = list.find((e: any) => e.name === n.label);
            if (target) target.enabled = n.data.enabled;
        }
    }
    cmds.dispatch(new PatchRenderGraphCommand(nextData, prev));
}

// 4B：删除节点
function removeNode(nodeId: string) {
    const name = nodeId.split('_').slice(1).join('_'); // 从 id 还原 name
    cmds.dispatch(new RemovePipelineEntryCommand(name));
}
</script>

<template>
    <div class="node-editor">
        <div class="toolbar">
            <button @click="loadGraph">Reset View</button>
            <button @click="applyParams">Apply Params</button>
        </div>
        <VueFlow v-model:nodes="nodes" v-model:edges="edges" fit-view-on-init @nodeDoubleClick="(e) => removeNode(e.node.id)">
            <Background pattern-color="#333" gap="16" />
            <Controls />
        </VueFlow>
    </div>
</template>

<style>
.node-editor { height: 100%; display: flex; flex-direction: column; }
.toolbar { padding: 6px; background: #1a1a1a; border-bottom: 1px solid #333; }
.toolbar button { margin-right: 8px; }
.vue-flow { flex: 1; background: #111; }
</style>
```

**验收标准（分阶段）**：

**阶段 A（只读）**：
- [ ] 节点图正确展示当前所有 Render Pass / Compute Pass / Resource
- [ ] 边正确连接 Pass 与 Target
- [ ] 切换 App 后节点图自动刷新

**阶段 B（可编辑）**：
- [ ] 修改节点 `enabled` 后 Apply，通过 `PatchRenderGraphCommand` 生效
- [ ] 双击节点删除，通过 `RemovePipelineEntryCommand` 生效，可 Undo
- [ ] 新增节点通过 `AddPipelineEntryCommand` 生效（需 UI 设计添加对话框）
- [ ] 无 `renderGraph.fromData()` 的整体替换调用

---

## 八、总体验收清单

| 检查项 | 标准 |
|--------|------|
| 架构铁律 | `src/ui/vue/` 下无任何文件直接调用 `scene.setField` 或 `renderGraph.fromData` |
| 命令闭环 | 所有保存/应用操作都产生可 Undo 的 Command，通过 `host.dispatch()` 下发 |
| 零感知 | Vue 组件不直接引用 `EditorCommandBus`，只通过 `useSceneCommands` 访问 |
| 热重载 | Script / WGSL 修改后无需刷新页面，3D 场景立即响应 |
| 接口保护 | WGSL 热重载拒绝接口变更，提示用户修改 pipeline.json |
| 结构隔离 | `PatchRenderGraphCommand` 仅处理 enabled/params；增删节点走独立命令 |
| 共存 | 原生 Scene / Pipeline 面板与 Vue 面板可正常切换，互不干扰 |
| 卸载 | `EditorUILayer.unmount()` 时所有 Vue app 正确 `unmount()` |

---

## 九、工作量汇总

| Phase | 内容 | 预计时间 |
|-------|------|---------|
| 0 | Vue 基础设施 + CodeEditor + EditorUILayer 改造 | 1 天 |
| 1 | 资源视图（只读） | 0.5 天 |
| 2 | 脚本编辑器（System/Render Script 热重载） | 1-1.5 天 |
| 3 | WGSL 编辑器（Shader 热重载 + 接口保护） | 0.5-1 天 |
| 4A | Pipeline 节点编辑器（只读可视化） | 1 天 |
| 4B | Pipeline 节点编辑器（可编辑 + 独立命令） | 1-2 天 |
| **总计** | | **4.5-7 天** |

**建议执行顺序**：0 → 1 → 2 → 3 → 4A → 4B。每个 Phase 完成后运行 `npx tsc --noEmit` 确保类型安全。
