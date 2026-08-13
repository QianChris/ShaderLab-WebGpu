import type { Engine } from '../../core/Engine';
import type { EventBus } from '../../core/events/EventBus';
import { mat4TransformVec4 } from '../../core/math';
import { resourceManager } from '../../core/render/ResourceManager';
import type { EditorCommandBus } from '../EditorCommandBus';

export type GizmoMode = 'move' | 'rotate' | 'scale';

/** Narrow camera view the gizmo needs (subset of CameraView — both the editor
 *  override and scene.getActiveCamera() satisfy this structurally). */
interface GizmoCamera {
    vp: Float32Array;
    ivp: Float32Array;
    pos: Float32Array;
    view: Float32Array;
}

interface BoundingSphere { cx: number; cy: number; cz: number; radius: number; }

/**
 * Editor transform gizmo: pick entities by ray-sphere intersection, render a
 * 3-axis / 3-ring / 3-box overlay on a 2D canvas stacked above the main
 * canvas, and drag the selected entity's Transform (position/rotation/scale)
 * through the command bus (undoable).
 *
 * Lifecycle: owned by EditorOrchestrator (always active in editor mode, like
 * ViewportCameraController). Player mode never instantiates it.
 *
 * Selection sources:
 *   - Left-click empty space (no physics 'pick' tool active) → ray-sphere pick
 *     against every MeshComponent entity → emit 'pick' { key, eid }.
 *   - The physics PickTool (when loaded) emits 'pick' independently; this
 *     tool subscribes to 'pick' to stay in sync.
 *
 * Drag (simplified — screen-plane, not axis-locked in this Phase 0.4 cut):
 *   - move:    screen dx → position along camera right; dy → along camera up.
 *   - rotate:  dx → yaw (around camera up); dy → pitch (around camera right).
 *   - scale:   dy → uniform scale factor.
 * Axis-locked drag and WebGPU gizmo pipeline are deferred (PLAN §3.0.2 notes
 * the WebGPU pipeline as the target; this 2D overlay is the Phase 0 baseline).
 *
 * Keyboard: W=move, E=rotate, R=scale (Blender convention). Escape deselects.
 */
export class TransformGizmoTool {
    private readonly canvas: HTMLCanvasElement;
    private readonly overlay: HTMLCanvasElement;
    private readonly ctx2d: CanvasRenderingContext2D;
    private readonly engine: Engine;
    private readonly commandBus: EditorCommandBus;
    private readonly eventBus: EventBus;

    private mode: GizmoMode = 'move';
    private selectedKey: string | null = null;
    private dragging = false;
    private lastX = 0;
    private lastY = 0;
    /** Cached bounding spheres per mesh name (computed lazily on first pick). */
    private readonly spheres = new Map<string, BoundingSphere | null>();
    private rafId = 0;
    private disposed = false;

    private readonly onPointerDown: (e: PointerEvent) => void;
    private readonly onPointerMove: (e: PointerEvent) => void;
    private readonly onPointerUp: (e: PointerEvent) => void;
    private readonly onKey: (e: KeyboardEvent) => void;
    private readonly onPick: (payload: unknown) => void;
    private unsubPick?: () => void;

    constructor(canvas: HTMLCanvasElement, engine: Engine, commandBus: EditorCommandBus, eventBus: EventBus) {
        this.canvas = canvas;
        this.engine = engine;
        this.commandBus = commandBus;
        this.eventBus = eventBus;

        // Overlay 2D canvas stacked above the WebGPU canvas. pointer-events:none
        // so it never swallows input (the main canvas still receives pointer
        // events; this only renders).
        this.overlay = document.createElement('canvas');
        this.overlay.style.cssText =
            'position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; z-index:2;';
        const parent = canvas.parentElement;
        if (!parent) throw new Error('TransformGizmoTool: canvas has no parent element');
        parent.appendChild(this.overlay);
        const ctx = this.overlay.getContext('2d');
        if (!ctx) throw new Error('TransformGizmoTool: 2D context unavailable');
        this.ctx2d = ctx;

        this.onPointerDown = (e) => this.handleDown(e);
        this.onPointerMove = (e) => this.handleMove(e);
        this.onPointerUp = () => this.handleUp();
        this.onKey = (e) => this.handleKey(e);
        this.onPick = (payload) => {
            const p = payload as { key?: string };
            if (p?.key) {
                this.selectedKey = p.key;
            }
        };
    }

    attach(): void {
        this.canvas.addEventListener('pointerdown', this.onPointerDown);
        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
        window.addEventListener('keydown', this.onKey);
        this.unsubPick = this.eventBus.on('pick', this.onPick);
        this.scheduleDraw();
    }

    dispose(): void {
        this.disposed = true;
        this.cancelDraw();
        this.canvas.removeEventListener('pointerdown', this.onPointerDown);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('keydown', this.onKey);
        this.unsubPick?.();
        this.unsubPick = undefined;
        this.overlay.remove();
    }

    /** Select an entity by key (used by external callers / future gizmo axis pick). */
    select(key: string | null): void {
        this.selectedKey = key;
        this.scheduleDraw();
    }

    setMode(mode: GizmoMode): void {
        this.mode = mode;
        this.scheduleDraw();
    }

    // ── Pointer handling ────────────────────────────────────────────────

    private handleDown(e: PointerEvent): void {
        if (this.disposed || e.button !== 0) return;
        const hit = this.rayPick(e.clientX, e.clientY);
        // Click on the already-selected entity → start a transform drag.
        if (hit && hit === this.selectedKey) {
            this.dragging = true;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            e.preventDefault();
            return;
        }
        // Click on a different entity → select it (emit pick so EditorPanel
        // and other listeners stay in sync).
        if (hit) {
            this.selectedKey = hit;
            this.eventBus.emit('pick', { key: hit, source: 'gizmo' });
            this.scheduleDraw();
            return;
        }
        // Miss → deselect (only when no physics tool is active; the physics
        // PickTool may still hit a collider and emit 'pick' to reselect).
        const physics = this.engine.systemRegistry.resolve({ name: 'physics' });
        if (!physics) {
            this.selectedKey = null;
            this.scheduleDraw();
        }
    }

    private handleMove(e: PointerEvent): void {
        if (this.disposed || !this.dragging || !this.selectedKey) return;
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.applyDrag(dx, dy);
    }

    private handleUp(): void {
        this.dragging = false;
    }

    private handleKey(e: KeyboardEvent): void {
        if (this.disposed) return;
        // Ignore when typing in an input/textarea (CodeMirror, name fields…).
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        if (e.key === 'w' || e.key === 'W') { this.setMode('move'); }
        else if (e.key === 'e' || e.key === 'E') { this.setMode('rotate'); }
        else if (e.key === 'r' || e.key === 'R') { this.setMode('scale'); }
        else if (e.key === 'Escape') { this.select(null); }
    }

    // ── Picking ─────────────────────────────────────────────────────────

    /** Ray-sphere pick against every MeshComponent entity. Returns the closest
     *  hit's entity key, or null when nothing was hit. */
    private rayPick(clientX: number, clientY: number): string | null {
        const cam = this.currentCamera();
        if (!cam) return null;
        const rect = this.canvas.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

        // Unproject NDC near/far → world ray.
        const near = mat4TransformVec4(cam.ivp, [ndcX, ndcY, 0, 1]);
        const far = mat4TransformVec4(cam.ivp, [ndcX, ndcY, 1, 1]);
        const ox = near[0] / near[3], oy = near[1] / near[3], oz = near[2] / near[3];
        let dx = far[0] / far[3] - ox;
        let dy = far[1] / far[3] - oy;
        let dz = far[2] / far[3] - oz;
        const dlen = Math.hypot(dx, dy, dz) || 1;
        dx /= dlen; dy /= dlen; dz /= dlen;

        let bestKey: string | null = null;
        let bestT = Infinity;
        const scene = this.engine.scene;
        for (const [key, eid] of scene.entityKeyMap) {
            if (!scene.hasComponent(eid, 'MeshComponent')) continue;
            const sphere = this.boundingSphereFor(eid);
            if (!sphere) continue;
            // ray-sphere: |o + t*d - c|^2 = r^2
            const ocx = ox - sphere.cx, ocy = oy - sphere.cy, ocz = oz - sphere.cz;
            const b = ocx * dx + ocy * dy + ocz * dz;
            const c = ocx * ocx + ocy * ocy + ocz * ocz - sphere.radius * sphere.radius;
            const disc = b * b - c;
            if (disc < 0) continue;
            const t = -b - Math.sqrt(disc);
            if (t > 0 && t < bestT) { bestT = t; bestKey = key; }
        }
        return bestKey;
    }

    /** Compute (or fetch cached) world-space bounding sphere for an entity's mesh. */
    private boundingSphereFor(eid: number): BoundingSphere | null {
        const scene = this.engine.scene;
        const meshName = scene.getField(eid, 'MeshComponent', 'mesh') as string;
        if (!meshName) return null;
        let sphere = this.spheres.get(meshName);
        if (sphere === undefined) {
            sphere = this.computeSphere(meshName);
            this.spheres.set(meshName, sphere);
        }
        if (!sphere) return null;
        // Place the local sphere at the entity's world position, scaled by the
        // max axis of the entity's scale (rough but adequate for picking).
        const px = scene.getField(eid, 'Transform', 'position') as unknown as number[] | undefined;
        const sc = scene.getField(eid, 'Transform', 'scale') as unknown as number[] | undefined;
        const ex = px?.[0] ?? 0, ey = px?.[1] ?? 0, ez = px?.[2] ?? 0;
        const s = Math.max(sc?.[0] ?? 1, sc?.[1] ?? 1, sc?.[2] ?? 1);
        return { cx: ex + sphere.cx * s, cy: ey + sphere.cy * s, cz: ez + sphere.cz * s, radius: sphere.radius * s };
    }

    private computeSphere(meshName: string): BoundingSphere | null {
        const rm = resourceManager;
        const data = rm.getMeshData(meshName) ?? rm.getPbrMeshData(meshName);
        if (!data) return null;
        const positions = data.positions;
        if (!positions || positions.length < 3) return null;
        let minx = Infinity, miny = Infinity, minz = Infinity;
        let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
            if (z < minz) minz = z; if (z > maxz) maxz = z;
        }
        const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5, cz = (minz + maxz) * 0.5;
        let r = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const dx = positions[i] - cx, dy = positions[i + 1] - cy, dz = positions[i + 2] - cz;
            const d = Math.hypot(dx, dy, dz);
            if (d > r) r = d;
        }
        return { cx, cy, cz, radius: r || 0.5 };
    }

    // ── Drag → Transform ─────────────────────────────────────────────────

    private applyDrag(dx: number, dy: number): void {
        if (!this.selectedKey) return;
        const scene = this.engine.scene;
        const eid = scene.entityKeyMap.get(this.selectedKey);
        if (eid == null) return;
        const cam = this.currentCamera();
        if (!cam) return;
        const sensitivity = 0.01;

        if (this.mode === 'move') {
            // Screen-plane movement along camera right (dx) and up (dy).
            // Camera right = row 0 of view matrix; up = row 1 (column-major).
            const view = cam.view;
            const rightX = view[0], rightY = view[4], rightZ = view[8];
            const upX = view[1], upY = view[5], upZ = view[9];
            const pos = scene.getField(eid, 'Transform', 'position') as unknown as number[] | undefined;
            const px = (pos?.[0] ?? 0) + (rightX * dx - upX * dy) * sensitivity;
            const py = (pos?.[1] ?? 0) + (rightY * dx - upY * dy) * sensitivity;
            const pz = (pos?.[2] ?? 0) + (rightZ * dx - upZ * dy) * sensitivity;
            this.commandBus.setField(this.selectedKey, 'Transform', 'position', [px, py, pz]);
        } else if (this.mode === 'rotate') {
            // Yaw around camera up (dx), pitch around camera right (dy).
            const rot = scene.getField(eid, 'Transform', 'rotation') as unknown as number[] | undefined;
            const yawDelta = dx * 0.01;
            const pitchDelta = dy * 0.01;
            // Simplified: apply as incremental quaternion around world Y and X.
            // Compose: q' = dq * q (world-space rotation).
            const [qx, qy, qz, qw] = normalizeQuat(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, rot?.[3] ?? 1);
            // yaw around Y: (0, sin(h/2), 0, cos(h/2))
            const yh = yawDelta / 2, ysh = Math.sin(yh), ych = Math.cos(yh);
            // pitch around X: (sin(p/2), 0, 0, cos(p/2))
            const ph = pitchDelta / 2, psh = Math.sin(ph), pch = Math.cos(ph);
            // dq_yaw * q
            const a = mulQuat(0, ysh, 0, ych, qx, qy, qz, qw);
            // dq_pitch * (dq_yaw * q)
            const r = mulQuat(psh, 0, 0, pch, a[0], a[1], a[2], a[3]);
            this.commandBus.setField(this.selectedKey, 'Transform', 'rotation', [r[0], r[1], r[2], r[3]]);
        } else { // scale
            const sc = scene.getField(eid, 'Transform', 'scale') as unknown as number[] | undefined;
            const factor = Math.max(0.05, 1 - dy * sensitivity);
            const sx = Math.max(0.01, (sc?.[0] ?? 1) * factor);
            this.commandBus.setField(this.selectedKey, 'Transform', 'scale', [sx, sx, sx]);
        }
    }

    // ── Gizmo overlay rendering ──────────────────────────────────────────

    private scheduleDraw(): void {
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            this.drawGizmo();
        });
    }

    private cancelDraw(): void {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    }

    private currentCamera(): GizmoCamera | null {
        return this.engine.editorView ?? this.engine.scene.getActiveCamera(this.engine.aspect());
    }

    private drawGizmo(): void {
        if (this.disposed) return;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (this.overlay.width !== w * dpr || this.overlay.height !== h * dpr) {
            this.overlay.width = w * dpr;
            this.overlay.height = h * dpr;
        }
        const ctx = this.ctx2d;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (!this.selectedKey) return;
        const eid = this.engine.scene.entityKeyMap.get(this.selectedKey);
        if (eid == null) return;
        const cam = this.currentCamera();
        if (!cam) return;

        const scene = this.engine.scene;
        const px = scene.getField(eid, 'Transform', 'position') as unknown as number[] | undefined;
        const origin: [number, number, number] = [px?.[0] ?? 0, px?.[1] ?? 0, px?.[2] ?? 0];
        // Gizmo size: scale with distance to keep a constant screen footprint.
        const dist = Math.hypot(cam.pos[0] - origin[0], cam.pos[1] - origin[1], cam.pos[2] - origin[2]);
        const size = Math.max(0.1, dist * 0.15);

        const center = this.project(origin, cam, w, h);
        if (!center) return;

        const axes: Array<{ dir: [number, number, number]; color: string; label: string }> = [
            { dir: [size, 0, 0], color: '#ff5b5b', label: 'X' },
            { dir: [0, size, 0], color: '#5bff7a', label: 'Y' },
            { dir: [0, 0, size], color: '#5b9bff', label: 'Z' },
        ];

        ctx.lineWidth = 2;
        ctx.font = '11px monospace';
        if (this.mode === 'move') {
            for (const ax of axes) {
                const end: [number, number, number] = [origin[0] + ax.dir[0], origin[1] + ax.dir[1], origin[2] + ax.dir[2]];
                const sp = this.project(end, cam, w, h);
                if (!sp) continue;
                ctx.strokeStyle = ax.color;
                ctx.beginPath();
                ctx.moveTo(center.x, center.y);
                ctx.lineTo(sp.x, sp.y);
                ctx.stroke();
                ctx.fillStyle = ax.color;
                ctx.fillText(ax.label, sp.x + 4, sp.y - 4);
            }
        } else if (this.mode === 'rotate') {
            // Three circles in the YZ, XZ, XY planes (perpendicular to X, Y, Z).
            this.drawRing(ctx, origin, [0, 1, 0], [0, 0, 1], size, '#ff5b5b', cam, w, h);
            this.drawRing(ctx, origin, [1, 0, 0], [0, 0, 1], size, '#5bff7a', cam, w, h);
            this.drawRing(ctx, origin, [1, 0, 0], [0, 1, 0], size, '#5b9bff', cam, w, h);
        } else { // scale
            for (const ax of axes) {
                const end: [number, number, number] = [origin[0] + ax.dir[0], origin[1] + ax.dir[1], origin[2] + ax.dir[2]];
                const sp = this.project(end, cam, w, h);
                if (!sp) continue;
                ctx.fillStyle = ax.color;
                ctx.fillRect(sp.x - 4, sp.y - 4, 8, 8);
            }
        }
    }

    private drawRing(
        ctx: CanvasRenderingContext2D,
        origin: [number, number, number],
        u: [number, number, number], v: [number, number, number],
        size: number, color: string, cam: GizmoCamera, w: number, h: number,
    ): void {
        const N = 24;
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const p: [number, number, number] = [
                origin[0] + (u[0] * ca + v[0] * sa) * size,
                origin[1] + (u[1] * ca + v[1] * sa) * size,
                origin[2] + (u[2] * ca + v[2] * sa) * size,
            ];
            const sp = this.project(p, cam, w, h);
            if (!sp) continue;
            if (i === 0) ctx.moveTo(sp.x, sp.y);
            else ctx.lineTo(sp.x, sp.y);
        }
        ctx.stroke();
    }

    /** Project a world point through the camera VP to screen pixels. Returns
     *  null when the point is behind the camera (w <= 0). */
    private project(p: [number, number, number], cam: GizmoCamera, w: number, h: number): { x: number; y: number } | null {
        const clip = mat4TransformVec4(cam.vp, [p[0], p[1], p[2], 1]);
        if (clip[3] <= 0) return null;
        const ndcX = clip[0] / clip[3];
        const ndcY = clip[1] / clip[3];
        return { x: (ndcX * 0.5 + 0.5) * w, y: (1 - (ndcY * 0.5 + 0.5)) * h };
    }
}

function normalizeQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
    const len = Math.hypot(x, y, z, w) || 1;
    return [x / len, y / len, z / len, w / len];
}

function mulQuat(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): [number, number, number, number] {
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}
