import { createWorld, addEntity, removeEntity, type World } from 'bitecs';
import { addComponent, hasComponent, removeComponent } from 'bitecs/legacy';
import { schemaRegistry } from './SchemaRegistry';
import { buildCameraMatrices, mat4FromTRS, type TRS } from '../math';

export type SceneData = Record<string, Record<string, Record<string, unknown>>>;

export class Scene {
    world: World;
    entityKeyMap = new Map<string, number>();
    entityTags = new Map<number, string[]>();

    constructor() {
        this.world = createWorld();
    }

    createEntity(key: string, data: Record<string, Record<string, unknown>>): number {
        const eid = addEntity(this.world);
        const tags: string[] = [];

        // force NameComponent
        const nc = schemaRegistry.get('NameComponent')!;
        addComponent(this.world, nc, eid);
        schemaRegistry.setAllFields('NameComponent', nc, eid, { name: key });

        for (const [compName, compData] of Object.entries(data)) {
            const comp = schemaRegistry.get(compName);
            if (!comp) continue;
            addComponent(this.world, comp, eid);
            schemaRegistry.setAllFields(compName, comp, eid, compData);

            if (schemaRegistry.isRenderTag(compName)) {
                tags.push(compName);
            }
        }

        this.entityKeyMap.set(key, eid);
        this.entityTags.set(eid, tags);
        return eid;
    }

    removeEntity(key: string): void {
        const eid = this.entityKeyMap.get(key);
        if (eid !== undefined) {
            removeEntity(this.world, eid);
            this.entityKeyMap.delete(key);
            this.entityTags.delete(eid);
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
        if (enabled && !hasComponent(this.world, comp, eid)) {
            addComponent(this.world, comp, eid);
            schemaRegistry.setAllFields(compName, comp, eid, {});
        } else if (!enabled && hasComponent(this.world, comp, eid)) {
            removeComponent(this.world, comp, eid);
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
        const camComp = schemaRegistry.get('Camera')!;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, camComp, eid)) continue;
            const active = schemaRegistry.getScalar(camComp, eid, 'active');
            if (active !== 1) continue;
            const fov = schemaRegistry.getScalar(camComp, eid, 'fov');
            const near = schemaRegistry.getScalar(camComp, eid, 'near');
            const far = schemaRegistry.getScalar(camComp, eid, 'far');
            return buildCameraMatrices(this.getTransformTRS(eid), fov, aspect, near, far);
        }
        return null;
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

    getModelMatrix(eid: number): Float32Array {
        const trs = this.getTransformTRS(eid);
        return mat4FromTRS(trs.pos, trs.rot, trs.scale);
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
