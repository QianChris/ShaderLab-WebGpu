/**
 * Minimal GPU mock for testing engine mechanisms without a real GPU.
 * Records all pass calls so tests can assert draw order, bind group
 * changes, and instancing behavior.
 */

export interface MockCall {
    fn: string;
    args: unknown[];
}

export class MockRenderPassEncoder {
    calls: MockCall[] = [];
    ended = false;

    setPipeline(p: unknown): void { this.calls.push({ fn: 'setPipeline', args: [p] }); }
    setBindGroup(group: number, bg: unknown, dynamicOffsets?: number[]): void {
        this.calls.push({ fn: 'setBindGroup', args: [group, bg, dynamicOffsets] });
    }
    setVertexBuffer(slot: number, buf: unknown): void { this.calls.push({ fn: 'setVertexBuffer', args: [slot, buf] }); }
    setIndexBuffer(buf: unknown, format: unknown): void { this.calls.push({ fn: 'setIndexBuffer', args: [buf, format] }); }
    setViewport(x: number, y: number, w: number, h: number, minDepth: number, maxDepth: number): void {
        this.calls.push({ fn: 'setViewport', args: [x, y, w, h, minDepth, maxDepth] });
    }
    setScissorRect(x: number, y: number, w: number, h: number): void {
        this.calls.push({ fn: 'setScissorRect', args: [x, y, w, h] });
    }
    draw(vCount: number, iCount?: number): void { this.calls.push({ fn: 'draw', args: [vCount, iCount] }); }
    drawIndexed(count: number, instanceCount?: number): void {
        this.calls.push({ fn: 'drawIndexed', args: [count, instanceCount] });
    }
    end(): void { this.ended = true; }

    /** Count calls of a given fn name. */
    count(fn: string): number {
        return this.calls.filter(c => c.fn === fn).length;
    }
    /** Get all calls of a given fn name. */
    filter(fn: string): MockCall[] {
        return this.calls.filter(c => c.fn === fn);
    }
}

export class MockComputePassEncoder {
    calls: MockCall[] = [];
    ended = false;
    setPipeline(p: unknown): void { this.calls.push({ fn: 'setPipeline', args: [p] }); }
    setBindGroup(group: number, bg: unknown): void { this.calls.push({ fn: 'setBindGroup', args: [group, bg] }); }
    dispatchWorkgroups(x: number, y?: number, z?: number): void {
        this.calls.push({ fn: 'dispatchWorkgroups', args: [x, y, z] });
    }
    end(): void { this.ended = true; }
}

export class MockCommandEncoder {
    renderPasses: MockRenderPassEncoder[] = [];
    computePasses: MockComputePassEncoder[] = [];
    copies: Array<{ srcOff: number; dstOff: number; size: number }> = [];
    finished = false;

    beginRenderPass(_desc: unknown): MockRenderPassEncoder {
        const pass = new MockRenderPassEncoder();
        this.renderPasses.push(pass);
        return pass;
    }
    beginComputePass(): MockComputePassEncoder {
        const pass = new MockComputePassEncoder();
        this.computePasses.push(pass);
        return pass;
    }
    copyBufferToBuffer(_src: unknown, srcOff: number, _dst: unknown, dstOff: number, size: number): void {
        this.copies.push({ srcOff, dstOff, size });
    }
    finish(): unknown { this.finished = true; return {}; }
}

export interface MockBuffer {
    size: number;
    usage: number;
    destroyed: boolean;
    destroy(): void;
}

export interface MockTexture {
    width: number;
    height: number;
    format: string;
    destroyed: boolean;
    views: number;
    createView(): { texture: MockTexture };
    destroy(): void;
}

export function createMockBuffer(size: number, usage: number): MockBuffer {
    return { size, usage, destroyed: false, destroy() { this.destroyed = true; } };
}

export function createMockTexture(w: number, h: number, format: string): MockTexture {
    const tex: MockTexture = {
        width: w, height: h, format, destroyed: false, views: 0,
        createView() { tex.views++; return { texture: tex }; },
        destroy() { tex.destroyed = true; },
    };
    return tex;
}

export function createMockDevice(): GPUDevice {
    const buffers: MockBuffer[] = [];
    const textures: MockTexture[] = [];
    const submitted: MockCommandEncoder[] = [];

    const device = {
        createBuffer: (config: { size?: number; usage?: number } = {}) => {
            const buf = createMockBuffer(config.size ?? 0, config.usage ?? 0);
            buffers.push(buf);
            return buf;
        },
        createTexture: (config: { size?: { width: number; height: number }; format?: string } = {}) => {
            const tex = createMockTexture(
                config.size?.width ?? 1,
                config.size?.height ?? 1,
                String(config.format ?? 'rgba8unorm'),
            );
            textures.push(tex);
            return tex;
        },
        createBindGroup: () => ({}),
        createBindGroupLayout: () => ({}),
        createSampler: () => ({}),
        createPipelineLayout: () => ({}),
        createShaderModule: () => ({}),
        createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
        createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
        createCommandEncoder: () => {
            const enc = new MockCommandEncoder();
            return enc;
        },
        queue: {
            submit: (cmds: unknown[]) => {
                for (const c of cmds) {
                    submitted.push(c as MockCommandEncoder);
                }
            },
            writeBuffer: () => {},
            copyExternalImageToTexture: () => {},
        },
        // Accessors for test assertions
        _buffers: buffers,
        _textures: textures,
        _submitted: submitted,
    };
    return device as unknown as GPUDevice;
}
