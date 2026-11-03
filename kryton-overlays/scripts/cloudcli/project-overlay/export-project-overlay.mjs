#!/usr/bin/env node
/*
 * VYROBI PROJEKTOVY OVERLAY Z FORKOVE VETVE - nastroj pro cloveka, v buildu NEBEZI.
 *
 * Projektovy overlay (po nacteni vzdy otevreny projekt; plan
 * `docs/plans/2026-10-05-cloudcli-vzdy-otevreny-projekt-plan.md`, Kroky 2a a 3) se
 * VYVIJI ve forku siteboon/claudecodeui, ne tady. Jeho vetev je vyriznuta z commitu
 * HLASOVEHO overlaye (`../voice-overlay/manifest.json`, pole `fork.commit`), tedy ze
 * stromu, ktery ve stage `cloudcli-client` projektovy overlay dostane, a nese dva
 * commity: obecny (jde do upstream PR) a nas (pravidlo `/home/coder/workspace`).
 * Tenhle skript z rozdilu `<base>..<head>` vyrobi obsah `project-overlay/`: jeden patch
 * na kazdy zmeneny upstream soubor (`patches/`), nove soubory (`files/`) a
 * `manifest.json` s sha256 kazdeho dotceneho souboru PRED a PO.
 *
 * ODMITNE: `<base>`, ktery neni commit z hlasoveho manifestu (projektovy overlay by
 * se pak aplikoval na jiny strom, nez na jakem vznikl), `<head>`, ktery neni jeho
 * potomkem, a jakykoli zasah do `server/`, do i18n modulu, do hlasoveho modulu nebo do
 * modulu znacky (`src/brand/`).
 *
 * KDY SE POUSTI: po kazde zmene na forkove vetvi, po kazdem preriznuti hlasoveho
 * overlaye a pri kazdem bumpu pinu.
 *
 * Pouziti:  node export-project-overlay.mjs <fork-dir> --head <ref>
 *               [--base <ref>] [--fork-repo <owner/repo>] [--fork-branch <branch>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOICE_MANIFEST = path.join(HERE, '..', 'voice-overlay', 'manifest.json');
const FORBIDDEN_PREFIXES = ['server/', 'src/modules/i18n/', 'src/modules/chat/voice/', 'src/brand/'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (fork, args, opts = {}) => execFileSync('git', ['-C', fork, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
const show = (fork, ref, file) => git(fork, ['show', `${ref}:${file}`]);
const patchName = (file) => `${file.replace(/\//g, '__')}.patch`;

function parseArgs(argv) {
    const voice = JSON.parse(fs.readFileSync(VOICE_MANIFEST, 'utf8'));
    const out = {
        fork: null,
        base: voice.fork.commit,
        head: null,
        forkRepo: 'mmmirusss/claudecodeui',
        forkBranch: 'feat/project-overlay-v1.37.3',
        voice,
    };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--base') out.base = argv[(i += 1)];
        else if (argv[i] === '--head') out.head = argv[(i += 1)];
        else if (argv[i] === '--fork-repo') out.forkRepo = argv[(i += 1)];
        else if (argv[i] === '--fork-branch') out.forkBranch = argv[(i += 1)];
        else if (!out.fork) out.fork = path.resolve(argv[i]);
        else throw new Error(`unexpected argument ${argv[i]}`);
    }
    if (!out.fork || !out.head) throw new Error('usage: export-project-overlay.mjs <fork-dir> --head <ref> [--base <ref>] [--fork-repo <owner/repo>] [--fork-branch <branch>]');
    return out;
}

function main() {
    const { fork, base, head, forkRepo, forkBranch, voice } = parseArgs(process.argv.slice(2));
    const baseSha = git(fork, ['rev-parse', `${base}^{commit}`]).toString().trim();
    const headSha = git(fork, ['rev-parse', `${head}^{commit}`]).toString().trim();
    if (baseSha !== voice.fork.commit) {
        throw new Error(`base ${baseSha} is not the voice overlay's fork commit ${voice.fork.commit} - the project overlay is cut from the tree after the voice overlay`);
    }
    try {
        git(fork, ['merge-base', '--is-ancestor', baseSha, headSha], { stdio: 'ignore' });
    } catch {
        throw new Error(`head ${headSha} is not a descendant of the voice overlay's commit ${baseSha}`);
    }

    const changes = git(fork, ['diff', '--name-status', '--no-renames', baseSha, headSha]).toString().trim().split('\n').filter(Boolean);
    if (changes.length === 0) throw new Error(`${baseSha}..${headSha} changes nothing`);

    // Nejdriv overit VSECHNY zmeny, teprve pak sahnout na adresar overlaye: odmitnuti nesmi
    // nechat v repu overlay bez `patches/` a `files/`.
    const parsed = changes.map((line) => {
        const [status, file] = line.split('\t');
        const hit = FORBIDDEN_PREFIXES.find((prefix) => file.startsWith(prefix));
        if (hit) throw new Error(`${file}: the project overlay must not touch ${hit}`);
        if (status !== 'M' && status !== 'A') throw new Error(`${file}: status ${status} is not supported - the overlay only modifies and adds files`);
        return { status, file };
    });

    for (const dir of ['patches', 'files']) fs.rmSync(path.join(HERE, dir), { recursive: true, force: true });

    const manifest = {
        upstream: voice.upstream,
        base: {
            description: 'the pin after scripts/cloudcli/apply-cs-locale.mjs and the voice overlay (its fork.commit); the brand overlay runs between them and this one in the cloudcli-client stage and must leave every file listed here untouched (scripts/cloudcli-project-overlay.test.js)',
            forkBranch: voice.fork.branch,
            forkCommit: baseSha,
        },
        fork: { repo: forkRepo, branch: forkBranch, commit: headSha },
        patches: [],
        files: [],
    };

    for (const { status, file } of parsed) {
        if (status === 'M') {
            const patch = git(fork, ['diff', '--no-color', '--no-ext-diff', '--full-index', baseSha, headSha, '--', file]);
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
            const rel = path.posix.join('files', file);
            fs.mkdirSync(path.dirname(path.join(HERE, rel)), { recursive: true });
            fs.writeFileSync(path.join(HERE, rel), body);
            manifest.files.push({ path: file, from: rel, sha256: sha256(body) });
        }
    }

    fs.writeFileSync(path.join(HERE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`project overlay exported: ${manifest.patches.length} patches, ${manifest.files.length} files `
        + `(base ${baseSha.slice(0, 7)}, head ${headSha.slice(0, 7)})\n`);
}

main();
