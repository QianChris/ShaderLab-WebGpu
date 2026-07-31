import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { systemRegistry, type System, type FrameContext, type SystemEntry } from '../../src/ecs/SystemRegistry';

class StubSystem implements System {
    update(_ctx: FrameContext): void {}
}

afterEach(() => {
    systemRegistry.removeSystemsByOwner('test');
    systemRegistry.removeDefsByOwner('test');
});

describe('SystemRegistry.autoInsert', () => {
    it('system with after: ["input"] → inserted after input', () => {
        const base: SystemEntry[] = [
            { name: 'input' },
            { name: 'camera' },
            { name: 'render' },
        ];
        systemRegistry.addDef({ name: 'myfx', source: 'builtin:myfx', after: ['input'] }, 'test');
        const result = systemRegistry.autoInsert(base);
        const idx = result.findIndex(s => s.name === 'myfx');
        const inputIdx = result.findIndex(s => s.name === 'input');
        expect(idx).toBeGreaterThan(inputIdx);
        expect(result.length).toBe(4);
    });

    it('system with before: ["render"] → inserted before render', () => {
        const base: SystemEntry[] = [
            { name: 'input' },
            { name: 'camera' },
            { name: 'render' },
        ];
        systemRegistry.addDef({ name: 'prerender', source: 'builtin:prerender', before: ['render'] }, 'test');
        const result = systemRegistry.autoInsert(base);
        const idx = result.findIndex(s => s.name === 'prerender');
        const renderIdx = result.findIndex(s => s.name === 'render');
        expect(idx).toBeLessThan(renderIdx);
    });

    it('system without after/before → not inserted', () => {
        const base: SystemEntry[] = [{ name: 'input' }];
        systemRegistry.addDef({ name: 'orphan', source: 'builtin:orphan' }, 'test');
        const result = systemRegistry.autoInsert(base);
        expect(result.find(s => s.name === 'orphan')).toBeUndefined();
    });

    it('multiple systems: both inserted between input and render', () => {
        const base: SystemEntry[] = [{ name: 'input' }, { name: 'render' }];
        systemRegistry.addDef({ name: 'a', source: 'builtin:a', after: ['input'], before: ['render'] }, 'test');
        systemRegistry.addDef({ name: 'b', source: 'builtin:b', after: ['input'], before: ['render'] }, 'test');
        const result = systemRegistry.autoInsert(base);
        const aIdx = result.findIndex(s => s.name === 'a');
        const bIdx = result.findIndex(s => s.name === 'b');
        const inputIdx = result.findIndex(s => s.name === 'input');
        const renderIdx = result.findIndex(s => s.name === 'render');
        // Both should be between input and render
        expect(aIdx).toBeGreaterThan(inputIdx);
        expect(aIdx).toBeLessThan(renderIdx);
        expect(bIdx).toBeGreaterThan(inputIdx);
        expect(bIdx).toBeLessThan(renderIdx);
    });

    it('after pointing to non-existent system → inserted at position 0', () => {
        const base: SystemEntry[] = [{ name: 'input' }];
        systemRegistry.addDef({ name: 'x', source: 'builtin:x', after: ['nonexistent'] }, 'test');
        const result = systemRegistry.autoInsert(base);
        // afterIdx = -1 → insertAt = max(0, min(0, 1)) = 0
        expect(result[0].name).toBe('x');
        expect(result[1].name).toBe('input');
    });
});

describe('SystemRegistry.registerBuiltin', () => {
    it('registered system resolves', () => {
        const sys = new StubSystem();
        systemRegistry.registerBuiltin('testsys', sys, 'test');
        expect(systemRegistry.resolve({ name: 'testsys' })).toBe(sys);
    });

    it('cross-owner duplicate → throws', () => {
        systemRegistry.registerBuiltin('shared', new StubSystem(), 'test');
        expect(() => systemRegistry.registerBuiltin('shared', new StubSystem(), 'other')).toThrow();
    });

    it('same-owner duplicate → no throw (re-registration allowed)', () => {
        systemRegistry.registerBuiltin('reload', new StubSystem(), 'test');
        expect(() => systemRegistry.registerBuiltin('reload', new StubSystem(), 'test')).not.toThrow();
    });

    it('unregistered system → null', () => {
        expect(systemRegistry.resolve({ name: 'nonsys' })).toBeNull();
    });
});

describe('SystemRegistry.addDef', () => {
    it('cross-owner duplicate → throws', () => {
        systemRegistry.addDef({ name: 'dup', source: 'builtin:dup' }, 'test');
        expect(() => systemRegistry.addDef({ name: 'dup', source: 'builtin:dup' }, 'other')).toThrow();
    });

    it('removeDefsByOwner → only removes that owner', () => {
        systemRegistry.addDef({ name: 'mine', source: 'builtin:mine' }, 'test');
        systemRegistry.addDef({ name: 'yours', source: 'builtin:yours' }, 'other');
        systemRegistry.removeDefsByOwner('test');
        expect(systemRegistry.getDef('mine')).toBeUndefined();
        expect(systemRegistry.getDef('yours')).toBeDefined();
    });
});
