import { Engine } from './Engine';
import { EditorPanel } from './editor/EditorPanel';
import { PipelinePanel } from './editor/PipelinePanel';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const errorEl = document.getElementById('error')!;
const editorEl = document.getElementById('editor')!;
const pipelineEl = document.getElementById('pipeline-panel')!;

function setupTabs(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    for (const btn of buttons) {
        btn.onclick = () => {
            const tab = btn.dataset.tab;
            for (const b of buttons) b.classList.toggle('active', b === btn);
            document.getElementById('tab-scene')!.style.display = tab === 'scene' ? 'flex' : 'none';
            document.getElementById('tab-pipeline')!.style.display = tab === 'pipeline' ? 'flex' : 'none';
        };
    }
}

async function main(): Promise<void> {
    if (!navigator.gpu) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'WebGPU is not supported.\nUse Chrome 113+ or Edge 113+.';
        return;
    }

    try {
        const engine = new Engine(canvas);
        await engine.init();

        const app = new URLSearchParams(location.search).get('app') ?? engine.engineConfig.defaultApp;
        await engine.loadApp(app);

        window.addEventListener('resize', () => engine.resize());

        const editor = new EditorPanel(editorEl);
        editor.attach(engine);
        editor.render();

        const pipelinePanel = new PipelinePanel(pipelineEl);
        pipelinePanel.attach(engine);
        pipelinePanel.render();

        setupTabs();

        engine.startLoop();

        // Unified app-switch refresh: both switchApp() (devtools) and the
        // editor's Load-JSON-of-app.json button go through this path so the
        // scene editor and pipeline panel both rebuild after a full loadApp.
        const refreshPanels = (): void => {
            editor.render();
            pipelinePanel.render();
        };
        const switchToApp = async (name: string): Promise<void> => {
            try {
                await engine.loadApp(name);
                refreshPanels();
                console.log(`[ShaderLab] switched to app '${name}'`);
            } catch (err) {
                console.error(err);
                errorEl.style.display = 'block';
                errorEl.textContent = `Error: ${err}`;
            }
        };
        editor.onAppSwitch = switchToApp;
        (window as unknown as { switchApp: (name: string) => Promise<void> }).switchApp = switchToApp;

        console.log('[ShaderLab] initialized');
        console.log('[ShaderLab] scene:', JSON.stringify(engine.exportScene(), null, 2));
    } catch (err) {
        console.error(err);
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err}`;
    }
}

main();
