import type { ShaderGraph, ShaderGraphNode, ShaderGraphEdge } from '../../../core/render/shaderGraph';

/** vue-flow node payload: the graph node data + a computed label. */
export interface GraphFlowNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: {
        node: ShaderGraphNode;
        label: string;
    };
}

export interface GraphFlowEdge {
    id: string;
    source: string;
    sourceHandle?: string;
    target: string;
    targetHandle?: string;
    label?: string;
}

/** Node kind → display color class (styled in the panel). */
export const NODE_CLASS: Record<string, string> = {
    data: 'node-data',
    shader: 'node-shader',
    if: 'node-if',
    foreach: 'node-loop',
    loop: 'node-loop',
};

export function nodeLabel(node: ShaderGraphNode): string {
    switch (node.type) {
        case 'data':
            return `📦 ${node.source}`;
        case 'shader':
            return `⚙ ${node.shader} → ${node.entryPoint}`;
        case 'if':
            return `❓ if ${node.condition}`;
        case 'foreach':
            return `🔁 foreach ${node.count}`;
        case 'loop':
            return `🔁 loop ${node.iterations}`;
        default:
            return (node as { id: string }).id;
    }
}

/** Convert a ShaderGraph to vue-flow nodes/edges with a simple layered layout:
 *  data nodes on the left, then shader/logic nodes laid out by execution order. */
export function shaderGraphToFlow(graph: ShaderGraph): { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] } {
    const nodes: GraphFlowNode[] = [];
    const edges: GraphFlowEdge[] = [];

    const order = executionOrder(graph);
    const dataNodes = graph.nodes.filter(n => n.type === 'data');
    const allFlow = order.map(id => graph.nodes.find(n => n.id === id)).filter((n): n is ShaderGraphNode => !!n && n.type !== 'data');

    let dataY = 0;
    for (const n of dataNodes) {
        nodes.push({
            id: n.id,
            type: 'data',
            position: { x: 0, y: dataY * 90 },
            data: { node: n, label: nodeLabel(n) },
        });
        dataY++;
    }

    let flowY = 0;
    for (const n of allFlow) {
        nodes.push({
            id: n.id,
            type: n.type,
            position: { x: 320, y: flowY * 110 },
            data: { node: n, label: nodeLabel(n) },
        });
        flowY++;
    }

    for (const e of graph.edges) {
        edges.push({
            id: e.id,
            source: e.source,
            sourceHandle: e.sourceHandle,
            target: e.target,
            targetHandle: e.targetHandle,
        });
    }

    return { nodes, edges };
}

/** Deterministic execution order: control bodies inline, next-chains linearized. */
function executionOrder(graph: ShaderGraph): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const nextOf = new Map<string, string>();
    const bodyOf = new Map<string, string[]>();
    for (const e of graph.edges) {
        if (e.sourceHandle === 'body') {
            const list = bodyOf.get(e.source) ?? [];
            list.push(e.target);
            bodyOf.set(e.source, list);
        } else if (e.sourceHandle === 'next') {
            nextOf.set(e.source, e.target);
        }
    }
    const visit = (id: string): void => {
        if (seen.has(id)) return;
        seen.add(id);
        result.push(id);
        for (const b of bodyOf.get(id) ?? []) visit(b);
        const next = nextOf.get(id);
        if (next) visit(next);
    };
    // Roots: nodes not targeted by a next/body edge.
    const targeted = new Set<string>([...nextOf.values(), ...[...bodyOf.values()].flat()]);
    for (const n of graph.nodes) {
        if (!targeted.has(n.id)) visit(n.id);
    }
    return result;
}
