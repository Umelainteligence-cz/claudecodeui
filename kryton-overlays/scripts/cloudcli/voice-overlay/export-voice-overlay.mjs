#!/usr/bin/env node
/*
 * VYROBI HLASOVY OVERLAY Z FORKOVE VETVE - nastroj pro cloveka, v buildu NEBEZI.
 *
 * Hlasovy overlay (auto-speak, odstraneni bloku <spoken>, ovladani prehravani,
 * zpevneni diktatu; plan „Hlas pro CloudCLI", U7 + U8) se VYVIJI ve forku
 * siteboon/claudecodeui, ne tady. Fork ma dve vetve:
 *   - `post-czech-base`: pin v1.37.3 (70e5785) + vystup `apply-cs-locale.mjs` -
 *     presne strom, ktery ve stage `cloudcli-client` dostane hlasovy overlay;
 *   - `feat/voice-overlay-v1.37.3`: vyvoj nad ni.
 * Tenhle skript z rozdilu tech dvou vetvi vyrobi obsah `voice-overlay/`:
 * jeden patch na kazdy upstream soubor (`patches/`), nove soubory (`files/`),
 * texty (`locales/`) a `manifest.json` s sha256 kazdeho dotceneho souboru PRED
 * (strom po ceskem overlayi) a PO (strom po hlasovem overlayi).
 *
 * KDY SE POUSTI: po kazde zmene na forkove vetvi a pri kazdem bumpu pinu - fork
 * se pak nejdriv prerizne na novy pin (KTD5), jinak by kontextove radky patchu
 * nesedely na strom, ktery `git apply` uvidi.
 *
 * Pouziti:  node export-voice-overlay.mjs <fork-dir> [--base <ref>] [--head <ref>] [--fork-repo <owner/repo>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALE_PREFIX = 'src/modules/chat/voice/locales/';
const ASSET = { path: 'public/kryton-voice/beh-selhal.mp3', from: 'assets/beh-selhal.mp3' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (fork, args, opts = {}) => execFileSync('git', ['-C', fork, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
const show = (fork, ref, file) => git(fork, ['show', `${ref}:${file}`]);
const patchName = (file) => `${file.replace(/\//g, '__')}.patch`;

function parseArgs(argv) {
    const out = { fork: null, base: 'post-czech-base', head: 'feat/voice-overlay-v1.37.3', forkRepo: 'mmmirusss/claudecodeui' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--base') out.base = argv[(i += 1)];
        else if (argv[i] === '--head') out.head = argv[(i += 1)];
        else if (argv[i] === '--fork-repo') out.forkRepo = argv[(i += 1)];
        else if (!out.fork) out.fork = path.resolve(argv[i]);
        else throw new Error(`unexpected argument ${argv[i]}`);
    }
    if (!out.fork) throw new Error('usage: export-voice-overlay.mjs <fork-dir> [--base <ref>] [--head <ref>]');
    return out;
}

function main() {
    const { fork, base, head, forkRepo } = parseArgs(process.argv.slice(2));
    const baseSha = git(fork, ['rev-parse', base]).toString().trim();
    const headSha = git(fork, ['rev-parse', head]).toString().trim();
    const pinSha = git(fork, ['rev-parse', `${base}~1`]).toString().trim();
    const changes = git(fork, ['diff', '--name-status', '--no-renames', base, head]).toString().trim().split('\n');

    for (const dir of ['patches', 'files', 'locales']) fs.rmSync(path.join(HERE, dir), { recursive: true, force: true });

    const manifest = {
        upstream: { repo: 'siteboon/claudecodeui', version: '1.37.3', commit: pinSha },
        base: { description: 'the pin after scripts/cloudcli/apply-cs-locale.mjs', forkBranch: base, forkCommit: baseSha },
        fork: { repo: forkRepo, branch: head, commit: headSha },
        patches: [],
        files: [],
        locales: [],
        asset: { ...ASSET, optional: true },
    };

    for (const line of changes) {
        const [status, file] = line.split('\t');
        if (file.startsWith('server/')) throw new Error(`${file}: the overlay is client-only (R15)`);
        if (status === 'M') {
            const patch = git(fork, ['diff', '--no-color', '--no-ext-diff', '--full-index', base, head, '--', file]);
            const rel = path.posix.join('patches', patchName(file));
            fs.mkdirSync(path.join(HERE, 'patches'), { recursive: true });
            fs.writeFileSync(path.join(HERE, rel), patch);
            manifest.patches.push({
                file,
                patch: rel,
                before: sha256(show(fork, baseSha, file)),
                after: sha256(show(fork, headSha, file)),
            });
        } else if (status === 'A') {
            const body = show(fork, headSha, file);
            const isLocale = file.startsWith(LOCALE_PREFIX);
            const rel = isLocale ? path.posix.join('locales', file.slice(LOCALE_PREFIX.length)) : path.posix.join('files', file);
            fs.mkdirSync(path.dirname(path.join(HERE, rel)), { recursive: true });
            fs.writeFileSync(path.join(HERE, rel), body);
            (isLocale ? manifest.locales : manifest.files).push({ path: file, from: rel, sha256: sha256(body) });
        } else {
            throw new Error(`${file}: status ${status} is not supported - the overlay only modifies and adds files`);
        }
    }

    fs.writeFileSync(path.join(HERE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`voice overlay exported: ${manifest.patches.length} patches, ${manifest.files.length} files, `
        + `${manifest.locales.length} locale files (base ${baseSha.slice(0, 7)}, head ${headSha.slice(0, 7)})\n`);
}

main();
