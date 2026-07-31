import { createWorld, addEntity, removeEntity, type World } from 'bitecs';
import { addComponent, hasComponent, removeComponent } from 'bitecs/legacy';
import { schemaRegistry } from './SchemaRegistry';
import { buildCameraMatricesInto, mat4FromTRSInto, type TRS } from '../math';

export type SceneData = Record<string, Record<string, Record<string, unknown>>>;

/** A resolved camera ready to render: view-projection matrices + its on-screen
 *  viewport rect (normalized x/y/w/h, default full screen). `aspect` is the
 *  camera's own aspect ratio (canvas aspect scaled by viewport w/h). */
export interface CameraView {
    eid: number;
    vp: Float32Array;
    ivp: Float32Array;
    pos: Float32Array;
    view: Float32Array;
    proj: Float32Array;
    viewport: [number, number, number, number];
    aspect: number;
}

export class Scene {
    world: World;
    entityKeyMap = new Map<string, number>();
    entityTags = new Map<number, string[]>();
    /** Per-entity component list (for O(E×avgC) toJSON instead of O(E×C)). */
    private entityComponents = new Map<number, string[]>();
    /** Scratch model matrix — reused by getModelMatrix to avoid per-call
     *  allocation. Safe because callers consume the result before the next
     *  entity's matrix is computed (PipelineDriver processes entities serially). */
    private scratchModel = new Float32Array(16);
    /** Reusable camera pool: pre-allocated CameraView objects with pre-allocated
     *  Float32Array fields, grown as needed. Avoids per-frame allocation in the
     *  getActiveCameras hot path. */
    private cameraPool: CameraView[] = [];
    /** Number of camera pool entries currently populated this frame. */
    private cameraCount = 0;

    constructor() {
        this.world = createWorld();
    }

    createEntity(key: string, data: Record<string, Record<string, unknown>>): number {
        const eid = addEntity(this.world);
        const tags: string[] = [];
        const comps: string[] = [];

        // force NameComponent
        const nc = schemaRegistry.get('NameComponent')!;
        addComponent(this.world, nc, eid);
        schemaRegistry.setAllFields('NameComponent', nc, eid, { name: key });
        comps.push('NameComponent');

        for (const [compName, compData] of Object.entries(data)) {
            const comp = schemaRegistry.get(compName);
            if (!comp) {
                throw new Error(
                    `Entity '${key}': unknown component '${compName}' — ` +
                    `is it declared in components.json (common or the app's)?`,
                );
            }
            addComponent(this.world, comp, eid);
            schemaRegistry.setAllFields(compName, comp, eid, compData);
            comps.push(compName);

            if (schemaRegistry.isRenderTag(compName)) {
                tags.push(compName);
            }
        }

        this.entityKeyMap.set(key, eid);
        this.entityTags.set(eid, tags);
        this.entityComponents.set(eid, comps);
        return eid;
    }

    removeEntity(key: string): void {
        const eid = this.entityKeyMap.get(key);
        if (eid !== undefined) {
            removeEntity(this.world, eid);
            this.entityKeyMap.delete(key);
            this.entityTags.delete(eid);
            this.entityComponents.delete(eid);
        }
    }

    /** Remove all entities. Call before loading a new app so the ECS world is empty. */
    clear(): void {
        for (const key of [...this.entityKeyMap.keys()]) {
            this.removeEntity(key);
        }
        this.entityKeyMap.clear();
        this.entityTags.clear();
    }

    setField(eid: number, compName: string, field: string, value: unknown): void {
        const comp = schemaRegistry.get(compName);
        if (!comp || !hasComponent(this.world, comp, eid)) return;
        schemaRegistry.setComposite(compName, comp, eid, field, value);
    }

    toggleComponent(eid: number, compName: string, enabled: boolean): void {
        if (schemaRegistry.mandatory.has(compName)) return;
        const comp = schemaRegistry.get(compName);
        if (!comp) return;
        const comps = this.entityComponents.get(eid);
        if (enabled && !hasComponent(this.world, comp, eid)) {
            addComponent(this.world, comp, eid);
            schemaRegistry.setAllFields(compName, comp, eid, {});
            if (comps && !comps.includes(compName)) comps.push(compName);
        } else if (!enabled && hasComponent(this.world, comp, eid)) {
            removeComponent(this.world, comp, eid);
            if (comps) {
                const i = comps.indexOf(compName);
                if (i >= 0) comps.splice(i, 1);
            }
        }
    }

    hasTag(eid: number, tag: string): boolean {
        const comp = schemaRegistry.get(tag);
        return comp ? hasComponent(this.world, comp, eid) : false;
    }

    hasComponent(eid: number, compName: string): boolean {
        const comp = schemaRegistry.get(compName);
        return comp ? hasComponent(this.world, comp, eid) : false;
    }

    getField(eid: number, compName: string, field: string): unknown {
        const comp = schemaRegistry.get(compName);
        if (!comp || !hasComponent(this.world, comp, eid)) return undefined;
        return schemaRegistry.getComposite(compName, comp, eid, field);
    }

    getTagColor(eid: number, tag: string): [number, number, number, number] {
        const comp = schemaRegistry.get(tag);
        const field = schemaRegistry.getFieldByRole(tag, 'color');
        if (!comp || !field) return [1, 1, 1, 1];
        return [
            schemaRegistry.getScalarField(tag, comp, eid, field, 0),
            schemaRegistry.getScalarField(tag, comp, eid, field, 1),
            schemaRegistry.getScalarField(tag, comp, eid, field, 2),
            schemaRegistry.getScalarField(tag, comp, eid, field, 3),
        ];
    }

    getTagExtra(eid: number, tag: string): number {
        const comp = schemaRegistry.get(tag);
        const field = schemaRegistry.getFieldByRole(tag, 'extra');
        if (!comp || !field) return 0;
        return schemaRegistry.getScalarField(tag, comp, eid, field, 0);
    }

    getTranslate(eid: number): [number, number] {
        const comp = schemaRegistry.get('Transform')!;
        if (!hasComponent(this.world, comp, eid)) return [0, 0];
        return [
            schemaRegistry.getScalarField('Transform', comp, eid, 'position', 0),
            schemaRegistry.getScalarField('Transform', comp, eid, 'position', 1),
        ];
    }

    getActiveCamera(aspect: number): { vp: Float32Array; ivp: Float32Array; pos: Float32Array; view: Float32Array; proj: Float32Array } | null {
        const cams = this.getActiveCameras(aspect);
        if (cams.length === 0) return null;
        const c = cams[0];
        return { vp: c.vp, ivp: c.ivp, pos: c.pos, view: c.view, proj: c.proj };
    }

    /** Collect every active Camera entity. Multi-view: more than one active
     *  camera is supported — each carries its own on-screen viewport rect
     *  (Camera.viewport, normalized) and a per-camera aspect derived from the
     *  viewport's w/h times the canvas aspect. Insertion order (= scene.json
     *  object order) is preserved, so the first declared camera is the "primary".
     *  Reuses a pre-allocated CameraView pool to avoid per-frame allocation. */
    getActiveCameras(canvasAspect: number): CameraView[] {
        const camComp = schemaRegistry.get('Camera')!;
        this.cameraCount = 0;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, camComp, eid)) continue;
            const active = schemaRegistry.getScalar(camComp, eid, 'active');
            if (active !== 1) continue;
            const fov = schemaRegistry.getScalar(camComp, eid, 'fov');
            const near = schemaRegistry.getScalar(camComp, eid, 'near');
            const far = schemaRegistry.getScalar(camComp, eid, 'far');
            // Viewport rect (normalized). Missing/zero → full screen [0,0,1,1].
            const vw = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 2) || 1;
            const vh = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 3) || 1;
            const vx = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 0) || 0;
            const vy = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 1) || 0;
            const camAspect = canvasAspect * (vw / Math.max(1e-6, vh));
            // Grow the pool lazily — never shrinks (stale entries are harmless
            // because cameraCount bounds the returned slice).
            const idx = this.cameraCount++;
            if (idx >= this.cameraPool.length) {
                this.cameraPool.push({
                    eid: 0,
                    vp: new Float32Array(16), ivp: new Float32Array(16),
                    pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
                    viewport: [0, 0, 1, 1], aspect: 1,
                });
            }
            const cam = this.cameraPool[idx];
            cam.eid = eid;
            cam.viewport[0] = vx; cam.viewport[1] = vy;
            cam.viewport[2] = vw; cam.viewport[3] = vh;
            cam.aspect = camAspect;
            buildCameraMatricesInto(this.getTransformTRS(eid), fov, camAspect, near, far, cam);
        }
        return this.cameraPool.slice(0, this.cameraCount);
    }

    private getTransformTRS(eid: number): TRS {
        const comp = schemaRegistry.get('Transform')!;
        if (!hasComponent(this.world, comp, eid)) {
            return { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
        }
        const f = (field: string, i: number): number =>
            schemaRegistry.getScalarField('Transform', comp, eid, field, i);
        const rx = f('rotation', 0), ry = f('rotation', 1), rz = f('rotation', 2), rw = f('rotation', 3);
        const rLen = Math.hypot(rx, ry, rz, rw) || 1;
        return {
            pos: [f('position', 0), f('position', 1), f('position', 2)],
            rot: [rx / rLen, ry / rLen, rz / rLen, rw / rLen],
            scale: [f('scale', 0), f('scale', 1), f('scale', 2)],
        };
    }

    /** Compute an entity's model matrix. With no `out`, writes into a reusable
     *  scratch buffer (safe for immediate consumption — callers must not retain
     *  the reference across another getModelMatrix call). Pass `out` to write
     *  into a caller-owned buffer for long-lived storage. */
    getModelMatrix(eid: number, out?: Float32Array): Float32Array {
        const trs = this.getTransformTRS(eid);
        return mat4FromTRSInto(trs.pos, trs.rot, trs.scale, out ?? this.scratchModel);
    }

    toJSON(): SceneData {
        const result: SceneData = {};
        for (const [key, eid] of this.entityKeyMap) {
            const entityData: Record<string, Record<string, unknown>> = {};
            for (const compName of schemaRegistry.comps.keys()) {
                const comp = schemaRegistry.get(compName)!;
                if (!hasComponent(this.world, comp, eid)) continue;
                entityData[compName] = schemaRegistry.readAllFields(compName, comp, eid);
            }
            result[key] = entityData;
        }
        return result;
    }

    getAllEntities(): { key: string; eid: number; tags: string[] }[] {
        return [...this.entityKeyMap.entries()].map(([key, eid]) => ({
            key, eid,
            tags: this.entityTags.get(eid) ?? [],
        }));
    }

    get componentNames(): string[] {
        return [...schemaRegistry.comps.keys()];
    }

    getEnvironmentAmbient(): [number, number, number, number] {
        const comp = schemaRegistry.get('EnvironmentComponent')!;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, comp, eid)) continue;
            return [
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 0),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 1),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 2),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 3),
            ];
        }
        const def = schemaRegistry.getFieldDefault('EnvironmentComponent', 'ambientLight') as number[];
        return [def?.[0] ?? 0, def?.[1] ?? 0, def?.[2] ?? 0, def?.[3] ?? 1];
    }

    getEnvironmentClearColor(): [number, number, number, number] | null {
        const comp = schemaRegistry.get('EnvironmentComponent')!;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, comp, eid)) continue;
            return [
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 0),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 1),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 2),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 3),
            ];
        }
        return null;
    }
}
