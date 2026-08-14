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
    proj: Float32Array;
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
    /** Per-axis screen-space segment endpoints from the last drawGizmo, used
     *  for axis hit-testing on pointer-down. */
    private axisScreens: Array<{ axis: 'x' | 'y' | 'z'; cx: number; cy: number; ex: number; ey: number }> = [];
    /** Axis locked by the current drag ('x'|'y'|'z' or null). */
    private activeAxis: 'x' | 'y' | 'z' | null = null;
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
    }

    /** Return the selected entity's position + a framing distance (from its
     *  bounding sphere) for the editor camera focus button. Null when
     *  nothing is selected. For skinned meshes the focus targets the root
     *  ancestor (which is what the gizmo moves). */
    getFocusTarget(): { x: number; y: number; z: number; distance: number } | null {
        if (!this.selectedKey) return null;
        const rootKey = this.getRootAncestor(this.selectedKey);
        const rootEid = this.engine.scene.entityKeyMap.get(rootKey);
        if (rootEid == null) return null;
        const [x, y, z] = this.engine.scene.getWorldPosition(rootEid);
        // Use the picked mesh entity's bounding sphere for framing distance.
        const pickedEid = this.engine.scene.entityKeyMap.get(this.selectedKey);
        const sphere = pickedEid != null ? this.boundingSphereFor(pickedEid) : null;
        const radius = sphere ? sphere.radius : 1;
        return { x, y, z, distance: Math.max(1, radius * 3) };
    }

    /** Walk the parent chain to the top-level ancestor (no parent). For a
     *  skinned mesh this is the root node whose Transform drives the whole
     *  skeleton (joint GlobalTransform is parented under it), so dragging the
     *  root actually moves the character. */
    private getRootAncestor(key: string): string {
        const scene = this.engine.scene;
        let cur = key;
        const guard = new Set<string>();
        while (true) {
            if (guard.has(cur)) break;
            guard.add(cur);
            const eid = scene.entityKeyMap.get(cur);
            if (eid == null) break;
            const parent = scene.getParent(eid);
            if (!parent) break;
            cur = parent;
        }
        return cur;
    }

    setMode(mode: GizmoMode): void {
        this.mode = mode;
    }

    // ── Pointer handling ────────────────────────────────────────────────

    private handleDown(e: PointerEvent): void {
        if (this.disposed || e.button !== 0) return;
        // 1. If an entity is selected and the gizmo is visible, hit-test the
        //    axis lines first so the user can grab a specific axis.
        if (this.selectedKey) {
            const axis = this.pickAxis(e.clientX, e.clientY);
            if (axis) {
                this.activeAxis = axis;
                this.dragging = true;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
                e.preventDefault();
                return;
            }
        }
        // 2. Otherwise ray-sphere pick an entity.
        const hit = this.rayPick(e.clientX, e.clientY);
        if (hit) {
            if (hit !== this.selectedKey) {
                this.selectedKey = hit;
                this.eventBus.emit('pick', { key: hit, source: 'gizmo' });
            }
            // Clicking the already-selected entity body starts a free
            // (screen-plane) drag with no axis locked.
            if (hit === this.selectedKey) {
                this.activeAxis = null;
                this.dragging = true;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
                e.preventDefault();
            }
            return;
        }
        // 3. Miss → deselect (unless the physics PickTool may still hit).
        const physics = this.engine.systemRegistry.resolve({ name: 'physics' });
        if (!physics) {
            this.selectedKey = null;
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
        this.activeAxis = null;
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
        const [ex, ey, ez] = this.engine.scene.getWorldPosition(eid);
        const sc = scene.getField(eid, 'Transform', 'scale') as unknown as number[] | undefined;
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
        // For skinned meshes, drag the root ancestor (joint GlobalTransform is
        // parented under it, so moving the root moves the whole character).
        // For static meshes getRootAncestor returns the entity itself.
        const targetKey = this.getRootAncestor(this.selectedKey);
        const scene = this.engine.scene;
        const eid = scene.entityKeyMap.get(targetKey);
        if (eid == null) return;
        const cam = this.currentCamera();
        if (!cam) return;

        // Axis-locked drag reads the screen-space axis direction stored by
        // the last drawGizmo. Free drag (activeAxis=null) uses camera right/up.
        const seg = this.activeAxis ? this.axisScreens.find(a => a.axis === this.activeAxis) : null;
        const axisWorld = this.activeAxis ? AXIS_DIRS[this.activeAxis] : null;

        if (this.mode === 'move') {
            if (seg && axisWorld) {
                const sdx = seg.ex - seg.cx, sdy = seg.ey - seg.cy;
                const slen = Math.hypot(sdx, sdy) || 1;
                const screenDot = (dx * sdx + dy * sdy) / slen;
                const w = screenDot * this.worldPerPixel(cam, eid);
                const pos = scene.getField(eid, 'Transform', 'position') as unknown as number[] | undefined;
                this.commandBus.setField(targetKey, 'Transform', 'position', [
                    (pos?.[0] ?? 0) + axisWorld[0] * w,
                    (pos?.[1] ?? 0) + axisWorld[1] * w,
                    (pos?.[2] ?? 0) + axisWorld[2] * w,
                ]);
            } else {
                // Free: screen-plane along camera right/up.
                const view = cam.view;
                const s = 0.01;
                const pos = scene.getField(eid, 'Transform', 'position') as unknown as number[] | undefined;
                this.commandBus.setField(targetKey, 'Transform', 'position', [
                    (pos?.[0] ?? 0) + (view[0] * dx - view[1] * dy) * s,
                    (pos?.[1] ?? 0) + (view[4] * dx - view[5] * dy) * s,
                    (pos?.[2] ?? 0) + (view[8] * dx - view[9] * dy) * s,
                ]);
            }
        } else if (this.mode === 'rotate') {
            // Axis-locked: angular displacement of the mouse around the entity
            // center on screen. Free: yaw from dx (around world up).
            const axis = axisWorld ?? [0, 1, 0];
            const angle = seg ? this.screenAngleDelta(dx, dy, seg.cx, seg.cy) : dx * 0.01;
            const rot = scene.getField(eid, 'Transform', 'rotation') as unknown as number[] | undefined;
            const [qx, qy, qz, qw] = normalizeQuat(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, rot?.[3] ?? 1);
            const h = angle / 2;
            const sh = Math.sin(h), ch = Math.cos(h);
            // dq = axis-angle(axis, angle): (axis·sin(h), cos(h)); q' = dq * q
            const r = mulQuat(axis[0] * sh, axis[1] * sh, axis[2] * sh, ch, qx, qy, qz, qw);
            this.commandBus.setField(targetKey, 'Transform', 'rotation', [r[0], r[1], r[2], r[3]]);
        } else { // scale
            const sc = scene.getField(eid, 'Transform', 'scale') as unknown as number[] | undefined;
            const s = [(sc?.[0] ?? 1), (sc?.[1] ?? 1), (sc?.[2] ?? 1)];
            let factor: number;
            if (seg) {
                const sdx = seg.ex - seg.cx, sdy = seg.ey - seg.cy;
                const slen = Math.hypot(sdx, sdy) || 1;
                factor = Math.max(0.05, 1 + ((dx * sdx + dy * sdy) / slen) * 0.01);
            } else {
                factor = Math.max(0.05, 1 - dy * 0.01);
            }
            if (this.activeAxis) {
                const idx = AXIS_IDX[this.activeAxis];
                s[idx] = Math.max(0.01, s[idx] * factor);
                this.commandBus.setField(targetKey, 'Transform', 'scale', [s[0], s[1], s[2]]);
            } else {
                // Free scale: apply the factor to every axis independently so a
                // non-uniform scale (e.g. [2,1,1] long box) keeps its ratio
                // instead of being flattened to [s[0], s[0], s[0]].
                this.commandBus.setField(targetKey, 'Transform', 'scale', [
                    Math.max(0.01, s[0] * factor),
                    Math.max(0.01, s[1] * factor),
                    Math.max(0.01, s[2] * factor),
                ]);
            }
        }
    }

    /** Approximate world units per screen pixel at the entity's depth — used
     *  to convert axis-locked screen drag deltas into world-space movement. */
    private worldPerPixel(cam: GizmoCamera, eid: number): number {
        const scene = this.engine.scene;
        const [ex, ey, ez] = scene.getWorldPosition(eid);
        const dist = Math.hypot(cam.pos[0] - ex, cam.pos[1] - ey, cam.pos[2] - ez);
        // proj[5] = 1/tan(fovY/2); visible world height at distance d = 2*d*tan.
        const tanHalf = 1 / (cam.proj[5] || 1);
        const h = this.canvas.clientHeight || 1;
        return (2 * dist * tanHalf) / h;
    }

    /** Angular displacement of the mouse around the entity's screen-space
     *  center between the previous and current pointer position. */
    private screenAngleDelta(dx: number, dy: number, cx: number, cy: number): number {
        const rect = this.canvas.getBoundingClientRect();
        const curX = this.lastX - rect.left, curY = this.lastY - rect.top;
        const prevX = curX - dx, prevY = curY - dy;
        const a1 = Math.atan2(prevY - cy, prevX - cx);
        const a2 = Math.atan2(curY - cy, curX - cx);
        return a2 - a1;
    }

    /** Hit-test the pointer against the 3 axis screen segments. Returns the
     *  closest axis within the pixel threshold, or null. */
    private pickAxis(clientX: number, clientY: number): 'x' | 'y' | 'z' | null {
        if (this.axisScreens.length === 0) return null;
        const rect = this.canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const threshold = 12;
        let bestAxis: 'x' | 'y' | 'z' | null = null;
        let bestDist = threshold;
        for (const a of this.axisScreens) {
            const d = pointToSegmentDist(px, py, a.cx, a.cy, a.ex, a.ey);
            if (d < bestDist) { bestDist = d; bestAxis = a.axis; }
        }
        return bestAxis;
    }

    // ── Gizmo overlay rendering ──────────────────────────────────────────

    private scheduleDraw(): void {
        if (this.rafId) return;
        // Continuous rAF so the gizmo follows entity movement and camera
        // changes without external redraw triggers. Each frame clears the
        // overlay and redraws (a few line/arc draws — negligible cost).
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            this.drawGizmo();
            this.scheduleDraw();
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
        const rootKey = this.getRootAncestor(this.selectedKey);
        const eid = this.engine.scene.entityKeyMap.get(rootKey) ?? this.engine.scene.entityKeyMap.get(this.selectedKey);
        if (eid == null) return;
        const cam = this.currentCamera();
        if (!cam) return;

        const scene = this.engine.scene;
        const origin: [number, number, number] = scene.getWorldPosition(eid);
        // Gizmo size: scale with distance to keep a constant screen footprint.
        const dist = Math.hypot(cam.pos[0] - origin[0], cam.pos[1] - origin[1], cam.pos[2] - origin[2]);
        const size = Math.max(0.1, dist * 0.15);

        const center = this.project(origin, cam, w, h);
        if (!center) return;

        const axes: Array<{ key: 'x' | 'y' | 'z'; dir: [number, number, number]; color: string; label: string }> = [
            { key: 'x', dir: [size, 0, 0], color: '#ff5b5b', label: 'X' },
            { key: 'y', dir: [0, size, 0], color: '#5bff7a', label: 'Y' },
            { key: 'z', dir: [0, 0, size], color: '#5b9bff', label: 'Z' },
        ];
        this.axisScreens = [];

        ctx.font = '11px monospace';
        // Always draw the 3 axis lines (pickable in every mode) + store screen
        // endpoints for axis hit-testing on pointer-down.
        for (const ax of axes) {
            const end: [number, number, number] = [origin[0] + ax.dir[0], origin[1] + ax.dir[1], origin[2] + ax.dir[2]];
            const sp = this.project(end, cam, w, h);
            if (!sp) continue;
            this.axisScreens.push({ axis: ax.key, cx: center.x, cy: center.y, ex: sp.x, ey: sp.y });
            ctx.strokeStyle = ax.color;
            ctx.lineWidth = this.activeAxis === ax.key ? 4 : 2;
            ctx.beginPath();
            ctx.moveTo(center.x, center.y);
            ctx.lineTo(sp.x, sp.y);
            ctx.stroke();
            ctx.fillStyle = ax.color;
            ctx.fillText(ax.label, sp.x + 4, sp.y - 4);
        }
        // Mode-specific extras drawn on top (rings for rotate, boxes for scale).
        if (this.mode === 'rotate') {
            this.drawRing(ctx, origin, [0, 1, 0], [0, 0, 1], size, '#ff5b5b', cam, w, h);
            this.drawRing(ctx, origin, [1, 0, 0], [0, 0, 1], size, '#5bff7a', cam, w, h);
            this.drawRing(ctx, origin, [1, 0, 0], [0, 1, 0], size, '#5b9bff', cam, w, h);
        } else if (this.mode === 'scale') {
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

const AXIS_DIRS: Record<'x' | 'y' | 'z', [number, number, number]> = {
    x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
};
const AXIS_IDX: Record<'x' | 'y' | 'z', number> = { x: 0, y: 1, z: 2 };

/** Minimum distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
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
