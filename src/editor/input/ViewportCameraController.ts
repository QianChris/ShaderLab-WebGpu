import type { CameraView } from '../../core/ecs/Scene';
import {
    mat4InverseInto,
    mat4LookAtInto,
    mat4MulInto,
    mat4PerspectiveInto,
} from '../../core/math';

/**
 * Editor-only viewport camera. Maintains an orbit/pan/zoom state independent
 * of any Camera entity in the scene, so the editor can frame the scene without
 * polluting player-mode camera state. The EditorOrchestrator reads
 * `getCameraView()` each frame and injects it as the engine's `editorView`
 * override (RenderGraph.execute uses it in place of scene cameras).
 *
 * Interaction:
 *   - Right-drag  → orbit (yaw + pitch)
 *   - Middle-drag → pan (translate target in screen plane)
 *   - Wheel       → zoom (change distance)
 *   - Left button is NOT consumed — left for pick/gizmo tools.
 *
 * Pitch is clamped to avoid flipping at the poles; distance is clamped to a
 * positive minimum to prevent entering the target.
 */
export class ViewportCameraController {
    private yaw = 0;
    private pitch = 0.35;
    private distance = 8;
    private targetX = 0;
    private targetY = 0.5;
    private targetZ = 0;
    private readonly fov = 50;
    private readonly near = 0.1;
    private readonly far = 1000;

    private readonly view = new Float32Array(16);
    private readonly proj = new Float32Array(16);
    private readonly vp = new Float32Array(16);
    private readonly ivp = new Float32Array(16);
    private readonly pos = new Float32Array(4);
    private readonly cameraView: CameraView = {
        eid: 0,
        vp: this.vp,
        ivp: this.ivp,
        pos: this.pos,
        view: this.view,
        proj: this.proj,
        viewport: [0, 0, 1, 1],
        aspect: 1,
    };

    private readonly canvas: HTMLCanvasElement;
    private disposed = false;
    /** Accumulated pointer delta since last move event (consumed in getCameraView). */

    private dragging: 'orbit' | 'pan' | null = null;
    private lastX = 0;
    private lastY = 0;

    private readonly onContext: (e: Event) => void;
    private readonly onPointerDown: (e: PointerEvent) => void;
    private readonly onPointerMove: (e: PointerEvent) => void;
    private readonly onPointerUp: (e: PointerEvent) => void;
    private readonly onWheel: (e: WheelEvent) => void;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.onContext = (e) => { e.preventDefault(); };
        this.onPointerDown = (e: PointerEvent) => this.handleDown(e);
        this.onPointerMove = (e: PointerEvent) => this.handleMove(e);
        this.onPointerUp = (e: PointerEvent) => this.handleUp(e);
        this.onWheel = (e: WheelEvent) => this.handleWheel(e);

        canvas.addEventListener('contextmenu', this.onContext);
        canvas.addEventListener('pointerdown', this.onPointerDown);
        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
    }

    /** Compute the current camera view (matrices written into pre-allocated
     *  arrays — caller must not retain the returned object across frames). */
    getCameraView(): CameraView {
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        // Right-handed orbit: eye sits behind target along (sy*cp, sp, cy*cp).
        const ex = this.targetX + this.distance * sy * cp;
        const ey = this.targetY + this.distance * sp;
        const ez = this.targetZ + this.distance * cy * cp;

        mat4LookAtInto([ex, ey, ez], [this.targetX, this.targetY, this.targetZ], [0, 1, 0], this.view);
        const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
        mat4PerspectiveInto((this.fov * Math.PI) / 180, aspect, this.near, this.far, this.proj);
        mat4MulInto(this.proj, this.view, this.vp);
        mat4InverseInto(this.vp, this.ivp);
        this.pos[0] = ex; this.pos[1] = ey; this.pos[2] = ez; this.pos[3] = 0;
        this.cameraView.aspect = aspect;
        return this.cameraView;
    }

    /** Frame the camera around the given world-space point at the given distance. */
    frameAround(x: number, y: number, z: number, distance: number): void {
        this.targetX = x; this.targetY = y; this.targetZ = z;
        this.distance = Math.max(0.1, distance);
        this.yaw = 0;
        this.pitch = 0.35;
    }

    private handleDown(e: PointerEvent): void {
        if (this.disposed) return;
        if (e.button === 2) {
            this.dragging = 'orbit';
            this.lastX = e.clientX; this.lastY = e.clientY;
            this.canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        } else if (e.button === 1) {
            this.dragging = 'pan';
            this.lastX = e.clientX; this.lastY = e.clientY;
            this.canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        }
    }

    private handleMove(e: PointerEvent): void {
        if (this.disposed || !this.dragging) return;
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX; this.lastY = e.clientY;

        if (this.dragging === 'orbit') {
            const rotateSpeed = 0.005;
            this.yaw -= dx * rotateSpeed;
            this.pitch -= dy * rotateSpeed;
            // Clamp pitch to avoid flipping.
            const limit = Math.PI / 2 - 0.05;
            this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
        } else if (this.dragging === 'pan') {
            const panSpeed = this.distance * 0.0015;
            // Pan in the camera's right/up directions.
            const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
            const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
            // right = (cy, 0, -sy) normalized in XZ plane
            const rx = cy, rz = -sy;
            // up (perpendicular to view dir in vertical plane): approximate (0,1,0) tilted
            // Simplified: pan horizontally along right, vertically along world-up tilted by pitch.
            this.targetX -= rx * dx * panSpeed;
            this.targetZ -= rz * dx * panSpeed;
            this.targetY += dy * panSpeed * cp;
            // forward/back pan along view dir (horizontal component only)
            const fwdX = sy * cp, fwdZ = cy * cp;
            this.targetX -= fwdZ * dy * panSpeed * sp;
            this.targetZ += fwdX * dy * panSpeed * sp;
        }
    }

    private handleUp(e: PointerEvent): void {
        if (this.disposed) return;
        if (this.dragging) {
            this.canvas.releasePointerCapture(e.pointerId);
            this.dragging = null;
        }
    }

    private handleWheel(e: WheelEvent): void {
        if (this.disposed) return;
        e.preventDefault();
        // Zoom: normalize wheel delta to a multiplicative factor.
        const factor = Math.exp(e.deltaY * 0.0015);
        this.distance = Math.max(0.1, Math.min(500, this.distance * factor));
    }

    dispose(): void {
        this.disposed = true;
        this.dragging = null;
        this.canvas.removeEventListener('contextmenu', this.onContext);
        this.canvas.removeEventListener('pointerdown', this.onPointerDown);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
        this.canvas.removeEventListener('wheel', this.onWheel);
    }
}
