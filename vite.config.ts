import { defineConfig } from 'vite';

export default defineConfig({
    server: { open: true },
    build: {
        rollupOptions: {
            // Secondary entry: the plugin API surface. Emitted with a stable
            // (un-hashed) name so the PluginManager can rewrite the bare
            // '@shaderlab/api' specifier in runtime-loaded plugins to a fixed
            // URL. Rollup extracts modules shared with the main entry into
            // common chunks, so both entries see the same module instances
            // (engine singletons stay singletons).
            input: {
                main: 'index.html',
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
