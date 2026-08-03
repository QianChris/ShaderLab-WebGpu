<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { VueFlow, useVueFlow, Handle, Position, type Node, type Edge, type Connection } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

import { useHost } from '../composables/useHost';
import { useEditorEvent } from '../composables/useEditorEvent';
import { shaderGraphToFlow, type GraphFlowNode, type GraphFlowEdge } from '../nodeGraph/graphAdapter';
import { MutateShaderGraphCommand, RegisterShaderGraphCommand } from '../../../editor/commands/ShaderGraphCommands';
import type { ShaderGraph, ShaderGraphNode, ShaderGraphEdge } from '../../../core/render/shaderGraph';

const host = useHost();
const { fitView } = useVueFlow();

const graphNames = ref<string[]>([]);
const selectedName = ref<string>('');
const flowNodes = ref<Node[]>([]);
const flowEdges = ref<Edge[]>([]);
const statusMsg = ref('');
const nodeParamError = ref('');
/** True once the <VueFlow> viewport has mounted (its `ready` event). fitView()
 *  is only safe after that — calling it earlier warns "Viewport not initialized". */
const flowReady = ref(false);

// Node template registry for the "Add node" menu.
const NODE_TYPES = ['data', 'shader', 'if', 'foreach', 'loop'] as const;

function refreshList(): void {
    graphNames.value = host.engine.shaderGraphRegistry.names();
    if (selectedName.value && !graphNames.value.includes(selectedName.value)) {
        selectedName.value = '';
    }
    if (!selectedName.value && graphNames.value.length > 0) {
        selectedName.value = graphNames.value[0];
    }
    loadGraph();
}

function currentGraph(): ShaderGraph | null {
    if (!selectedName.value) return null;
    const ex = host.engine.shaderGraphRegistry.get(selectedName.value);
    return ex ? ex.toData() : null;
}

function loadGraph(): void {
    const graph = currentGraph();
    if (!graph) {
        flowNodes.value = [];
        flowEdges.value = [];
        return;
    }
    const converted = shaderGraphToFlow(graph);
    flowNodes.value = converted.nodes.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: { node: n.data.node, label: n.data.label },
    })) as Node[];
    flowEdges.value = converted.edges.map(e => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
    })) as Edge[];
    // fitView is only valid once the viewport exists (flowReady). The panel is
    // mounted into a display:none tab, so re-fit when it becomes visible too.
    if (flowReady.value) {
        nextTickFit();
    }
}

function nextTickFit(): void {
    requestAnimationFrame(() => {
        if (flowReady.value) fitView({ padding: 0.3, maxZoom: 1.2 });
    });
}

function onFlowReady(): void {
    flowReady.value = true;
    nextTickFit();
}

useEditorEvent('editor:changed', refreshList);
onMounted(refreshList);

// ── Edits ──────────────────────────────────────────────

function applyGraph(mutate: (g: ShaderGraph) => void): void {
    const graph = currentGraph();
    if (!graph) return;
    const prev = JSON.stringify(graph);
    mutate(graph);
    host.dispatch(new MutateShaderGraphCommand(graph.name, graph, prev));
    loadGraph();
}

function addNode(type: string): void {
    if (!(NODE_TYPES as readonly string[]).includes(type)) {
        statusMsg.value = 'Invalid node type';
        return;
    }
    const id = `n${Date.now()}`;
    applyGraph(g => {
        switch (type) {
            case 'data':
                g.nodes.push({ id, type: 'data', source: 'MyComponent.hPos', kind: 'storage' });
                break;
            case 'shader':
                g.nodes.push({ id, type: 'shader', shader: 'graphs/sim.wgsl', entryPoint: 'main', count: 'MyComponent.count' });
                break;
            case 'if':
                g.nodes.push({ id, type: 'if', condition: 'MyComponent.enabled' });
                break;
            case 'foreach':
                g.nodes.push({ id, type: 'foreach', count: 'MyComponent.count' });
                break;
            case 'loop':
                g.nodes.push({ id, type: 'loop', iterations: '3' });
                break;
        }
    });
}

function removeNode(nodeId: string): void {
    applyGraph(g => {
        g.nodes = g.nodes.filter(n => n.id !== nodeId);
        g.edges = g.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
    });
}

/** Draw a new edge (vue-flow @connect). Constructs a ShaderGraphEdge from the
 *  connection's source/target + handle ids and dispatches via applyGraph so
 *  it enters the undo stack (same mechanism as commitParams). Connection
 *  constraints are enforced by isValidConnection first. */
function onConnect(conn: Connection): void {
    if (!isValidConnection(conn)) {
        statusMsg.value = 'invalid connection — data.out→shader.in:N only; body/next from control nodes';
        return;
    }
    if (!conn.source || !conn.target) return;
    // Block duplicate edges (same source/handle → target/handle).
    const graph = currentGraph();
    if (graph?.edges.some(e =>
        e.source === conn.source && e.sourceHandle === (conn.sourceHandle ?? 'out')
        && e.target === conn.target && e.targetHandle === (conn.targetHandle ?? 'in:0'))) {
        statusMsg.value = 'connection already exists';
        return;
    }
    const edge: ShaderGraphEdge = {
        id: `e${Date.now()}`,
        source: conn.source,
        sourceHandle: (conn.sourceHandle ?? 'out') as ShaderGraphEdge['sourceHandle'],
        target: conn.target,
        targetHandle: conn.targetHandle ?? 'in:0',
    };
    applyGraph(g => { g.edges.push(edge); });
    statusMsg.value = '';
}

/** Connection constraints:
 *  - data.out → shader.in:N only (buffer binding)
 *  - body/next from control nodes (if/foreach/loop) → any target (the
 *    executor determines role by sourceHandle, so the target handle is free)
 *  - no self-loops, no other handle combinations */
function isValidConnection(conn: Connection): boolean {
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    const srcNode = flowNodes.value.find(n => n.id === conn.source);
    const tgtNode = flowNodes.value.find(n => n.id === conn.target);
    if (!srcNode || !tgtNode) return false;
    const sh = conn.sourceHandle ?? '';
    const th = conn.targetHandle ?? '';
    if (sh === 'out') {
        // data output → shader binding slot only
        return srcNode.type === 'data' && tgtNode.type === 'shader' && /^in:\d+$/.test(th);
    }
    if (sh === 'body' || sh === 'next') {
        return srcNode.type === 'if' || srcNode.type === 'foreach' || srcNode.type === 'loop';
    }
    return false;
}

/** Re-serialize the flow node data back into the graph. Fields edited in the
 *  inspector (see selectedNodeParams) mutate node.data.node, so we push the
 *  live node objects back into the graph and dispatch. */
function commitParams(): void {
    const graph = currentGraph();
    if (!graph) return;
    nodeParamError.value = '';
    const prev = JSON.stringify(graph);
    // Read current values from the flow nodes — including dragged positions
    // (vue-flow updates node.position on drag; mirror it into the graph node
    // so Save persists the layout. Absent position = graphAdapter auto-layouts).
    const nodes = flowNodes.value.map(n => {
        const node = (n.data as { node: ShaderGraphNode }).node;
        if (n.position) node.position = { x: n.position.x, y: n.position.y };
        return node;
    });
    graph.nodes = nodes;
    host.dispatch(new MutateShaderGraphCommand(graph.name, graph, prev));
    loadGraph();
    statusMsg.value = '';
}

/** Track position changes (drag) without dispatching a command per frame —
 *  the user clicks Apply (commitParams) to persist. Just flag unsaved state. */
function onNodesChange(changes: { type: string; id?: string }[]): void {
    if (changes.some(c => c.type === 'position')) {
        statusMsg.value = 'unsaved layout — click Apply';
    }
}

const selectedNodeId = ref<string>('');
const selectedNode = computed<ShaderGraphNode | null>(() => {
    if (!selectedNodeId.value) return null;
    const n = flowNodes.value.find(x => x.id === selectedNodeId.value);
    return n ? (n.data as { node: ShaderGraphNode }).node : null;
});

function selectNode(id: string): void {
    selectedNodeId.value = id;
}
</script>

<template>
    <div class="node-editor vue-panel">
        <div class="toolbar">
            <select v-model="selectedName" @change="loadGraph">
                <option v-for="g in graphNames" :key="g" :value="g">{{ g }}</option>
            </select>
            <button @click="commitParams">Apply</button>
            <span class="status">{{ statusMsg }}</span>
        </div>

        <div v-if="!selectedName" class="empty">
            No shader graphs loaded. Add a `kind: "shaderGraph"` entry to render.json
            (or register one via RegisterShaderGraphCommand).
        </div>

        <div v-else class="flow-area">
            <!-- Palette: click a node template to add it -->
            <div class="palette">
                <div class="palette-title">Add</div>
                <button v-for="t in NODE_TYPES" :key="t" :class="['palette-item', `node-${t}`]"
                        :title="`Add ${t} node`" @click="addNode(t)">{{ t }}</button>
            </div>
            <div class="flow-wrap">
            <VueFlow
                :nodes="flowNodes"
                :edges="flowEdges"
                :node-types="{}"
                fit-view-on-init
                @ready="onFlowReady"
                @connect="onConnect"
                @nodes-change="onNodesChange"
                @node-click="({ node }) => selectNode(node.id)"
                @node-double-click="({ node }) => removeNode(node.id)">
                <template #node-data="{ data }">
                    <div class="gf-node node-data">
                        <Handle type="source" :position="Position.Right" id="out" />
                        <div class="gf-title">{{ data.label }}</div>
                        <div class="gf-hint">BufferHandle source</div>
                    </div>
                </template>
                <template #node-shader="{ data }">
                    <div class="gf-node node-shader">
                        <Handle type="target" :position="Position.Left" id="in:0" />
                        <Handle type="target" :position="Position.Left" id="in:1" style="top:60%" />
                        <Handle type="target" :position="Position.Left" id="in:2" style="top:80%" />
                        <Handle type="source" :position="Position.Right" id="next" />
                        <div class="gf-title">{{ data.label }}</div>
                        <div class="gf-hint">Compute shader</div>
                    </div>
                </template>
                <template #node-if="{ data }">
                    <div class="gf-node node-if">
                        <Handle type="source" :position="Position.Bottom" id="body" />
                        <Handle type="source" :position="Position.Right" id="next" />
                        <div class="gf-title">{{ data.label }}</div>
                        <div class="gf-hint">Conditional</div>
                    </div>
                </template>
                <template #node-foreach="{ data }">
                    <div class="gf-node node-loop">
                        <Handle type="source" :position="Position.Bottom" id="body" />
                        <Handle type="source" :position="Position.Right" id="next" />
                        <div class="gf-title">{{ data.label }}</div>
                        <div class="gf-hint">Iterate</div>
                    </div>
                </template>
                <template #node-loop="{ data }">
                    <div class="gf-node node-loop">
                        <Handle type="source" :position="Position.Bottom" id="body" />
                        <Handle type="source" :position="Position.Right" id="next" />
                        <div class="gf-title">{{ data.label }}</div>
                        <div class="gf-hint">Loop</div>
                    </div>
                </template>
                <Background pattern-color="#333" :gap="16" />
                <Controls />
            </VueFlow>
            </div>
        </div>

        <!-- Node inspector: edit params sourced from component fields -->
        <div v-if="selectedNode" class="inspector">
            <div class="inspector-title">Node — {{ selectedNode.id }}</div>
            <div v-if="selectedNode.type === 'data'" class="inspector-body">
                <label>Component.field (BufferHandle)</label>
                <input v-model="(selectedNode as any).source" @change="commitParams" />
                <label>kind</label>
                <select v-model="(selectedNode as any).kind" @change="commitParams">
                    <option>storage</option><option>uniform</option><option>vertex</option>
                </select>
            </div>
            <div v-else-if="selectedNode.type === 'shader'" class="inspector-body">
                <label>shader</label>
                <input v-model="(selectedNode as any).shader" @change="commitParams" />
                <label>entryPoint</label>
                <input v-model="(selectedNode as any).entryPoint" @change="commitParams" />
                <label>count (Component.field)</label>
                <input v-model="(selectedNode as any).count" @change="commitParams" />
                <label>workgroupSize</label>
                <input type="number" v-model.number="(selectedNode as any).workgroupSize" @change="commitParams" />
            </div>
            <div v-else-if="selectedNode.type === 'if'" class="inspector-body">
                <label>condition (Component.field)</label>
                <input v-model="(selectedNode as any).condition" @change="commitParams" />
            </div>
            <div v-else-if="selectedNode.type === 'foreach'" class="inspector-body">
                <label>count (Component.field)</label>
                <input v-model="(selectedNode as any).count" @change="commitParams" />
            </div>
            <div v-else-if="selectedNode.type === 'loop'" class="inspector-body">
                <label>iterations (number or Component.field)</label>
                <input v-model="(selectedNode as any).iterations" @change="commitParams" />
            </div>
            <div v-if="nodeParamError" class="inspector-error">{{ nodeParamError }}</div>
            <button class="inspector-del" @click="selectedNodeId = ''">Deselect</button>
        </div>
    </div>
</template>

<style>
.node-editor { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.toolbar { padding: 6px; background: #1a1a1a; border-bottom: 1px solid #333; display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
.toolbar select, .toolbar button { font-size: 11px; background: #2a3a5c; color: #ccc; border: 1px solid #3a4a6c; border-radius: 3px; padding: 2px 6px; }
.status { color: #7fd8a8; font-size: 10px; margin-left: auto; }
.flow-area { flex: 1; display: flex; min-height: 0; }
.palette {
    width: 80px; flex-shrink: 0; background: #1a1a1a; border-right: 1px solid #333;
    display: flex; flex-direction: column; gap: 4px; padding: 6px;
}
.palette-title { color: #8899aa; font-size: 9px; text-transform: uppercase; font-weight: 600; }
.palette-item {
    font-size: 10px; padding: 4px 6px; border-radius: 3px; cursor: pointer;
    border: 1px solid #3a4a6c; color: #ccc; background: #0d1b33; text-align: left;
}
.palette-item:hover { background: #1e2d44; border-color: #4a8fc7; }
.palette-item.node-data { border-left: 3px solid #4a8fc7; }
.palette-item.node-shader { border-left: 3px solid #2f7a58; }
.palette-item.node-if { border-left: 3px solid #c77f4a; }
.palette-item.node-foreach, .palette-item.node-loop { border-left: 3px solid #7a4ac7; }
.flow-wrap { flex: 1; min-height: 0; position: relative; }
.empty { padding: 20px; color: #667; }
.vue-flow { flex: 1; background: #111; }

.gf-node { padding: 6px 10px; border-radius: 6px; font-size: 11px; min-width: 140px; border: 1px solid #3a4a6c; }
.gf-title { color: #fff; font-weight: 600; word-break: break-all; }
.gf-hint { color: #8899aa; font-size: 9px; margin-top: 2px; }
.node-data { background: #1a2744; border-color: #4a8fc7; }
.node-shader { background: #1d3a2a; border-color: #2f7a58; }
.node-if { background: #3a2a1a; border-color: #c77f4a; }
.node-loop { background: #2a1d3a; border-color: #7a4ac7; }

.inspector {
    flex-shrink: 0; border-top: 1px solid #333; background: #16213e;
    padding: 8px; max-height: 180px; overflow-y: auto;
}
.inspector-title { color: #7ec8e3; font-size: 11px; font-weight: 600; margin-bottom: 6px; }
.inspector-body { display: flex; flex-direction: column; gap: 4px; }
.inspector-body label { color: #8899aa; font-size: 10px; }
.inspector-body input, .inspector-body select {
    background: #0d1b33; color: #ddd; border: 1px solid #2a3a5c; border-radius: 3px;
    padding: 2px 5px; font-size: 11px; font-family: monospace;
}
.inspector-error { color: #ff6b6b; font-size: 10px; margin-top: 4px; }
.inspector-del { margin-top: 6px; font-size: 10px; background: #2a3a5c; color: #ccc; border: 1px solid #3a4a6c; border-radius: 3px; padding: 2px 6px; }
</style>
