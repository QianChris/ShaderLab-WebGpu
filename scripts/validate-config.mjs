import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

const ROOT = join(pathResolve(import.meta.dirname, '..'), 'public');
const COMMON = join(ROOT, 'common');
const APPS = join(ROOT, 'apps');
const PLUGINS = join(ROOT, 'plugins');
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));

const problems = [];
const note = (msg) => problems.push(msg);

/** Plugin static analysis: existence + registerSystem('name')/components names
 *  + renderHook keys (regex-level — runtime fail-loud remains the authority). */
function pluginInfo(id) {
    const dir = join(PLUGINS, id);
    const entry = ['index.ts', 'index.js'].map(f => join(dir, f)).find(existsSync);
    if (!entry) return null;
    const sources = readdirSync(dir)
        .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
        .map(f => readFileSync(join(dir, f), 'utf8'))
        .join('\n');
    const systems = [...sources.matchAll(/registerSystem\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    const components = [...sources.matchAll(/name:\s*['"]([A-Za-z0-9_]+Component)['"]/g)].map(m => m[1]);
    const hooks = [...sources.matchAll(/['"]([A-Za-z0-9_]+\.[A-Za-z0-9_]+)['"]\s*:/g)].map(m => m[1]);
    return { systems, components, hooks };
}

// generators registered in Primitives.ts
const GENERATORS = ['triangle', 'cube', 'icosphere', 'uvsphere', 'pbrCube', 'pbrIcosphere', 'pbrUvSphere', 'pbrPlane'];

const commonComponents = J(join(PLUGINS, 'core', 'components.json')).map(c => c.name);
const phases = J(join(PLUGINS, 'core', 'phases.json'));
const phaseNames = new Set(phases.map(p => p.name));
const phaseBehavior = Object.fromEntries(phases.map(p => [p.name, p.behavior ?? 'normal']));
const vboNames = new Set(Object.keys(J(join(PLUGINS, 'core', 'vbo-presets.json'))));
const fallbackNames = new Set(Object.keys(J(join(PLUGINS, 'core', 'fallback-textures.json'))));
const engineConfig = J(join(COMMON, 'engine-config.json'));
const scriptsSubdir = engineConfig.renderScriptsSubdir ?? 'scripts';

// meshes.json generators
for (const m of J(join(PLUGINS, 'core', 'meshes.json'))) {
    if (!GENERATORS.includes(m.generator)) note(`common/meshes.json '${m.name}': unknown generator '${m.generator}'`);
}

// pipeline helper: resolve '<plugin>:rest', app-relative, or absolute refs
function loadPipeline(appDir, rel) {
    const m = /^([A-Za-z0-9_-]+):(?!\/)(.+)$/.exec(rel);
    if (m) {
        const p = join(PLUGINS, m[1], m[2]);
        return existsSync(p) ? { path: p, cfg: J(p) } : null;
    }
    const p1 = rel.startsWith('/') ? join(ROOT, rel) : null;
    if (p1 && existsSync(p1)) return { path: p1, cfg: J(p1) };
    const p2 = appDir ? join(appDir, rel) : null;
    if (p2 && existsSync(p2)) return { path: p2, cfg: J(p2) };
    return null;
}

function checkPipeline(appName, appComponents, rel, cfgEntry) {
    if (!cfgEntry) { note(`${appName}: pipeline '${rel}' not found (plugin/app/absolute)`); return; }
    const { cfg } = cfgEntry;
    const decl = cfg.renderer;
    if (!decl) return;
    const allComps = new Set([...commonComponents, ...appComponents]);
    for (const q of decl.query ?? []) {
        if (!allComps.has(q)) note(`${appName}/${rel}: query component '${q}' not registered`);
    }
    const phase = decl.phase;
    if (phase && !phaseNames.has(phase)) note(`${appName}/${rel}: unknown phase '${phase}'`);
    // group-0 rule (only matters for pipelines recorded by PipelineDriver = non-postprocess phases)
    const bl = cfg.bindLayout ?? [];
    const recorded = phase && phaseBehavior[phase] !== 'postprocess-chain';
    if (recorded && bl.length > 0 && bl[0] !== 'frame' && bl[0] !== 'frameShadow') {
        const covers0 = (decl.bindGroups ?? []).some(bg => bg.group === 0);
        if (!covers0) note(`${appName}/${rel}: bindLayout[0]='${bl[0]}' not frame/frameShadow and no group-0 bindGroups (would throw)`);
    }
    // vbo refs
    for (const step of decl.geometry?.steps ?? []) {
        for (const vb of step.vertexBuffers ?? []) {
            if (vb.source === 'vbo' && !vboNames.has(vb.vbo ?? 'quad')) {
                note(`${appName}/${rel}: vbo '${vb.vbo ?? 'quad'}' not in vbo-presets.json`);
            }
        }
    }
    // texture fallbacks
    for (const bg of decl.bindGroups ?? []) {
        for (const t of bg.textures ?? []) {
            if (t.fallback && !fallbackNames.has(t.fallback)) {
                note(`${appName}/${rel}: texture fallback '${t.fallback}' not in fallback-textures.json`);
            }
        }
        // uniform writes value sources: check script:/atom namespaces roughly
        for (const w of bg.uniform?.writes ?? []) {
            checkValueSource(appName, rel, w.value, allComps);
        }
    }
    if (decl.geometry?.hook) hookRefs.push({ appName, rel, hook: decl.geometry.hook });
    if (decl.compute?.script) hookRefs.push({ appName, rel, hook: decl.compute.script });
}

const NS = { builtin: ['entityId','time','dt','aspect','screenW','screenH'], transform: ['model','normalMatrix'], tag: ['color','extra'] };
function checkValueSource(appName, rel, src, allComps) {
    if (typeof src !== 'string') return;
    const colon = src.indexOf(':');
    const prefix = colon >= 0 ? src.slice(0, colon) : '';
    if (prefix === 'const') return;
    if (prefix === 'script') { scriptValueRefs.push({ appName, rel, name: src.slice(colon+1) }); return; }
    const atoms = prefix === 'pack' ? src.slice(colon+1).split(',').map(s => s.trim()) : [src];
    for (const a of atoms) {
        if (a === '' || !Number.isNaN(Number(a))) continue;
        const dot = a.indexOf('.');
        if (dot < 0) { note(`${appName}/${rel}: unresolvable atom '${a}' in '${src}'`); continue; }
        const head = a.slice(0, dot), field = a.slice(dot+1);
        if (NS[head]) {
            if (!NS[head].includes(field)) note(`${appName}/${rel}: unknown ${head}.* atom '${a}'`);
        } else if (!allComps.has(head)) {
            note(`${appName}/${rel}: value source '${a}' references unknown component '${head}'`);
        }
    }
}

const hookRefs = [];
const scriptValueRefs = [];

// per-app checks
const engineConfigFull = J(join(COMMON, 'engine-config.json'));
const enginePlugins = engineConfigFull.plugins ?? [];
for (const id of enginePlugins) {
    if (!pluginInfo(id)) note(`engine-config.json: plugin '${id}' missing under public/plugins/`);
}
for (const app of readdirSync(APPS)) {
    const dir = join(APPS, app);
    const manifest = J(join(dir, 'app.json'));
    const appComponents = [];
    const pluginSystems = [];
    for (const rel of manifest.components ?? []) {
        const p = rel.startsWith('/') ? join(ROOT, rel) : join(dir, rel);
        if (!existsSync(p)) { note(`${app}: components file '${rel}' missing`); continue; }
        for (const c of J(p)) appComponents.push(c.name);
    }
    // Plugins contribute components + systems (static regex scan of their sources).
    for (const id of [...enginePlugins, ...(manifest.plugins ?? [])]) {
        const info = pluginInfo(id);
        if (!info) { note(`${app}: plugin '${id}' missing under public/plugins/ (WILL THROW)`); continue; }
        appComponents.push(...info.components);
        pluginSystems.push(...info.systems);
    }
    const allComps = new Set([...commonComponents, ...appComponents]);

    // scene.json component names
    const scenePath = join(dir, manifest.scene ?? 'scene.json');
    if (!existsSync(scenePath)) { note(`${app}: scene.json missing`); continue; }
    const scene = J(scenePath);
    for (const [key, entity] of Object.entries(scene)) {
        for (const comp of Object.keys(entity)) {
            if (!allComps.has(comp)) note(`${app}/scene.json entity '${key}': unknown component '${comp}' (WILL THROW)`);
        }
    }

    // render.json
    const renderPath = join(dir, manifest.render ?? 'render.json');
    const render = J(renderPath);
    for (const key of Object.keys(render.phases ?? {})) {
        if (!phaseNames.has(key)) note(`${app}/render.json: unknown phase key '${key}' (WILL THROW)`);
    }
    for (const file of render.renderScripts ?? []) {
        const p = join(COMMON, scriptsSubdir, file);
        if (!existsSync(p)) note(`${app}/render.json: renderScript '${file}' missing at ${p} (WILL THROW)`);
    }
    // pipelines referenced
    for (const [phaseKey, entries] of Object.entries(render.phases ?? {})) {
        for (const e of entries) {
            checkPipeline(app, appComponents, e.pipeline, loadPipeline(dir, e.pipeline));
        }
    }

    // tools
    if (manifest.tools) {
        const tp = join(dir, manifest.tools);
        if (!existsSync(tp)) note(`${app}: tools file '${manifest.tools}' missing (WILL THROW)`);
        else {
            for (const t of J(tp)) {
                if (t.enabled === false) continue;
                if (!t.source && !t.type) note(`${app}/tools.json: entry lacks type and source (WILL THROW)`);
                if (t.type && t.type !== 'pick') note(`${app}/tools.json: unknown type '${t.type}' (WILL THROW)`);
                if (t.source) {
                    const sp = t.source.startsWith('/') ? join(ROOT, t.source) : join(dir, t.source);
                    if (!existsSync(sp)) note(`${app}/tools.json: script '${t.source}' missing (WILL THROW)`);
                }
            }
        }
    }

    // systems.json + defs
    const sysPath = join(dir, manifest.systems ?? 'systems.json');
    const BUILTINS = ['input','script','physics','camera','light','animation','render','gaussianSplat', ...pluginSystems];
    if (existsSync(sysPath)) {
        for (const s of J(sysPath)) {
            const defRel = s.def ?? `systems/${s.name}.json`;
            const defCommon = join(COMMON, defRel);
            const defApp = join(dir, defRel);
            const defPath = existsSync(defCommon) ? defCommon : (existsSync(defApp) ? defApp : null);
            if (!defPath) {
                if (!BUILTINS.includes(s.name)) note(`${app}/systems.json: system '${s.name}' has no def and is not a builtin (WILL THROW)`);
                continue;
            }
            const def = J(defPath);
            if (def.source && !def.source.startsWith('builtin:')) {
                const sp = def.source.startsWith('/') ? join(ROOT, def.source) : join(dir, def.source);
                if (!existsSync(sp)) note(`${app}: system '${s.name}' script '${def.source}' missing (WILL THROW)`);
            } else if (def.source?.startsWith('builtin:')) {
                const id = def.source.slice(8);
                if (!BUILTINS.includes(id)) note(`${app}: system '${s.name}' builtin id '${id}' unknown (WILL THROW)`);
            }
        }
    }

    // gltf: mapping exists in common, so only check files exist
    for (const g of manifest.gltf ?? []) {
        const gp = g.startsWith('/') ? join(ROOT, g) : join(dir, g);
        if (!existsSync(gp)) note(`${app}: gltf '${g}' missing`);
    }
}

// common systems.json: defs are plugin-provided now; only explicit def paths must exist
for (const s of J(join(COMMON, 'systems.json'))) {
    if (s.def && !existsSync(join(COMMON, s.def))) {
        note(`common/systems.json: explicit def '${s.def}' missing for '${s.name}'`);
    }
}

// hook/script value refs: hooks are plugin-registered (renderHooks) or come
// from legacy app renderScripts. Build per-app availability sets.
const scriptFileCache = new Map();
function scriptExports(file) {
    if (scriptFileCache.has(file)) return scriptFileCache.get(file);
    const p = join(COMMON, scriptsSubdir, file);
    if (!existsSync(p)) { scriptFileCache.set(file, null); return null; }
    const src = readFileSync(p, 'utf8');
    const names = [...src.matchAll(/export\s+(?:function|const|let)\s+([A-Za-z0-9_]+)/g)].map(m => m[1]);
    scriptFileCache.set(file, names);
    return names;
}
const appHookSets = new Map();
for (const app of readdirSync(APPS)) {
    const manifest = J(join(APPS, app, 'app.json'));
    const render = J(join(APPS, app, manifest.render ?? 'render.json'));
    const hooks = new Set();
    for (const id of [...enginePlugins, ...(manifest.plugins ?? [])]) {
        for (const h of pluginInfo(id)?.hooks ?? []) hooks.add(h);
    }
    for (const f of render.renderScripts ?? []) {
        const base = f.replace(/^[^/]+\//, '').replace(/\.js$/, '');
        for (const fn of scriptExports(f) ?? []) hooks.add(`${base}.${fn}`);
    }
    appHookSets.set(app, hooks);
}
for (const { appName, rel, hook } of hookRefs) {
    if (!appHookSets.get(appName)?.has(hook)) {
        note(`${appName}/${rel}: hook '${hook}' not provided by any loaded plugin or renderScript (WILL THROW at frame)`);
    }
}
for (const { appName, rel, name } of scriptValueRefs) {
    if (!appHookSets.get(appName)?.has(name)) {
        note(`${appName}/${rel}: value script '${name}' not provided by any loaded plugin or renderScript (WILL THROW at frame)`);
    }
}

if (problems.length === 0) {
    console.log('OK: no config relies on removed silent-fail behavior');
} else {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log('  - ' + p);
}
