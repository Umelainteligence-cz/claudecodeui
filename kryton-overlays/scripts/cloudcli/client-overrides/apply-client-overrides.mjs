#!/usr/bin/env node
/*
 * OVERRIDES ZAVISLOSTI CloudCLI KLIENTA (red-dwarf#1985, dp4; zapojeno v dpf3, Q1807 = A1).
 *
 * CO DELA: nad stromem pinu (`/src` ve stage `cloudcli-client` v `Dockerfile.server`) PRED
 * `npm ci` posune zranitelne balicky lockfilu UPSTREAMU na opravene verze z `overrides.json`
 * (vedle tohoto skriptu) a lockfile prepocita:
 *   1. do `package.json` dopise `overrides` - klic `<balicek>@<major>` (u 0.x `@~0.<minor>`),
 *      hodnota presna verze. Klic s rozsahem posune jen kopie v TOM majoru: `brace-expansion`
 *      je ve strome v majorech 1, 2 i 5 a kazdy ma vlastni opravu;
 *   2. balicek, ktery upstream deklaruje PRIMO (dependencies/devDependencies/optional...), npm
 *      v `overrides` s jinou hodnotou odmitne (EOVERRIDE). U nej se prepise primo deklarace na
 *      presnou verzi - jen kdyz tvar je `^x.y.z` a cilova verze ho splnuje, tedy rozsah se jen
 *      zuzi - a override dostane `$<balicek>` (prechodne kopie tehoz majoru jdou za ni);
 *   3. `npm install --package-lock-only --ignore-scripts --before=<before>` prepocita lockfile (nic
 *      neinstaluje, nic nespousti); `npm ci` za nim instaluje z prepocitaneho lockfilu. `before`
 *      (okamzik v `overrides.json`) dela vysledek DETERMINISTICKY: novy balik, ktery si opravena
 *      verze vyzada (vite 7.3 -> esbuild 0.28 a jeho nativni binarky), i posunuta prechodna
 *      zavislost (caniuse-lite) se vybere tak, jak registr vypadal v ten okamzik - ne podle toho,
 *      kdy bezi build nebo denni brana. Bez nej by brana a build mohly hodnotit ruzne lockfily
 *      (revize Opus, 22. 10. 2026: caniuse-lite se mezi dvema behy posunul). Verze z `overrides`
 *      vydana az po `before` = ETARGET = NPM_FAILED;
 *   4. `verify()` precte lockfile z disku: kazdy klic musi ve strome neco potkat a KAZDA kopie
 *      balicku v jeho majoru musi mit presne cilovou verzi.
 *
 * JEDNA DEFINICE: verze stoji jen v `overrides.json`. Tentyz skript nad tymz souborem pousti
 * brana `scripts/dependency-audit.js --cloudcli-fork Dockerfile.server` (`forkOverridesSource`, stitek
 * `cloudcli-fork`) nad lockfilem stazenym na pinu, takze audituje lockfile, ktery build skutecne instaluje.
 *
 * KAZDE PREKVAPENI JE CERVENE (exit 1, build polozi): `package.json`/`package-lock.json` v git
 * klonu jine nez na HEAD (OVERLAY_TOUCHED_MANIFEST - overlay, ktery je zmenil, by build rozesel
 * s branou: ta pousti skript nad cistym pinem), upstream ma vlastni `overrides`
 * (UPSTREAM_OVERRIDES - slouceni je rozhodnuti, ne mechanika), neplatny `overrides.json`
 * (OVERRIDES_INVALID), prima deklarace jineho tvaru nez `^x.y.z` nebo cilova verze mimo ni
 * (DIRECT_RANGE), `npm install` selhal (NPM_FAILED), klic, ktery ve strome nic nepotkal
 * (OVERRIDE_STALE - bump pinu, ktery balicek odstrani, musi klic vedome smazat), kopie
 * v majoru klice s jinou verzi (OVERRIDE_NOT_APPLIED).
 *
 * KDY SE MENI: bump `CLOUDCLI_COMMIT` = premerit (`node scripts/dependency-audit.js --cloudcli-fork
 * Dockerfile.server`), co upstream opravil sam, smazat (OVERRIDE_STALE na to upozorni jen u balicku, ktery ze stromu
 * zmizel; balicek, ktery upstream povysil sam, se tu jen prepise na tutez nebo vyssi verzi -
 * smazat ho, kdyz uz audit nic nehlasi). Nova verze se vybira takto: nejnovejsi neohrozena ve
 * stejnem majoru, ktera je venku aspon 14 dni; kdyz takova neni, nejnizsi opravena. `before` se
 * posune jen spolu se zmenou verzi (tesne za vydani nejmladsi z nich) a vysledek se premeri branou.
 *
 * IDEMPOTENTNI: `package.json`, ktery uz nese presne tyto `overrides`, se nemeni; lockfile se
 * prepocita znovu (stejny vysledek) a overi.
 *
 * Ciste Node 22 + npm, nula zavislosti (stage `cloudcli-client` ma jen node, npm a git).
 * Prikaz npm: promenna CLOUDCLI_OVERRIDES_NPM (brana mu preda sve DEPENDENCY_AUDIT_NPM), jinak `npm`.
 *
 * Pouziti:  node apply-client-overrides.mjs <src-root> [--overrides <overrides.json>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECLARED = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// `<name>@<major>` or, for 0.x, `<name>@~0.<minor>`; scoped names keep their leading `@`.
const KEY = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(?:(0|[1-9]\d*)|~0\.(0|[1-9]\d*))$/;
const NPM_ARGS = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class Refusal extends Error {
    constructor(reason, detail) {
        super(`${reason}: ${detail}`);
        this.reason = reason;
    }
}

const refuse = (reason, detail) => {
    throw new Refusal(reason, detail);
};

function parseArgs(argv) {
    let src = null;
    let file = path.join(HERE, 'overrides.json');
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--overrides') {
            if (i + 1 >= argv.length) refuse('BAD_USAGE', '--overrides needs a file');
            file = path.resolve(argv[++i]);
        } else if (src === null && !argv[i].startsWith('--')) {
            src = path.resolve(argv[i]);
        } else {
            refuse('BAD_USAGE', `unexpected argument ${JSON.stringify(argv[i])}`);
        }
    }
    if (src === null) refuse('BAD_USAGE', 'usage: apply-client-overrides.mjs <src-root> [--overrides <overrides.json>]');
    for (const f of ['package.json', 'package-lock.json']) {
        if (!fs.existsSync(path.join(src, f))) refuse('BAD_USAGE', `${src} is not a CloudCLI source tree (no ${f})`);
    }
    return { src, file };
}

/** { before, entries: [{ key, name, major, minor, version }] } from overrides.json. Minor is set only for 0.x keys. */
function loadOverrides(file) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        refuse('OVERRIDES_INVALID', `${file} unreadable or not JSON (${e.message})`);
    }
    if (!raw || typeof raw.overrides !== 'object' || raw.overrides === null || Array.isArray(raw.overrides)) {
        refuse('OVERRIDES_INVALID', `${file} has no "overrides" object`);
    }
    if (Object.keys(raw).sort().join(',') !== 'before,overrides') refuse('OVERRIDES_INVALID', `${file} must hold exactly "before" and "overrides"`);
    const before = raw.before;
    if (typeof before !== 'string' || !INSTANT.test(before) || new Date(before).toISOString() !== before) refuse('OVERRIDES_INVALID', `before ${JSON.stringify(before)} is not an instant like 2026-10-08T00:00:00.000Z`);
    if (Date.parse(before) > Date.now()) refuse('OVERRIDES_INVALID', `before ${before} is in the future - it would not pin anything`);
    const entries = Object.entries(raw.overrides).map(([key, version]) => {
        const m = key.match(KEY);
        if (!m) refuse('OVERRIDES_INVALID', `key ${JSON.stringify(key)} is not <package>@<major> (or <package>@~0.<minor>)`);
        if (typeof version !== 'string' || !EXACT.test(version)) refuse('OVERRIDES_INVALID', `${key}: ${JSON.stringify(version)} is not an exact x.y.z version`);
        const [, name, majorStr, zeroMinor] = m;
        const major = majorStr === undefined ? 0 : Number(majorStr);
        const minor = zeroMinor === undefined ? null : Number(zeroMinor);
        if (!inScope(version, major, minor)) refuse('OVERRIDES_INVALID', `${key}: ${version} is outside the key's own range`);
        return { key, name, major, minor, version };
    });
    return { before, entries };
}

function inScope(version, major, minor) {
    const m = String(version).match(EXACT);
    if (!m) return false;
    if (Number(m[1]) !== major) return false;
    return minor === null ? major !== 0 : Number(m[2]) === minor;
}

/** `^x.y.z` satisfied by an exact version (same rules as semver's caret, no prereleases). */
function caretAllows(range, version) {
    const r = range.match(/^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    const v = version.match(EXACT);
    if (!r || !v) return false;
    const [a, b, c] = r.slice(1).map(Number);
    const [x, y, z] = v.slice(1).map(Number);
    if (a !== 0) return x === a && (y > b || (y === b && z >= c));
    if (b !== 0) return x === 0 && y === b && z >= c;
    return x === 0 && y === 0 && z === c;
}

/** package.json with the overrides written in. Throws Refusal; does not write. */
function planPackageJson(pkg, entries) {
    const overrides = {};
    const next = JSON.parse(JSON.stringify(pkg));
    for (const e of entries) {
        const declaredIn = DECLARED.filter((s) => pkg[s] && Object.prototype.hasOwnProperty.call(pkg[s], e.name));
        if (declaredIn.length === 0) {
            overrides[e.key] = e.version;
            continue;
        }
        for (const s of declaredIn) {
            const range = pkg[s][e.name];
            if (s === 'peerDependencies') refuse('DIRECT_RANGE', `${e.name} is a peer dependency of the upstream package - an override there is a decision, not mechanics`);
            // `range === e.version`: a tree this script already narrowed (second run).
            if (range !== e.version && !caretAllows(range, e.version)) refuse('DIRECT_RANGE', `${e.name}: upstream declares ${JSON.stringify(range)} in ${s}; ${e.version} must satisfy a ^x.y.z range (the declaration is only narrowed)`);
            next[s][e.name] = e.version;
        }
        overrides[e.key] = `$${e.name}`;
    }
    if (pkg.overrides !== undefined && JSON.stringify(pkg.overrides) !== JSON.stringify(overrides)) {
        refuse('UPSTREAM_OVERRIDES', `package.json already has its own "overrides" (${JSON.stringify(pkg.overrides).slice(0, 200)}) - merging them is a decision; re-measure the pin`);
    }
    next.overrides = overrides;
    return next;
}

/**
 * In a git clone (the stage's /src) the manifest must be the pin's own - or, on a second run,
 * exactly what this script makes of it. The gate runs the script over the pin's untouched files;
 * an overlay that edited them would make the build install a lockfile the gate never saw.
 */
function checkPristine(src, pkg, entries) {
    if (!fs.existsSync(path.join(src, '.git'))) return;
    const show = (f) => {
        try {
            return execFileSync('git', ['-C', src, 'show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            refuse('OVERLAY_TOUCHED_MANIFEST', `cannot read HEAD:${f} in ${src} (${e.message.split('\n')[0]})`);
        }
        return null;
    };
    const headPkg = JSON.parse(show('package.json'));
    if (JSON.stringify(pkg) === JSON.stringify(planPackageJson(headPkg, entries))) return;
    if (JSON.stringify(pkg) !== JSON.stringify(headPkg)) refuse('OVERLAY_TOUCHED_MANIFEST', `package.json in ${src} differs from the pin (HEAD) - an overlay changed it; the gate audits the pin's own`);
    if (fs.readFileSync(path.join(src, 'package-lock.json'), 'utf8') !== show('package-lock.json')) refuse('OVERLAY_TOUCHED_MANIFEST', `package-lock.json in ${src} differs from the pin (HEAD) - an overlay changed it; the gate audits the pin's own`);
}

function runNpm(src, before) {
    const npm = process.env.CLOUDCLI_OVERRIDES_NPM || 'npm';
    const r = spawnSync(npm, [...NPM_ARGS, `--before=${before}`], { cwd: src, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
        const why = r.error ? (r.error.code || r.error.message) : `exit ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`;
        refuse('NPM_FAILED', `${npm} ${NPM_ARGS.join(' ')} --before=${before} in ${src} failed (${why})`);
    }
}

/** Reads the lockfile back: every key met something, every copy in its range is the target. */
function verify(src, entries) {
    let lock;
    try {
        lock = JSON.parse(fs.readFileSync(path.join(src, 'package-lock.json'), 'utf8'));
    } catch (e) {
        refuse('NPM_FAILED', `package-lock.json after npm install does not parse (${e.message})`);
    }
    if (!lock || typeof lock.packages !== 'object' || lock.packages === null) refuse('NPM_FAILED', 'package-lock.json after npm install has no "packages" (lockfileVersion 2+ expected)');
    const copies = new Map();
    for (const [p, e] of Object.entries(lock.packages)) {
        if (!p || !e || typeof e.version !== 'string') continue;
        const name = e.name || p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (!copies.has(name)) copies.set(name, []);
        copies.get(name).push({ path: p, version: e.version });
    }
    let applied = 0;
    for (const e of entries) {
        const hits = (copies.get(e.name) || []).filter((c) => {
            const m = c.version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\./);
            if (!m || Number(m[1]) !== e.major) return false;
            return e.minor === null || Number(m[2]) === e.minor;
        });
        if (hits.length === 0) refuse('OVERRIDE_STALE', `${e.key} matches nothing in the lockfile - the pin no longer has it; delete the key from overrides.json`);
        const wrong = hits.filter((c) => c.version !== e.version);
        if (wrong.length) refuse('OVERRIDE_NOT_APPLIED', `${e.key} -> ${e.version}, but ${wrong.map((c) => `${c.path}@${c.version}`).join(', ')}`);
        applied += hits.length;
    }
    return applied;
}

function main(argv) {
    const { src, file } = parseArgs(argv);
    const { before, entries } = loadOverrides(file);
    const pkgFile = path.join(src, 'package.json');
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
        refuse('BAD_USAGE', `${pkgFile} does not parse (${e.message})`);
    }
    checkPristine(src, pkg, entries);
    const next = planPackageJson(pkg, entries);
    const same = JSON.stringify(next) === JSON.stringify(pkg);
    if (!same) fs.writeFileSync(pkgFile, `${JSON.stringify(next, null, 2)}\n`);
    let copies = 0;
    if (entries.length) {
        runNpm(src, before);
        copies = verify(src, entries);
    }
    process.stdout.write(`client overrides OK: ${entries.length} keys, ${copies} lockfile entries on the fixed version${same ? ' (package.json already carried them)' : ''}\n`);
}

try {
    main(process.argv.slice(2));
} catch (e) {
    if (e instanceof Refusal) {
        process.stderr.write(`client overrides REFUSED - ${e.message}\n`);
        process.exit(1);
    }
    process.stderr.write(`client overrides REFUSED - UNEXPECTED: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
}
