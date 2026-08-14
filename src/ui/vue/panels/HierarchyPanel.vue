<script setup lang="ts">
import { ref, computed } from 'vue';
import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';
import { SetParentCommand } from '../../../editor/commands/SceneCommands';

const host = useHost();
const scene = host.engine.scene;

interface Row { key: string; name: string; depth: number; hasChildren: boolean; }

/** Flattened depth-first traversal of the entity tree (roots first, then
 *  their children). The name comes from NameComponent; the parent chain is
 *  Scene's childMap (Transform.parent back-ref from Phase 2a). */
const rows = computed<Row[]>(() => {
    trigger.value; // dependency: re-evaluate on editor:changed
    const all = scene.getAllEntities().map(e => e.key);
    const childrenOf = (key: string): string[] => scene.getChildren(key);
    const out: Row[] = [];
    const visited = new Set<string>();
    const visit = (key: string, depth: number): void => {
        if (visited.has(key)) return;
        visited.add(key);
        const eid = scene.entityKeyMap.get(key);
        const name = eid != null
            ? (scene.getField(eid, 'NameComponent', 'name') as string ?? key)
            : key;
        const kids = childrenOf(key);
        out.push({ key, name, depth, hasChildren: kids.length > 0 });
        for (const c of kids) visit(c, depth + 1);
    };
    // Roots first (entities whose parent is '').
    for (const key of all) {
        const eid = scene.entityKeyMap.get(key);
        if (eid == null) continue;
        const parent = scene.getParent(eid);
        if (!parent) visit(key, 0);
    }
    // Any orphaned (parent missing) entities appear as roots too.
    for (const key of all) {
        if (!visited.has(key)) visit(key, 0);
    }
    return out;
});

const selectedKey = ref('');
const dragKey = ref('');
const dropTarget = ref('');
/** Bump on every editor:changed so the `rows` computed re-evaluates (scene
 *  reads are not reactive by themselves). */
const trigger = ref(0);

// Sync selection when the gizmo / EditorPanel pick an entity.
useEditorEvent('pick', (payload) => {
    const p = payload as { key?: string };
    if (p?.key) selectedKey.value = p.key;
});
// Refresh the tree on any editor change (entity add/remove/field/reparent).
useEditorEvent('editor:changed', () => { trigger.value++; });

function selectRow(key: string): void {
    selectedKey.value = key;
    host.eventBus.emit('pick', { key, source: 'hierarchy' });
}

function onDragStart(e: DragEvent, key: string): void {
    dragKey.value = key;
    if (e.dataTransfer) {
        e.dataTransfer.setData('text/hierarchy', key);
        e.dataTransfer.effectAllowed = 'move';
    }
}

function onDragOver(e: DragEvent, key: string): void {
    if (!dragKey.value || dragKey.value === key) return;
    e.preventDefault();
    dropTarget.value = key;
}

function onDrop(e: DragEvent, key: string): void {
    e.preventDefault();
    dropTarget.value = '';
    const child = dragKey.value;
    dragKey.value = '';
    if (!child || child === key) return;
    // Scene.setParent throws on cycles (e.g. dropping an ancestor onto its
    // own descendant); surface that as an alert so the user sees why nothing
    // happened instead of a silent console error.
    try {
        host.dispatch(new SetParentCommand(child, key));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[HierarchyPanel] reparent failed:', msg);
        alert(`Cannot reparent '${child}' under '${key}':\n${msg}`);
    }
}

function onDragLeave(): void { dropTarget.value = ''; }
</script>

<template>
    <div class="hierarchy-panel vue-panel">
        <div class="h-head">
            <span>Hierarchy</span>
            <span class="h-count">{{ rows.length }}</span>
        </div>
        <div class="h-body">
            <div v-for="r in rows" :key="r.key"
                 :class="['h-row', { selected: selectedKey === r.key, droptarget: dropTarget === r.key }]"
                 :style="{ paddingLeft: (8 + r.depth * 14) + 'px' }"
                 draggable="true"
                 @click="selectRow(r.key)"
                 @dragstart="onDragStart($event, r.key)"
                 @dragover="onDragOver($event, r.key)"
                 @drop="onDrop($event, r.key)"
                 @dragleave="onDragLeave">
                <span :class="['h-twisty', { leaf: !r.hasChildren }]">{{ r.hasChildren ? '▾' : '•' }}</span>
                <span class="h-name" :title="r.key">{{ r.name }}</span>
            </div>
            <div v-if="rows.length === 0" class="h-empty">No entities</div>
        </div>
    </div>
</template>

<style>
.hierarchy-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: #ccc; font-size: 12px; }
.h-head {
    padding: 6px 10px; color: #7ec8e3; font-weight: 600; font-size: 11px;
    border-bottom: 1px solid #2a3a5c; display: flex; justify-content: space-between;
    align-items: center; flex-shrink: 0;
}
.h-count { font-size: 10px; color: #8899aa; background: #24344f; border-radius: 8px; padding: 0 6px; line-height: 16px; }
.h-body { flex: 1; overflow-y: auto; min-height: 0; }
.h-row {
    display: flex; align-items: center; gap: 4px; padding: 3px 8px 3px 0;
    cursor: pointer; white-space: nowrap; overflow: hidden;
    border-left: 2px solid transparent;
}
.h-row:hover { background: #1e2d44; }
.h-row.selected { background: #1a4d8f; color: #fff; border-left-color: #4a8fc7; }
.h-row.droptarget { background: #2f7a4f; outline: 1px dashed #7fd8a8; }
.h-twisty { font-size: 10px; color: #678; width: 12px; flex-shrink: 0; }
.h-twisty.leaf { color: #445; }
.h-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.h-empty { padding: 14px; color: #667; font-style: italic; }
</style>
