import { createWorld, addEntity, removeEntity, type World } from 'bitecs';
import { addComponent, hasComponent, removeComponent } from 'bitecs/legacy';
import { schemaRegistry } from './SchemaRegistry';
import { buildCameraMatricesInto, mat4FromTRSInto, mat4MulInto, type TRS } from '../math';

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
    /** Reverse of entityKeyMap (eid → key) for parent-hierarchy traversal. */
    private eidToKey = new Map<number, string>();
    /** Parent → children key map (the back-ref of Transform.parent). */
    private childMap = new Map<string, Set<string>>();
    /** Child → parent key (reverse of childMap for O(1) parent lookup). */
    private parentOf = new Map<string, string>();
    /** Scratch model matrix — reused by getModelMatrix to avoid per-call
     *  allocation. Safe because callers consume the result before the next
     *  entity's matrix is computed (PipelineDriver processes entities serially). */
    private scratchModel = new Float32Array(16);
    /** Local TRS scratch (independent of scratchModel so a recursive parent
     *  computation does not clobber the child's local matrix). */
    private localScratch = new Float32Array(16);
    /** Parent world matrix scratch (same reason — used inside getModelMatrix
     *  recursion before writing into the caller's target). */
    private parentScratch = new Float32Array(16);
    /** Cached world matrices per entity (16 floats each). Invalidated by
     *  Transform field writes / setParent / removeEntity. */
    private worldMatrices = new Map<number, Float32Array>();
    /** Entity ids whose world matrix needs recomputation on next getModelMatrix. */
    private worldDirty = new Set<number>();
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
        this.eidToKey.set(eid, key);
        this.entityTags.set(eid, tags);
        this.entityComponents.set(eid, comps);

        // Wire parent (Transform.parent → childMap back-ref). The parent must
        // already exist (scene.json / glTF loader declare parents before
        // children); a missing parent is a config bug → throw.
        const transformData = data['Transform'] as { parent?: string } | undefined;
        const parentKey = transformData?.parent;
        if (parentKey) {
            this.linkParent(key, parentKey);
        }
        this.invalidate(eid);
        return eid;
    }

    removeEntity(key: string): void {
        const eid = this.entityKeyMap.get(key);
        if (eid !== undefined) {
            // Detach from parent's children list (if any).
            const parentKey = this.getParentKey(eid);
            if (parentKey) {
                this.childMap.get(parentKey)?.delete(key);
            }
            // Reparent orphans to root so the hierarchy stays consistent.
            const kids = this.childMap.get(key);
            if (kids) {
                for (const ck of kids) {
                    const ceid = this.entityKeyMap.get(ck);
                    if (ceid != null) this.setField(ceid, 'Transform', 'parent', '');
                }
            }
            this.childMap.delete(key);
            this.parentOf.delete(key);
            removeEntity(this.world, eid);
            this.entityKeyMap.delete(key);
            this.eidToKey.delete(eid);
            this.entityTags.delete(eid);
            this.entityComponents.delete(eid);
            this.worldMatrices.delete(eid);
            this.worldDirty.delete(eid);
        }
    }

    /** Remove all entities. Call before loading a new app so the ECS world is empty. */
    clear(): void {
        for (const key of [...this.entityKeyMap.keys()]) {
            this.removeEntity(key);
        }
        this.entityKeyMap.clear();
        this.eidToKey.clear();
        this.entityTags.clear();
        this.childMap.clear();
        this.parentOf.clear();
        this.worldMatrices.clear();
        this.worldDirty.clear();
    }

    setField(eid: number, compName: string, field: string, value: unknown): void {
        const comp = schemaRegistry.get(compName);
        if (!comp || !hasComponent(this.world, comp, eid)) return;
        schemaRegistry.setComposite(compName, comp, eid, field, value);
        if (compName === 'Transform') {
            if (field === 'parent') {
                const childKey = this.eidToKey.get(eid);
                if (childKey) this.relinkParent(childKey, value as string);
            } else if (field === 'position' || field === 'rotation' || field === 'scale') {
                this.invalidate(eid);
            }
        }
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

    /** Compute an entity's world model matrix. With no `out`, writes into a
     *  reusable scratch buffer (safe for immediate consumption — callers must
     *  not retain the reference across another getModelMatrix call). Pass
     *  `out` to write into a caller-owned buffer for long-lived storage.
     *  Recursive across the parent chain (Transform.parent) with per-entity
     *  caching: writes to Transform.position/rotation/scale/parent mark the
     *  entity + its descendants dirty so the next read recomputes. */
    getModelMatrix(eid: number, out?: Float32Array): Float32Array {
        const target = out ?? this.scratchModel;
        if (!this.worldDirty.has(eid)) {
            const cached = this.worldMatrices.get(eid);
            if (cached) { target.set(cached); return target; }
        }
        // Recurse the parent chain FIRST so the parent's cached world matrix
        // is valid before we compute our own local. We deliberately do NOT
        // read this.parentScratch after the call — the parent's result lives
        // in the worldMatrices cache, and parentScratch may have been
        // clobbered by deeper recursion.
        const parentKey = this.getParentKey(eid);
        let parentMat: Float32Array | null = null;
        if (parentKey) {
            const parentEid = this.entityKeyMap.get(parentKey);
            if (parentEid != null) {
                if (!this.worldMatrices.has(parentEid) || this.worldDirty.has(parentEid)) {
                    this.getModelMatrix(parentEid, this.parentScratch);
                }
                parentMat = this.worldMatrices.get(parentEid) ?? null;
            }
        }
        // Now compute our local TRS — after parent recursion is done with
        // localScratch (parent used it for its own local; that value is no
        // longer needed because the parent's world is cached).
        const trs = this.getTransformTRS(eid);
        mat4FromTRSInto(trs.pos, trs.rot, trs.scale, this.localScratch);
        if (parentMat) {
            mat4MulInto(parentMat, this.localScratch, target);
        } else {
            target.set(this.localScratch);
        }
        let buf = this.worldMatrices.get(eid);
        if (!buf) { buf = new Float32Array(16); this.worldMatrices.set(eid, buf); }
        buf.set(target);
        this.worldDirty.delete(eid);
        return target;
    }

    // ── Parent hierarchy (Transform.parent back-ref) ───────────────────

    /** Direct children keys of `key`, or empty array if none. */
    getChildren(key: string): string[] {
        const set = this.childMap.get(key);
        return set ? [...set] : [];
    }

    /** Parent key of `eid`, or '' if it is a root. */
    getParent(eid: number): string {
        return this.getParentKey(eid);
    }

    /** Wire a parent for `childKey`. Writes the Transform.parent field and
     *  maintains the childMap / parentOf caches. Throws on cycles or missing
     *  parent (fail-loud). Public for editor drag-reparent (Phase 3). */
    setParent(childKey: string, parentKey: string): void {
        const childEid = this.entityKeyMap.get(childKey);
        if (childEid == null) throw new Error(`setParent: child '${childKey}' does not exist`);
        this.setField(childEid, 'Transform', 'parent', parentKey);
    }

    private getParentKey(eid: number): string {
        const key = this.eidToKey.get(eid);
        if (key == null) return '';
        return this.parentOf.get(key) ?? '';
    }

    /** Link childKey under parentKey (no field write — caller already set the
     *  Transform.parent field). Maintains childMap + parentOf + cycle check. */
    private linkParent(childKey: string, parentKey: string): void {
        if (!parentKey) return;
        if (!this.entityKeyMap.has(parentKey)) {
            throw new Error(`Transform.parent '${parentKey}' does not exist (entity '${childKey}')`);
        }
        // Cycle check: walk the parent chain from parentKey upward; if we hit
        // childKey, linking would form a cycle.
        let cur: string | undefined = parentKey;
        const guard = new Set<string>();
        while (cur) {
            if (cur === childKey) {
                throw new Error(`Hierarchy cycle: '${childKey}' is already an ancestor of '${parentKey}'`);
            }
            if (guard.has(cur)) break; // existing cycle (shouldn't happen) — stop
            guard.add(cur);
            cur = this.parentOf.get(cur);
        }
        let kids = this.childMap.get(parentKey);
        if (!kids) { kids = new Set(); this.childMap.set(parentKey, kids); }
        kids.add(childKey);
        this.parentOf.set(childKey, parentKey);
    }

    /** Re-link an entity whose Transform.parent field just changed: detach
     *  from the old parent's children list, attach to the new one, invalidate. */
    private relinkParent(childKey: string, newParentKey: string): void {
        const oldParent = this.parentOf.get(childKey);
        if (oldParent) this.childMap.get(oldParent)?.delete(childKey);
        if (newParentKey) {
            this.linkParent(childKey, newParentKey);
        } else {
            this.parentOf.delete(childKey);
        }
        const childEid = this.entityKeyMap.get(childKey);
        if (childEid != null) this.invalidate(childEid);
    }

    /** Mark `eid`'s world matrix (and all descendants') as needing recomputation. */
    private invalidate(eid: number): void {
        this.worldDirty.add(eid);
        const key = this.eidToKey.get(eid);
        if (!key) return;
        const kids = this.childMap.get(key);
        if (!kids) return;
        for (const ck of kids) {
            const ceid = this.entityKeyMap.get(ck);
            if (ceid != null) this.invalidate(ceid);
        }
    }

    /** Export every entity's components as JSON. Uses the per-entity component
     *  list (entityComponents) for O(E×avgC) instead of scanning every
     *  registered component per entity (O(E×C)). */
    toJSON(): SceneData {
        const result: SceneData = {};
        for (const [key, eid] of this.entityKeyMap) {
            const entityData: Record<string, Record<string, unknown>> = {};
            const comps = this.entityComponents.get(eid);
            if (comps) {
                for (const compName of comps) {
                    const comp = schemaRegistry.get(compName);
                    if (comp && hasComponent(this.world, comp, eid)) {
                        entityData[compName] = schemaRegistry.readAllFields(compName, comp, eid);
                    }
                }
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

    /** Return the component names registered on a specific entity. */
    getEntityComponentNames(eid: number): string[] {
        return this.entityComponents.get(eid) ?? [];
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
