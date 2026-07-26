import { EnginePlugin, type PluginContext, type FrameContext, type System, RAPIER } from '@shaderlab/api';
import { generateSplatCollider, type SplatColliderResult } from './SplatCollider.ts';

interface PhysicsSystemLike {
    hasBodyRecord(eid: number): boolean;
    attachColliderToBody(eid: number, desc: import('@dimforge/rapier3d-compat').ColliderDesc): boolean;
}

interface SplatManagerLike {
    getCenters(): Float32Array | null;
}

interface SplatPhysicsState {
    gsEid: number;
    hullDescs: SplatColliderResult | null;
    attached: boolean;
}

class SplatPhysicsSystem implements System {
    private state: SplatPhysicsState | null = null;

    setState(state: SplatPhysicsState): void {
        this.state = state;
    }

    update(ctx: FrameContext): void {
        if (!this.state || this.state.attached) return;
        const physics = ctx.attachments?.physics as PhysicsSystemLike | undefined;
        if (!physics || !physics.hasBodyRecord(this.state.gsEid)) return;

        const result = this.state.hullDescs;
        if (!result || result.colliderDescs.length === 0) {
            this.state.attached = true;
            return;
        }

        let attached = 0;
        for (const desc of result.colliderDescs) {
            desc.setDensity(8);
            desc.setFriction(0.9);
            desc.setRestitution(0.05);
            desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
            if (physics.attachColliderToBody(this.state.gsEid, desc)) {
                attached++;
            }
        }

        this.state.attached = true;
        this.state.hullDescs = null;
        console.log(`[splat-physics] attached ${attached} convex hulls to GsEntity`);
    }
}

export default class SplatPhysicsPlugin extends EnginePlugin {
    readonly meta = { id: 'splat-physics', dependencies: ['splat', 'physics'] };

    private system = new SplatPhysicsSystem();

    setup(ctx: PluginContext): void {
        ctx.registerSystem('splatPhysics', this.system);
    }

    async appLoaded(ctx: PluginContext): Promise<void> {
        const splatSys = ctx.getSystem<SplatManagerLike>('gaussianSplat');
        if (!splatSys) {
            console.warn('[splat-physics] gaussianSplat system not found');
            return;
        }

        const centers = splatSys.getCenters();
        if (!centers || centers.length === 0) {
            console.warn('[splat-physics] no splat centers available');
            return;
        }

        let gsEid: number | null = null;
        for (const [, eid] of ctx.scene.entityKeyMap) {
            if (ctx.scene.hasComponent(eid, 'GsComponent')) {
                gsEid = eid;
                break;
            }
        }
        if (gsEid === null) {
            console.warn('[splat-physics] no GsComponent entity found');
            return;
        }

        console.log(`[splat-physics] generating convex hulls from ${Math.floor(centers.length / 4)} splats...`);
        const start = performance.now();
        const result = generateSplatCollider(centers);
        const elapsed = (performance.now() - start).toFixed(0);
        console.log(`[splat-physics] generated ${result.hullCount} convex hulls in ${elapsed}ms`);

        ctx.scene.toggleComponent(gsEid, 'RigidBodyComponent', true);
        ctx.scene.setField(gsEid, 'RigidBodyComponent', 'bodyType', 'dynamic');
        ctx.scene.setField(gsEid, 'RigidBodyComponent', 'ccd', 1);
        ctx.scene.setField(gsEid, 'RigidBodyComponent', 'linearDamping', 0.05);
        ctx.scene.setField(gsEid, 'RigidBodyComponent', 'angularDamping', 0.3);
        ctx.scene.setField(gsEid, 'RigidBodyComponent', 'gravityScale', 1);

        ctx.scene.toggleComponent(gsEid, 'ColliderComponent', true);
        ctx.scene.setField(gsEid, 'ColliderComponent', 'shape', 'cuboid');
        ctx.scene.setField(gsEid, 'ColliderComponent', 'halfExtents', [0.01, 0.01, 0.01]);
        ctx.scene.setField(gsEid, 'ColliderComponent', 'isSensor', 1);
        ctx.scene.setField(gsEid, 'ColliderComponent', 'density', 0);

        this.system.setState({
            gsEid,
            hullDescs: result,
            attached: false,
        });
    }

    appUnloading(): void {
        this.system.setState({ gsEid: -1, hullDescs: null, attached: true });
    }
}
