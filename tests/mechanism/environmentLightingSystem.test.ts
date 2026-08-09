import { describe, expect, it } from 'vitest';
import {
    EnvironmentLightingSystem,
} from '../../public/plugins/environment-lighting/EnvironmentLightingSystem.ts';

describe('EnvironmentLightingSystem fail-loud handoff', () => {
    it('throws an asynchronous activation failure on the next update', () => {
        const system = new EnvironmentLightingSystem(() => {});
        const error = new Error('environment source missing');

        system.fail(error);

        expect(() => system.update({} as never)).toThrow(error);
        expect(() => system.update({} as never)).not.toThrow();
    });

    it('discards stale failures when the app unloads', () => {
        const system = new EnvironmentLightingSystem(() => {});
        system.fail(new Error('stale environment failure'));

        system.clear();

        expect(() => system.update({} as never)).not.toThrow();
    });
});
