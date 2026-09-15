#!/usr/bin/env node
/**
 * Post-process the vite build output (`dist/`) into a deployable GitHub Pages
 * site (root-path hosting, e.g. <user>.github.io or a custom domain):
 *
 *   1. Scan `public/apps/<id>/app.json` and merge with `site/demos.json` metadata
 *      -> `dist/demos.json` (listing page data).
 *   2. Move the editor entry `dist/index.html` -> `dist/editor.html` (asset URLs
 *      are absolute `/assets/...`, so the rename is safe at root path).
 *   3. Generate `dist/index.html` from `site/index.html`, injecting the SHA-256
 *      of the site password (client-side gate — a deterrent, NOT real security).
 *   4. Inject the same gate check into `dist/player.html` and `dist/editor.html`.
 *   5. Write `dist/.nojekyll`.
 *
 * Usage:
 *   node scripts/build-site.mjs [--password <pw>]     (or env SITE_PASSWORD)
 *
 * Source files (public/, src/, player.html) are never modified, so `npm run dev`
 * is completely unaffected by the gate.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const fail = (msg) => { throw new Error(`[build-site] ${msg}`); };

// ---------------------------------------------------------------- password
const argv = process.argv.slice(2);
const pwFlag = argv.indexOf('--password');
const password = pwFlag >= 0 && argv[pwFlag + 1]
    ? argv[pwFlag + 1]
    : process.env.SITE_PASSWORD;
if (!password) {
    console.warn('[build-site] WARNING: no --password / SITE_PASSWORD provided, falling back to "shaderlab"');
}
const passwordHash = createHash('sha256').update(`sl:${password ?? 'shaderlab'}`).digest('hex');

// ---------------------------------------------------------------- dist check
if (!existsSync(distDir)) fail('dist/ not found — run `npm run build` first');
for (const f of ['index.html', 'player.html']) {
    if (!existsSync(join(distDir, f))) fail(`dist/${f} missing — unexpected build output`);
}

// ---------------------------------------------------------------- demo scan
const appsDir = join(root, 'public', 'apps');
const appIds = readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(appsDir, e.name, 'app.json')))
    .map((e) => e.name)
    .sort();

const metaPath = join(root, 'site', 'demos.json');
const metaList = JSON.parse(readFileSync(metaPath, 'utf8'));
if (!Array.isArray(metaList)) fail('site/demos.json must be an array');

const byId = new Map(appIds.map((id) => [id, { id, title: id, description: '' }]));
const ordered = [];
for (const entry of metaList) {
    if (!byId.has(entry.id)) fail(`site/demos.json lists unknown demo "${entry.id}"`);
    Object.assign(byId.get(entry.id), entry);
    ordered.push(byId.get(entry.id));
}
for (const id of appIds) {
    if (!ordered.some((d) => d.id === id)) {
        console.warn(`[build-site] NOTE: app "${id}" not in site/demos.json — appended with default title`);
        ordered.push(byId.get(id));
    }
}

writeFileSync(join(distDir, 'demos.json'), JSON.stringify(ordered, null, 2));
console.log(`[build-site] demos.json: ${ordered.length} demos`);

// ---------------------------------------------------------------- editor rename
renameSync(join(distDir, 'index.html'), join(distDir, 'editor.html'));

// ---------------------------------------------------------------- listing page
const template = readFileSync(join(root, 'site', 'index.html'), 'utf8');
const PLACEHOLDER = '__SITE_PASSWORD_HASH__';
if (!template.includes(PLACEHOLDER)) fail(`site/index.html is missing the ${PLACEHOLDER} placeholder`);
writeFileSync(join(distDir, 'index.html'), template.replace(PLACEHOLDER, passwordHash));

// ---------------------------------------------------------------- gate injection
const GATE = `<script>(function(){try{var v=JSON.parse(localStorage.getItem('sl-site-auth'));if(v&&Date.now()-v.t<6048e5)return}catch(e){}location.replace('/')}())</script>`;
for (const f of ['player.html', 'editor.html']) {
    const p = join(distDir, f);
    let html = readFileSync(p, 'utf8');
    if (html.includes('sl-site-auth')) fail(`dist/${f} already contains a gate — refusing to double-inject`);
    if (!html.includes('</head>')) fail(`dist/${f} has no </head> to inject into`);
    html = html.replace('</head>', `${GATE}</head>`);
    writeFileSync(p, html);
    console.log(`[build-site] gate injected into dist/${f}`);
}

// ---------------------------------------------------------------- nojekyll
writeFileSync(join(distDir, '.nojekyll'), '');

console.log('[build-site] done — deploy the contents of dist/ to your Pages repo root');
