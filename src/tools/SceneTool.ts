import type { Scene } from '../ecs/Scene';
import type { EventBus } from '../events/EventBus';

export interface ToolConfig {
    /** Builtin tool name (e.g., "pick"). Mutually exclusive with `source`. */
    type?: string;
    /** Script path (e.g., "scripts/myTool.js") — script-loaded tool.
     *  Mutually exclusive with `type`. Path resolves relative to app base
     *  (or absolute if leading /). */
    source?: string;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface ToolContext {
    scene: Scene;
    bus: EventBus;
    /** Cross-system lookup (structural typing at the call site) — tools take
     *  no compile-time dependency on any system implementation. */
    getSystem<T = unknown>(name: string): T | null;
    getAspect: () => number;
}

export interface SceneTool {
    attach(): void;
    detach(): void;
}

/** Lifecycle hooks a script tool may export. All optional; missing hooks are skipped. */
export interface ToolScriptModule {
    attach?: (ctx: ToolContext) => void;
    detach?: () => void;
    [key: string]: unknown;
}
