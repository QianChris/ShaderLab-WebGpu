declare module 'bitecs/legacy' {
    import type { World, EntityId } from 'bitecs';

    export const Types: Record<string, number>;

    export function defineComponent<T extends Record<string, number>>(
        schema: T,
    ): Record<keyof T, Float32Array | Uint32Array | Uint8Array | Int32Array>;

    export function defineQuery(
        components: object[],
    ): (world: World) => readonly EntityId[];

    export function addComponent(world: World, component: object, eid: EntityId): void;
    export function removeComponent(world: World, component: object, eid: EntityId): void;
    export function hasComponent(world: World, component: object, eid: EntityId): boolean;
}
