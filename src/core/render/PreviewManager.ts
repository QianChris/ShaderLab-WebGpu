import type { ResourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import type { MeshData, PbrMeshData } from './Primitives';

/** A preview result for a resource, shown in the asset panel's column 3. */
export interface PreviewResult {
    kind: 'image' | 'text' | 'none';
    /** data URL for image previews (canvas.toDataURL). */
    url?: string;
    /** text lines for text-based previews (shader source / pipeline config). */
    text?: string[];
}

/** Strategy per resource kind. Mesh → wireframe canvas; texture → GPU copy to
 *  canvas; shader/pipeline → text snippet. Results are LRU-cached so repeat
 *  selections don't re-render. */
type CacheKey = string;
const MAX_CACHE = 64;

export class PreviewManager {
    private cache = new Map<CacheKey, PreviewResult>();
    private device: GPUDevice;
    private rm: ResourceManager;

    constructor(device: GPUDevice, rm: ResourceManager) {
        this.device = device;
        this.rm = rm;
    }

    /** Clear the cache (e.g. on app switch so stale previews don't linger). */
    clear(): void {
        for (const v of this.cache.values()) {
            if (v.url?.startsWith('blob:')) URL.revokeObjectURL(v.url);
        }
        this.cache.clear();
    }

    async getPreview(kind: 'mesh' | 'texture' | 'shader' | 'pipeline', key: string): Promise<PreviewResult> {
        const cacheKey = `${kind}:${key}`;
        const hit = this.cache.get(cacheKey);
        if (hit) return hit;
        let result: PreviewResult;
        try {
            if (kind === 'mesh') result = this.meshPreview(key);
            else if (kind === 'texture') result = await this.texturePreview(key);
            else if (kind === 'shader') result = this.shaderPreview(key);
            else result = this.pipelinePreview(key);
        } catch {
            result = { kind: 'none', text: ['Preview failed'] };
        }
        this.put(cacheKey, result);
        return result;
    }

    private put(key: CacheKey, val: PreviewResult): void {
        if (this.cache.size >= MAX_CACHE) {
            // Evict oldest (Map preserves insertion order).
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                const old = this.cache.get(oldest);
                if (old?.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
                this.cache.delete(oldest);
            }
        }
        this.cache.set(key, val);
    }

    // ── Mesh: 2D wireframe projection on a 128×128 canvas ───────────

    private meshPreview(name: string): PreviewResult {
        const data = this.rm.getMeshData(name) ?? this.rm.getPbrMeshData(name);
        if (!data) return { kind: 'text', text: [`mesh: ${name}`, '(no CPU data — GPU-only mesh)'] };
        const url = this.drawWireframe(data);
        return { kind: 'image', url };
    }

    /** Simple orthographic wireframe: project positions onto xy (drop z),
     *  fit to the canvas with padding, draw triangle edges from the index
     *  buffer. Good enough to distinguish mesh shapes at a glance. */
    private drawWireframe(data: MeshData | PbrMeshData): string {
        const SIZE = 128;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#0d1b33';
        ctx.fillRect(0, 0, SIZE, SIZE);

        const pos = data.positions;
        if (!pos.length) return canvas.toDataURL();
        // Bounding box (xyz).
        let minx = Infinity, miny = Infinity, minz = Infinity;
        let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
            if (z < minz) minz = z; if (z > maxz) maxz = z;
        }
        const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
        const sx = (maxx - minx) || 1, sy = (maxy - miny) || 1;
        const scale = Math.min((SIZE - 16) / sx, (SIZE - 16) / sy);
        const toCanvasX = (x: number) => SIZE / 2 + (x - cx) * scale;
        const toCanvasY = (y: number) => SIZE / 2 - (y - cy) * scale;

        ctx.strokeStyle = '#4a8fc7';
        ctx.lineWidth = 1;
        const idx = data.indices;
        const drawn = new Set<number>();
        const edge = (a: number, b: number): void => {
            const k = a < b ? a * 100000 + b : b * 100000 + a;
            if (drawn.has(k)) return;
            drawn.add(k);
            const ax = toCanvasX(pos[a * 3]), ay = toCanvasY(pos[a * 3 + 1]);
            const bx = toCanvasX(pos[b * 3]), by = toCanvasY(pos[b * 3 + 1]);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
        };
        if (idx.length) {
            for (let i = 0; i < idx.length; i += 3) {
                const a = idx[i], b = idx[i + 1], c = idx[i + 2];
                edge(a, b); edge(b, c); edge(c, a);
            }
        } else {
            // No indices: draw points.
            ctx.fillStyle = '#4a8fc7';
            for (let i = 0; i < pos.length; i += 3) {
                ctx.fillRect(toCanvasX(pos[i]) - 1, toCanvasY(pos[i + 1]) - 1, 2, 2);
            }
        }
        return canvas.toDataURL();
    }

    // ── Texture: GPU copy to canvas ─────────────────────────────────

    private async texturePreview(key: string): Promise<PreviewResult> {
        const tex = this.rm.getTexture(key);
        if (!tex) return { kind: 'text', text: [`texture: ${key}`, '(not loaded)'] };
        const w = Math.min(tex.width, 128);
        const h = Math.min(tex.height, 128);
        const bytesPerRow = w * 4;
        const size = bytesPerRow * h;
        const staging = this.device.createBuffer({
            size: Math.max(size, 4),
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: tex, aspect: 'all' },
            { buffer: staging, bytesPerRow, rowsPerImage: h },
            { width: w, height: h },
        );
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const view = new Uint8Array(staging.getMappedRange(), 0, size);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(w, h);
        // copyExternalImageSubResourceToTexture gives BGRA on some platforms;
        // rgba8unorm gives RGBA. Normalize to RGBA for the canvas.
        img.data.set(view.subarray(0, size));
        ctx.putImageData(img, 0, 0);
        staging.unmap();
        staging.destroy();
        return { kind: 'image', url: canvas.toDataURL() };
    }

    // ── Shader: text snippet ───────────────────────────────────────

    private shaderPreview(key: string): PreviewResult {
        const src = PipelineLoader.getShaderKeySource(key);
        if (!src) return { kind: 'text', text: [`shader: ${key}`, '(source not cached)'] };
        const lines = src.split('\n').slice(0, 12);
        return { kind: 'text', text: lines };
    }

    // ── Pipeline: config labels ─────────────────────────────────────

    private pipelinePreview(name: string): PreviewResult {
        const cfg = PipelineLoader.getConfig(name);
        if (!cfg) return { kind: 'text', text: [`pipeline: ${name}`, '(not found)'] };
        return {
            kind: 'text',
            text: [
                `name: ${cfg.name ?? name}`,
                `vertex: ${cfg.vertex?.shader ?? '—'}`,
                `fragment: ${cfg.fragment ? cfg.fragment.shader : '—'}`,
                `bindLayout: ${(cfg.bindLayout ?? []).join(', ') || '—'}`,
            ],
        };
    }
}
