#!/usr/bin/env node
/*
 * HLASOVY OVERLAY CloudCLI KLIENTA - auto-speak, blok <spoken>, prehravani, diktat.
 *
 * CO DELA: nad cerstve naklonovanym upstream stromem, na ktery uz zapusobil cesky
 * overlay (`../apply-cs-locale.mjs`), aplikuje hlasovy overlay - patch na kazdy
 * dotceny upstream soubor (`patches/`), nove soubory (`files/`), texty `en` + `cs`
 * (`locales/`) a volitelne zvukovou narazku „Běh selhal" (`assets/`). Bezi ve stage
 * `cloudcli-client` v `Dockerfile.server`, mezi ceskym overlayem a `npm ci`.
 *
 * PROC EXISTUJE: plan „Hlas pro CloudCLI" (U7 + U8, KTD5). Upstream v pinu umi jen
 * rucni predcitani; automaticke predcitani dokoncene odpovedi, skryti hlasoveho
 * bloku a zpevneni diktatu nese tenhle overlay, dokud je nevyda upstream. Je to
 * KLIENT - `server/` upstreamu se nesaha (R15).
 *
 * KDY SE TENHLE ADRESAR SMAZE: az upstream vyda verzi, ktera funkci nese (upstream
 * PR z U9). Bump pinu, ktery ceskou cast odstrani, tenhle overlay NEODSTRANUJE -
 * ma vlastni COPY/RUN, vlastni testovaci krok a vlastni radek v rosteru. Nesahne
 * na `config.ts` ani `languages.ts` (ty patri ceskemu overlayi); svuj jmenny
 * prostor `voice` si registruje sam z vlastniho modulu.
 *
 * LICENCE (AGPL-3.0-or-later): nabidka zdroje je tenhle adresar (patche + nove
 * soubory) spolu s forkovou vetvi a upstream PR, ze ktere vznikl (manifest.json).
 *
 * KAZDE PREKVAPENI JE CERVENE. Pred prvnim zasahem se overi sha256 KAZDEHO
 * dotceneho souboru proti manifestu: musi byt bud presne strom po ceskem overlayi
 * (`before`), nebo presne strom po hlasovem overlayi (`after`) - cokoli jineho je
 * posunuty pin a build SPADNE a soubor jmenuje (MANIFEST_MISMATCH). Patche jdou
 * pres `git apply` BEZ fuzzu; odmitnuty patch je PATCH_REFUSED. Nove soubory, ktere
 * uz ve stromu jsou s jinym obsahem, jsou NEW_FILE_COLLISION. Po zasahu `verify()`
 * cte z disku a porovna sha256 `after` u vseho.
 *
 * IDEMPOTENTNI: soubor, ktery uz ma `after`, se preskoci; nove soubory se zapisi
 * bajtove stejne. Druhy beh nic nezmeni a skonci nulou.
 *
 * Ciste Node 22 + git, nula zavislosti: stage `cloudcli-client` ma jen node a git.
 *
 * Pouziti:  node apply-voice-overlay.mjs <src-root> [--overlay-dir <dir>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Soubory ceskeho overlaye. Hlasovy overlay na ne sahat NESMI (KTD5). */
const CZECH_OWNED = ['src/modules/i18n/config.ts', 'src/modules/i18n/languages.ts'];

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

function loadManifest(overlayDir) {
    const file = path.join(overlayDir, 'manifest.json');
    if (!fs.existsSync(file)) refuse('OVERLAY_FILE_MISSING', `manifest.json is not in ${overlayDir}`);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        refuse('MANIFEST_INVALID', `manifest.json does not parse (${e.message})`);
    }
    for (const key of ['patches', 'files', 'locales']) {
        if (!Array.isArray(manifest[key])) refuse('MANIFEST_INVALID', `manifest.json has no ${key} list`);
    }
    if (manifest.patches.length === 0) refuse('MANIFEST_INVALID', 'manifest.json lists no patch');
    for (const p of manifest.patches) {
        if (!isHex64(p.before) || !isHex64(p.after)) refuse('MANIFEST_INVALID', `${p.file}: before/after is not a sha256`);
        if (CZECH_OWNED.includes(p.file)) refuse('MANIFEST_INVALID', `${p.file} belongs to the Czech overlay`);
        if (String(p.file).startsWith('server/')) refuse('MANIFEST_INVALID', `${p.file}: the overlay is client-only`);
    }
    for (const f of [...manifest.files, ...manifest.locales]) {
        if (!isHex64(f.sha256)) refuse('MANIFEST_INVALID', `${f.path}: sha256 is missing`);
        if (String(f.path).startsWith('server/')) refuse('MANIFEST_INVALID', `${f.path}: the overlay is client-only`);
    }
    return manifest;
}

/** Obsah overlaye samotneho: kazdy soubor, na ktery manifest ukazuje, musi existovat. */
function readOverlayFile(overlayDir, rel) {
    const file = inside(overlayDir, rel, 'overlay file');
    if (!fs.existsSync(file)) refuse('OVERLAY_FILE_MISSING', `${rel} is listed in manifest.json but not in the overlay`);
    return fs.readFileSync(file);
}

// ---------------------------------------------------------------------------
// 1. Kontrola stromu proti manifestu - PRED jakymkoli zapisem.
// ---------------------------------------------------------------------------

function classifyPatchedFiles(src, manifest) {
    const pending = [];
    const done = [];
    for (const p of manifest.patches) {
        const target = inside(src, p.file, 'patched file');
        if (!fs.existsSync(target)) refuse('MANIFEST_MISMATCH', `${p.file} does not exist in the tree - the pin moved, re-cut the overlay`);
        const actual = sha256(fs.readFileSync(target));
        if (actual === p.after) done.push(p);
        else if (actual === p.before) pending.push(p);
        else {
            const lf = sha256(Buffer.from(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), 'utf8'));
            if (lf === p.before || lf === p.after) {
                refuse('MANIFEST_MISMATCH', `${p.file} has CRLF line endings (a checkout with core.autocrlf=true?) - upstream is LF; check the tree out with LF`);
            }
            refuse('MANIFEST_MISMATCH', `${p.file} has sha256 ${actual}, expected ${p.before} (post-Czech pin) `
                + `or ${p.after} (voice overlay applied) - the pin moved or the file was edited; re-cut the overlay from the fork`);
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
            refuse('NEW_FILE_COLLISION', `${f.path} already exists in the tree with other content - upstream may have shipped it; remove the overlay instead of stacking on it`);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Zasah.
// ---------------------------------------------------------------------------

function gitApply(src, patchFile, check) {
    // Line endings are the patch's own (upstream is LF): a checkout-style conversion
    // (`core.autocrlf=true`, the Windows default) would rewrite the patched file to
    // CRLF, and its hash would then match neither side of the manifest (measured).
    const args = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', ...(check ? ['--check'] : []), patchFile];
    // `git apply` run inside SOMEBODY ELSE'S repository applies paths relative to that
    // repository's root and silently skips the rest (measured: exit 0, nothing patched).
    // The ceiling stops the search above <src>: <src> is its own repository or none.
    // Forward slashes: Git for Windows ignores a backslashed ceiling (measured).
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src).split(path.sep).join('/') };
    try {
        execFileSync('git', args, { cwd: src, env, stdio: ['ignore', 'pipe', 'pipe'] });
        return null;
    } catch (e) {
        return String(e.stderr || e.message || e).trim();
    }
}

function applyPatches(src, overlayDir, pending) {
    // Nejdriv --check pro VSECHNY: bud se aplikuji vsechny, nebo zadny.
    for (const p of pending) {
        readOverlayFile(overlayDir, p.patch);
        const error = gitApply(src, path.join(overlayDir, p.patch), true);
        if (error) refuse('PATCH_REFUSED', `${p.file}: git apply --check refused ${p.patch} (${error})`);
    }
    for (const p of pending) {
        const error = gitApply(src, path.join(overlayDir, p.patch), false);
        if (error) refuse('PATCH_REFUSED', `${p.file}: git apply refused ${p.patch} (${error})`);
    }
}

function writeNewFiles(src, overlayDir, entries) {
    for (const f of entries) {
        const target = inside(src, f.path, 'new file');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readOverlayFile(overlayDir, f.from));
    }
}

function copyAsset(src, overlayDir, asset) {
    if (!asset) return 'no asset slot';
    const from = inside(overlayDir, asset.from, 'asset');
    if (!fs.existsSync(from)) {
        if (asset.optional) return `failure cue not generated yet (${asset.from}) - the cue falls back to the local chime`;
        refuse('OVERLAY_FILE_MISSING', `${asset.from} is required and missing`);
    }
    const target = inside(src, asset.path, 'asset target');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    return `failure cue -> ${asset.path}`;
}

// ---------------------------------------------------------------------------
// 3. Overeni PO zasahu, z disku.
// ---------------------------------------------------------------------------

function flatKeys(value, prefix = '') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    return Object.entries(value).flatMap(([k, v]) => flatKeys(v, prefix ? `${prefix}.${k}` : k));
}

function verify(src, manifest) {
    const problems = [];
    for (const p of manifest.patches) {
        const target = path.join(src, p.file);
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
        if (actual !== p.after) problems.push(`${p.file} is ${actual}, expected ${p.after}`);
    }
    for (const f of [...manifest.files, ...manifest.locales]) {
        const target = path.join(src, f.path);
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
        if (actual !== f.sha256) problems.push(`${f.path} is ${actual}, expected ${f.sha256}`);
    }
    const locales = {};
    for (const f of manifest.locales) {
        try {
            locales[f.path] = new Set(flatKeys(JSON.parse(fs.readFileSync(path.join(src, f.path), 'utf8'))));
        } catch (e) {
            problems.push(`${f.path} does not parse (${e.message})`);
        }
    }
    const sets = Object.values(locales);
    if (sets.length < 2) problems.push('the voice overlay needs its en and cs texts');
    for (const set of sets.slice(1)) {
        const a = [...sets[0]].sort().join('\n');
        const b = [...set].sort().join('\n');
        if (a !== b) problems.push('the en and cs voice texts carry different keys');
    }
    if (problems.length > 0) {
        refuse('VERIFY_FAILED', `the patched tree does not carry the voice overlay:\n  - ${problems.join('\n  - ')}`);
    }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

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
            refuse('BAD_USAGE', `unknown option ${a} - usage: apply-voice-overlay.mjs <src-root> [--overlay-dir <dir>]`);
        } else if (src === null) {
            src = path.resolve(a);
        } else {
            refuse('BAD_USAGE', `unexpected argument ${a}`);
        }
    }
    if (src === null) refuse('BAD_USAGE', 'usage: apply-voice-overlay.mjs <src-root> [--overlay-dir <dir>]');
    if (!fs.existsSync(path.join(src, 'package.json'))) refuse('BAD_USAGE', `${src} is not a CloudCLI source tree (no package.json)`);
    return { src, overlayDir };
}

function main(argv) {
    const { src, overlayDir } = parseArgs(argv);
    const manifest = loadManifest(overlayDir);

    const { pending, done } = classifyPatchedFiles(src, manifest);
    checkNewFiles(src, overlayDir, manifest.files);
    checkNewFiles(src, overlayDir, manifest.locales);

    applyPatches(src, overlayDir, pending);
    writeNewFiles(src, overlayDir, manifest.files);
    writeNewFiles(src, overlayDir, manifest.locales);
    const cue = copyAsset(src, overlayDir, manifest.asset);

    verify(src, manifest);

    const state = pending.length === 0 ? 'already applied' : `${pending.length} patched${done.length ? `, ${done.length} already applied` : ''}`;
    process.stdout.write(`voice overlay OK: ${manifest.patches.length} upstream files (${state}), `
        + `${manifest.files.length} new files, ${manifest.locales.length} locale files; ${cue}\n`);
}

try {
    main(process.argv.slice(2));
} catch (e) {
    if (e instanceof Refusal) {
        process.stderr.write(`voice overlay REFUSED - ${e.message}\n`);
        process.exit(1);
    }
    process.stderr.write(`voice overlay REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
}
