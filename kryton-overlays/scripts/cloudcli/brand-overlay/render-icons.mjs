#!/usr/bin/env node
/*
 * NASTROJ UDRZBARE - vyrenderuje sadu ikon Brain Chat do `assets/` (plan „CloudCLI theme
 * and brand", KTD8 radek „Icons"; U8). NESPOUSTI se pri stavbe obrazu: vystupy jsou
 * commitnute v `assets/` a jejich sha256 v `manifest.json` (polozky `assets`), takze
 * stavba nic nerenderuje a nepotrebuje `sharp`.
 *
 * CO VYROBI: presne soubory, ktere KTD8 jmenuje - `public/logo.svg`, `public/favicon.svg`,
 * `public/favicon.png`, `public/logo-{32,64,128,256,512}.png` a `public/icons/icon-<n>x<n>.
 * {png,svg}` pro velikosti upstreamoveho `public/generate-icons.js` (72 ... 512). NIKDY
 * loga poskytovatelu v `public/icons/` (claude-ai-icon.svg, codex*.svg, cursor*.svg).
 * Znacka = lucide `Brain` (cesty z `lucide-react` toho stromu, ISC) v barve `--brand-ink`
 * na dlazdici `--brand-tile` ze SVETLEHO bloku `files/src/brand/palette.css` (KTD10).
 * Logo a favicon maji zaoblenou dlazdici (25 % jako upstreamovy `generate-icons.js`),
 * PWA ikony jsou bez zaobleni - jsou `maskable` a zaobli je system (komentar upstreamove
 * `icon-template.svg`). PNG se rasterizuji `sharp` ZE STROMU CloudCLI (jeho zavislost,
 * ne nase - Red Dwarf tim nic nepridava), v rozmeru, ktery nese jmeno souboru.
 *
 * Pouziti (v naklonovanem pinu s `npm ci`):
 *   node render-icons.mjs --tree <cloudcli-tree> [--out <dir>]   (vychozi --out = ./assets)
 * Pak premer sha256 v `manifest.json` (polozky `assets`, pole `sha256`).
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Velikosti PWA ikon - stejne jako `sizes` v upstreamovem `public/generate-icons.js`. */
export const PWA_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
export const LOGO_SIZES = [32, 64, 128, 256, 512];

const fail = (msg) => {
    process.stderr.write(`render-icons FAILED - ${msg}\n`);
    process.exit(1);
};

/** `H S% L%` -> `#rrggbb`. */
export function hslToHex(triple) {
    const m = /^(-?[\d.]+) (-?[\d.]+)% (-?[\d.]+)%$/.exec(triple.trim());
    if (!m) throw new Error(`not an "H S% L%" triple: ${triple}`);
    const h = Number(m[1]);
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${[f(0), f(8), f(4)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Svetle `--brand-tile` a `--brand-ink` z prvniho bloku `:root` v palette.css. */
export function brandColours(paletteCss) {
    const root = /:root\s*\{([^}]*)\}/.exec(paletteCss.replace(/\/\*[\s\S]*?\*\//g, ''));
    if (!root) throw new Error('palette.css has no :root block');
    const pick = (name) => {
        const d = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root[1]);
        if (!d) throw new Error(`palette.css :root has no ${name}`);
        return hslToHex(d[1]);
    };
    return { tile: pick('--brand-tile'), ink: pick('--brand-ink') };
}

/** Cesty ikony `Brain` z lucide-react toho stromu (aby znacka byla ta, kterou kresli klient). */
export function lucideBrainPaths(tree) {
    const file = path.join(tree, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons', 'brain.js');
    if (!fs.existsSync(file)) throw new Error(`${file} is missing - run npm ci in the CloudCLI tree first`);
    const paths = [...fs.readFileSync(file, 'utf8').matchAll(/d:\s*"([^"]+)"/g)].map((m) => m[1]);
    if (paths.length === 0) throw new Error(`${file} declares no path`);
    return paths;
}

/** Jedna ikona: dlazdice + Brain (24x24 viewBox lucide, glyf zabira 2/3 dlazdice). */
export function iconSvg({ size, rounded, tile, ink, paths }) {
    const rx = rounded ? 6 : 0; // 25 % z 24, jako upstreamovy generate-icons.js
    const body = paths.map((d) => `    <path d="${d}"/>`).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
  <rect width="24" height="24" rx="${rx}" fill="${tile}"/>
  <g transform="translate(4 4) scale(0.6667)" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">
${body}
  </g>
</svg>
`;
}

/** Plan vystupu: relativni cesta -> { size, rounded, kind }. */
export function plan() {
    const out = {
        'public/logo.svg': { size: 32, rounded: true, kind: 'svg' },
        'public/favicon.svg': { size: 64, rounded: true, kind: 'svg' },
        'public/favicon.png': { size: 32, rounded: true, kind: 'png' },
    };
    for (const s of LOGO_SIZES) out[`public/logo-${s}.png`] = { size: s, rounded: true, kind: 'png' };
    for (const s of PWA_SIZES) {
        out[`public/icons/icon-${s}x${s}.svg`] = { size: s, rounded: false, kind: 'svg' };
        out[`public/icons/icon-${s}x${s}.png`] = { size: s, rounded: false, kind: 'png' };
    }
    return out;
}

async function main(argv) {
    let tree = null;
    let outDir = path.join(HERE, 'assets');
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--tree') tree = path.resolve(argv[++i] ?? '');
        else if (argv[i] === '--out') outDir = path.resolve(argv[++i] ?? '');
        else fail(`unexpected argument ${argv[i]}`);
    }
    if (!tree) fail('usage: render-icons.mjs --tree <cloudcli-tree> [--out <dir>]');
    // sharp is CloudCLI's own dependency (package.json of the pin); never ours.
    const sharp = createRequire(path.join(tree, 'package.json'))('sharp');
    const colours = brandColours(fs.readFileSync(path.join(HERE, 'files', 'src', 'brand', 'palette.css'), 'utf8'));
    const paths = lucideBrainPaths(tree);
    for (const [rel, spec] of Object.entries(plan())) {
        const svg = iconSvg({ ...spec, ...colours, paths });
        const target = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (spec.kind === 'svg') fs.writeFileSync(target, svg);
        // The svg's own width/height is the target size; resize() only pins it exactly.
        else fs.writeFileSync(target, await sharp(Buffer.from(svg)).resize(spec.size, spec.size).png({ compressionLevel: 9 }).toBuffer());
        process.stdout.write(`rendered ${rel} (${spec.size}x${spec.size})\n`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((e) => fail(e && e.stack ? e.stack : String(e)));
}
