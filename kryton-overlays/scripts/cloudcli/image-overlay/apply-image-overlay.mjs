#!/usr/bin/env node
/*
 * OBRAZKOVY OVERLAY CloudCLI KLIENTA - obrazky ze souboru projektu primo v chatu.
 *
 * CO DELA: nad upstream stromem po ceskem, hlasovem, brand a projektovem overlayi
 * aplikuje backport upstream siteboon/claudecodeui#1307 (commit 4b98d2e, vydany v 1.37.4):
 * `![popis](cesta/v/projektu.png)` v odpovedi Claude se v chatu ukaze jako nahled
 * s lightboxem; soubor se nacte pres trasu souboru projektu, kterou uz pouziva editor
 * CloudCLI (`api.readFileBlob`), takze jen soubory uvnitr korene projektu relace.
 * Patche na `Markdown.tsx` a `ChatInterface.tsx` (`patches/`), nove soubory (`files/`).
 * Bezi ve stage `cloudcli-client` v `Dockerfile.server`, za projektovym overlayem a pred
 * `npm ci`.
 *
 * NASE UPRAVA NAVIC (rozbor cli1, oddil 5b): `MarkdownImage.tsx` odmitne http(s) adresu
 * na vlastniho hostitele (jakekoli schema a port) a kazdou cestu zacinajici `/api/` - zadny same-origin GET s cookie
 * pracovny na stavove trasy CloudCLI (`/api/projects/clone-progress` klonuje repozitar).
 * Dokazuje ji `src/modules/chat/tests/markdownImageOrigin.test.tsx`. Obrazky z cizich
 * domen overlay NEZAVIRA (to je CSP hrany, samostatne tema).
 *
 * KDY SE TENHLE ADRESAR SMAZE: pri bumpu pinu na >= 1.37.4 (nese #1307 sam). Bump
 * `Markdown.tsx` nebo `ChatInterface.tsx` zmeni a tenhle skript polozi
 * (MANIFEST_MISMATCH), nove soubory narazi na upstreamove (NEW_FILE_COLLISION). Nase
 * odmitnuti vlastniho hostitele a `/api/` ale upstream NEMA: pri bumpu ho prenest jako
 * maly overlay na upstreamovy `MarkdownImage.tsx` (i s testem), nebo poslat upstream.
 *
 * LICENCE (AGPL-3.0-or-later): zdroj zmeny je tenhle adresar (upstream patch #1307
 * + nase uprava). Forkova vetev z `manifest.json` (pole `fork`) zatim NEEXISTUJE,
 * zverejneni je HITL krok jako u projektoveho overlaye.
 *
 * KAZDE PREKVAPENI JE CERVENE. Pred prvnim zasahem se overi sha256 KAZDEHO
 * dotceneho souboru proti manifestu: bud presne strom po predchozich overlayich
 * (`before`), nebo presne strom po tomhle overlayi (`after`) - cokoli jineho je
 * posunuty pin a build SPADNE a soubor jmenuje (MANIFEST_MISMATCH). Patche jdou pres
 * `git apply` BEZ fuzzu (PATCH_REFUSED). Novy soubor, ktery uz ve stromu je
 * s jinym obsahem, je NEW_FILE_COLLISION. Manifest, ktery sahne na `server/`, na
 * i18n modul ceskeho overlaye, na hlasovy modul, na `src/brand/` nebo na modul
 * projektoveho overlaye (i nekanonickou cestou jako `./server/x`), a patch, ktery podle
 * `git apply --numstat` sahne na jiny soubor nez svuj, jsou MANIFEST_INVALID. Vsechny
 * kontroly a `git apply --check` probehnou PRED prvnim zapisem, takze odmitnuty beh
 * strom nezmeni. Po zasahu `verify()` cte z disku a porovna sha256 `after` u vseho.
 *
 * IDEMPOTENTNI: soubor, ktery uz ma `after`, se preskoci; nove soubory se zapisi
 * bajtove stejne. Druhy beh nic nezmeni a skonci nulou.
 *
 * Ciste Node 22 + git, nula zavislosti: stage `cloudcli-client` ma jen node a git.
 *
 * Pouziti:  node apply-image-overlay.mjs <src-root> [--overlay-dir <dir>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Prefixy, na ktere obrazkovy overlay nesmi sahnout nikdy: server upstreamu,
 * i18n modul (cesky overlay), hlasovy modul (hlasovy overlay), modul znacky
 * (brand overlay) a modul projektu (projektovy overlay, bezi tesne pred timhle).
 * Uplny prunik se soubory ostatnich manifestu hlida test v repu, ne tenhle skript.
 */
const FORBIDDEN_PREFIXES = ['server/', 'src/modules/i18n/', 'src/modules/chat/voice/', 'src/brand/', 'src/modules/project-workspace/'];

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

function checkTarget(rel) {
    // Jen kanonicka relativni cesta: `./server/x` nebo `src//a` by obesly kontrolu prefixu
    // a `path.join` by je pak tise prelozil na zakazany soubor.
    if (typeof rel !== 'string' || !rel || path.posix.normalize(rel) !== rel || rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\\')) {
        refuse('MANIFEST_INVALID', `${JSON.stringify(rel)} is not a canonical relative path`);
    }
    const hit = FORBIDDEN_PREFIXES.find((prefix) => rel.startsWith(prefix));
    if (hit) refuse('MANIFEST_INVALID', `${rel}: the image overlay must not touch ${hit} (server, Czech, voice, brand or project overlay)`);
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
    for (const key of ['patches', 'files']) {
        if (!Array.isArray(manifest[key])) refuse('MANIFEST_INVALID', `manifest.json has no ${key} list`);
    }
    if (manifest.patches.length === 0) refuse('MANIFEST_INVALID', 'manifest.json lists no patch');
    for (const p of manifest.patches) {
        if (!isHex64(p.before) || !isHex64(p.after)) refuse('MANIFEST_INVALID', `${p.file}: before/after is not a sha256`);
        checkTarget(p.file);
    }
    for (const f of manifest.files) {
        if (!isHex64(f.sha256)) refuse('MANIFEST_INVALID', `${f.path}: sha256 is missing`);
        checkTarget(f.path);
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
        const body = fs.readFileSync(target);
        const actual = sha256(body);
        if (actual === p.after) done.push(p);
        else if (actual === p.before) pending.push(p);
        else {
            const lf = sha256(Buffer.from(body.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
            if (lf === p.before || lf === p.after) {
                refuse('MANIFEST_MISMATCH', `${p.file} has CRLF line endings (a checkout with core.autocrlf=true?) - upstream is LF; check the tree out with LF`);
            }
            refuse('MANIFEST_MISMATCH', `${p.file} has sha256 ${actual}, expected ${p.before} (after the Czech, voice, brand and project overlays) `
                + `or ${p.after} (image overlay applied) - the pin moved or the file was edited; re-cut the overlay from the fork`);
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
    // Konce radku drzi patch sam (upstream je LF); konverze pri checkoutu by soubor
    // prepsala na CRLF a jeho hash by nesedel na zadnou stranu manifestu.
    const args = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', ...(check ? ['--check'] : []), patchFile];
    // `git apply` spusteny uvnitr CIZIHO repozitare aplikuje cesty vuci jeho koreni
    // a zbytek tise preskoci (exit 0, nic nezaplatovano). Strop hledani nad <src>
    // zajisti, ze <src> je bud svuj vlastni repozitar, nebo zadny.
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src).split(path.sep).join('/') };
    try {
        execFileSync('git', args, { cwd: src, env, stdio: ['ignore', 'pipe', 'pipe'] });
        return null;
    } catch (e) {
        return String(e.stderr || e.message || e).trim();
    }
}

/**
 * Patch smi sahnout PRAVE na svuj soubor. `git apply` aplikuje vsechno, co v patchi je,
 * i hunk pripsany navic bez radku `diff --git`; `--numstat` je gitovo vlastni cteni patche,
 * takze se nespoleha na regex nad textem.
 */
function patchTargets(src, patchFile) {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src).split(path.sep).join('/') };
    let out;
    try {
        out = execFileSync('git', ['apply', '--numstat', patchFile], { cwd: src, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (e) {
        return { error: String(e.stderr || e.message || e).trim() };
    }
    return { files: out.split('\n').filter(Boolean).map((line) => line.split('\t').slice(2).join('\t')) };
}

function checkPatches(src, overlayDir, pending) {
    for (const p of pending) {
        readOverlayFile(overlayDir, p.patch);
        const targets = patchTargets(src, path.join(overlayDir, p.patch));
        if (targets.error) refuse('PATCH_REFUSED', `${p.file}: git apply --numstat cannot read ${p.patch} (${targets.error})`);
        if (targets.files.length !== 1 || targets.files[0] !== p.file) {
            refuse('MANIFEST_INVALID', `${p.patch} touches ${JSON.stringify(targets.files)}, expected exactly ${p.file}`);
        }
        const error = gitApply(src, path.join(overlayDir, p.patch), true);
        if (error) refuse('PATCH_REFUSED', `${p.file}: git apply --check refused ${p.patch} (${error})`);
    }
}

function applyPatches(src, overlayDir, pending) {
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

// ---------------------------------------------------------------------------
// 3. Overeni PO zasahu, z disku.
// ---------------------------------------------------------------------------

function verify(src, manifest) {
    const problems = [];
    for (const p of manifest.patches) {
        const target = path.join(src, p.file);
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
        if (actual !== p.after) problems.push(`${p.file} is ${actual}, expected ${p.after}`);
    }
    for (const f of manifest.files) {
        const target = path.join(src, f.path);
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
        if (actual !== f.sha256) problems.push(`${f.path} is ${actual}, expected ${f.sha256}`);
    }
    if (problems.length > 0) {
        refuse('VERIFY_FAILED', `the patched tree does not carry the image overlay:\n  - ${problems.join('\n  - ')}`);
    }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const USAGE = 'usage: apply-image-overlay.mjs <src-root> [--overlay-dir <dir>]';

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

    // Vsechno, co muze odmitnout, probehne pred prvnim zapisem.
    const { pending, done } = classifyPatchedFiles(src, manifest);
    checkNewFiles(src, overlayDir, manifest.files);
    checkPatches(src, overlayDir, pending);

    applyPatches(src, overlayDir, pending);
    writeNewFiles(src, overlayDir, manifest.files);

    verify(src, manifest);

    const state = pending.length === 0 ? 'already applied' : `${pending.length} patched${done.length ? `, ${done.length} already applied` : ''}`;
    process.stdout.write(`image overlay OK: ${manifest.patches.length} upstream files (${state}), ${manifest.files.length} new files\n`);
}

try {
    main(process.argv.slice(2));
} catch (e) {
    if (e instanceof Refusal) {
        process.stderr.write(`image overlay REFUSED - ${e.message}\n`);
        process.exit(1);
    }
    process.stderr.write(`image overlay REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
}
