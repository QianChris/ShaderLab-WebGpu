import { useHost } from './useHost';
import { SetFieldCommand } from '../../../editor/commands/SceneCommands';
import type { Command } from '../../../editor/commands/Command';

/**
 * Command factory for Vue panels. Every write goes through host.dispatch()
 * so edits are undoable and gated by the editor's edit-mode check. Vue panels
 * never touch the EditorCommandBus or engine write methods directly.
 */
export function useSceneCommands() {
    const host = useHost();
    const dispatch = (cmd: Command) => host.dispatch(cmd);

    return {
        dispatch,
        setField(entityKey: string, comp: string, field: string, value: unknown): boolean {
            return dispatch(new SetFieldCommand(entityKey, comp, field, value));
        },
    };
}
