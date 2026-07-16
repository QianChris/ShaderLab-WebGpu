// OrbitCameraController — RIGHT half of the screen (multi-view).
// Left drag: orbit (azimuth + elevation)
// Right drag: pan target
// Wheel: zoom distance
//
// Multi-view: this camera only responds to pointer input that lands in the
// right half of the canvas (NDC x >= 0). The left half drives the other camera.
// Mouse event payloads carry normalized x in [-1, 1] (see InputSystem).

let azimuth = 0;
let elevation = 0.25;
let distance = 5;
let targetX = 0, targetY = 0, targetZ = 0;

let prevX = 0, prevY = 0;
let dragButton = -1;

const ROT_SPEED = 3.0;
const PAN_SPEED = 1.5;
const ZOOM_SPEED = 0.15;
const MIN_DIST = 1.0;
const MAX_DIST = 50.0;
const MIN_EL = -Math.PI / 2 + 0.05;
const MAX_EL = Math.PI / 2 - 0.05;

function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

export function init(ctx) {
    const pos = ctx.getField('Transform', 'position');
    if (pos && pos.length >= 3) {
        const px = pos[0], py = pos[1], pz = pos[2];
        distance = Math.max(MIN_DIST, Math.hypot(px, py, pz));
        elevation = Math.asin(Math.max(-1, Math.min(1, py / distance)));
        azimuth = Math.atan2(px, pz);
    }

    ctx.on('mousedown', (e) => {
        if (e.x < 0) return; // only the right half
        dragButton = e.button;
        prevX = e.x;
        prevY = e.y;
    });

    ctx.on('mouseup', () => {
        dragButton = -1;
    });

    ctx.on('mousemove', (e) => {
        if (dragButton < 0) return;
        const dx = e.x - prevX;
        const dy = e.y - prevY;
        prevX = e.x;
        prevY = e.y;

        if (dragButton === 0) {
            azimuth -= dx * ROT_SPEED;
            elevation -= dy * ROT_SPEED;
            elevation = Math.max(MIN_EL, Math.min(MAX_EL, elevation));
        } else if (dragButton === 2) {
            const cel = Math.cos(elevation);
            const sel = Math.sin(elevation);
            const caz = Math.cos(azimuth);
            const saz = Math.sin(azimuth);
            const fwd = [-cel * saz, -sel, -cel * caz];
            const right = normalize(cross(fwd, [0, 1, 0]));
            const up = cross(right, fwd);
            const pan = distance * PAN_SPEED * 0.3;
            targetX += (right[0] * (-dx) + up[0] * (-dy)) * pan;
            targetY += (right[1] * (-dx) + up[1] * (-dy)) * pan;
            targetZ += (right[2] * (-dx) + up[2] * (-dy)) * pan;
        }
    });

    ctx.on('wheel', (e) => {
        if (e.x < 0) return; // only zoom this camera when the wheel is in the right half
        distance *= 1 + e.delta * ZOOM_SPEED;
        distance = Math.max(MIN_DIST, Math.min(MAX_DIST, distance));
    });
}

export function update(_ctx) {
    const cel = Math.cos(elevation);
    const sel = Math.sin(elevation);

    const cx = targetX + cel * Math.sin(azimuth) * distance;
    const cy = targetY + sel * distance;
    const cz = targetZ + cel * Math.cos(azimuth) * distance;

    const ha = azimuth * 0.5;
    const he = elevation * 0.5;
    const sa = Math.sin(ha), ca = Math.cos(ha);
    const se = Math.sin(he), ce = Math.cos(he);

    _ctx.setField('Transform', 'position', [cx, cy, cz]);
    _ctx.setField('Transform', 'rotation', [-ca * se, ce * sa, sa * se, ca * ce]);
}
