import type { Scene } from '../ecs/Scene';
import type { EventBus } from '../events/EventBus';
import type { PhysicsSystem } from '../ecs/PhysicsSystem';

export interface ToolConfig {
    type: string;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface ToolContext {
    scene: Scene;
    bus: EventBus;
    physics: PhysicsSystem;
    getAspect: () => number;
}

export interface SceneTool {
    attach(): void;
    detach(): void;
}
