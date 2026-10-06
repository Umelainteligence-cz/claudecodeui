#!/usr/bin/env node
/*
 * GENERATOR PALETY Brain Chat (plan „CloudCLI theme and brand", U7, KTD6 + KTD10).
 *
 * CO DELA: precte snimek `palette.source.json` (oklch hodnoty tematu `schejbal-legal`
 * ze Schejbal OS) a napise `files/src/brand/palette.css` - bloky `:root { ... }` a
 * `.dark { ... }` s nazvy tokenu CloudCLI v jeho formatu Tailwind v3 (`H S% L%`, bez
 * obalu `hsl()`), `color-scheme` k obema rezimum (R7), sklenene `--nav-*` tokeny
 * prestavene z namapovanych zakladnich tokenu pri alfach upstreamu
 * (`src/index.css:47-57`, `:108-118` v pinu) a dvojici `--brand-tile` / `--brand-ink`.
 *
 * PREVOD: oklch -> OKLab -> linearni sRGB -> sRGB -> HSL, zaokrouhleno na jedno
 * desetinne misto. Hodnota mimo gamut sRGB (kanal mimo [0, 1] o vic nez toleranci
 * zaokrouhleni) je OUT_OF_GAMUT a generator skonci 1 a NIC nezapise - tichy clamp by
 * zmenil barvu, kterou nikdo neschvalil.
 *
 * `palette.css` je commitnuty a hlida ho test drift (`scripts/cloudcli-brand-overlay.test.js`):
 * po kazde zmene snimku sem pust generator a preriznout manifest (sha256 souboru).
 *
 * Pouziti:  node generate-palette.mjs [--source <json>] [--out <css> | --stdout]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** R5: tokeny CloudCLI, ktere paleta nastavi (az na CLOUDCLI_FROM 1:1 podle jmena). */
export const R5_TOKENS = [
    '--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground',
    '--primary', '--primary-foreground', '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
    '--accent', '--accent-foreground', '--destructive', '--destructive-foreground', '--border', '--input', '--ring',
];

/**
 * MAPOVANI PODLE VYZNAMU, NE PODLE JMENA - zaznamenana odchylka od KTD6 „1:1 by name"
 * (rozhodnuti koordinatora z povereni vlastnika, 2026-10-06). CloudCLI pouziva `--accent`
 * jako NEUTRALNI povrch pro hover a vybrany radek (upstream ma accent == secondary ==
 * muted), `schejbal-legal` ma `--accent` jako fialove zvyrazneni. Podle jmena mel vybrany
 * radek postranniho panelu (`bg-accent` s `text-foreground` / `text-muted-foreground`)
 * v tmavem rezimu namerene 2.99:1 a 1.04:1. Proto se CloudCLI token bere z tokenu
 * snimku se stejnym VYZNAMEM, v obou rezimech. Snimek si `--accent` a `--accent-foreground`
 * nechava beze zmeny: je to verna kopie tematu a cte ho tripwire na strane Schejbal OS.
 */
export const CLOUDCLI_FROM = {
    '--accent': '--muted',
    '--accent-foreground': '--foreground',
};

/**
 * Sklenene `--nav-*` tokeny: [jmeno, zakladni token, alfa svetle, alfa tmave].
 * Zaklad je token, jehoz hodnotu ma upstream v pinu (svetle i tmave); kde upstream
 * pouziva hodnotu sdilenou vic tokeny (`muted` = `secondary` = `accent`), vybran je
 * vyznamove nejblizsi. `--nav-float-shadow` zustava cerny (upstream), `--nav-glass-blur`
 * a `--nav-glass-saturate` nejsou barvy.
 */
export const NAV_TOKENS = [
    ['--nav-glass-bg', { light: '--background', dark: '--card' }, 0.7, 0.55],
    ['--nav-tab-glow', '--primary', 0.18, 0.25],
    ['--nav-tab-ring', '--primary', 0.10, 0.15],
    ['--nav-float-ring', '--border', 0.5, 0.3],
    ['--nav-divider-color', '--border', 0.5, 0.5],
    ['--nav-input-bg', '--muted', 0.5, 0.5],
    ['--nav-input-focus-ring', '--ring', 0.22, 0.25],
];

/** Tolerance zaokrouhleni v sRGB [0, 1]: vstup na 2-3 desetinna mista se smi minout o tolik. */
const GAMUT_EPSILON = 0.0005;

class Refusal extends Error {
    constructor(reason, detail) {
        super(`${reason}: ${detail}`);
        this.reason = reason;
    }
}
const refuse = (reason, detail) => {
    throw new Refusal(reason, detail);
};

function parseOklch(value) {
    const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(String(value));
    if (!m) refuse('BAD_VALUE', `${JSON.stringify(value)} is not an opaque oklch(L C H) value`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** oklch -> sRGB v [0, 1] (bez clampu); vraci i to, kolik chybi do gamutu. */
export function oklchToSrgb(value) {
    const [L, C, H] = parseOklch(value);
    const h = (H * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
    const gamma = (x) => (Math.abs(x) <= 0.0031308 ? 12.92 * x : Math.sign(x) * (1.055 * Math.abs(x) ** (1 / 2.4) - 0.055));
    return lin.map(gamma);
}

/**
 * oklch -> `H S% L%` (jedno desetinne misto). Mimo gamut = Refusal OUT_OF_GAMUT, ledaze
 * volajici vyslovne povoli orez (`allowClip`, jen pro polozky `gamutClip` snimku) - pak
 * se kanaly oriznou do [0, 1] jako to dela prohlizec; povoleny orez hodnoty, ktera
 * v gamutu JE, je STALE_CLIP (seznam nesmi zastarat potichu).
 */
export function oklchToHsl(value, { allowClip = false } = {}) {
    const rgb = oklchToSrgb(value);
    const worst = Math.max(...rgb.map((c) => Math.max(0 - c, c - 1, 0)));
    if (allowClip && worst <= GAMUT_EPSILON) {
        refuse('STALE_CLIP', `${value} is inside sRGB - remove it from gamutClip`);
    }
    if (worst > GAMUT_EPSILON && !allowClip) {
        refuse('OUT_OF_GAMUT', `${value} lies outside sRGB by ${worst.toFixed(4)} (tolerance ${GAMUT_EPSILON}) - a clamp would change the colour`);
    }
    const [r, g, b] = rgb.map((c) => Math.min(1, Math.max(0, c)));
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let hue = 0;
    let sat = 0;
    if (d > 1e-9) {
        sat = d / (1 - Math.abs(2 * l - 1));
        if (max === r) hue = ((g - b) / d) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
    }
    const one = (x) => {
        const v = Math.round(x * 10) / 10;
        return (Object.is(v, -0) ? 0 : v).toFixed(1);
    };
    let H = one(hue);
    if (H === '360.0') H = '0.0';
    return `${H} ${one(sat * 100)}% ${one(l * 100)}%`;
}

function modeBlock(source, mode) {
    const vars = source.variables && source.variables[mode];
    if (!vars || typeof vars !== 'object') refuse('BAD_SOURCE', `palette.source.json has no variables.${mode}`);
    const hsl = {};
    const clip = source.gamutClip || {};
    const convert = (token) => {
        if (!(token in vars)) refuse('BAD_SOURCE', `variables.${mode} has no ${token}`);
        try {
            return oklchToHsl(vars[token], { allowClip: Object.hasOwn(clip, `${mode} ${token}`) });
        } catch (e) {
            if (e instanceof Refusal) refuse(e.reason, `${mode} ${token}: ${e.message}`);
            throw e;
        }
    };
    for (const t of R5_TOKENS) hsl[t] = convert(CLOUDCLI_FROM[t] || t);
    const brand = source.brand || {};
    for (const t of ['--brand-tile', '--brand-ink']) {
        if (!brand[t]) refuse('BAD_SOURCE', `palette.source.json brand has no ${t}`);
        hsl[t] = convert(brand[t]);
    }
    const lines = [`  color-scheme: ${mode};`, ''];
    for (const t of R5_TOKENS) {
        if (CLOUDCLI_FROM[t]) lines.push(`  /* ${t} <- ${CLOUDCLI_FROM[t]}: CloudCLI's accent is a neutral hover/selected surface (meaning over name). */`);
        lines.push(`  ${t}: ${hsl[t]};`);
    }
    lines.push('', '  /* Nav glass, rebuilt from the mapped tokens at upstream\'s alphas. */');
    for (const [name, base, aLight, aDark] of NAV_TOKENS) {
        const from = typeof base === 'string' ? base : base[mode];
        const alpha = mode === 'light' ? aLight : aDark;
        lines.push(`  ${name}: ${hsl[from]} / ${alpha.toFixed(2).replace(/0$/, '')};`);
    }
    lines.push('', '  /* Brain Chat mark: the teal of the app\'s Brain Chat tab (KTD10). */');
    lines.push(`  --brand-tile: ${hsl['--brand-tile']};`, `  --brand-ink: ${hsl['--brand-ink']};`);
    return lines.join('\n');
}

/** Cely text palette.css ze snimku. */
export function renderPalette(source) {
    const src = source.source || {};
    for (const key of Object.keys(source.gamutClip || {})) {
        const [mode, token] = key.split(' ');
        if (!source.variables?.[mode] || !(token in source.variables[mode])) refuse('BAD_SOURCE', `gamutClip names ${key}, which is not in variables`);
    }
    return [
        '/*',
        ' * GENERATED by scripts/cloudcli/brand-overlay/generate-palette.mjs - DO NOT EDIT.',
        ` * Theme ${source.theme} from ${src.repo}@${String(src.commit).slice(0, 9)} (palette.source.json).`,
        ' * Imported directly after index.css (src/main.tsx), so these blocks win by source',
        ' * order: Tailwind v3 compiles @layer base away (KTD6).',
        ' */',
        ':root {',
        modeBlock(source, 'light'),
        '}',
        '',
        '.dark {',
        modeBlock(source, 'dark'),
        '}',
        '',
    ].join('\n');
}

function main(argv) {
    let sourceFile = path.join(HERE, 'palette.source.json');
    let out = path.join(HERE, 'files', 'src', 'brand', 'palette.css');
    let toStdout = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--source') sourceFile = path.resolve(argv[++i] ?? refuse('BAD_USAGE', '--source needs a file'));
        else if (a === '--out') out = path.resolve(argv[++i] ?? refuse('BAD_USAGE', '--out needs a file'));
        else if (a === '--stdout') toStdout = true;
        else refuse('BAD_USAGE', `unknown argument ${a} - usage: generate-palette.mjs [--source <json>] [--out <css> | --stdout]`);
    }
    let source;
    try {
        source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    } catch (e) {
        refuse('BAD_SOURCE', `${sourceFile} does not read as JSON (${e.message})`);
    }
    const css = renderPalette(source);
    if (toStdout) {
        process.stdout.write(css);
        return;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, css);
    process.stdout.write(`palette written: ${path.relative(process.cwd(), out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(`palette generator REFUSED - ${e instanceof Refusal ? e.message : (e && e.stack) || e}\n`);
        process.exit(1);
    }
}
