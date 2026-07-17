import type { Scene } from './Scene';
import type { EventBus } from '../events/EventBus';
import type { InputSystem } from './InputSystem';
import type { ScriptSystem } from './ScriptSystem';
import type { PhysicsSystem } from './PhysicsSystem';
import type { CameraSystem } from './CameraSystem';
import type { LightSystem } from './LightSystem';
import type { AnimationSystem } from './AnimationSystem';
import type { RenderGraph } from '../render/RenderGraph';
import type { GaussianSplatManager } from '../render/GaussianSplatManager';
import type { SystemEntry } from '../Engine';

/**
 * Ambient frame state passed to every System.update(). Built-in systems pull
 * what they need from this single context object; cross-system references
 * (camera/light/physics/…) are exposed transitively for systems that read
 * another system's output (e.g. gaussianSplat reads camera.lastView).
 *
 * The cross-system fields are transitional — once a script system can register
 * itself and be looked up by name, the hard-typed fields will be replaced by
 * `systemRegistry.get(name)`.
 */
export interface FrameContext {
    scene: Scene;
    time: number;
    dt: number;
    aspect: number;
    cw: number;
    ch: number;
    canvas: HTMLCanvasElement;
    device: GPUDevice;
    context: GPUCanvasContext;
    format: GPUTextureFormat;
    eventBus: EventBus;
    physics: PhysicsSystem;
    camera: CameraSystem;
    light: LightSystem;
    animation: AnimationSystem;
    input: InputSystem;
    script: ScriptSystem;
    splats: GaussianSplatManager | null;
    gsEntityEid: number | null;
    renderGraph: RenderGraph;
}

/** Uniform interface every system — builtin or script-loaded — must satisfy. */
export interface System {
    update(ctx: FrameContext): void;
    dispose?(): void;
}

/**
 * Resolves a `SystemEntry` (from systems.json) to a runnable System instance.
 *
 * Step 1 scope: only `builtin:<id>` lookups. A builtin is registered via
 * `registerBuiltin(name, instance)` at engine init; `resolve()` finds it by
 * the entry's `name` (matching the previous switch-case behaviour). Step 2
 * adds script-loaded systems (`source: "scripts/x.js"`).
 */
class SystemRegistry {
    private builtins = new Map<string, System>();

    /** Register a builtin system instance under `name` (matches systems.json `name`). */
    registerBuiltin(name: string, sys: System): void {
        this.builtins.set(name, sys);
    }

    /** Drop a builtin registration (used when an app-opted-in system is torn down). */
    unregisterBuiltin(name: string): void {
        this.builtins.delete(name);
    }

    /** Resolve a SystemEntry to its System, or null if not registered yet
     *  (e.g. an app-opted-in builtin that wasn't created this session). */
    resolve(entry: SystemEntry): System | null {
        return this.builtins.get(entry.name) ?? null;
    }
}

export const systemRegistry = new SystemRegistry();
