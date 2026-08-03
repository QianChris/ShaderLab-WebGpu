import { ToolSystem } from './ToolSystem';
import type { Scene } from '../../core/ecs/Scene';
import type { EventBus } from '../../core/events/EventBus';

/**
 * Editor-owned wrapper around the tool lifecycle. The engine core no longer
 * loads tools.json — only the editor mounts an input manager, so picking and
 * other interaction tools stay fully editor-side (player mode never loads
 * them). ToolSystem manages SceneTool attach/detach internally via load().
 */
export class EditorInputManager {
    private toolSystem: ToolSystem;

    constructor(
        scene: Scene,
        eventBus: EventBus,
        getSystem: <T>(name: string) => T | null,
        getAspect: () => number,
    ) {
        this.toolSystem = new ToolSystem(scene, eventBus, getSystem, getAspect);
    }

    /** Load the current App's tools.json (path resolved from the app base). */
    async loadTools(appBase: string, toolsPath: string): Promise<void> {
        this.toolSystem.setBase(appBase);
        await this.toolSystem.loadFromFile(`${appBase}/${toolsPath}`);
    }

    dispose(): void {
        this.toolSystem.dispose();
    }
}
