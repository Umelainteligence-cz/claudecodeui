#!/usr/bin/env node
/*
 * VYROBI FORKOVY OVERLAY Z FORKOVE VETVE - nastroj pro cloveka, v buildu NEBEZI.
 *
 * Forkovy overlay (hlas: auto-speak, odstraneni bloku <spoken>, ovladani prehravani,
 * zpevneni diktatu - plan „Hlas pro CloudCLI", U7 + U8; a kontextovy prstenec Brain
 * Chatu - plan `docs/plans/2026-10-16-cloudcli-server-overlay-plan.md`) se VYVIJI ve
 * forku `Umelainteligence-cz/claudecodeui`, ne tady. Fork ma dve vetve:
 *   - `post-czech-base`: pin v1.37.3 (70e5785) + vystup `apply-cs-locale.mjs` -
 *     presne strom, ktery ve stage `cloudcli-client` dostane forkovy overlay;
 *   - `feat/voice-overlay-v1.37.3`: vyvoj nad ni.
 * Tenhle skript z rozdilu tech dvou vetvi vyrobi obsah `voice-overlay/`:
 * jeden patch na kazdy upstream soubor (`patches/`), nove soubory (`files/`),
 * texty (`locales/`) a `manifest.json` s sha256 kazdeho dotceneho souboru PRED
 * (strom po ceskem overlayi) a PO (strom po forkovem overlayi).
 *
 * KLIENT I SERVER: pravidlo R15 („jen klient, `server/` se nesaha") bylo pravidlo
 * planu Schejbal OS; majitel Miroslav ho 16. 10. 2026 zrusil (R1). Patche a nove
 * soubory v `server/` a `shared/` se exportuji jako kazde jine; polovinu pozdeji
 * odvodi `halfOf` z `overlay-paths.mjs` z cesty.
 *
 * CO SE NEEXPORTUJE (KTD6): presne `.env.example`, `.gitignore`, `CONCEPTS.md` a
 * `docs/**` - do buildu nikdy nejdou (namereno: jedine cesty rozdilu mimo `src/` a
 * `server/`). Cokoli jineho necekaneho (smazany soubor, prejmenovani, zmena typu)
 * dal hazi a soubor jmenuje. Hazi i zmena `package.json`, `package-lock.json` nebo
 * `server/tsconfig.json` (H8): build by bezel na forkovych zavislostech nebo
 * nastavenich prekladace, kdezto `base` instaluje zamek z tarballu.
 *
 * KDY SE POUSTI: po kazde zmene na forkove vetvi a pri kazdem bumpu pinu - fork
 * se pak nejdriv prerizne na novy pin (KTD5), jinak by kontextove radky patchu
 * nesedely na strom, ktery `git apply` uvidi. Export, ktery prida nebo zmeni
 * polozku v `server/`, chce bezpecnostni cteni serveroveho rozdilu, nove spusteni
 * `scripts/cloudcli-platform-probe.sh` a, kdyz se dotkne `claude-runtime.provider`,
 * preriznuti ZA6.3 polozky v `../server-overlay/apply-server-overlay.mjs`.
 *
 * KDY SE SMAZE: spolu s celym adresarem - az upstream vyda verzi, ktera nese hlas
 * i kontextovy prstenec, klienta i server (viz hlavicka `apply-voice-overlay.mjs`).
 *
 * LICENCE (AGPL-3.0-or-later): nabidka zdroje overlaye je forkova vetev, kterou
 * zapise do `manifest.json` (`fork.repo`, `fork.branch`, `fork.commit`).
 *
 * Pouziti:  node export-voice-overlay.mjs <fork-dir> [--base <ref>] [--head <ref>]
 *               [--fork-repo <owner/repo>] [--out-dir <dir>]
 *           (`--out-dir` je vychozi tenhle adresar; jiny jen pro testy a suchy beh)
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CZECH_LOCALE_DIR, isCzechOwned, serverEntryCount } from './overlay-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALE_PREFIX = 'src/modules/chat/voice/locales/';
const ASSET = { path: 'public/kryton-voice/beh-selhal.mp3', from: 'assets/beh-selhal.mp3' };

/** Cesty, ktere do buildu nikdy nejdou (KTD6). Nic jineho se nepreskakuje. */
const SKIPPED_FILES = ['.env.example', '.gitignore', 'CONCEPTS.md'];
const SKIPPED_DIRS = ['docs/'];
const isSkipped = (file) => SKIPPED_FILES.includes(file) || SKIPPED_DIRS.some((d) => file.startsWith(d));

/**
 * Soubory, ktere fork menit nesmi (H8): build v `cloudcli-client` by pak bezel na
 * forkovych zavislostech nebo nastavenich prekladace, kdezto `base` instaluje zamek
 * z npm tarballu - prelozeny server by nesedel na balicek, do ktereho se vymeni.
 */
const BUILD_INPUT_FILES = ['package.json', 'package-lock.json', 'server/tsconfig.json'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (fork, args, opts = {}) => execFileSync('git', ['-C', fork, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
const show = (fork, ref, file) => git(fork, ['show', `${ref}:${file}`]);
const patchName = (file) => `${file.replace(/\//g, '__')}.patch`;

const USAGE = 'usage: export-voice-overlay.mjs <fork-dir> [--base <ref>] [--head <ref>] [--fork-repo <owner/repo>] [--out-dir <dir>]';

function parseArgs(argv) {
    const out = { fork: null, base: 'post-czech-base', head: 'feat/voice-overlay-v1.37.3', forkRepo: 'Umelainteligence-cz/claudecodeui', outDir: HERE };
    const value = (i) => {
        if (i >= argv.length) throw new Error(`${argv[i - 1]} needs a value - ${USAGE}`);
        return argv[i];
    };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--base') out.base = value((i += 1));
        else if (argv[i] === '--head') out.head = value((i += 1));
        else if (argv[i] === '--fork-repo') out.forkRepo = value((i += 1));
        else if (argv[i] === '--out-dir') out.outDir = path.resolve(value((i += 1)));
        else if (argv[i].startsWith('-')) throw new Error(`unknown option ${argv[i]} - ${USAGE}`);
        else if (!out.fork) out.fork = path.resolve(argv[i]);
        else throw new Error(`unexpected argument ${argv[i]}`);
    }
    if (!out.fork) throw new Error(USAGE);
    return out;
}

function main() {
    const { fork, base, head, forkRepo, outDir } = parseArgs(process.argv.slice(2));
    const baseSha = git(fork, ['rev-parse', base]).toString().trim();
    const headSha = git(fork, ['rev-parse', head]).toString().trim();
    const pinSha = git(fork, ['rev-parse', `${base}~1`]).toString().trim();
    const changes = git(fork, ['diff', '--name-status', '--no-renames', base, head]).toString().trim().split('\n').filter(Boolean);

    // Nejdriv cely rozdil zkontrolovat, az pak cokoli smazat: necekana zmena nesmi
    // nechat adresar overlaye napul prazdny.
    const kept = [];
    for (const line of changes) {
        const [status, file] = line.split('\t');
        if (isSkipped(file)) continue;
        if (BUILD_INPUT_FILES.includes(file)) {
            throw new Error(`${file}: the fork overlay must not change ${file} - the server build would run on the fork's `
                + 'dependencies or compiler settings while base installs the tarball lockfile; change it upstream or bump the pin');
        }
        // Cesky locale patri ceskemu overlayi. Fork ho trackuje jen proto, ze mu ho driv
        // spolkl .gitignore (fork ccf59d43): pridany soubor bajtove shodny s tim, co
        // zapise scripts/cloudcli/locale-cs/, se preskoci; cokoli jineho je konflikt.
        if (isCzechOwned(file)) {
            const own = path.join(HERE, '..', 'locale-cs', file.slice(CZECH_LOCALE_DIR.length));
            const same = status === 'A' && file.startsWith(CZECH_LOCALE_DIR) && fs.existsSync(own)
                && sha256(fs.readFileSync(own)) === sha256(show(fork, head, file));
            if (same) continue;
            throw new Error(`${file} belongs to the Czech overlay (scripts/cloudcli/apply-cs-locale.mjs, locale-cs/) - change it there, not in the fork overlay`);
        }
        if (status !== 'M' && status !== 'A') {
            throw new Error(`${file}: status ${status} is not supported - the overlay only modifies and adds files`);
        }
        kept.push({ status, file });
    }

    for (const dir of ['patches', 'files', 'locales']) fs.rmSync(path.join(outDir, dir), { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    const manifest = {
        upstream: { repo: 'siteboon/claudecodeui', version: '1.37.3', commit: pinSha },
        base: { description: 'the pin after scripts/cloudcli/apply-cs-locale.mjs', forkBranch: base, forkCommit: baseSha },
        fork: { repo: forkRepo, branch: head, commit: headSha },
        patches: [],
        files: [],
        locales: [],
        asset: { ...ASSET, optional: true },
    };

    for (const { status, file } of kept) {
        if (status === 'M') {
            const patch = git(fork, ['diff', '--no-color', '--no-ext-diff', '--full-index', base, head, '--', file]);
            const rel = path.posix.join('patches', patchName(file));
            fs.mkdirSync(path.join(outDir, 'patches'), { recursive: true });
            fs.writeFileSync(path.join(outDir, rel), patch);
            manifest.patches.push({
                file,
                patch: rel,
                before: sha256(show(fork, baseSha, file)),
                after: sha256(show(fork, headSha, file)),
            });
        } else {
            const body = show(fork, headSha, file);
            const isLocale = file.startsWith(LOCALE_PREFIX);
            const rel = isLocale ? path.posix.join('locales', file.slice(LOCALE_PREFIX.length)) : path.posix.join('files', file);
            fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
            fs.writeFileSync(path.join(outDir, rel), body);
            (isLocale ? manifest.locales : manifest.files).push({ path: file, from: rel, sha256: sha256(body) });
        }
    }

    const serverHalf = serverEntryCount(manifest);
    fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`fork overlay exported: ${manifest.patches.length} patches, ${manifest.files.length} files, `
        + `${manifest.locales.length} locale files; server half: ${serverHalf} entries `
        + `(base ${baseSha.slice(0, 7)}, head ${headSha.slice(0, 7)})\n`);
}

main();
