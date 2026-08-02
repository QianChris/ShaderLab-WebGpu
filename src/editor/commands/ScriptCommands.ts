import type { Command, CommandContext } from './Command';

/** Structural contract for the core plugin's ScriptSystem (gameplay scripts).
 *  Editor stays plugin-agnostic: it resolves the 'script' system by name and
 *  calls reloadScript through this shape only. */
interface GameplayScriptSystem {
    reloadScript(path: string, source: string): void;
}

/** Hot-reload a script-loaded system (systems.json `source: "<path>.js"`).
 *  Replaces the running adapter with one wrapping the new source. */
export class ReloadSystemScriptCommand implements Command {
    readonly type = 'reloadSystemScript';
    readonly description = 'reloadSystemScript';
    constructor(
        private entryName: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        void ctx.engine.systemRegistry.reloadScriptByEntry(this.entryName, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        void ctx.engine.systemRegistry.reloadScriptByEntry(this.entryName, this.prevSource);
        return true;
    }
}

/** Hot-reload a gameplay script (ScriptComponent.script path) through the
 *  core plugin's ScriptSystem. Resolves the 'script' system structurally and
 *  calls reloadScript(path, source) — the engine has no plugin knowledge. */
export class ReloadGameplayScriptCommand implements Command {
    readonly type = 'reloadGameplayScript';
    readonly description = 'reloadGameplayScript';
    constructor(
        private path: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        const sys = ctx.engine.systemRegistry.resolve({ name: 'script' }) as unknown as GameplayScriptSystem | null;
        if (!sys?.reloadScript) return false;
        sys.reloadScript(this.path, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const sys = ctx.engine.systemRegistry.resolve({ name: 'script' }) as unknown as GameplayScriptSystem | null;
        if (!sys?.reloadScript) return false;
        sys.reloadScript(this.path, this.prevSource);
        return true;
    }
}

/** Hot-reload a render escape-hatch script (render.json `renderScripts` entry)
 *  from in-memory source; re-registers all its exported hooks. */
export class ReloadRenderScriptCommand implements Command {
    readonly type = 'reloadRenderScript';
    readonly description = 'reloadRenderScript';
    constructor(
        private file: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        void ctx.engine.renderGraph.reloadRenderScript(this.file, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        void ctx.engine.renderGraph.reloadRenderScript(this.file, this.prevSource);
        return true;
    }
}

