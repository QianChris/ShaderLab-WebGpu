import { AppHost } from './host/AppHost';
import { EditorUILayer } from './ui/layers/EditorUILayer';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const errorEl = document.getElementById('error')!;
const uiContainer = document.getElementById('ui-container')!;
const app = document.getElementById('app')!;

async function main(): Promise<void> {
    // Surface ALL errors on first load (including unhandled promise rejections
    // from fire-and-forget async mount() calls) so editor wiring failures are
    // visible in the console instead of silently leaving the UI half-built.
    window.addEventListener('error', (e) => {
        console.error('[ShaderLab] window.onerror:', e.message, '\n', e.error);
    });
    window.addEventListener('unhandledrejection', (e) => {
        console.error('[ShaderLab] unhandledrejection:', e.reason);
    });

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

        // Editor layer: toolbar, tab shell, command bus, input manager, panels.
        const editorLayer = new EditorUILayer();
        host.mountLayer(editorLayer, app);

        // Load the App's custom UI (ui-config.json).
        await host.loadAppUI(`${host.engineConfig.appsRoot}/${appName}`);

        window.addEventListener('resize', () => host.resize());
        host.startLoop();

        // Devtools back-compat: switchApp reloads app + refreshes the editor.
        (window as unknown as { switchApp: (name: string) => Promise<void> }).switchApp = (name: string) => editorLayer.switchApp(name);
        (window as unknown as { engine: unknown }).engine = host.engine;
        (window as unknown as { host: unknown }).host = host;

        console.log('[ShaderLab] editor mode initialized');
        console.log('[ShaderLab] scene:', JSON.stringify(host.engine.exportScene(), null, 2));
    } catch (err) {
        console.error(err);
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err}`;
    }
}

main();
