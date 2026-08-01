import type { Engine } from '../Engine';
import type { Command, CommandContext } from './commands/Command';
import { SetFieldCommand, CreateEntityCommand, RemoveEntityCommand } from './commands/SceneCommands';
import { MutateRenderGraphCommand } from './commands/RenderGraphCommands';

export type EditMode = 'edit' | 'play' | 'pause';

export class EditorHost {
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
            this._engine.loadSceneData(s.scene as Record<string, Record<string, Record<string, unknown>>>);
            this._engine.renderGraph.fromData(s.renderGraph as import('../render/types').RenderGraphData);
        }
        this._engine.eventBus.emit('editor:stop');
    }

    dispatch(cmd: Command): boolean {
        if (this.mode !== 'edit') {
            console.warn(`[EditorHost] Blocked ${cmd.type} while in ${this.mode} mode`);
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

    mutateRenderGraph(data: object): boolean {
        return this.dispatch(new MutateRenderGraphCommand(data));
    }
}
