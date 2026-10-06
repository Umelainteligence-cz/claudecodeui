#!/usr/bin/env node
/*
 * JEDNORAZOVE VYROBI ZVUKOVOU NARAZKU „Běh selhal" - v buildu NEBEZI.
 *
 * Plan „Hlas pro CloudCLI", OQ2: kdyz vlastni beh stavitele selze na strane
 * serveru, jedinym zvukem je pevna ceska veta „Běh selhal" - vyrobena JEDNOU
 * z tohoto pevneho textu, commitnuta jako `assets/beh-selhal.mp3` a za behu
 * prehravana lokalne, bez volani dodavatele. Dokud soubor neexistuje, klient
 * misto ni zazvoni mistni znelkou (`failureCue.ts`) a `apply-voice-overlay.mjs`
 * to v logu buildu rekne.
 *
 * NEPOUSTET, dokud neplati R5 planu: na firemnim uctu ElevenLabs je vypnute
 * treninkove vyuziti dat, prijata DPA a zapsana politika mazani historie
 * (zaznam brany U1). Proto skript vyzaduje `--gate-record-signed`. Text je
 * pevny a neobsahuje zadna klientska data; klic se cte jen z prostredi a nikam
 * se nezapisuje.
 *
 * Pouziti:
 *   ELEVENLABS_API_KEY=... node generate-failure-cue.mjs --voice-id <id> --gate-record-signed
 *     [--model eleven_flash_v2_5]
 * Po vyrobe: poslechnout, commitnout `assets/beh-selhal.mp3`, prestavet obraz.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CUE_TEXT = 'Běh selhal';
const OUT = path.join(HERE, 'assets', 'beh-selhal.mp3');

function fail(message) {
    process.stderr.write(`failure cue NOT generated - ${message}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const out = { voiceId: null, model: 'eleven_flash_v2_5', signed: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--voice-id') out.voiceId = argv[(i += 1)] ?? null;
        else if (a === '--model') out.model = argv[(i += 1)] ?? out.model;
        else if (a === '--gate-record-signed') out.signed = true;
        else fail(`unknown argument ${a}`);
    }
    return out;
}

async function main() {
    const { voiceId, model, signed } = parseArgs(process.argv.slice(2));
    if (!signed) fail('the U1 gate record (R5: training off, DPA accepted, history policy written) must be signed first; pass --gate-record-signed once it is');
    if (!voiceId || !/^[A-Za-z0-9]{8,64}$/.test(voiceId)) fail('--voice-id <the Czech voice chosen by the listening test> is required');
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) fail('ELEVENLABS_API_KEY is not set in the environment');

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: CUE_TEXT, model_id: model, language_code: 'cs' }),
    });
    if (!res.ok) fail(`the vendor answered ${res.status}; nothing was written`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 1000) fail(`the vendor returned only ${audio.length} bytes; nothing was written`);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, audio);
    const digest = crypto.createHash('sha256').update(audio).digest('hex');
    process.stdout.write(`failure cue written: ${path.relative(HERE, OUT)} (${audio.length} bytes, sha256 ${digest}, voice ${voiceId}, model ${model})\n`);
}

await main();
