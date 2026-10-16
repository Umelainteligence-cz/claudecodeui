/*
 * POLOVINY FORKOVEHO OVERLAYE - ktera cesta je server a co z ni tsc vyrobi.
 *
 * Forkovy overlay (hlas + kontextovy prstenec, `manifest.json` vedle) nese KLIENTA
 * (`src/**`, `public/**`, ...) i SERVER (`server/**` a `shared/**`). Polovina polozky
 * se NEUKLADA, odvozuje se z cesty (KTD4 planu
 * `docs/plans/2026-10-16-cloudcli-server-overlay-plan.md`): `server/` nebo `shared/`
 * = server, cokoli jineho = klient.
 *
 * `serverOutputs` mapuje serverovy zdroj na vystupy `npm run build:server` presne
 * tak, jak je pojmenuje tsc upstreamu (`server/tsconfig.json`: `rootDir ".."`,
 * `outDir` -> `dist-server`, `allowJs`, `sourceMap`):
 *   server/a/b.ts|.tsx|.js|.jsx -> dist-server/server/a/b.js + .js.map
 *   server/a/b.mts|.mjs         -> dist-server/server/a/b.mjs + .mjs.map
 *   server/a/b.cts|.cjs         -> dist-server/server/a/b.cjs + .cjs.map
 *   *.d.ts / *.d.mts / *.d.cts a cokoli jineho -> nic (tsc z toho JS nevyrobi)
 * Stejne pro `shared/**`. Pro klientskou cestu vraci prazdny seznam.
 *
 * Bez vedlejsich ucinku na urovni modulu: importuje ho `apply-voice-overlay.mjs`
 * (ten spousti CLI uz pri importu), `check-server-dist.mjs` i testy.
 */

/**
 * Soubory CESKEHO overlaye (`scripts/cloudcli/apply-cs-locale.mjs`): jeho kotvy v
 * `config.ts` a `languages.ts` a cesky locale `locales/cs/*.json`, ktery zapisuje z
 * `scripts/cloudcli/locale-cs/`. Forkovy overlay je nesmi nest - pri odstraneni
 * ceskeho overlaye by jinak cestina zustala viset na forkovem.
 */
const CZECH_OWNED_FILES = ['src/modules/i18n/config.ts', 'src/modules/i18n/languages.ts'];
export const CZECH_LOCALE_DIR = 'src/modules/i18n/locales/cs/';

export function isCzechOwned(file) {
    const p = String(file).replace(/\\/g, '/');
    return CZECH_OWNED_FILES.includes(p) || p.startsWith(CZECH_LOCALE_DIR);
}

/** Koreny zdroju, ktere preklada `npm run build:server`. */
const SERVER_ROOTS = ['server/', 'shared/'];

/** 'server' pro `server/**` a `shared/**`, jinak 'client'. */
export function halfOf(file) {
    const p = String(file).replace(/\\/g, '/');
    return SERVER_ROOTS.some((root) => p.startsWith(root)) ? 'server' : 'client';
}

const EMIT = [
    [/\.d\.(ts|mts|cts)$/, null],
    [/\.(ts|tsx|js|jsx)$/, '.js'],
    [/\.(mts|mjs)$/, '.mjs'],
    [/\.(cts|cjs)$/, '.cjs'],
];

/**
 * Vystupy serveroveho zdroje v `dist-server/` (cesty relativne ke koreni repa,
 * s predponou `dist-server/`). Klientska cesta nebo soubor, ze ktereho tsc nic
 * nevyrobi, vraci [].
 */
export function serverOutputs(file) {
    const p = String(file).replace(/\\/g, '/');
    if (halfOf(p) !== 'server') return [];
    for (const [re, ext] of EMIT) {
        if (re.test(p)) {
            if (ext === null) return [];
            const js = `dist-server/${p.replace(re, ext)}`;
            return [js, `${js}.map`];
        }
    }
    return [];
}

/**
 * Serverove polozky manifestu - JEDNA definice pro apply, export i dukaz:
 * `touched` = cesty patchu serverove poloviny, `added` = nove serverove soubory.
 */
export function serverEntryPaths(manifest) {
    const touched = (manifest.patches || []).map((p) => p.file).filter((f) => halfOf(f) === 'server');
    const added = (manifest.files || []).map((f) => f.path).filter((f) => halfOf(f) === 'server');
    return { touched, added };
}

/** Pocet serverovych polozek manifestu (patche + nove soubory) - pro souhrnne radky apply i exportu. */
export function serverEntryCount(manifest) {
    const { touched, added } = serverEntryPaths(manifest);
    return touched.length + added.length;
}
