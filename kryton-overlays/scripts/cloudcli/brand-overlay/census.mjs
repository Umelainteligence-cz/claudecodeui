#!/usr/bin/env node
/*
 * CENSUS ZNACKY CloudCLI KLIENTA (plan „CloudCLI theme and brand", KTD15 / U9).
 *
 * Bezi ve stage `cloudcli-client` po buildu a testech, nad stromem PO brand overlayi.
 * Hleda kazdy vyskyt `/CloudCLI|Claude (Code )?UI/` v tom, co builder muze uvidet:
 *   - `src/**\/*.{ts,tsx}` - BEZ komentaru a bez `**\/tests/**`;
 *   - kazdy locale JSON (`src/**\/locales/**\/*.json`) - jen HODNOTY, klicem je cesta
 *     klicu (`app.title`), protoze jmeno klice se nevykresluje;
 *   - `index.html` a `public/**\/*.{html,json,js}` (HTML bez `<!-- -->`, JS bez komentaru).
 * Kazdy zasah musi byt na allow-listu (`census-allow.json`): JSON podle cesty souboru
 * (`*` = jeden segment, napr. adresar locale) + cesty klicu, kod a HTML podle souboru +
 * literalu, ktery zasah obsahuje - NIKDY podle cisla radku. Kazda polozka nese duvod
 * z KTD8. Zasah mimo seznam = UNLISTED_BRAND_HIT, polozka, kterou nic netrefi =
 * ALLOW_ENTRY_UNUSED (seznam nesmi tise bobtnat); obojí exit 1 se seznamem.
 *
 * Pozitivni kontrola: nad NEUPRAVENYM pinem census spadne a vypise zasahy (sidebar, titulek,
 * manifest, sw.js, ...); merila to sucha zkouska, viz popis PR.
 *
 * Odstranovani komentaru je lexer bez zavislosti: retezce '…' a "…" konci na konci radku
 * (jako u JS), takze chybne precteny apostrof v JSX textu poskodi nejvys jeden radek.
 * Komentare se nahrazuji mezerami, takze pozice zasahu sedi na puvodni text.
 * Co se maze (M1 z revize): blokovy komentar a `//` do konce radku - ale NEJISTOTA SE
 * ROZHODUJE K POCITANI (falesne cerveny build je videt a vyresi se, tichy pruchod by vydal
 * stare jmeno):
 *   - `//` hned za `:` neni nikdy komentar (schema URL, `https://`), v zadnem typu souboru;
 *   - v `.tsx` otevre `//` nebo `/*` komentar jen tehdy, kdyz je nejblizsi predchozi
 *     neprazdny znak na tomtez radku nic (zacatek radku) nebo jeden z `; , { } ( ) [ ] =`;
 *     cokoli jineho (slovo, `>`, text bez uvozovek) muze byt JSX text a zustane. JSX
 *     komentar `{/* … *\/}` dal funguje. Zbytek: `<p>{n}, // CloudCLI</p>` se smaze dal
 *     (v pinu 1.37.3 zadny takovy neni; plan M1, odlozeno);
 *   - `.ts`, `public/*.js` a `<script>` v HTML (bez JSX) jako drive, krome pravidla `:`.
 *
 * Pouziti:  node census.mjs <src-root> [--allow <census-allow.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATTERN = /CloudCLI|Claude (Code )?UI/g;

const fail = (reason, lines) => {
    process.stderr.write(`brand census FAILED - ${reason}:\n  - ${lines.join('\n  - ')}\n`);
    process.exit(1);
};

// ---------------------------------------------------------------------------
// Komentare pryc (se zachovanim pozic).
// ---------------------------------------------------------------------------

const REGEX_BEFORE = new Set([...'(,=:[!&|?{};+-*%<>~^']);

// In .tsx a comment may open only after one of these (or at line start), see the header.
const JSX_COMMENT_AFTER = new Set([...';,{}()[]=']);

/** The nearest non-blank character before `i` on the same line, '' at line start. */
function prevOnLine(text, i) {
    for (let k = i - 1; k >= 0; k -= 1) {
        const ch = text[k];
        if (ch === '\n') return '';
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') return ch;
    }
    return '';
}

/** Is the `//` or `/*` at `i` text rather than a comment? Uncertain = text (M1). */
function slashesAreText(text, i, jsx) {
    if (text[i + 1] === '/' && text[i - 1] === ':') return true;
    if (!jsx) return false;
    const prev = prevOnLine(text, i);
    return prev !== '' && !JSX_COMMENT_AFTER.has(prev);
}

/**
 * JS/TS: komentare -> mezery (konce radku zustanou). `jsx: true` pro `.tsx`: komentar
 * jen tam, kde nemuze byt JSX text (viz hlavicka).
 */
export function stripJsComments(text, { jsx = false } = {}) {
    const out = text.split('');
    const blank = (from, to) => {
        for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
    };
    let i = 0;
    let lastSignificant = '';
    while (i < text.length) {
        const c = text[i];
        const n = text[i + 1];
        if (c === '/' && (n === '/' || n === '*') && slashesAreText(text, i, jsx)) {
            // A URL scheme or JSX text: keep it and count what follows.
            i += 2;
            lastSignificant = '/';
        } else if (c === '/' && n === '/') {
            const end = text.indexOf('\n', i);
            const stop = end === -1 ? text.length : end;
            blank(i, stop);
            i = stop;
        } else if (c === '/' && n === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2;
            blank(i, stop);
            i = stop;
        } else if (c === '"' || c === "'") {
            i += 1;
            while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
            i += 1;
            lastSignificant = c;
        } else if (c === '`') {
            i += 1;
            while (i < text.length && text[i] !== '`') i += text[i] === '\\' ? 2 : 1;
            i += 1;
            lastSignificant = c;
        } else if (c === '/' && (lastSignificant === '' || REGEX_BEFORE.has(lastSignificant))) {
            // A regex literal: skip it whole (a `'` or `//` inside must not open anything).
            i += 1;
            let inClass = false;
            while (i < text.length && text[i] !== '\n') {
                if (text[i] === '\\') i += 1;
                else if (text[i] === '[') inClass = true;
                else if (text[i] === ']') inClass = false;
                else if (text[i] === '/' && !inClass) break;
                i += 1;
            }
            i += 1;
            lastSignificant = '/';
        } else {
            if (!/\s/.test(c)) lastSignificant = c;
            i += 1;
        }
    }
    return out.join('');
}

/** HTML: `<!-- … -->` -> mezery; vlozene `<script>` bez JS komentaru. */
export function stripHtmlComments(text) {
    let out = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => `${open}${stripJsComments(body)}${close}`);
    return out;
}

// ---------------------------------------------------------------------------
// Sber zasahu.
// ---------------------------------------------------------------------------

function walk(root, rel, visit) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            walk(root, child, visit);
        } else if (entry.isFile()) visit(child);
    }
}

function jsonLeaves(value, prefix, out) {
    if (typeof value === 'string') out.push({ key: prefix, value });
    else if (Array.isArray(value)) value.forEach((v, i) => jsonLeaves(v, prefix ? `${prefix}.${i}` : String(i), out));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) jsonLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
}

/** Vrati { textFiles: [{file, text}], jsonFiles: [{file, leaves}] } k prohledani. */
export function collect(src) {
    const textFiles = [];
    const jsonFiles = [];
    const addJson = (file) => {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
        } catch (e) {
            fail('UNREADABLE_JSON', [`${file} does not parse (${e.message})`]);
        }
        jsonFiles.push({ file, leaves: jsonLeaves(data, '', []) });
    };
    walk(src, 'src', (file) => {
        if (/(^|\/)tests\//.test(file)) return;
        if (/\.(ts|tsx)$/.test(file)) textFiles.push({ file, text: stripJsComments(fs.readFileSync(path.join(src, file), 'utf8'), { jsx: file.endsWith('.tsx') }) });
        else if (/\/locales\/.*\.json$/.test(file)) addJson(file);
    });
    if (fs.existsSync(path.join(src, 'index.html'))) {
        textFiles.push({ file: 'index.html', text: stripHtmlComments(fs.readFileSync(path.join(src, 'index.html'), 'utf8')) });
    }
    walk(src, 'public', (file) => {
        if (file.endsWith('.json')) addJson(file);
        else if (file.endsWith('.html')) textFiles.push({ file, text: stripHtmlComments(fs.readFileSync(path.join(src, file), 'utf8')) });
        else if (file.endsWith('.js')) textFiles.push({ file, text: stripJsComments(fs.readFileSync(path.join(src, file), 'utf8')) });
    });
    return { textFiles, jsonFiles };
}

// ---------------------------------------------------------------------------
// Allow-list.
// ---------------------------------------------------------------------------

export function loadAllow(file) {
    let allow;
    try {
        allow = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        fail('ALLOW_LIST_INVALID', [`${file} does not parse (${e.message})`]);
    }
    const problems = [];
    if (!Array.isArray(allow.json) || !Array.isArray(allow.code)) problems.push('the allow-list needs a json and a code list');
    for (const e of allow.json || []) {
        if (typeof e.key !== 'string' || !/^[^:]+\.json:[^:]+$/.test(e.key)) problems.push(`json entry ${JSON.stringify(e)}: key must be <file.json>:<key.path>`);
        if (typeof e.reason !== 'string' || e.reason.trim().length < 10) problems.push(`json entry ${JSON.stringify(e.key)} carries no reason`);
    }
    for (const e of allow.code || []) {
        if (typeof e.file !== 'string' || typeof e.literal !== 'string' || !e.literal) problems.push(`code entry ${JSON.stringify(e)}: needs file and literal`);
        if (typeof e.reason !== 'string' || e.reason.trim().length < 10) problems.push(`code entry ${JSON.stringify(e.file)} ${JSON.stringify(e.literal)} carries no reason`);
    }
    if (problems.length > 0) fail('ALLOW_LIST_INVALID', problems);
    return allow;
}

const segmentGlob = (pattern) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function census(src, allow) {
    const { textFiles, jsonFiles } = collect(src);
    const unlisted = [];
    let allowed = 0;
    const used = new Set();

    const jsonRules = allow.json.map((e) => {
        const at = e.key.indexOf(':');
        return { entry: e, file: segmentGlob(e.key.slice(0, at)), key: e.key.slice(at + 1) };
    });
    for (const { file, leaves } of jsonFiles) {
        for (const { key, value } of leaves) {
            const hits = value.match(PATTERN);
            if (!hits) continue;
            const rule = jsonRules.find((r) => r.key === key && r.file.test(file));
            if (rule) {
                allowed += hits.length;
                used.add(rule.entry);
            } else unlisted.push(`${file}:${key} = ${JSON.stringify(value)}`);
        }
    }
    for (const { file, text } of textFiles) {
        const ranges = [];
        for (const e of allow.code.filter((x) => x.file === file)) {
            for (let at = text.indexOf(e.literal); at !== -1; at = text.indexOf(e.literal, at + 1)) ranges.push({ e, from: at, to: at + e.literal.length });
        }
        for (const m of text.matchAll(PATTERN)) {
            const r = ranges.find((x) => m.index >= x.from && m.index + m[0].length <= x.to);
            if (r) {
                allowed += 1;
                used.add(r.e);
            } else {
                const line = text.split('\n')[lineOf(text, m.index) - 1].trim();
                unlisted.push(`${file} (line ${lineOf(text, m.index)}): "${m[0]}" in ${JSON.stringify(line.length > 160 ? `${line.slice(0, 160)}…` : line)}`);
            }
        }
    }
    const unused = [...allow.json.filter((e) => !used.has(e)).map((e) => `json ${e.key}`),
        ...allow.code.filter((e) => !used.has(e)).map((e) => `code ${e.file} ${JSON.stringify(e.literal)}`)];
    return { allowed, unlisted, unused };
}

function main(argv) {
    let src = null;
    let allowFile = path.join(HERE, 'census-allow.json');
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--allow') allowFile = path.resolve(argv[++i] ?? '');
        else if (src === null) src = path.resolve(argv[i]);
        else fail('BAD_USAGE', [`unexpected argument ${argv[i]}`]);
    }
    if (!src) fail('BAD_USAGE', ['usage: census.mjs <src-root> [--allow <census-allow.json>]']);
    if (!fs.existsSync(path.join(src, 'src'))) fail('BAD_USAGE', [`${src} has no src/ - not a CloudCLI tree`]);
    const allow = loadAllow(allowFile);
    const { allowed, unlisted, unused } = census(src, allow);
    if (unlisted.length > 0) {
        fail('UNLISTED_BRAND_HIT', [`${unlisted.length} hit(s) of ${PATTERN} are not on ${path.basename(allowFile)} - brand them (KTD8) or allow-list them with a reason:`, ...unlisted]);
    }
    if (unused.length > 0) {
        fail('ALLOW_ENTRY_UNUSED', [`${unused.length} allow-list entr(y/ies) match nothing - remove them (the upstream string moved or went away):`, ...unused]);
    }
    process.stdout.write(`brand census OK: ${allowed} allow-listed hits, 0 unlisted\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
