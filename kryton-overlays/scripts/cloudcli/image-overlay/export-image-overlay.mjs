#!/usr/bin/env node
/*
 * VYROBI OBRAZKOVY OVERLAY Z GITOVEHO STROMU - nastroj pro cloveka, v buildu NEBEZI.
 *
 * Obrazkovy overlay (backport upstream siteboon/claudecodeui#1307 + nase odmitnuti
 * vlastniho originu a `/api/`, viz hlavicka `apply-image-overlay.mjs`) se vyrabi z repozitare,
 * ve kterem:
 *   <base> = pin `upstream.commit` z hlasoveho manifestu, na nem po rade
 *            `apply-cs-locale.mjs`, hlasovy, brand a projektovy overlay (jeden commit),
 *   <head> = potomek <base>: upstream commit 4b98d2e (`git apply` jeho diffu) a nase uprava.
 * Postup (30. 10. 2026, cli2): klon pinu, ctyri apply skripty z tohoto repa, commit,
 * `git diff 4b98d2e^ 4b98d2e | git apply`, commit, uprava `MarkdownImage.tsx` + test, commit.
 * Hashe `before` v manifestu jsou tedy VYSTUP vsech ctyr drivejsich overlayu: jejich zmena
 * v `Markdown.tsx` nebo `ChatInterface.tsx` tenhle overlay donuti preriznout.
 *
 * Z rozdilu `<base>..<head>` vyrobi obsah `image-overlay/`: jeden patch na kazdy zmeneny
 * upstream soubor (`patches/`), nove soubory (`files/`) a `manifest.json` s sha256 kazdeho
 * dotceneho souboru PRED a PO. ODMITNE `<head>`, ktery neni potomkem `<base>`, a jakykoli
 * zasah do `server/`, i18n modulu, hlasoveho modulu, `src/brand/` nebo modulu projektu.
 *
 * KDY SE POUSTI: po kazde zmene nektereho z drivejsich overlayu v souborech manifestu
 * a po zmene nasi upravy. Pri bumpu pinu na >= 1.37.4 se overlay maze (viz apply).
 *
 * Pouziti:  node export-image-overlay.mjs <repo-dir> --base <ref> --head <ref>
 *               [--fork-repo <owner/repo>] [--fork-branch <branch>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOICE_MANIFEST = path.join(HERE, '..', 'voice-overlay', 'manifest.json');
const FORBIDDEN_PREFIXES = ['server/', 'src/modules/i18n/', 'src/modules/chat/voice/', 'src/brand/', 'src/modules/project-workspace/'];
const UPSTREAM_CHANGE = {
    pr: 'siteboon/claudecodeui#1307',
    commit: '4b98d2eaec077470b737790b32e896051c5ff5ba',
    release: '1.37.4',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (repo, args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
const show = (repo, ref, file) => git(repo, ['show', `${ref}:${file}`]);
const patchName = (file) => `${file.replace(/\//g, '__')}.patch`;

function parseArgs(argv) {
    const out = { repo: null, base: null, head: null, forkRepo: 'mmmirusss/claudecodeui', forkBranch: 'feat/image-overlay-v1.37.3' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--base') out.base = argv[(i += 1)];
        else if (argv[i] === '--head') out.head = argv[(i += 1)];
        else if (argv[i] === '--fork-repo') out.forkRepo = argv[(i += 1)];
        else if (argv[i] === '--fork-branch') out.forkBranch = argv[(i += 1)];
        else if (!out.repo) out.repo = path.resolve(argv[i]);
        else throw new Error(`unexpected argument ${argv[i]}`);
    }
    if (!out.repo || !out.base || !out.head) throw new Error('usage: export-image-overlay.mjs <repo-dir> --base <ref> --head <ref> [--fork-repo <owner/repo>] [--fork-branch <branch>]');
    return out;
}

function main() {
    const { repo, base, head, forkRepo, forkBranch } = parseArgs(process.argv.slice(2));
    const voice = JSON.parse(fs.readFileSync(VOICE_MANIFEST, 'utf8'));
    const baseSha = git(repo, ['rev-parse', `${base}^{commit}`]).toString().trim();
    const headSha = git(repo, ['rev-parse', `${head}^{commit}`]).toString().trim();
    try {
        git(repo, ['merge-base', '--is-ancestor', baseSha, headSha], { stdio: 'ignore' });
    } catch {
        throw new Error(`head ${headSha} is not a descendant of base ${baseSha}`);
    }

    const changes = git(repo, ['diff', '--name-status', '--no-renames', baseSha, headSha]).toString().trim().split('\n').filter(Boolean);
    if (changes.length === 0) throw new Error(`${baseSha}..${headSha} changes nothing`);

    // Nejdriv overit VSECHNY zmeny, teprve pak sahnout na adresar overlaye.
    const parsed = changes.map((line) => {
        const [status, file] = line.split('\t');
        const hit = FORBIDDEN_PREFIXES.find((prefix) => file.startsWith(prefix));
        if (hit) throw new Error(`${file}: the image overlay must not touch ${hit}`);
        if (status !== 'M' && status !== 'A') throw new Error(`${file}: status ${status} is not supported - the overlay only modifies and adds files`);
        return { status, file };
    });

    for (const dir of ['patches', 'files']) fs.rmSync(path.join(HERE, dir), { recursive: true, force: true });

    const manifest = {
        upstream: voice.upstream,
        upstreamChange: UPSTREAM_CHANGE,
        base: {
            description: 'the pin after scripts/cloudcli/apply-cs-locale.mjs, the voice, the brand and the project overlay, in the cloudcli-client stage order; every before hash below is that tree',
            commit: baseSha,
        },
        fork: { repo: forkRepo, branch: forkBranch, commit: headSha, published: false },
        patches: [],
        files: [],
    };

    for (const { status, file } of parsed) {
        if (status === 'M') {
            const patch = git(repo, ['diff', '--no-color', '--no-ext-diff', '--full-index', baseSha, headSha, '--', file]);
            const rel = path.posix.join('patches', patchName(file));
            fs.mkdirSync(path.join(HERE, 'patches'), { recursive: true });
            fs.writeFileSync(path.join(HERE, rel), patch);
            manifest.patches.push({ file, patch: rel, before: sha256(show(repo, baseSha, file)), after: sha256(show(repo, headSha, file)) });
        } else {
            const body = show(repo, headSha, file);
            const rel = path.posix.join('files', file);
            fs.mkdirSync(path.dirname(path.join(HERE, rel)), { recursive: true });
            fs.writeFileSync(path.join(HERE, rel), body);
            manifest.files.push({ path: file, from: rel, sha256: sha256(body) });
        }
    }

    fs.writeFileSync(path.join(HERE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`image overlay exported: ${manifest.patches.length} patches, ${manifest.files.length} files `
        + `(base ${baseSha.slice(0, 7)}, head ${headSha.slice(0, 7)})\n`);
}

main();
