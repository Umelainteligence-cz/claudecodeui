#!/usr/bin/env node
/*
 * PDF OVERLAY KLIENTA BRAIN CHATU (E474) - "Exportovat jako > PDF (tisk)".
 *
 * CO DELA: nad upstream stromem po vsech drivejsich klientskych overlayich (cesky, hlasovy,
 * brand, projektovy, chybovy, obrazkovy) prida do menu exportu prepisu ctvrtou polozku
 * "PDF (tisk)" hned za "Webova stranka (.html)". PDF dela tisk prohlizece nad tymz HTML,
 * ktere vyrabi export .html (`buildTranscriptHtml`); hlavni cesta je nova karta otevrena
 * synchronne v kliknuti, zaloha skryty `srcdoc` ram (mereni kroku 0, plan E474).
 * Dva upstream soubory dostanou ukotvene vlozky (`edits` v `manifest.json`), nove soubory
 * jsou v `files/` (tisk, tiskove CSS, vlastni texty cs/en, testy).
 * Bezi ve stage `cloudcli-client` v `Dockerfile.server`, za obrazkovym overlayem a pred
 * `client-overrides` a `npm ci`.
 *
 * PROC KOTVY A ZNAME OTISKY, NE JEDEN `before`: overlay ma sedet na pin 1.37.3 i na 1.37.10
 * (oba soubory se mezi nimi lisi). Manifest proto nese pro kazdy upstream soubor SEZNAM
 * znamych `before` sha256 a k nim `after`. Jiny otisk = MANIFEST_MISMATCH a build spadne se
 * jmenem souboru. Kotva musi byt v souboru PRAVE JEDNOU (ANCHOR_MISSING / ANCHOR_AMBIGUOUS);
 * vysledek vlozek se porovna s `after` sveho `before` jeste PRED zapisem (AFTER_MISMATCH).
 * Kdyz upstream PDF vyda sam (`'pdf'` v souboru, ktery jeste neni nas `after`), skript
 * odmitne (UPSTREAM_HAS_PDF): overlay se pak smaze, nevrstvi se na upstream.
 *
 * SLEDOVANY SOUBOR: `watched` (upstream `buildTranscriptHtml.tsx`) overlay nemeni, ale `toPrintableHtml`
 * prepisuje jeho vystup. Jeho otisk musi byt jeden ze znamych, jinak WATCHED_FILE_CHANGED (pred zapisem).
 *
 * KAZDE PREKVAPENI JE CERVENE: manifest, ktery sahne na `server/`, i18n modul ceskeho
 * overlaye, hlasovy modul, `src/brand/` nebo modul projektoveho overlaye (i nekanonickou
 * cestou), je MANIFEST_INVALID; novy soubor, ktery uz ve stromu je s jinym obsahem, je
 * NEW_FILE_COLLISION. Vsechny kontroly probehnou pred prvnim zapisem, odmitnuty beh strom
 * nezmeni. Po zasahu `verify()` cte z disku.
 *
 * IDEMPOTENTNI: soubor s otiskem `after` se preskoci, nove soubory se zapisi bajtove stejne.
 *
 * KDY SE TENHLE ADRESAR SMAZE: az upstream vyda export do PDF (skript to ohlasi jako
 * UPSTREAM_HAS_PDF), nebo kdyz vlastnik obrazu rozhodne jinak. Pri posunu pinu na verzi,
 * jejiz otisk v manifestu neni: pridat verzi do VERSIONS v `check-upstream.mjs`, zmerit `before`, `after`
 * a `watched` (`check-upstream.mjs --online --write`), prepsat PLAN_BEFORE/PLAN_WATCHED v
 * `scripts/cloudcli-pdf-export-overlay.test.js`, overit kotvy a `toPrintableHtml` nad novym builderem.
 *
 * LICENCE (AGPL-3.0-or-later): zdroj zmeny je tenhle adresar; zverejneny strom `/src` nese
 * vetev `brain-chat-v1.37.3` forku (runbook cloudcli-subdomain, krok 7) - HITL krok operatora.
 *
 * Ciste Node 22, nula zavislosti: stage `cloudcli-client` ma jen node a git.
 *
 * Pouziti:  node apply-pdf-export-overlay.mjs <src-root> [--overlay-dir <dir>]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Na tohle PDF overlay nesahne nikdy: server, cesky i18n modul, hlas, znacka, projekt. */
export const FORBIDDEN_PREFIXES = ['server/', 'src/modules/i18n/', 'src/modules/chat/voice/', 'src/brand/', 'src/modules/project-workspace/'];

export class Refusal extends Error {
    constructor(reason, detail) {
        super(`${reason}: ${detail}`);
        this.reason = reason;
    }
}

const refuse = (reason, detail) => {
    throw new Refusal(reason, detail);
};

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function inside(root, rel, what) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        refuse('MANIFEST_INVALID', `${what} ${JSON.stringify(rel)} is not a relative path inside its root`);
    }
    return path.join(root, rel);
}

function checkTarget(rel) {
    if (typeof rel !== 'string' || !rel || path.posix.normalize(rel) !== rel || rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\\')) {
        refuse('MANIFEST_INVALID', `${JSON.stringify(rel)} is not a canonical relative path`);
    }
    const hit = FORBIDDEN_PREFIXES.find((prefix) => rel.startsWith(prefix));
    if (hit) refuse('MANIFEST_INVALID', `${rel}: the PDF overlay must not touch ${hit} (server, Czech, voice, brand or project overlay)`);
}

export function loadManifest(overlayDir) {
    const file = path.join(overlayDir, 'manifest.json');
    if (!fs.existsSync(file)) refuse('OVERLAY_FILE_MISSING', `manifest.json is not in ${overlayDir}`);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        refuse('MANIFEST_INVALID', `manifest.json does not parse (${e.message})`);
    }
    if (typeof manifest.marker !== 'string' || manifest.marker.length < 8) refuse('MANIFEST_INVALID', 'manifest.json has no marker');
    for (const key of ['edits', 'files']) {
        if (!Array.isArray(manifest[key])) refuse('MANIFEST_INVALID', `manifest.json has no ${key} list`);
    }
    if (manifest.edits.length === 0) refuse('MANIFEST_INVALID', 'manifest.json lists no edited file');
    for (const e of manifest.edits) {
        checkTarget(e.file);
        if (!Array.isArray(e.known) || e.known.length === 0) refuse('MANIFEST_INVALID', `${e.file}: no known before/after`);
        for (const k of e.known) {
            if (!isHex64(k.before) || !isHex64(k.after) || typeof k.version !== 'string') refuse('MANIFEST_INVALID', `${e.file}: known entry needs version, before and after sha256`);
        }
        if (!Array.isArray(e.inserts) || e.inserts.length === 0) refuse('MANIFEST_INVALID', `${e.file}: no inserts`);
        for (const ins of e.inserts) {
            if (typeof ins.anchor !== 'string' || !ins.anchor || typeof ins.text !== 'string' || !['after', 'replace'].includes(ins.mode)) {
                refuse('MANIFEST_INVALID', `${e.file}: an insert needs anchor, text and mode after|replace`);
            }
            if (!ins.text.includes(manifest.marker)) refuse('MANIFEST_INVALID', `${e.file}: an insert does not carry the marker ${JSON.stringify(manifest.marker)}`);
        }
    }
    for (const f of manifest.files) {
        if (!isHex64(f.sha256)) refuse('MANIFEST_INVALID', `${f.path}: sha256 is missing`);
        checkTarget(f.path);
    }
    if (!Array.isArray(manifest.watched)) refuse('MANIFEST_INVALID', 'manifest.json has no watched list');
    for (const w of manifest.watched) {
        checkTarget(w.file);
        if (typeof w.why !== 'string' || !w.why) refuse('MANIFEST_INVALID', `${w.file}: watched entry needs why`);
        if (!Array.isArray(w.known) || w.known.length === 0 || !w.known.every((k) => typeof k.version === 'string' && isHex64(k.sha256))) {
            refuse('MANIFEST_INVALID', `${w.file}: watched entry needs known [{version, sha256}]`);
        }
    }
    return manifest;
}

/** Sledovane soubory: overlay je nemeni, ale stavi na jejich vystupu - jiny otisk = build stop. */
export function checkWatched(src, manifest) {
    for (const w of manifest.watched) {
        const target = inside(src, w.file, 'watched file');
        if (!fs.existsSync(target)) refuse('WATCHED_FILE_CHANGED', `${w.file} does not exist in the tree (${w.why}) - the pin moved, re-measure the overlay`);
        const actual = sha256(fs.readFileSync(target));
        if (!w.known.some((k) => k.sha256 === actual)) {
            refuse('WATCHED_FILE_CHANGED', `${w.file} has sha256 ${actual}, known: ${w.known.map((k) => `${k.version} ${k.sha256}`).join(', ')} (${w.why}) - re-check toPrintableHtml against it and re-measure`);
        }
    }
}

/**
 * Ciste vlozky nad textem. Kazda kotva musi byt PRAVE JEDNOU v textu PRED zasahem (pocita se
 * nad puvodnim textem, aby vlozka nemohla vyrobit kotvu pro dalsi).
 */
export function applyInserts(text, inserts, file = '<file>') {
    for (const ins of inserts) {
        const count = text.split(ins.anchor).length - 1;
        if (count === 0) refuse('ANCHOR_MISSING', `${file}: anchor ${JSON.stringify(ins.anchor.slice(0, 80))} is not in the file`);
        if (count > 1) refuse('ANCHOR_AMBIGUOUS', `${file}: anchor ${JSON.stringify(ins.anchor.slice(0, 80))} occurs ${count} times`);
    }
    let out = text;
    for (const ins of inserts) {
        out = ins.mode === 'replace' ? out.replace(ins.anchor, () => ins.text) : out.replace(ins.anchor, () => ins.anchor + ins.text);
    }
    return out;
}

function readOverlayFile(overlayDir, rel) {
    const file = inside(overlayDir, rel, 'overlay file');
    if (!fs.existsSync(file)) refuse('OVERLAY_FILE_MISSING', `${rel} is listed in manifest.json but not in the overlay`);
    return fs.readFileSync(file);
}

/** Kontrola a priprava vsech upstream souboru PRED zapisem; vraci, co se ma zapsat. */
export function planEdits(src, manifest) {
    const writes = [];
    let done = 0;
    for (const e of manifest.edits) {
        const target = inside(src, e.file, 'edited file');
        if (!fs.existsSync(target)) refuse('MANIFEST_MISMATCH', `${e.file} does not exist in the tree - the pin moved, re-measure the overlay`);
        const body = fs.readFileSync(target);
        const actual = sha256(body);
        if (e.known.some((k) => k.after === actual)) {
            done += 1;
            continue;
        }
        const text = body.toString('utf8');
        const known = e.known.find((k) => k.before === actual);
        if (!known) {
            if (/'pdf'/.test(text)) refuse('UPSTREAM_HAS_PDF', `${e.file} already speaks of 'pdf' - upstream shipped a PDF export; remove this overlay instead of stacking on it`);
            const lf = sha256(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8'));
            if (e.known.some((k) => k.before === lf || k.after === lf)) {
                refuse('MANIFEST_MISMATCH', `${e.file} has CRLF line endings - upstream is LF; check the tree out with LF`);
            }
            refuse('MANIFEST_MISMATCH', `${e.file} has sha256 ${actual}, known: ${e.known.map((k) => `${k.version} ${k.before}`).join(', ')} - the pin moved or the file was edited; re-measure the overlay`);
        }
        const out = applyInserts(text, e.inserts, e.file);
        const got = sha256(Buffer.from(out, 'utf8'));
        if (got !== known.after) refuse('AFTER_MISMATCH', `${e.file} (${known.version}): the inserts give ${got}, expected ${known.after}`);
        writes.push({ target, out });
    }
    return { writes, done };
}

export function checkNewFiles(src, overlayDir, entries) {
    for (const f of entries) {
        const body = readOverlayFile(overlayDir, f.from);
        if (sha256(body) !== f.sha256) refuse('OVERLAY_FILE_CORRUPT', `${f.from} does not match its sha256 in manifest.json`);
        const target = inside(src, f.path, 'new file');
        if (fs.existsSync(target) && sha256(fs.readFileSync(target)) !== f.sha256) {
            refuse('NEW_FILE_COLLISION', `${f.path} already exists in the tree with other content - upstream may have shipped it; remove the overlay instead of stacking on it`);
        }
    }
}

function verify(src, manifest) {
    const problems = [];
    for (const e of manifest.edits) {
        const target = path.join(src, e.file);
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
        if (!e.known.some((k) => k.after === actual)) problems.push(`${e.file} is ${actual}, expected one of ${e.known.map((k) => k.after).join(', ')}`);
        else if (!fs.readFileSync(target, 'utf8').includes(manifest.marker)) problems.push(`${e.file} does not carry the marker`);
    }
    for (const f of manifest.files) {
        const target = path.join(src, f.path);
        const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : 'missing';
        if (actual !== f.sha256) problems.push(`${f.path} is ${actual}, expected ${f.sha256}`);
    }
    if (problems.length > 0) refuse('VERIFY_FAILED', `the tree does not carry the PDF overlay:\n  - ${problems.join('\n  - ')}`);
}

const USAGE = 'usage: apply-pdf-export-overlay.mjs <src-root> [--overlay-dir <dir>]';

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
    if (!fs.existsSync(path.join(src, 'package.json'))) refuse('BAD_USAGE', `${src} is not a client source tree (no package.json)`);
    return { src, overlayDir };
}

export function main(argv) {
    const { src, overlayDir } = parseArgs(argv);
    const manifest = loadManifest(overlayDir);
    checkWatched(src, manifest);
    const { writes, done } = planEdits(src, manifest);
    checkNewFiles(src, overlayDir, manifest.files);
    for (const w of writes) fs.writeFileSync(w.target, w.out);
    for (const f of manifest.files) {
        const target = inside(src, f.path, 'new file');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readOverlayFile(overlayDir, f.from));
    }
    verify(src, manifest);
    const state = writes.length === 0 ? 'already applied' : `${writes.length} edited${done ? `, ${done} already applied` : ''}`;
    return `PDF overlay OK: ${manifest.edits.length} upstream files (${state}), ${manifest.files.length} new files\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(main(process.argv.slice(2)));
    } catch (e) {
        if (e instanceof Refusal) {
            process.stderr.write(`PDF overlay REFUSED - ${e.message}\n`);
            process.exit(1);
        }
        process.stderr.write(`PDF overlay REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
        process.exit(1);
    }
}
