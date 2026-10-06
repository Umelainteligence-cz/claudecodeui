#!/usr/bin/env node
/*
 * DOCASNY CESKY OVERLAY CloudCLI KLIENTA.
 *
 * CO DELA: vezme osm ceskych souboru z `locale-cs/` vedle sebe, nasype je do
 * cerstve naklonovaneho upstream stromu (`<src>/src/modules/i18n/locales/cs/`)
 * a pripise `cs` do dvou upstream souboru - `config.ts` (importy + blok
 * `resources`) a `languages.ts` (polozka jazyka). Bezi ve stage
 * `cloudcli-client` v `Dockerfile.server`, mezi klonem a `npm run build:client`.
 *
 * PROC EXISTUJE: `Dockerfile.server` stavi klienta z PINOVANEHO commitu
 * (v1.37.3 = 70e5785). Upstream v tom commitu cestinu nema, takze stavitel by
 * v ramu videl anglictinu. Vlastnik (Miroslav) rozhodl 23. 9. 2026, ze si ji do
 * vlastniho buildu pridame drive, nez ji vyda upstream.
 *
 * KDY SE TENHLE SOUBOR SMAZE: jakmile upstream vyda verzi, ktera `cs` nese sama.
 * Bump pinu v `Dockerfile.server` je zaroven odstranenim overlaye - skript, adresar
 * `locale-cs/`, obe `COPY` a `RUN` ve stage `cloudcli-client`, radek v rosteru
 * `.github/workflows/scripts-test-gate.yml`, `scripts/cloudcli-cs-overlay.test.js`
 * a odstavec v `docs/runbooks/2026-09-12-cloudcli-subdomain.md`. Az do te doby
 * plati amendment ADR 0191 sekce 5 („CloudCLI bezi nezmenene") - Schejbal OS.
 *
 * LICENCE (AGPL-3.0-or-later): CloudCLI je AGPL-3.0-or-later, takze nase uprava
 * MUSI byt verejne dostupna. Je: `mmmirusss/claudecodeui`, vetev `feat/i18n-czech`,
 * a upstream PR siteboon/claudecodeui#1384. To je nabidka zdroje - kdyz se meni
 * obsah `locale-cs/`, meni se i ta vetev.
 *
 * KAZDE PREKVAPENI JE CERVENE, ZAMERNE. Chybejici kotva, kotva vickrat, cizi `cs`
 * uz ve stromu, chybejici nebo rozbity cesky soubor, nebo overeni po zasahu, ktere
 * `cs` nenajde - vsechno konci `exit 1`. BUMP PINU, KTERY TYHLE SOUBORY POSUNE,
 * MUSI BUILD POLOZIT, ne tise vypustit cestinu: zeleny build s anglickym ramem je
 * horsi nez cerveny build, protoze si ho nikdo nevsimne.
 *
 * IDEMPOTENTNI: druhy beh nad uz zasazenym stromem nic nezmeni a skonci nulou.
 * Rozpoznava se podle znacky, kterou skript sam zapisuje (MARKER nize) - `cs`,
 * ktere tam je BEZ ni, je cizi a je to duvod k odmitnuti, ne k prepsani.
 *
 * Ciste Node 22, nula zavislosti: stage `cloudcli-client` ma jen node a git.
 *
 * Pouziti:  node apply-cs-locale.mjs <src-root> [--locale-dir <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Znacka, podle ktere skript pozna VLASTNI zasah. Nesmi se menit bez duvodu. */
const MARKER = 'KRYTON-CS-OVERLAY';

/** Poradi odpovida anglickemu bloku v `config.ts` pinu. */
const NAMESPACES = ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks', 'git'];

/** `common` -> `csCommon`, `codeEditor` -> `csCodeEditor`. */
const importName = (ns) => `cs${ns[0].toUpperCase()}${ns.slice(1)}`;

// ---------------------------------------------------------------------------
// Kotvy. Doslovne z pinu v1.37.3 (70e5785). Kazda musi byt ve svem souboru
// PRAVE JEDNOU - jinak nevime, kam sahame.
// ---------------------------------------------------------------------------

/** `config.ts`: posledni radek anglickeho bloku importu. Za nej jdou ceske. */
const CONFIG_IMPORT_ANCHOR = "import enGit from '@/modules/i18n/locales/en/git.json';\n";

/** `config.ts`: zacatek mapy `resources`. Cesky blok jde PRED anglicky. */
const CONFIG_RESOURCES_ANCHOR = '    resources: {\n      en: {\n';

/** `languages.ts`: polozka anglictiny. Ceska jde hned za ni. */
const LANGUAGES_EN_ENTRY = [
    '  {',
    "    value: 'en',",
    "    label: 'English',",
    "    nativeName: 'English',",
    '  },',
    '',
].join('\n');

/** `languages.ts`: anglictina MUSI byt prvni polozka pole - na tom kotva stoji. */
const LANGUAGES_LIST_OPEN = 'export const languages: Language[] = [\n';

// ---------------------------------------------------------------------------
// Odmitnuti. Kazde nese POJMENOVANY duvod - log z buildu je jedine, co po sobe
// stage `cloudcli-client` nechava.
// ---------------------------------------------------------------------------

class Refusal extends Error {
    constructor(reason, detail) {
        super(`${reason}: ${detail}`);
        this.reason = reason;
    }
}

const refuse = (reason, detail) => {
    throw new Refusal(reason, detail);
};

// KONCE RADKU. Kotvy vyse jsou psane s LF, protoze upstream repozitar je LF a
// `git checkout` ve stage `cloudcli-client` (linuxovy `node:22-bookworm-slim`,
// `core.autocrlf` nenastaveno) da LF. Checkout na Windows s `autocrlf=true` ale
// da CRLF a kotva by se nenasla - skript by polozil build z duvodu, ktery s
// cestinou nema nic spolecneho. Proto se kotvy i vkladane bloky prevedou na
// konec radku, ktery ten SOUBOR opravdu ma; zbytek souboru se nesaha, takze
// smiseny soubor si sve radky ponecha bajtove tak, jak byly.
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const toEol = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, '\r\n'));
const toLf = (text) => text.replace(/\r\n/g, '\n');

/** Pocet vyskytu `needle` v `haystack` - kotva se overuje na ROVNOST jedne. */
function occurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
}

function requireExactlyOnce(text, needle, where, what) {
    const n = occurrences(text, needle);
    if (n === 0) refuse('ANCHOR_MISSING', `${where}: ${what} not found - the pin moved, teach this script before bumping it`);
    if (n > 1) refuse('ANCHOR_AMBIGUOUS', `${where}: ${what} found ${n} times - refusing to guess which one to patch`);
}

function readFileOrRefuse(file, where) {
    if (!fs.existsSync(file)) refuse('SOURCE_FILE_MISSING', `${where} does not exist at ${file}`);
    return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// Ceske soubory.
// ---------------------------------------------------------------------------

function flatKeyCount(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 1;
    let n = 0;
    for (const v of Object.values(value)) n += flatKeyCount(v);
    return n;
}

/** Nacte a zkontroluje vsech osm ceskych souboru. Chybejici JEDEN je odmitnuti. */
function loadLocaleFiles(localeDir) {
    if (!fs.existsSync(localeDir)) refuse('LOCALE_FILE_MISSING', `the overlay directory ${localeDir} does not exist`);
    const files = [];
    let keys = 0;
    for (const ns of NAMESPACES) {
        const file = path.join(localeDir, `${ns}.json`);
        if (!fs.existsSync(file)) refuse('LOCALE_FILE_MISSING', `${ns}.json is not in ${localeDir} - the Czech locale is incomplete`);
        const raw = fs.readFileSync(file);
        let parsed;
        try {
            parsed = JSON.parse(raw.toString('utf8'));
        } catch (e) {
            refuse('LOCALE_FILE_UNPARSABLE', `${ns}.json is not valid JSON (${e.message})`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            refuse('LOCALE_FILE_UNPARSABLE', `${ns}.json is not a JSON object`);
        }
        keys += flatKeyCount(parsed);
        files.push({ ns, raw });
    }
    return { files, keys };
}

// ---------------------------------------------------------------------------
// Zasahy.
// ---------------------------------------------------------------------------

function patchConfig(file) {
    const text = readFileOrRefuse(file, 'config.ts');
    if (text.includes(MARKER)) return { text, changed: false };
    if (/\n {6}cs: \{/.test(toLf(text)) || text.includes('locales/cs/')) {
        refuse('CS_ALREADY_PRESENT', 'config.ts already carries a cs block this script did not write - upstream may have shipped Czech; remove the overlay instead of stacking on it');
    }

    const eol = eolOf(text);
    const importAnchor = toEol(CONFIG_IMPORT_ANCHOR, eol);
    const resourcesAnchor = toEol(CONFIG_RESOURCES_ANCHOR, eol);
    requireExactlyOnce(text, importAnchor, 'config.ts', "the en import block's last line (enGit)");
    requireExactlyOnce(text, resourcesAnchor, 'config.ts', 'the resources map opening with en');

    const imports = toEol([
        '',
        `// ${MARKER}: docasny cesky overlay, viz scripts/cloudcli/apply-cs-locale.mjs`,
        ...NAMESPACES.map((ns) => `import ${importName(ns)} from '@/modules/i18n/locales/cs/${ns}.json';`),
        '',
    ].join('\n'), eol);

    const resources = toEol([
        '    resources: {',
        `      // ${MARKER}`,
        '      cs: {',
        ...NAMESPACES.map((ns) => `        ${ns}: ${importName(ns)},`),
        '      },',
        '      en: {',
        '',
    ].join('\n'), eol);

    const patched = text
        .replace(importAnchor, importAnchor + imports)
        .replace(resourcesAnchor, resources);
    return { text: patched, changed: true };
}

function patchLanguages(file) {
    const text = readFileOrRefuse(file, 'languages.ts');
    if (text.includes(MARKER)) return { text, changed: false };
    if (/value: 'cs'/.test(text)) {
        refuse('CS_ALREADY_PRESENT', 'languages.ts already lists cs and this script did not add it - upstream may have shipped Czech; remove the overlay instead of stacking on it');
    }

    const eol = eolOf(text);
    const enEntry = toEol(LANGUAGES_EN_ENTRY, eol);
    requireExactlyOnce(text, enEntry, 'languages.ts', 'the English language entry');
    if (!text.includes(toEol(LANGUAGES_LIST_OPEN, eol) + enEntry)) {
        refuse('ANCHOR_MISSING', 'languages.ts: English is no longer the first entry of the languages array');
    }

    const entry = toEol([
        `  // ${MARKER}`,
        '  {',
        "    value: 'cs',",
        "    label: 'Czech',",
        "    nativeName: 'Čeština',",
        '  },',
        '',
    ].join('\n'), eol);

    return { text: text.replace(enEntry, enEntry + entry), changed: true };
}

// ---------------------------------------------------------------------------
// Overeni PO zasahu. Cte z disku, ne z pameti - zapis, ktery neprosel, je
// presne ta trida chyby, kvuli ktere tahle funkce existuje.
// ---------------------------------------------------------------------------

function verify(i18nDir) {
    const problems = [];
    const csDir = path.join(i18nDir, 'locales', 'cs');
    for (const ns of NAMESPACES) {
        const file = path.join(csDir, `${ns}.json`);
        if (!fs.existsSync(file)) {
            problems.push(`locales/cs/${ns}.json is not on disk`);
            continue;
        }
        try {
            JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            problems.push(`locales/cs/${ns}.json does not parse after the copy (${e.message})`);
        }
    }

    // Overeni je jen cteni, takze si text normalizuje na LF a neresi konce radku.
    const config = fs.existsSync(path.join(i18nDir, 'config.ts')) ? toLf(fs.readFileSync(path.join(i18nDir, 'config.ts'), 'utf8')) : '';
    if (!config.includes(MARKER)) problems.push('config.ts carries no overlay marker');
    if (!/\n {6}cs: \{/.test(config)) problems.push('config.ts has no cs block in resources');
    for (const ns of NAMESPACES) {
        if (!config.includes(`locales/cs/${ns}.json`)) problems.push(`config.ts does not import locales/cs/${ns}.json`);
    }

    const langs = fs.existsSync(path.join(i18nDir, 'languages.ts')) ? toLf(fs.readFileSync(path.join(i18nDir, 'languages.ts'), 'utf8')) : '';
    if (!langs.includes(MARKER)) problems.push('languages.ts carries no overlay marker');
    if (!/value: 'cs',/.test(langs)) problems.push('languages.ts does not list cs');
    if (!/nativeName: 'Čeština',/.test(langs)) problems.push('languages.ts lost the Czech native name');

    if (problems.length > 0) {
        refuse('VERIFY_FAILED', `the patched tree does not carry Czech:\n  - ${problems.join('\n  - ')}`);
    }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    let src = null;
    let localeDir = path.join(HERE, 'locale-cs');
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--locale-dir') {
            i += 1;
            if (i >= argv.length) refuse('BAD_USAGE', '--locale-dir needs a directory');
            localeDir = path.resolve(argv[i]);
        } else if (a.startsWith('-')) {
            refuse('BAD_USAGE', `unknown option ${a} - usage: apply-cs-locale.mjs <src-root> [--locale-dir <dir>]`);
        } else if (src === null) {
            src = path.resolve(a);
        } else {
            refuse('BAD_USAGE', `unexpected argument ${a}`);
        }
    }
    if (src === null) refuse('BAD_USAGE', 'usage: apply-cs-locale.mjs <src-root> [--locale-dir <dir>]');
    return { src, localeDir };
}

function main(argv) {
    const { src, localeDir } = parseArgs(argv);
    const i18nDir = path.join(src, 'src', 'modules', 'i18n');

    const { files, keys } = loadLocaleFiles(localeDir);

    // 1. Ceske soubory. Kopiruji se i pri opakovanem behu - jsou bajtove stejne,
    //    takze to nic nemeni, a strom, kde jeden zmizel, se tim opravi.
    const csDir = path.join(i18nDir, 'locales', 'cs');
    fs.mkdirSync(csDir, { recursive: true });
    for (const { ns, raw } of files) fs.writeFileSync(path.join(csDir, `${ns}.json`), raw);

    // 2. Oba upstream soubory.
    const configFile = path.join(i18nDir, 'config.ts');
    const languagesFile = path.join(i18nDir, 'languages.ts');
    const config = patchConfig(configFile);
    const langs = patchLanguages(languagesFile);
    if (config.changed) fs.writeFileSync(configFile, config.text);
    if (langs.changed) fs.writeFileSync(languagesFile, langs.text);

    // 3. Overeni z disku.
    verify(i18nDir);

    const state = config.changed || langs.changed ? 'config.ts + languages.ts patched' : 'already applied';
    process.stdout.write(`cs overlay OK: ${NAMESPACES.length} namespaces, ${keys} keys -> ${csDir} (${state})\n`);
}

try {
    main(process.argv.slice(2));
} catch (e) {
    if (e instanceof Refusal) {
        process.stderr.write(`cs overlay REFUSED - ${e.message}\n`);
        process.exit(1);
    }
    process.stderr.write(`cs overlay REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
}
