#!/usr/bin/env node
/*
 * KONTROLA `dist` PO BUILDU KLIENTA (plan „CloudCLI theme and brand", KTD6 / U9).
 *
 * Paleta Brain Chat vyhrava nad tokeny upstreamu jen PORADIM VE ZDROJI: Tailwind v3
 * `@layer base` zkompiluje pryc, oba bloky `:root` maji stejnou specificitu, takze plati
 * ten posledni. Tenhle skript to dokazuje na HOTOVEM buildu: v `dist/assets/*.css` musi
 * POSLEDNI deklarace `--background` v pravidle `:root` nest svetlou hodnotu z
 * `palette.css`. Kdyby se import palety dostal pred `index.css` (nebo ho bundler
 * presunul), build spadne PALETTE_NOT_LAST, misto aby tise vyrobil upstreamove barvy.
 *
 * Druha kontrola (U9, KTD8 „Document title"): `dist/index.html` musi nest presne
 * `<title>Brain Chat</title>` - jinak TITLE_NOT_BRAND (napr. vite vzal index.html bez
 * upravy brand overlaye).
 *
 * Pouziti:  node check-dist.mjs <dist-dir> [--palette <palette.css>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TITLE = '<title>Brain Chat</title>';

const fail = (reason, detail) => {
    process.stderr.write(`brand dist check FAILED - ${reason}: ${detail}\n`);
    process.exit(1);
};

/** Vsechny hodnoty `--background` v pravidlech se selektorem presne `:root`, v poradi. */
function rootBackgrounds(css) {
    const out = [];
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/(?<=^|[}{;])\s*:root\s*\{([^{}]*)\}/g)) {
        for (const d of m[1].matchAll(/--background\s*:\s*([^;}]+)/g)) out.push(d[1].trim());
    }
    return out;
}

const norm = (v) => v.trim().split(/\s+/).map((t) => {
    const m = /^(-?[\d.]+)(%?)$/.exec(t);
    return m ? `${Number(m[1])}${m[2]}` : t;
}).join(' ');

function main(argv) {
    let dist = null;
    let palette = path.join(HERE, 'files', 'src', 'brand', 'palette.css');
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--palette') palette = path.resolve(argv[++i] ?? '');
        else if (dist === null) dist = path.resolve(argv[i]);
        else fail('BAD_USAGE', `unexpected argument ${argv[i]}`);
    }
    if (!dist) fail('BAD_USAGE', 'usage: check-dist.mjs <dist-dir> [--palette <palette.css>]');

    const indexHtml = path.join(dist, 'index.html');
    const html = fs.existsSync(indexHtml) ? fs.readFileSync(indexHtml, 'utf8') : '';
    if (!html.includes(TITLE)) {
        const found = /<title>[\s\S]*?<\/title>/.exec(html);
        fail('TITLE_NOT_BRAND', `${indexHtml} does not carry ${TITLE} (found ${found ? found[0] : 'no <title>'}) - the brand overlay's index.html edit did not reach the build`);
    }
    process.stdout.write(`brand dist check: title OK (${TITLE})\n`);

    const paletteRoots = rootBackgrounds(fs.readFileSync(palette, 'utf8'));
    if (paletteRoots.length !== 1) fail('BAD_PALETTE', `${palette} must declare --background in :root exactly once`);
    const expected = paletteRoots[0];

    const assets = path.join(dist, 'assets');
    const cssFiles = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => f.endsWith('.css')).sort() : [];
    if (cssFiles.length === 0) fail('NO_CSS', `${assets} holds no .css file`);

    // Load order BETWEEN css files is not visible here, so the tokens must live in one.
    const holders = cssFiles
        .map((f) => ({ file: f, all: rootBackgrounds(fs.readFileSync(path.join(assets, f), 'utf8')) }))
        .filter((h) => h.all.length > 0);
    if (holders.length === 0) fail('NO_ROOT_BACKGROUND', `no :root { --background } in ${cssFiles.join(', ')}`);
    if (holders.length > 1) fail('AMBIGUOUS_ORDER', `:root --background is declared in ${holders.map((h) => h.file).join(' and ')} - the order between files cannot be proven`);
    const last = { ...holders[0], value: holders[0].all[holders[0].all.length - 1] };
    if (norm(last.value) !== norm(expected)) {
        fail('PALETTE_NOT_LAST', `the last :root --background in ${last.file} is "${last.value}", the palette's light value is "${expected}" `
            + `(all :root values in order: ${last.all.join(' | ')}) - the palette import must come after index.css`);
    }
    process.stdout.write(`brand dist check: palette order OK (${last.file}: last :root --background = ${last.value})\n`);
}

main(process.argv.slice(2));
