import type { ToolFactory } from '../../editor/input/SceneTool';

export type { ToolFactory } from '../../editor/input/SceneTool';

/** Module-level registry of tool factories, keyed by config `type`. Populated
 *  entirely by plugins (ctx.registerToolType) — the engine ships no built-in
 *  tools. Lives in core (no DOM/editor deps) so plugins may register tool
 *  types in player mode too; only the editor's input manager ever instantiates
 *  them from a tools.json config. */
export const TOOL_REGISTRY: Record<string, ToolFactory> = {};

/** Register a tool type (plugins). Duplicate names throw (fail-loud). */
export function registerToolType(type: string, factory: ToolFactory): void {
    if (TOOL_REGISTRY[type]) throw new Error(`Tool type '${type}' already registered`);
    TOOL_REGISTRY[type] = factory;
}

/** Remove a tool type (plugin unload). */
export function unregisterToolType(type: string): void {
    delete TOOL_REGISTRY[type];
}
