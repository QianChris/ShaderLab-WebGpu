import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
    plugins: [vue(), basicSsl()],
    server: { open: true, host: true },
    build: {
        rollupOptions: {
            // Multi-entry: the editor (index.html → main.ts) and the runtime
            // player (player.html → player.ts). Plus the secondary plugin API
            // entry emitted with a stable name so the PluginManager can rewrite
            // the bare '@shaderlab/api' specifier in runtime-loaded plugins to
            // a fixed URL. Rollup extracts modules shared across entries into
            // common chunks, so all entries see the same module instances
            // (engine singletons stay singletons).
            input: {
                main: 'index.html',
                player: 'player.html',
                api: 'src/api.ts',
            },
            // The api entry is dynamically imported at RUNTIME by plugin Blob
            // modules (PluginManager rewrites '@shaderlab/api' to
            // /assets/engine-api.js), so its exports are consumed OUTSIDE the
            // build graph. Vite hardcodes `preserveEntrySignatures: false` for
            // app builds (user config at rollupOptions top level overrides it;
            // output-level does NOT), which lets Rollup tree-shake AND rename
            // entry exports unused inside the graph — silently stripping
            // EnginePlugin/EVENT_TYPES/... from prod builds. Dev was unaffected
            // because plugins import /src/api.ts directly. Guarded by
            // scripts/check-api-exports.mjs.
            preserveEntrySignatures: (chunk) => (chunk.name === 'api' ? 'strict' : false),
            output: {
                entryFileNames: (chunk) => chunk.name === 'api'
                    ? 'assets/engine-api.js'
                    : 'assets/[name]-[hash].js',
            },
        },
    },
});
