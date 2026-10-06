#!/usr/bin/env node
/*
 * BRAND OVERLAY CloudCLI KLIENTA - Brain Chat: paleta, pre-paint a (od U8) znacka.
 *
 * CO DELA: nad stromem pinu, na ktery uz zapusobil cesky (`../apply-cs-locale.mjs`)
 * a hlasovy overlay (`../voice-overlay/`), ve stage `cloudcli-client` v `Dockerfile.server`
 * PRED `npm ci`, ve ctyrech krocich:
 *   1. zkopiruje nove soubory (`files/`, polozky `files` v manifestu),
 *   2. aplikuje hook patche (`patches/`, polozky `patches`) pres `git apply` BEZ fuzzu,
 *   3. udela ukotvene datove upravy (`edits/`, polozky `edits`: soubor, jeho before/after
 *      sha256 a seznam operaci nad kotvou, ktera musi byt ve strome PRAVE JEDNOU),
 *   4. `verify()` precte vysledek z disku.
 * U7: `src/brand/palette.css`, jeden import v `src/main.tsx` hned za
 * `import '@/index.css'` a pre-paint skript v `<head>` souboru `index.html` (KTD13).
 * U8 (znacka, KTD8): nove soubory `src/brand/*` (znacka, atribuce, konstanty, i18n,
 * testy), hook patche peti upstreamovych souboru, zameny `replace` v `index.html`,
 * `public/manifest.json`, `public/sw.js`, `public/clear-cache.html` a v `sidebar.json`
 * + `common.json` KAZDEHO locale, a NAHRAZENE assety (`assets/`, polozky `assets`:
 * cesta, `before` = upstream, `sha256` = nase) - sada ikon Brain. Krok 3b zapise assety.
 *
 * LOCALE: mnozina locale je seznam `locales.names` v manifestu. Adresar locale ve strome,
 * ktery manifest nezna, = LOCALE_NOT_IN_MANIFEST (exit 1): pridani locale upstreamem
 * vynuti preriznuti, misto aby tise vyslo „CloudCLI". Upravy `sidebar.json`/`common.json`
 * jsou JEDINE soubory pod `src/modules/i18n/`, na ktere overlay smi (jen datove upravy).
 * ASSETY: jen sada ikon KTD8 (`ASSET_PATH`) - loga poskytovatelu v `public/icons/`
 * (claude-ai, codex, cursor) manifest ani nemuze jmenovat. `verify()` cte locale zpet
 * i VYZNAMEM (`app.title` = "Brain Chat", token v `mainContent.loading`), nejen hashem.
 *
 * PROC EXISTUJE: plan „CloudCLI theme and brand" (KD2, KD3, KTD5). Overlay je TRVALY -
 * na rozdil od ceskeho a hlasoveho se nemaze pri zadnem spoustaci; pri kazdem bumpu pinu
 * se preriza (before/after sha256 se premeri nad stromem po hlasovem overlayi). Nic
 * neimportuje z `voice-overlay/` - ten adresar jednou zmizi.
 *
 * KAZDE PREKVAPENI JE CERVENE, a NIC se nezapise, dokud neprojde kontrola VSEHO:
 * soubor, jehoz sha256 neni ani `before` ani `after`, je MANIFEST_MISMATCH (se jmenem
 * souboru, CRLF strom zvlast); kotva chybi/je dvakrat = ANCHOR_MISSING/ANCHOR_DUPLICATED;
 * patch, ktery `git apply --check` odmitne = PATCH_REFUSED; uprava, jejiz vysledek neni
 * `after`, = EDIT_RESULT_MISMATCH; novy soubor s jinym obsahem uz ve strome =
 * NEW_FILE_COLLISION; HLIDANY upstream soubor (polozky `watched`: pravidlo motivu, ktere
 * pre-paint skript zrcadli - `ThemeContext.tsx`, `userSettings.ts`) s jinym sha256 nebo
 * chybejici = WATCHED_FILE_CHANGED. Hlidane soubory overlay NIKDY nezapisuje, jen je hashuje;
 * seznam je obecny (cesta, sha256, proc), aby na nem stavely i dalsi vrstvy overlaye.
 * Po zasahu `verify()` porovna `after` u vseho a zkontroluje, ze
 * import palety je v `main.tsx` prave jednou a hned po importu `index.css`.
 *
 * IDEMPOTENTNI: soubor, ktery uz ma `after`, se preskoci; nove soubory se zapisi bajtove
 * stejne. Druhy beh nic nezmeni a skonci nulou (vrstvy Dockeru na tom stoji).
 *
 * Ciste Node 22 + git, nula zavislosti: stage `cloudcli-client` ma jen node a git.
 *
 * Pouziti:  node apply-brand-overlay.mjs <src-root> [--overlay-dir <dir>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Soubory ceskeho a hlasoveho overlaye. Brand overlay na ne nesaha. */
const OTHER_OVERLAYS = ['src/modules/i18n/', 'src/modules/chat/voice/'];

/**
 * Jedina vyjimka z OTHER_OVERLAYS: DATOVA uprava `sidebar.json` / `common.json` locale
 * (KTD8 - znacka vlastni `app.title` a token v `mainContent.loading` v KAZDEM locale,
 * i v ceskem, aby odstraneni ceskeho overlaye nevratilo „CloudCLI").
 */
const LOCALE_EDIT = /^src\/modules\/i18n\/locales\/[^/]+\/(sidebar|common)\.json$/;

/** KTD8 „Icons": jen sada ikon Brain, nikdy loga poskytovatelu v `public/icons/`. */
const ASSET_PATH = /^public\/(logo\.svg|favicon\.(svg|png)|logo-\d+\.png|icons\/icon-\d+x\d+\.(png|svg))$/;

const BRAND_NAME = 'Brain Chat';

/** Import palety, ktery `verify()` hleda v `src/main.tsx` (KTD6). */
const MAIN_FILE = 'src/main.tsx';
const INDEX_CSS_IMPORT = "import '@/index.css'";
const PALETTE_IMPORT = "import '@/brand/palette.css'";

class Refusal extends Error {
    constructor(reason, detail) {
        super(`${reason}: ${detail}`);
        this.reason = reason;
    }
}

const refuse = (reason, detail) => {
    throw new Refusal(reason, detail);
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Cesta z manifestu musi zustat uvnitr sveho korene - manifest je vstup. */
function inside(root, rel, what) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        refuse('MANIFEST_INVALID', `${what} ${JSON.stringify(rel)} is not a relative path inside its root`);
    }
    return path.join(root, rel);
}

function checkTarget(file, { localeEditAllowed = false } = {}) {
    if (String(file).startsWith('server/')) refuse('MANIFEST_INVALID', `${file}: the overlay is client-only`);
    if (localeEditAllowed && LOCALE_EDIT.test(String(file))) return;
    if (OTHER_OVERLAYS.some((p) => String(file).startsWith(p))) refuse('MANIFEST_INVALID', `${file} belongs to the Czech or voice overlay`);
}

function loadManifest(overlayDir) {
    const file = path.join(overlayDir, 'manifest.json');
    if (!fs.existsSync(file)) refuse('OVERLAY_FILE_MISSING', `manifest.json is not in ${overlayDir}`);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        refuse('MANIFEST_INVALID', `manifest.json does not parse (${e.message})`);
    }
    for (const key of ['files', 'patches', 'edits']) {
        if (!Array.isArray(manifest[key])) refuse('MANIFEST_INVALID', `manifest.json has no ${key} list`);
    }
    // U8 list; a manifest without it (the U7 shape) replaces no asset.
    if (manifest.assets === undefined) manifest.assets = [];
    if (!Array.isArray(manifest.assets)) refuse('MANIFEST_INVALID', 'manifest.json assets is not a list');
    for (const f of manifest.files) {
        if (!isHex64(f.sha256)) refuse('MANIFEST_INVALID', `${f.path}: sha256 is missing`);
        checkTarget(f.path);
    }
    for (const p of manifest.patches) {
        if (!isHex64(p.before) || !isHex64(p.after)) refuse('MANIFEST_INVALID', `${p.file}: before/after is not a sha256`);
        checkTarget(p.file);
    }
    // `watched` is optional (absent = nothing watched); when present every entry names a
    // relative path, its sha256 on the post-voice pin, and WHY it is watched.
    if (manifest.watched === undefined) manifest.watched = [];
    if (!Array.isArray(manifest.watched)) refuse('MANIFEST_INVALID', 'manifest.json watched is not a list');
    for (const w of manifest.watched) {
        if (!w || typeof w.path !== 'string' || !w.path) refuse('MANIFEST_INVALID', `a watched entry has no path (${JSON.stringify(w)})`);
        const name = w.path;
        inside('.', name, 'watched file');
        if (!isHex64(w.sha256)) refuse('MANIFEST_INVALID', `watched ${name}: sha256 is missing`);
        if (typeof w.why !== 'string' || !w.why.trim()) refuse('MANIFEST_INVALID', `watched ${name}: why is missing - say what depends on this file`);
    }
    for (const e of manifest.edits) {
        if (!isHex64(e.before) || !isHex64(e.after)) refuse('MANIFEST_INVALID', `${e.file}: before/after is not a sha256`);
        checkTarget(e.file, { localeEditAllowed: true });
    }
    for (const e of manifest.edits) {
        if (!Array.isArray(e.ops) || e.ops.length === 0) refuse('MANIFEST_INVALID', `${e.file}: an edit lists no ops`);
        for (const op of e.ops) {
            if (!(op.op in EDIT_OPS)) refuse('MANIFEST_INVALID', `${e.file}: unknown edit op ${JSON.stringify(op.op)}`);
            if (typeof op.anchor !== 'string' || !op.anchor) refuse('MANIFEST_INVALID', `${e.file}: an edit op has no anchor`);
            if (op.op === 'replace' && typeof op.replacement !== 'string') refuse('MANIFEST_INVALID', `${e.file}: a replace op has no replacement string`);
        }
    }
    for (const a of manifest.assets) {
        if (!ASSET_PATH.test(String(a.path))) refuse('MANIFEST_INVALID', `${a.path}: an asset must be one of the KTD8 Brain icon files (never a provider logo)`);
        if (!isHex64(a.before) || !isHex64(a.sha256)) refuse('MANIFEST_INVALID', `${a.path}: before/sha256 is not a sha256`);
    }
    if (manifest.locales !== undefined) {
        const l = manifest.locales;
        if (!l || typeof l.root !== 'string' || !Array.isArray(l.names) || !Array.isArray(l.edited) || l.names.length === 0) {
            refuse('MANIFEST_INVALID', 'manifest.json locales needs root, names and edited');
        }
        inside('.', l.root, 'locale root');
        for (const name of l.names) {
            for (const f of l.edited) {
                const file = `${l.root}/${name}/${f}`;
                if (!manifest.edits.some((e) => e.file === file)) refuse('MANIFEST_INVALID', `${file}: the locale is listed but this file has no edit`);
            }
        }
    }
    return manifest;
}

/** Obsah overlaye samotneho: kazdy soubor, na ktery manifest ukazuje, musi existovat. */
function readOverlayFile(overlayDir, rel) {
    const file = inside(overlayDir, rel, 'overlay file');
    if (!fs.existsSync(file)) refuse('OVERLAY_FILE_MISSING', `${rel} is listed in manifest.json but not in the overlay`);
    return fs.readFileSync(file);
}

const count = (text, needle) => text.split(needle).length - 1;

/** Kotva musi byt v souboru PRAVE JEDNOU - jinak nevime, kam sahame. */
function checkAnchor(file, text, anchor) {
    const n = count(text, anchor);
    if (n === 0) refuse('ANCHOR_MISSING', `${file}: the anchor ${JSON.stringify(anchor)} is not there - the pin moved; re-cut the brand overlay`);
    if (n > 1) refuse('ANCHOR_DUPLICATED', `${file}: the anchor ${JSON.stringify(anchor)} is there ${n} times - re-cut the brand overlay`);
}

// ---------------------------------------------------------------------------
// 1. Kontrola stromu proti manifestu - PRED jakymkoli zapisem.
// ---------------------------------------------------------------------------

/** Rozdeli upstream soubory (patche i upravy) na hotove a cekajici; cokoli tretiho = odmitnuti. */
function classify(src, entries, sideName) {
    const pending = [];
    const done = [];
    for (const p of entries) {
        const target = inside(src, p.file, 'upstream file');
        if (!fs.existsSync(target)) refuse('MANIFEST_MISMATCH', `${p.file} does not exist in the tree - the pin moved, re-cut the brand overlay`);
        const body = fs.readFileSync(target);
        const actual = sha256(body);
        if (actual === p.after) done.push(p);
        else if (actual === p.before) pending.push(p);
        else {
            const lf = sha256(Buffer.from(body.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
            if (lf === p.before || lf === p.after) {
                refuse('MANIFEST_MISMATCH', `${p.file} has CRLF line endings (a checkout with core.autocrlf=true?) - upstream is LF; check the tree out with LF`);
            }
            refuse('MANIFEST_MISMATCH', `${p.file} has sha256 ${actual}, expected ${p.before} (pin after the Czech and voice overlays) `
                + `or ${p.after} (${sideName} applied) - the pin moved, an earlier overlay changed, or the file was edited; re-cut the brand overlay`);
        }
    }
    return { pending, done };
}

function checkNewFiles(src, overlayDir, entries) {
    for (const f of entries) {
        const body = readOverlayFile(overlayDir, f.from);
        if (sha256(body) !== f.sha256) refuse('OVERLAY_FILE_CORRUPT', `${f.from} does not match its sha256 in manifest.json`);
        const target = inside(src, f.path, 'new file');
        if (fs.existsSync(target) && sha256(fs.readFileSync(target)) !== f.sha256) {
            refuse('NEW_FILE_COLLISION', `${f.path} already exists in the tree with other content - upstream may have shipped it; re-cut instead of stacking on it`);
        }
    }
}

function gitApply(src, patchFile, check) {
    // Line endings are the patch's own (upstream is LF): a checkout-style conversion
    // (`core.autocrlf=true`, the Windows default) would rewrite the patched file to CRLF.
    const args = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', ...(check ? ['--check'] : []), patchFile];
    // `git apply` inside SOMEBODY ELSE'S repository applies paths relative to that
    // repository's root and silently skips the rest. The ceiling stops the search above
    // <src>. Forward slashes: Git for Windows ignores a backslashed ceiling.
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src).split(path.sep).join('/') };
    try {
        execFileSync('git', args, { cwd: src, env, stdio: ['ignore', 'pipe', 'pipe'] });
        return null;
    } catch (e) {
        return String(e.stderr || e.message || e).trim();
    }
}

function checkPatches(src, overlayDir, pending) {
    for (const p of pending) {
        if (p.anchor !== undefined) checkAnchor(p.file, fs.readFileSync(path.join(src, p.file), 'utf8'), p.anchor);
        readOverlayFile(overlayDir, p.patch);
        const error = gitApply(src, path.join(overlayDir, p.patch), true);
        if (error) refuse('PATCH_REFUSED', `${p.file}: git apply --check refused ${p.patch} (${error})`);
    }
}

/** Druhy datovych uprav. Kazdy dostane text a kotvu (uz overenou: prave jednou) a vrati novy text. */
const EDIT_OPS = {
    insertBefore: (text, op, overlayDir) => {
        const insert = readOverlayFile(overlayDir, op.from).toString('utf8');
        return text.replace(op.anchor, () => `${insert}${op.anchor}`);
    },
    // U8: the anchor (exactly once) becomes the replacement - a literal, never a regex.
    replace: (text, op) => text.replace(op.anchor, () => op.replacement),
};

/**
 * Mnozina locale ve strome == `locales.names` z manifestu. Adresar navic = upstream pridal
 * jazyk, ktery by jinak tise ukazal „CloudCLI" (KTD5); chybejici adresar chyti `classify`.
 */
function checkLocaleSet(src, manifest) {
    if (manifest.locales === undefined) return;
    const root = inside(src, manifest.locales.root, 'locale root');
    if (!fs.existsSync(root)) refuse('MANIFEST_MISMATCH', `${manifest.locales.root} does not exist in the tree - the pin moved, re-cut the brand overlay`);
    const extra = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !manifest.locales.names.includes(d.name))
        .map((d) => d.name);
    if (extra.length > 0) {
        refuse('LOCALE_NOT_IN_MANIFEST', `${manifest.locales.root} holds ${extra.join(', ')}, which manifest.json does not list - `
            + 'an upstream locale addition; re-cut the brand overlay so its sidebar.json and common.json say Brain Chat');
    }
}

/** Assety: overlay kopie musi sedet na sha256; ve strome je upstream (`before`) nebo uz nase. */
function classifyAssets(src, overlayDir, assets) {
    const pending = [];
    for (const a of assets) {
        const body = readOverlayFile(overlayDir, a.from);
        if (sha256(body) !== a.sha256) refuse('OVERLAY_FILE_CORRUPT', `${a.from} does not match its sha256 in manifest.json`);
        const target = inside(src, a.path, 'asset');
        if (!fs.existsSync(target)) refuse('MANIFEST_MISMATCH', `${a.path} does not exist in the tree - the pin moved, re-cut the brand overlay`);
        const actual = sha256(fs.readFileSync(target));
        if (actual === a.before) pending.push(a);
        else if (actual !== a.sha256) {
            refuse('MANIFEST_MISMATCH', `${a.path} has sha256 ${actual}, expected ${a.before} (upstream) or ${a.sha256} (Brain icon) - `
                + 'upstream changed its icon set; re-cut the brand overlay');
        }
    }
    return pending;
}

/** Spocita vysledek kazde cekajici upravy V PAMETI a overi ho proti `after`. */
function planEdits(src, overlayDir, pending) {
    const results = [];
    for (const e of pending) {
        let text = fs.readFileSync(path.join(src, e.file), 'utf8');
        for (const op of e.ops) {
            checkAnchor(e.file, text, op.anchor);
            text = EDIT_OPS[op.op](text, op, overlayDir);
        }
        const got = sha256(Buffer.from(text, 'utf8'));
        if (got !== e.after) {
            refuse('EDIT_RESULT_MISMATCH', `${e.file}: the edits produce ${got}, manifest.json expects ${e.after} - an edit file changed; re-cut the brand overlay`);
        }
        results.push({ file: e.file, text });
    }
    return results;
}

/**
 * Hlidane upstream soubory: overlay je nepise, ale stoji na nich (pre-paint skript zrcadli
 * pravidlo motivu z `ThemeContext.tsx` a `userSettings.ts`). Jiny sha256 = pravidlo se mohlo
 * pohnout, a to se nesmi projevit tise spatnym motivem pri prvnim vykresleni.
 */
function checkWatched(src, entries) {
    for (const w of entries) {
        const target = inside(src, w.path, 'watched file');
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : null;
        if (actual === w.sha256) continue;
        const state = actual === null ? 'is missing from the tree' : `has sha256 ${actual}, expected ${w.sha256}`;
        refuse('WATCHED_FILE_CHANGED', `${w.path} ${state} (watched because: ${w.why}) - the theme rule may have moved; `
            + 're-check the pre-paint script (edits/index.html.pre-paint.html) and PARITY in scripts/cloudcli-brand-overlay.test.js '
            + 'against upstream, then re-measure the watched sha256 in manifest.json');
    }
}

// ---------------------------------------------------------------------------
// 2. Zasah (az po kontrole vseho).
// ---------------------------------------------------------------------------

function writeNewFiles(src, overlayDir, entries) {
    for (const f of entries) {
        const target = inside(src, f.path, 'new file');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readOverlayFile(overlayDir, f.from));
    }
}

function applyPatches(src, overlayDir, pending) {
    for (const p of pending) {
        const error = gitApply(src, path.join(overlayDir, p.patch), false);
        if (error) refuse('PATCH_REFUSED', `${p.file}: git apply refused ${p.patch} (${error})`);
    }
}

function writeEdits(src, results) {
    for (const r of results) fs.writeFileSync(path.join(src, r.file), r.text);
}

function writeAssets(src, overlayDir, pending) {
    for (const a of pending) fs.writeFileSync(path.join(src, a.path), readOverlayFile(overlayDir, a.from));
}

// ---------------------------------------------------------------------------
// 3. Overeni PO zasahu, z disku.
// ---------------------------------------------------------------------------

function verify(src, manifest) {
    const problems = [];
    const hashOf = (rel) => {
        const target = path.join(src, rel);
        return fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
    };
    for (const p of [...manifest.patches, ...manifest.edits]) {
        const actual = hashOf(p.file);
        if (actual !== p.after) problems.push(`${p.file} is ${actual}, expected ${p.after}`);
    }
    for (const f of manifest.files) {
        const actual = hashOf(f.path);
        if (actual !== f.sha256) problems.push(`${f.path} is ${actual}, expected ${f.sha256}`);
    }
    for (const w of manifest.watched) {
        const actual = hashOf(w.path);
        if (actual !== w.sha256) problems.push(`watched ${w.path} is ${actual}, expected ${w.sha256} - the overlay must never write it`);
    }
    for (const a of manifest.assets) {
        const actual = hashOf(a.path);
        if (actual !== a.sha256) problems.push(`${a.path} is ${actual}, expected the Brain icon ${a.sha256}`);
    }
    // KTD8 read back as MEANING, not only as hashes: the name every locale shows.
    if (manifest.locales !== undefined) {
        const readJson = (rel) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(src, rel), 'utf8'));
            } catch (e) {
                problems.push(`${rel} does not parse (${e.message})`);
                return null;
            }
        };
        for (const name of manifest.locales.names) {
            const base = `${manifest.locales.root}/${name}`;
            if (manifest.locales.edited.includes('sidebar.json')) {
                const title = readJson(`${base}/sidebar.json`)?.app?.title;
                if (title !== BRAND_NAME) problems.push(`${base}/sidebar.json app.title is ${JSON.stringify(title)}, expected "${BRAND_NAME}"`);
            }
            if (manifest.locales.edited.includes('common.json')) {
                const loading = readJson(`${base}/common.json`)?.mainContent?.loading;
                if (typeof loading !== 'string' || !loading.includes(BRAND_NAME) || /CloudCLI/.test(loading)) {
                    problems.push(`${base}/common.json mainContent.loading is ${JSON.stringify(loading)}, expected the token "${BRAND_NAME}"`);
                }
            }
        }
    }
    // The palette wins by SOURCE ORDER (KTD6): its import must sit right after index.css.
    if (manifest.files.some((f) => f.path === 'src/brand/palette.css')) {
        const mainPath = path.join(src, MAIN_FILE);
        const lines = fs.existsSync(mainPath) ? fs.readFileSync(mainPath, 'utf8').split('\n') : [];
        const palette = lines.flatMap((l, i) => (l.trim() === PALETTE_IMPORT ? [i] : []));
        const indexCss = lines.flatMap((l, i) => (l.trim() === INDEX_CSS_IMPORT ? [i] : []));
        if (palette.length !== 1) problems.push(`${MAIN_FILE} must import the palette exactly once, found ${palette.length}`);
        else if (indexCss.length !== 1 || palette[0] !== indexCss[0] + 1) {
            problems.push(`${MAIN_FILE} must import the palette directly after ${INDEX_CSS_IMPORT} (source order decides, KTD6)`);
        }
    }
    if (problems.length > 0) {
        refuse('VERIFY_FAILED', `the tree does not carry the brand overlay:\n  - ${problems.join('\n  - ')}`);
    }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const USAGE = 'usage: apply-brand-overlay.mjs <src-root> [--overlay-dir <dir>]';

function parseArgs(argv) {
    let src = null;
    let overlayDir = HERE;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--overlay-dir') {
            i += 1;
            if (i >= argv.length) refuse('BAD_USAGE', '--overlay-dir needs a directory');
            overlayDir = path.resolve(argv[i]);
        } else if (a.startsWith('-')) {
            refuse('BAD_USAGE', `unknown option ${a} - ${USAGE}`);
        } else if (src === null) {
            src = path.resolve(a);
        } else {
            refuse('BAD_USAGE', `unexpected argument ${a}`);
        }
    }
    if (src === null) refuse('BAD_USAGE', USAGE);
    if (!fs.existsSync(path.join(src, 'package.json'))) refuse('BAD_USAGE', `${src} is not a CloudCLI source tree (no package.json)`);
    return { src, overlayDir };
}

function main(argv) {
    const { src, overlayDir } = parseArgs(argv);
    const manifest = loadManifest(overlayDir);

    // Everything is checked before the first write; a refusal leaves the tree untouched.
    checkLocaleSet(src, manifest);
    checkNewFiles(src, overlayDir, manifest.files);
    const assets = classifyAssets(src, overlayDir, manifest.assets);
    const patches = classify(src, manifest.patches, 'brand overlay');
    const edits = classify(src, manifest.edits, 'brand overlay');
    checkPatches(src, overlayDir, patches.pending);
    const editResults = planEdits(src, overlayDir, edits.pending);
    checkWatched(src, manifest.watched);

    writeNewFiles(src, overlayDir, manifest.files);
    applyPatches(src, overlayDir, patches.pending);
    writeEdits(src, editResults);
    writeAssets(src, overlayDir, assets);

    verify(src, manifest);

    const pending = patches.pending.length + edits.pending.length + assets.length;
    const total = manifest.patches.length + manifest.edits.length + manifest.assets.length;
    const state = pending === 0 ? 'already applied' : pending === total ? 'applied' : `${pending} applied, ${total - pending} already applied`;
    process.stdout.write(`brand overlay OK: ${manifest.files.length} new files, ${manifest.patches.length} patched upstream files, `
        + `${manifest.edits.length} edited upstream files, ${manifest.assets.length} replaced assets (${state})\n`);
}

try {
    main(process.argv.slice(2));
} catch (e) {
    if (e instanceof Refusal) {
        process.stderr.write(`brand overlay REFUSED - ${e.message}\n`);
        process.exit(1);
    }
    process.stderr.write(`brand overlay REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
}
