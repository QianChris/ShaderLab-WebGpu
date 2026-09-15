#!/usr/bin/env node
/**
 * Verifies that every name imported from '@shaderlab/api' by runtime-loaded
 * plugin code is actually exported by the built `dist/assets/engine-api.js`.
 *
 * Why this exists: plugins live outside the build graph. Rollup's default
 * tree-shaking drops entry exports that nothing inside the graph uses, so an
 * export that only plugins import (e.g. EVENT_TYPES) silently vanishes from
 * the prod bundle — dev works fine (plugins import /src/api.ts), and only the
 * deployed player breaks. This check fails loud before that ships.
 *
 * Run after `npm run build` (requires dist/assets/engine-api.js).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'dist', 'assets', 'engine-api.js');
const pluginsDir = join(root, 'public', 'plugins');

const fail = (msg) => { throw new Error(`[check-api-exports] ${msg}`); };

// Same minimal WebGPU constant polyfill as tests/setup.ts — the api module
// graph references these at module scope.
const polyfills = {
    GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 8, STORAGE_BINDING: 16, RENDER_ATTACHMENT: 32 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
};
for (const [name, value] of Object.entries(polyfills)) {
    if (!(name in globalThis)) globalThis[name] = value;
}

if (!existsSync(bundlePath)) fail('dist/assets/engine-api.js not found — run `npm run build` first');

// ---- parse src/api.ts into value exports vs type exports (it is written
// exclusively as `export { X } from '...'` / `export type { X } from '...'`,
// no `export *`, no inline declarations — see the file header).
const apiSrc = readFileSync(join(root, 'src', 'api.ts'), 'utf8');
const valueExports = new Set();
const typeExports = new Set();
for (const m of apiSrc.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (let spec of m[1].split(',')) {
        spec = spec.trim();
        if (!spec) continue;
        const name = spec.includes(' as ') ? spec.split(/\s+as\s+/).pop().trim() : spec;
        valueExports.add(name);
    }
}
for (const m of apiSrc.matchAll(/^export\s+type\s+\{([^}]*)\}/gm)) {
    for (let spec of m[1].split(',')) {
        spec = spec.trim();
        if (spec) typeExports.add(spec);
    }
}
if (valueExports.size === 0) fail('failed to parse any value exports from src/api.ts — parser broken or api.ts shape changed');

// ---- collect plugin-side imports (value imports only; `type` specifiers are erased)
const importedNames = new Map(); // name -> [files]
function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|js)$/.test(entry.name)) continue;
        const src = readFileSync(p, 'utf8');
        const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@shaderlab\/api['"]/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            for (let spec of m[1].split(',')) {
                spec = spec.trim();
                if (!spec || spec.startsWith('type ')) continue;
                const imported = spec.split(/\s+as\s+/)[0].trim();
                if (!imported) continue;
                if (!importedNames.has(imported)) importedNames.set(imported, []);
                importedNames.get(imported).push(p);
            }
        }
    }
}
walk(pluginsDir);
if (importedNames.size === 0) fail('no @shaderlab/api imports found under public/plugins — scan is broken');

// ---- load the built bundle and check value exports
const mod = await import(pathToFileURL(bundlePath).href);
const exported = new Set(Object.keys(mod));

const unknown = [...importedNames.keys()].filter((n) => !valueExports.has(n) && !typeExports.has(n));
if (unknown.length > 0) {
    fail(`names imported by plugins that api.ts does not export at all:\n  ${unknown.join(', ')}`);
}

const missing = [...importedNames.entries()]
    .filter(([name]) => valueExports.has(name) && !exported.has(name))
    .map(([name, files]) => `  ${name}  (imported by ${files.map((f) => f.split('plugins')[1]).join(', ')})`);

const checkedCount = [...importedNames.keys()].filter((n) => valueExports.has(n)).length;
console.log(`[check-api-exports] ${checkedCount} value imports to verify, bundle exports ${exported.size}`);
if (missing.length > 0) {
    fail(`missing from dist/assets/engine-api.js:\n${missing.join('\n')}`);
}
console.log('[check-api-exports] OK — all plugin-visible api exports present in prod bundle');
