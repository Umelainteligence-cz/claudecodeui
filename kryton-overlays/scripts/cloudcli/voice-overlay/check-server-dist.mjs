#!/usr/bin/env node
/*
 * ROZDILOVY DUKAZ SERVERU CloudCLI - `dist-server` z npm tarballu proti `dist-server`
 * postavenemu z forkoveho stromu, PRED vymenou v obrazu.
 *
 * CO DELA: `Dockerfile.server` (stage `base`) instaluje CloudCLI z npm tarballu pinu
 * a pak jeho `dist-server/` NAHRADI serverem, ktery stage `cloudcli-client`
 * postavila (`npm run build:server`) ze stromu po ceskem, forkovem (hlas + kontextovy
 * prstenec) a znackovem overlayi. Tenhle skript pred vymenou dokaze, ze se ve
 * stromu zmenilo PRAVE to, co forkovy overlay rika (`manifest.json`), a nic jineho
 * (KTD3 planu `docs/plans/2026-10-16-cloudcli-server-overlay-plan.md`, rozhodnuti
 * majitele Miroslava R3 z 16. 10. 2026):
 *   - kazdy soubor tarballu musi v prestavbe existovat (MISSING_IN_REBUILD);
 *   - soubor se smi lisit jen tehdy, kdyz je vystupem serveroveho zdroje, ktery
 *     manifest jmenuje - patch nebo novy soubor (UNEXPECTED_DIFFERENCE);
 *   - soubor prestavby, ktery tarball nema, musi byt vystupem NOVEHO serveroveho
 *     zdroje overlaye (UNEXPECTED_NEW_FILE);
 *   - prazdny dukaz je odmitnuti (VACUOUS_PROOF): nula porovnanych souboru;
 *     manifest se serverovymi polozkami, ze kterych tsc nic nevyrobi; nebo manifest
 *     se serverovymi polozkami, z jejichz vystupu se NELISI ANI JEDEN (jednotlivy
 *     bajtove stejny vystup dotceneho zdroje je v poradku - typovy soubor, mapa,
 *     ktera se nepohnula -, vsechny stejne nejsou).
 * Serverova polozka = `patches[].file` a `files[].path`, jejichz polovina je
 * `server` (`halfOf` z `overlay-paths.mjs`); vystupy pocita `serverOutputs` tamtez,
 * stejne jako je pojmenuje tsc upstreamu.
 *
 * CESKY A ZNACKOVY OVERLAY ZADNOU CESTU `server/`/`shared/` NENESOU (pinuje
 * `scripts/cloudcli-voice-overlay.test.js`), takze zasah ukazuje na forkovy overlay
 * nebo na posunuty pin - text kazdeho odmitnuti to rika.
 *
 * Kazde odmitnuti jmenuje soubor a duvod; vypisou se VSECHNY nalezy, kod odmitnuti
 * je kod prvniho. Uspech je jeden radek
 *   server dist proof OK: compared N, identical M, overlay outputs K, new F
 * (N = soubory tarballu, M = bajtove stejne, K = lisici se nebo nove vystupy
 * serverovych zdroju overlaye, F = nove soubory prestavby).
 *
 * Ciste Node 22, nula zavislosti. Funkce jsou exportovane pro testy; CLI bezi jen
 * pri primem spusteni.
 *
 * Pouziti:  node check-server-dist.mjs <tarball-dist-server> <rebuilt-dist-server> --manifest <file>
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { serverEntryPaths, serverOutputs } from './overlay-paths.mjs';

const USAGE = 'usage: check-server-dist.mjs <tarball-dist-server> <rebuilt-dist-server> --manifest <file>';
const SOURCE_NOTE = 'note: the Czech and brand overlays carry no server/ or shared/ path, '
    + 'so this points at the fork overlay (scripts/cloudcli/voice-overlay/manifest.json) or at a moved pin';

export class Refusal extends Error {
    constructor(reason, detail) {
        super(`${reason}: ${detail}`);
        this.reason = reason;
    }
}

const refuse = (reason, detail) => {
    throw new Refusal(reason, detail);
};


/** Vsechny bezne soubory pod `root`, relativne s lomitky. Odkaz je nalez, ne soubor. */
export function listFiles(root) {
    const out = new Map();
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const rel = path.relative(root, full).split(path.sep).join('/');
            const st = fs.lstatSync(full);
            if (st.isDirectory()) walk(full);
            else if (st.isFile()) out.set(rel, full);
            else refuse('UNSUPPORTED_ENTRY', `${rel} is neither a file nor a directory - ${SOURCE_NOTE}`);
        }
    };
    walk(root);
    return out;
}

/** Serverove polozky manifestu a jejich vystupy relativne k `dist-server/`. */
export function serverEntries(manifest) {
    const strip = (p) => p.replace(/^dist-server\//, '');
    const { touched, added } = serverEntryPaths(manifest);
    const outputs = new Map();
    for (const f of touched) for (const o of serverOutputs(f)) outputs.set(strip(o), { source: f, isNew: false });
    for (const f of added) for (const o of serverOutputs(f)) outputs.set(strip(o), { source: f, isNew: true });
    return { touched, added, outputs };
}

/**
 * Jadro dukazu. Vraci { compared, identical, overlayOutputs, newFiles } nebo hazi
 * Refusal (s `reason`) se vsemi nalezy.
 */
export function proveServerDist(tarballDir, rebuiltDir, manifest) {
    for (const [what, dir] of [['tarball dist-server', tarballDir], ['rebuilt dist-server', rebuiltDir]]) {
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) refuse('BAD_USAGE', `${what} ${dir} is not a directory - ${USAGE}`);
    }
    if (!manifest || typeof manifest !== 'object') refuse('MANIFEST_INVALID', 'the manifest is not an object');
    for (const key of ['patches', 'files']) {
        if (manifest[key] !== undefined && !Array.isArray(manifest[key])) refuse('MANIFEST_INVALID', `the manifest's ${key} is not a list`);
    }

    const tarball = listFiles(tarballDir);
    const rebuilt = listFiles(rebuiltDir);
    const { touched, added, outputs } = serverEntries(manifest);
    const serverSources = [...touched, ...added];

    const problems = [];
    const add = (reason, detail) => problems.push({ reason, detail });

    if (tarball.size === 0) add('VACUOUS_PROOF', `${tarballDir}: the tarball dist-server holds no file, nothing was compared`);
    if (serverSources.length > 0 && outputs.size === 0) {
        add('VACUOUS_PROOF', `the manifest names server entries (${serverSources.join(', ')}) but tsc emits nothing from them`);
    }

    let identical = 0;
    let overlayOutputs = 0;
    let newFiles = 0;
    for (const [rel, full] of tarball) {
        const other = rebuilt.get(rel);
        if (!other) {
            add('MISSING_IN_REBUILD', `${rel} is in the tarball dist-server but not in the rebuild`);
            continue;
        }
        if (fs.readFileSync(full).equals(fs.readFileSync(other))) {
            identical += 1;
            continue;
        }
        const owner = outputs.get(rel);
        if (owner) overlayOutputs += 1;
        else add('UNEXPECTED_DIFFERENCE', `${rel} differs from the tarball but no server source in the manifest produces it`);
    }
    for (const rel of rebuilt.keys()) {
        if (tarball.has(rel)) continue;
        newFiles += 1;
        const owner = outputs.get(rel);
        if (owner && owner.isNew) overlayOutputs += 1;
        else if (owner) add('UNEXPECTED_NEW_FILE', `${rel} is new in the rebuild, but its source ${owner.source} is a PATCHED file, not a new one`);
        else add('UNEXPECTED_NEW_FILE', `${rel} is new in the rebuild and no new server source in the manifest produces it`);
    }
    if (serverSources.length > 0 && outputs.size > 0 && overlayOutputs === 0) {
        add('VACUOUS_PROOF', `the manifest names server entries (${serverSources.join(', ')}) but not one of their outputs differs from the tarball or is new`);
    }

    if (problems.length > 0) {
        refuse(problems[0].reason, `${problems.length} finding(s):\n  - ${problems.map((p) => `${p.reason}: ${p.detail}`).join('\n  - ')}\n  ${SOURCE_NOTE}`);
    }
    return { compared: tarball.size, identical, overlayOutputs, newFiles };
}

function parseArgs(argv) {
    const positional = [];
    let manifestFile = null;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--manifest') {
            i += 1;
            if (i >= argv.length) refuse('BAD_USAGE', `--manifest needs a file - ${USAGE}`);
            manifestFile = path.resolve(argv[i]);
        } else if (a.startsWith('-')) {
            refuse('BAD_USAGE', `unknown option ${a} - ${USAGE}`);
        } else {
            positional.push(path.resolve(a));
        }
    }
    if (positional.length !== 2 || !manifestFile) refuse('BAD_USAGE', USAGE);
    return { tarballDir: positional[0], rebuiltDir: positional[1], manifestFile };
}

function readManifest(file) {
    if (!fs.existsSync(file)) refuse('MANIFEST_INVALID', `${file} does not exist`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return refuse('MANIFEST_INVALID', `${file} does not parse (${e.message})`);
    }
}

export function main(argv) {
    const { tarballDir, rebuiltDir, manifestFile } = parseArgs(argv);
    const r = proveServerDist(tarballDir, rebuiltDir, readManifest(manifestFile));
    process.stdout.write(`server dist proof OK: compared ${r.compared}, identical ${r.identical}, `
        + `overlay outputs ${r.overlayOutputs}, new ${r.newFiles}\n`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        if (e instanceof Refusal) {
            process.stderr.write(`server dist proof REFUSED - ${e.message}\n`);
        } else {
            process.stderr.write(`server dist proof REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
        }
        process.exit(1);
    }
}
