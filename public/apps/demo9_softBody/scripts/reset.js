// Reset controls (escape-hatch: ScriptComponent scripts run in page realm,
// so window.engine / window.switchApp are reachable globals).
//   R       — lightweight PBD re-seed (destroys GPU buffers; next simulate
//             tick lazily rebuilds the cube from PbdSoftBodyComponent defaults)
//   Shift+R — full app reload (re-seeds scene + camera + plugins)
export function init() {
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'r' && e.key !== 'R') return;
        if (e.shiftKey) {
            window.switchApp('demo9_softBody');
            return;
        }
        const pbd = window.engine?.attachments?.get('pbd')?.obj;
        if (pbd?.clear) {
            pbd.clear();
            console.log('[demo9] PBD re-seeded');
        }
    });
}
