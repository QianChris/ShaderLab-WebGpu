import { AppHost } from './host/AppHost';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const errorEl = document.getElementById('error')!;
const uiContainer = document.getElementById('ui-container')!;

/**
 * Runtime entry (player.html): engine + app UI only. No editor UI, no input
 * manager / tools, no undo — the AppHost dispatches commands directly to the
 * engine (unstacked) and no editor layer intercepts them.
 */
async function main(): Promise<void> {
    if (!navigator.gpu) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'WebGPU is not supported.\nUse Chrome 113+ or Edge 113+.';
        return;
    }

    try {
        const host = new AppHost(canvas, uiContainer);
        await host.init();

        const appName = new URLSearchParams(location.search).get('app') ?? host.engineConfig.defaultApp;
        await host.loadApp(appName);

        // ❌ No editor layer / input manager in player mode.
        // ✅ Load the App's custom UI only.
        await host.loadAppUI(`${host.engineConfig.appsRoot}/${appName}`);

        window.addEventListener('resize', () => host.resize());
        host.startLoop();

        (window as unknown as { host: unknown }).host = host;

        console.log('[ShaderLab] player mode initialized');
    } catch (err) {
        console.error(err);
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err}`;
    }
}

main();
