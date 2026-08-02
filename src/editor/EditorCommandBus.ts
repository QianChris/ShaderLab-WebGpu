import type { Engine } from '../core/Engine';
import type { Command, CommandContext } from './commands/Command';
import {
    SetFieldCommand,
    CreateEntityCommand,
    RemoveEntityCommand,
    LoadSceneDataCommand,
    ToggleComponentCommand,
} from './commands/SceneCommands';
import {
    MutateRenderGraphCommand,
    PatchRenderGraphCommand,
    MutatePipelineConfigCommand,
} from './commands/RenderGraphCommands';
import type { SceneData } from '../core/ecs/Scene';
import type { RenderGraphData } from '../core/render/types';

export type EditMode = 'edit' | 'play' | 'pause';

/**
 * Editor command channel: the ONLY path by which editor UI state changes reach
 * the engine. Dispatches execute commands with undo/redo + edit-mode gating,
 * then broadcast `editor:changed` for panels to refresh. UI never touches the
 * engine registries/scene/render-graph write methods directly.
 */
export class EditorCommandBus {
    private mode: EditMode = 'edit';
    private undoStack: Command[] = [];
    private redoStack: Command[] = [];
    private maxHistory = 50;
    private editSnapshot: object | null = null;

    constructor(private _engine: Engine) {}

    get engine(): Engine { return this._engine; }
    get editMode(): EditMode { return this.mode; }
    get scene() { return this._engine.scene; }
    get renderGraph() { return this._engine.renderGraph; }

    play(): void {
        if (this.mode === 'play') return;
        this.editSnapshot = {
            scene: this._engine.exportScene(),
            renderGraph: this._engine.exportRenderGraph(),
        };
        this.mode = 'play';
        this._engine.eventBus.emit('editor:play');
    }

    pause(): void {
        if (this.mode !== 'play') return;
        this.mode = 'pause';
        this._engine.eventBus.emit('editor:pause');
    }

    stop(): void {
        if (this.mode === 'edit') return;
        this.mode = 'edit';
        if (this.editSnapshot) {
            const s = this.editSnapshot as { scene: unknown; renderGraph: unknown };
            this._engine.loadSceneData(s.scene as SceneData);
            this._engine.renderGraph.fromData(s.renderGraph as RenderGraphData);
        }
        this._engine.eventBus.emit('editor:stop');
    }

    dispatch(cmd: Command): boolean {
        if (this.mode !== 'edit') {
            console.warn(`[EditorCommandBus] Blocked ${cmd.type} while in ${this.mode} mode`);
            return false;
        }
        const ctx: CommandContext = { engine: this._engine };
        if (!cmd.execute(ctx)) return false;

        this.undoStack.push(cmd);
        if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
        this.redoStack.length = 0;
        this._engine.eventBus.emit('editor:changed', { source: cmd.type });
        return true;
    }

    undo(): void {
        if (this.undoStack.length === 0) return;
        const cmd = this.undoStack.pop()!;
        cmd.undo({ engine: this._engine });
        this.redoStack.push(cmd);
        this._engine.eventBus.emit('editor:changed', { source: 'undo' });
    }

    redo(): void {
        if (this.redoStack.length === 0) return;
        const cmd = this.redoStack.pop()!;
        cmd.execute({ engine: this._engine });
        this.undoStack.push(cmd);
        this._engine.eventBus.emit('editor:changed', { source: 'redo' });
    }

    setField(entityKey: string, comp: string, field: string, value: unknown): boolean {
        return this.dispatch(new SetFieldCommand(entityKey, comp, field, value));
    }

    createEntity(key: string, data: Record<string, Record<string, unknown>>): boolean {
        return this.dispatch(new CreateEntityCommand(key, data));
    }

    removeEntity(key: string): boolean {
        return this.dispatch(new RemoveEntityCommand(key));
    }

    loadSceneData(data: SceneData, prevData?: string): boolean {
        return this.dispatch(new LoadSceneDataCommand(data, prevData));
    }

    toggleComponent(entityKey: string, compName: string, enabled: boolean): boolean {
        return this.dispatch(new ToggleComponentCommand(entityKey, compName, enabled));
    }

    mutateRenderGraph(data: object): boolean {
        return this.dispatch(new MutateRenderGraphCommand(data));
    }

    patchRenderGraph(data: RenderGraphData, prevData?: string): boolean {
        return this.dispatch(new PatchRenderGraphCommand(data, prevData));
    }

    mutatePipelineConfig(pipeline: string, nextJson: string, prevJson?: string): boolean {
        return this.dispatch(new MutatePipelineConfigCommand(pipeline, nextJson, prevJson));
    }
}
