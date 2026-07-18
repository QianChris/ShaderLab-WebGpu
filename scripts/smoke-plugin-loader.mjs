// Node smoke test for the PluginManager loading chain: replicates
// fetch → sucrase type-strip → es-module-lexer import rewrite → module import
// against the REAL plugin sources in public/plugins/<id>/, with '@shaderlab/api'
// resolved to an in-memory stub. Catches transpile/rewrite regressions without
// a browser. Run: node scripts/smoke-plugin-loader.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'sucrase';
import { init as lexInit, parse } from 'es-module-lexer';

const ROOT = pathResolve(import.meta.dirname, '..');
const PLUGINS = join(ROOT, 'public', 'plugins');

// ── Stub '@shaderlab/api' with the pieces plugins touch at class-definition
//    time. Runtime ctx calls are exercised with a mock context below.
const API_STUB = `
export class EnginePlugin {}
`;
const apiStubUrl = 'data:text/javascript;base64,' + Buffer.from(API_STUB).toString('base64');

const loaded = new Map();

async function moduleFor(absPath, inFlight = new Set()) {
    if (loaded.has(absPath)) return loaded.get(absPath);
    if (inFlight.has(absPath)) throw new Error(`circular import at ${absPath}`);
    inFlight.add(absPath);

    let code = readFileSync(absPath, 'utf8');
    if (absPath.endsWith('.ts')) {
        code = transform(code, { transforms: ['typescript'], disableESTransforms: true }).code;
    }
    await lexInit;
    const [imports] = parse(code, absPath);
    for (let i = imports.length - 1; i >= 0; i--) {
        const imp = imports[i];
        if (imp.d === -2) continue;
        const raw = code.slice(imp.s, imp.e);
        const quoted = raw[0] === '"' || raw[0] === '\'';
        const spec = imp.n ?? (quoted ? raw.slice(1, -1) : undefined);
        if (spec === undefined) throw new Error(`${absPath}: non-literal dynamic import`);
        let target = null;
        if (spec === '@shaderlab/api') {
            target = apiStubUrl;
        } else if (spec.startsWith('./') || spec.startsWith('../')) {
            const child = pathResolve(dirname(absPath), spec);
            target = await moduleFor(child, inFlight);
        } else {
            throw new Error(`${absPath}: bare import '${spec}' not allowed in plugins`);
        }
        const replacement = quoted ? `'${target}'` : target;
        code = code.slice(0, imp.s) + replacement + code.slice(imp.e);
    }
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
    loaded.set(absPath, dataUrl);
    inFlight.delete(absPath);
    return dataUrl;
}

let failures = 0;
for (const id of readdirSync(PLUGINS)) {
    const entryTs = join(PLUGINS, id, 'index.ts');
    const entryJs = join(PLUGINS, id, 'index.js');
    const entry = existsSync(entryTs) ? entryTs : (existsSync(entryJs) ? entryJs : null);
    if (!entry) continue;   // not a plugin dir (e.g. tsconfig.json)
    try {
        const url = await moduleFor(entry);
        const mod = await import(url);
        if (typeof mod.default !== 'function') throw new Error('no default-exported class');
        const instance = new mod.default();
        if (!instance.meta || instance.meta.id !== id) {
            throw new Error(`meta.id '${instance.meta?.id}' !== folder '${id}'`);
        }
        // Exercise setup + one system update with a mock context.
        const registered = new Map();
        const writes = [];
        const mockCtx = {
            baseUrl: `/plugins/${id}`,
            registerSystem: (name, sys) => registered.set(name, sys),
            registerAttachment: () => {},
            registerRenderHook: () => {},
            registerPhaseBehavior: () => {},
            registerMeshGenerator: () => {},
            registerToolType: () => {},
            registerValueAtoms: () => {},
            getSystem: () => null,
            getPlugin: () => null,
        };
        await instance.init?.(mockCtx);
        await instance.setup?.(mockCtx);
        for (const [name, sys] of registered) {
            const sceneStub = {
                entityKeyMap: new Map([['E', 1]]),
                hasComponent: () => true,
                getField: () => 1,
                setField: () => {},
                getModelMatrix: () => new Float32Array(16),
            };
            sys.update?.({
                scene: sceneStub, time: 0.16, dt: 0.016, aspect: 1, cw: 800, ch: 600,
                attachments: {},
                getSystem: () => null,
                getBuffer: () => null,
                writeBuffer: (n, d) => writes.push([n, d.byteLength]),
                dispatchCompute: () => {},
            });
            console.log(`  [${id}] system '${name}' update OK (buffer writes: ${JSON.stringify(writes)})`);
        }
        console.log(`OK plugin '${id}' (${loaded.size} module file(s) transpiled+rewritten)`);
    } catch (err) {
        failures++;
        console.error(`FAIL plugin '${id}':`, err.message);
    }
}
if (failures > 0) { process.exitCode = 1; } else { console.log('smoke-plugin-loader: all plugins pass'); }
