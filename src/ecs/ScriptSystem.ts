import { defineQuery } from 'bitecs/legacy';
import { schemaRegistry } from './SchemaRegistry';
import type { Scene } from './Scene';
import type { EventBus } from '../events/EventBus';
import type { PhysicsSystem } from './PhysicsSystem';

export interface ScriptContext {
    eid: number;
    scene: Scene;
    time: number;
    dt: number;
    /** Current viewport aspect ratio (width / height). */
    aspect: number;
    /** Physics system (ray casts, etc); null before attach. */
    physics: PhysicsSystem | null;
    getField(compName: string, field: string): unknown;
    setField(compName: string, field: string, value: unknown): void;
    on(type: string, handler: (payload: unknown) => void): () => void;
    /** Publish an event on the shared bus. */
    emit(type: string, payload?: unknown): void;
}

interface ScriptModule {
    init?: (ctx: ScriptContext) => void;
    update?: (ctx: ScriptContext) => void;
    [key: string]: unknown;
}

export class ScriptSystem {
    private scene!: Scene;
    private bus: EventBus;
    private baseDir: string;
    private getAspect: () => number = () => 1;
    private physics: PhysicsSystem | null = null;
    private hooks: string[] = ['init', 'update'];
    private query!: (w: import('bitecs').World) => readonly number[];
    private modules = new Map<string, ScriptModule>();
    private loading = new Set<string>();
    private initialized = new Set<string>();

    constructor(bus: EventBus, baseDir = '') {
        this.bus = bus;
        this.baseDir = baseDir;
    }

    /** Set the script lifecycle hooks to call (from engine-config.json). */
    setHooks(hooks: string[]): void {
        this.hooks = hooks;
    }

    /** Set the base directory for resolving relative script paths (e.g. '/apps/shadow'). */
    setBaseDir(dir: string): void {
        this.baseDir = dir;
    }

    attach(scene: Scene): void {
        this.scene = scene;
        this.query = defineQuery([schemaRegistry.get('ScriptComponent')!]);
    }

    /** Provide runtime services scripts can use (physics ray casts, viewport aspect). */
    provide(physics: PhysicsSystem, getAspect: () => number): void {
        this.physics = physics;
        this.getAspect = getAspect;
    }

    /** Drop cached modules and init flags (call when the scene is reset). */
    clear(): void {
        this.modules.clear();
        this.initialized.clear();
        this.loading.clear();
    }

    update(time: number, dt: number): void {
        for (const eid of this.query(this.scene.world)) {
            const enabled = schemaRegistry.getScalar(schemaRegistry.get('ScriptComponent')!, eid, 'enabled');
            if (enabled !== 1) continue;

            const path = this.scene.getField(eid, 'ScriptComponent', 'script') as string;
            if (!path) continue;

            const mod = this.modules.get(path);
            if (!mod) {
                this.load(path);
                continue;
            }

            const key = `${path}#${eid}`;
            const ctx = this.makeContext(eid, time, dt);
            for (const hook of this.hooks) {
                if (hook === 'init') {
                    if (!this.initialized.has(key)) {
                        this.initialized.add(key);
                        const fn = mod[hook];
                        if (typeof fn === 'function') fn(ctx);
                    }
                } else {
                    const fn = mod[hook];
                    if (typeof fn === 'function') fn(ctx);
                }
            }
        }
    }

    private makeContext(eid: number, time: number, dt: number): ScriptContext {
        const scene = this.scene;
        const bus = this.bus;
        return {
            eid,
            scene,
            time,
            dt,
            aspect: this.getAspect(),
            physics: this.physics,
            getField: (compName, field) => scene.getField(eid, compName, field),
            setField: (compName, field, value) => scene.setField(eid, compName, field, value),
            on: (type, handler) => bus.on(type, handler),
            emit: (type, payload) => bus.emit(type, payload),
        };
    }

    private load(path: string): void {
        if (this.loading.has(path)) return;
        this.loading.add(path);
        const url = (path.startsWith('/') ? path : `${this.baseDir}/${path}`) + `?t=${Date.now()}`;
        fetch(url)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.text();
            })
            .then(src => {
                const blob = new Blob([src], { type: 'text/javascript' });
                const blobUrl = URL.createObjectURL(blob);
                return import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
            })
            .then(mod => {
                this.modules.set(path, (mod.default ?? mod) as ScriptModule);
            })
            .catch(err => {
                console.error(`[ScriptSystem] failed to load '${path}':`, err);
            })
            .finally(() => {
                this.loading.delete(path);
            });
    }
}
