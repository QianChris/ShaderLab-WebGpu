import type { Scene } from '../ecs/Scene';
import type { EventBus } from '../events/EventBus';
import type { PhysicsSystem } from '../ecs/PhysicsSystem';
import type { SceneTool, ToolConfig, ToolContext } from './SceneTool';
import { PickTool } from './PickTool';

type ToolFactory = (config: ToolConfig, ctx: ToolContext) => SceneTool;

/** Registry of optional scene tools, keyed by config `type`. */
const TOOL_REGISTRY: Record<string, ToolFactory> = {
    pick: (config, ctx) => new PickTool(config, ctx),
};

/**
 * Loads optional interaction tools from tools.json and wires each to the scene,
 * event bus and physics system. Absent/empty config means no tools are active,
 * so picking (and future tools) stay fully opt-in.
 */
export class ToolSystem {
    private tools: SceneTool[] = [];
    private ctx: ToolContext;

    constructor(scene: Scene, bus: EventBus, physics: PhysicsSystem, getAspect: () => number) {
        this.ctx = { scene, bus, physics, getAspect };
    }

    async loadFromFile(url: string): Promise<void> {
        let configs: ToolConfig[] = [];
        try {
            const resp = await fetch(url);
            if (resp.ok) configs = await resp.json() as ToolConfig[];
        } catch {
            configs = [];
        }
        this.load(configs);
    }

    load(configs: ToolConfig[]): void {
        this.dispose();
        for (const config of configs) {
            if (config.enabled === false) continue;
            const factory = TOOL_REGISTRY[config.type];
            if (!factory) {
                console.warn(`[ToolSystem] unknown tool type '${config.type}'`);
                continue;
            }
            const tool = factory(config, this.ctx);
            tool.attach();
            this.tools.push(tool);
        }
    }

    dispose(): void {
        for (const tool of this.tools) tool.detach();
        this.tools = [];
    }
}
