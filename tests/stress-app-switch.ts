/**
 * Stress test: rapidly switch between all 8 demos for 10 rounds (80 load/unload
 * cycles) and check for resource leaks.
 *
 * Usage (browser console after `npm run dev`):
 *   const { runStressTest } = await import('/tests/stress-app-switch.ts');
 *   const results = await runStressTest(window.engine);
 *   console.log(results);
 *
 * Leak detection: round 0 is a warm-up (different demos create different
 * common-scoped resources during render graph compilation). The baseline is
 * the MAX post-unload count across all round-0 unloads. Rounds 1+ are checked
 * for growth beyond that baseline. A real leak shows counts growing each round.
 *
 * Acceptance: 0 failures, 0 leaks (growth), no console errors.
 */
export interface StressTestResults {
    passes: number;
    fails: number;
    leaks: string[];
    errors: string[];
    baseline: Record<string, number> | null;
}

export async function runStressTest(
    engine: { loadApp(name: string): Promise<void>; unloadCurrentApp(): void; getResourceStats?(): Record<string, number> },
    rounds = 10,
): Promise<StressTestResults> {
    const demos = [
        'demo1',
        'demo2',
        'demo3_shadow',
        'demo4_spriteSheet',
        'demo5_deferred',
        'demo6_3dgsViewer',
        'demo7_multiView',
        'demo8_customSystem',
    ];
    const results: StressTestResults = { passes: 0, fails: 0, leaks: [], errors: [], baseline: null };
    const baseline: Record<string, number> = {};

    for (let round = 0; round < rounds; round++) {
        for (const demo of demos) {
            try {
                await engine.loadApp(demo);
                await new Promise<void>(r => requestAnimationFrame(() => r()));

                engine.unloadCurrentApp();

                const postUnload = engine.getResourceStats?.();
                if (postUnload) {
                    if (round === 0) {
                        for (const key of Object.keys(postUnload)) {
                            baseline[key] = Math.max(baseline[key] ?? 0, postUnload[key]);
                        }
                    } else {
                        for (const key of Object.keys(postUnload)) {
                            const after = postUnload[key];
                            const base = baseline[key] ?? 0;
                            if (after > base) {
                                results.leaks.push(`${demo} round ${round}: ${key}=${after} (baseline=${base}, +${after - base})`);
                            }
                        }
                    }
                }

                results.passes++;
            } catch (e) {
                results.fails++;
                results.errors.push(`${demo} round ${round}: ${(e as Error).message ?? e}`);
            }
        }
    }

    results.baseline = baseline;
    return results;
}
