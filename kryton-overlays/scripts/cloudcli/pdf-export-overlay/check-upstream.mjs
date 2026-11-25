#!/usr/bin/env node
/*
 * PDF overlay (E474) - zmereni a kontrola manifestu proti SKUTECNYM upstream souborum.
 *
 * Manifest nese pro kazdy upraveny soubor zname `before` (upstream) a `after` (po vlozkach)
 * pro kazdou podporovanou verzi. Tenhle nastroj je zmeri ze stazenych souboru a:
 *   - bez prepinace porovna s manifestem (exit 1 pri rozjeti) - "kotva sedi na upstream";
 *   - s `--write` je do manifestu zapise (pri recutu na novou verzi) a dopise `files` ze slozky files/.
 * Zdroj souboru:
 *   --online           `gh api` GET na siteboon/claudecodeui pro tagy z VERSIONS a pin z Dockerfile.server
 *   --from-dir <dir>   offline: <dir>/<verze>/<jmeno souboru> (napr. v1.37.3/ChatExportMenu.tsx)
 * Pousti clovek nebo koordinator, ne brana CI (sit). AGPL kod upstreamu se do repa nevendoruje.
 *
 * Pouziti: node check-upstream.mjs (--online | --from-dir <dir>) [--write]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { applyInserts, sha256 } from './apply-pdf-export-overlay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const UPSTREAM = 'siteboon/claudecodeui';
/** Verze, na ktere ma overlay sedet (plan E474, rozhodnuti platformy 25. 11. 2026). */
export const VERSIONS = ['v1.37.3', 'v1.37.10'];

function pinFromDockerfile() {
    const text = fs.readFileSync(path.join(REPO, 'Dockerfile.server'), 'utf8');
    const version = /^ARG CLOUDCLI_VERSION=(\S+)$/m.exec(text)?.[1];
    const commit = /^ARG CLOUDCLI_COMMIT=([0-9a-f]{40})$/m.exec(text)?.[1];
    if (!version || !commit) throw new Error('Dockerfile.server has no CLOUDCLI_VERSION/CLOUDCLI_COMMIT');
    return { version: `v${version}`, commit };
}

function fetchOnline(ref, file) {
    return execFileSync('gh', ['api', `repos/${UPSTREAM}/contents/${file}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw'], { maxBuffer: 16 * 1024 * 1024 });
}

function filesUnder(dir, base = dir) {
    const out = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) out.push(...filesUnder(full, base));
        else out.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return out;
}

function main(argv) {
    const write = argv.includes('--write');
    const online = argv.includes('--online');
    const fromIdx = argv.indexOf('--from-dir');
    if (online === (fromIdx !== -1)) throw new Error('usage: check-upstream.mjs (--online | --from-dir <dir>) [--write]');
    const fromDir = fromIdx !== -1 ? path.resolve(argv[fromIdx + 1]) : null;
    const read = (ref, file) => (online ? fetchOnline(ref, file) : fs.readFileSync(path.join(fromDir, ref, path.basename(file))));

    const manifestFile = path.join(HERE, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const pin = pinFromDockerfile();
    const problems = [];

    for (const e of manifest.edits) {
        const known = [];
        for (const version of VERSIONS) {
            const body = read(version, e.file);
            const out = applyInserts(body.toString('utf8'), e.inserts, `${e.file}@${version}`);
            known.push({ version, before: sha256(body), after: sha256(Buffer.from(out, 'utf8')) });
        }
        if (online) {
            const atPin = sha256(fetchOnline(pin.commit, e.file));
            if (!known.some((k) => k.before === atPin)) problems.push(`${e.file}: the pin ${pin.version} ${pin.commit} has ${atPin}, not a known before`);
        }
        if (write) e.known = known;
        else if (JSON.stringify(e.known) !== JSON.stringify(known)) problems.push(`${e.file}: manifest ${JSON.stringify(e.known)} != measured ${JSON.stringify(known)}`);
    }
    for (const w of manifest.watched ?? []) {
        const known = VERSIONS.map((version) => ({ version, sha256: sha256(read(version, w.file)) }));
        if (write) w.known = known;
        else if (JSON.stringify(w.known) !== JSON.stringify(known)) problems.push(`${w.file} (watched) changed: ${JSON.stringify(known)}`);
    }
    const files = filesUnder(path.join(HERE, 'files')).map((rel) => ({
        path: rel,
        from: `files/${rel}`,
        sha256: sha256(fs.readFileSync(path.join(HERE, 'files', rel))),
    }));
    if (write) manifest.files = files;
    else if (JSON.stringify(manifest.files) !== JSON.stringify(files)) problems.push('files: the manifest does not match the files/ directory');

    if (write) {
        fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
        process.stdout.write(`manifest written: ${manifest.edits.length} edited files x ${VERSIONS.length} versions, ${files.length} new files\n`);
    }
    if (problems.length) {
        process.stderr.write(`PDF overlay upstream check FAILED:\n  - ${problems.join('\n  - ')}\n`);
        process.exit(1);
    }
    if (!write) process.stdout.write(`PDF overlay upstream check OK (${online ? `online, pin ${pin.version}` : 'from dir'}): ${VERSIONS.join(', ')}\n`);
}

main(process.argv.slice(2));
