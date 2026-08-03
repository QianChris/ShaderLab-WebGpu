import { inject } from 'vue';
import type { AppHost } from '../../../host/AppHost';

export const HOST_KEY: unique symbol = Symbol('host');

export function useHost(): AppHost {
    const host = inject<AppHost>(HOST_KEY);
    if (!host) throw new Error('useHost() must be called inside a Vue editor panel');
    return host;
}
