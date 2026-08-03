import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    server: { open: true },
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
            output: {
                entryFileNames: (chunk) => chunk.name === 'api'
                    ? 'assets/engine-api.js'
                    : 'assets/[name]-[hash].js',
            },
        },
    },
});
