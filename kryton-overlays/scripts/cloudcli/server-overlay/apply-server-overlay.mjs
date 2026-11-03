#!/usr/bin/env node
/*
 * SERVEROVY OVERLAY CloudCLI - loopback token a bez bypassPermissions (ZA6.3 / P2-05,
 * RD-AUD-T-0040, nalez RD-AUD-0052; plan docs/plans/2026-10-11-naprava-auditu-plan.md,
 * karta ZA6; dodatek RD-ADR-055 z 13. 10. 2026).
 *
 * CO RESI. CloudCLI bezi v platform modu na 127.0.0.1:3001 a pousti KAZDY proces
 * pracovny (uid coder) bez credentialu: REST i WebSocket vezmou prvniho uzivatele
 * databaze. Supervisor (scripts/cloudcli-start.sh) proto spousti CloudCLI s
 * `API_KEY=<loopback token>` - upstreamovy `validateApiKey` (`server/index.js`,
 * `app.use('/api', validateApiKey)`) pak kazde /api bez `X-API-Key` odmitne 401 a brana
 * (scripts/cloudcli-gate.Caddyfile.tmpl) hlavicku prohlizeci prida. Upstream ale
 * NEKRYJE WebSocket a nabizi rezim bez dotazu. Tenhle overlay doplni presne to:
 *
 *   0. API_KEY se pri nacteni `auth.middleware.js` (server bezi v jednom procesu, `cloudcli
 *      start` ho importuje) PREVEZME do konstanty modulu a SMAZE z `process.env`: upstream
 *      predava cele `process.env` vsemu, co spousti (chat Claude, PTY `/shell`, Codex,
 *      Cursor, OpenCode, git) - bez toho by token prectl kazdy model v CloudCLI pres `printenv`
 *      (revize A a B 13. 10. 2026). /proc/<pid>/environ nese puvodni blok dal; ten hlida ZA0.9;
 *   1. WebSocket (`/ws`, `/shell`, `/desktop-notifications`, `/plugin-ws/*`): s nastavenym
 *      API_KEY chce upgrade stejnou `X-API-Key` (timingSafeEqual) - jinak 401 od `ws`;
 *   2. `/api/browser-use-mcp/tools/<nastroj>` se z `validateApiKey` vyjima: ma vlastni token
 *      upstreamu (`browser-use-mcp.routes.js`) a vola ho Browser MCP z Clauda, ktery API_KEY
 *      nezna - bez vyjimky by Browser MCP v pracovne padal;
 *   3. bez bypassPermissions: rezim zmizi ze seznamu schopnosti vsech ctyr poskytovatelu
 *      (klient z nej stavi nabidku), a server ho neuplatni, ani kdyz prijde - Claude
 *      (`permissionMode` z klienta i `skipPermissions` z nastaveni; rezim jde do SDK VZDY
 *      vyslovne, takze `permissions.defaultMode` z nastaveni bypass nevrati, a vrstva flag
 *      settings nese `disableBypassPermissionsMode: 'disable'`; kryje chat i generovani commit
 *      zpravy), Codex (`danger-full-access`), OpenCode (`--auto`), Cursor (`-f`) a terminal
 *      `/shell` (`--dangerously-skip-permissions` z zatrzitka);
 *   4. `/api/agent` (neinteraktivni beh agenta s pevnym bypass) = 403. V produktu ho nic nevola;
 *   5. `POST /api/system/update` (samoaktualizace z aplikace) = 403 KRYTON_SELF_UPDATE_DISABLED (CC9,
 *      Q1670 = A1): CloudCLI prichazi s obrazem pracovny, update z aplikace by obesel pin i overlaye.
 *      Klient tlacitko nenabidne (brand overlay vypina kontrolu verze v `useVersionCheck`);
 *   6. kod chyby Claude pro ceskou kartu (lnk2, plan docs/plans/2026-10-30-ceske-hlaseni-chyb-plan.md,
 *      krok K2): `normalizeMessage` (ziva zprava i radek historie) prenese `error` zpravy asistenta
 *      jako `errorCode`, `kind: 'error'` z behu nese kod posledni chyby TEHOZ behu. Kartu kresli
 *      klient (scripts/cloudcli/error-overlay/); neznamy kod = dnesni text.
 *
 * CO NEDELA. Neni to hranice uid: token cte kazdy proces `coder` (soubor i
 * /proc/<pid>/environ). Brzdi slepe a modelem rizene pokusy na loopback, ne cileny kod
 * spusteny jako `coder` - ten si `claude --dangerously-skip-permissions` spusti sam.
 * Terminal `/shell` (PTY s libovolnym prikazem) zustava terminalem: zatrzitko „bypass" uz
 * nic nepripoji, ale prikaz si builder v terminalu napise sam - chrani ho bod 1. Prepinace
 * „skip permissions" v nastaveni klienta a v terminalu zustanou v UI, ale nic neudelaji.
 *
 * KAZDE PREKVAPENI JE CERVENE a NIC se nezapise, dokud neprojde kontrola VSEHO: soubor,
 * jehoz sha256 neni ani `before` ani `after` = MANIFEST_MISMATCH; kotva chybi nebo je
 * vickrat, nez rika `count` = ANCHOR_MISSING / ANCHOR_COUNT; vysledek upravy neni `after`
 * = EDIT_RESULT_MISMATCH. Soubor, ktery uz ma `after`, se preskoci (idempotence). Hashe
 * jsou ZMERENE na @cloudcli-ai/cloudcli@1.37.3 z lockfile `scripts/cloudcli/` (13. 10. 2026) -
 * AZ NA claude-runtime.provider.js a claude-sessions.provider.js: od 16. 10. 2026 (dodatek RD-ADR-055, rozhodnuti majitele R1-R5)
 * bezi server POSTAVENY ze zdroje s forkovym overlayem (`scripts/cloudcli/voice-overlay/`, dukaz
 * `check-server-dist.mjs`), a ty soubory prstenec meni - jejich hashe jsou zmerene na forkovem buildu
 * (`measuredOn`). Hash pak potvrzuje, co fork zkompiloval, NE upstream; proto kazde preriznuti
 * tohoto souboru chce SEMANTICKE cteni: rozdil proti tarballu nesmi mimo dve kotvy nize nic
 * prirazovat do permissionMode, settings, allowDangerouslySkipPermissions ani pridat povolujici
 * canUseTool (16. 10. 2026 precteno: 261 pridanych, 13 odebranych radku, nic z toho; nova
 * injekce `createQuery` prichazi z createRuntimeContext na serveru, ne od klienta). Ostatnich
 * osm souboru dukaz drzi bajtove shodnych s tarballem. Cast toho cteni je od 16. 10. 2026 i
 * BRANA (H4, `semanticGuard`): upraveny text kazdeho souboru postaveneho z forku (`measuredOn`)
 * musi mit prave jedno prirazeni `sdkOptions.permissionMode` (u claude-sessions zadne,
 * `measuredOn.permissionModeAssignments`), zadne
 * `allowDangerouslySkipPermissions` a zadne prirazeni 'bypassPermissions' (porovnani `===`/`!==`
 * se nepocitaji) - jinak SEMANTIC_GUARD a nic se nezapise. Rucni cteni nenahrazuje;
 * `settings` a `canUseTool` hlida dal jen ono;
 * bump pinu = preriznout: `node apply-server-overlay.mjs <pkg> --print-hashes` nad cerstvym
 * stromem, kotvy opravit, hashe prepsat. Pin verze hlida `scripts/cloudcli-server-overlay.test.js`.
 *
 * LICENCE (AGPL-3.0-or-later): CloudCLI je AGPL, tahle uprava se nasazuje v obrazu.
 * Nabidka zdroje je tenhle soubor; kam ji vystavit verejne (fork jako u ceskeho a
 * hlasoveho overlaye), je otevrene rozhodnuti operatora (plan s6, .relay/s6-plan.md).
 *
 * Ciste Node 22, nula zavislosti. Pouziti (Dockerfile.server, stage `base`, po `npm ci`):
 *   node apply-server-overlay.mjs /opt/cloudcli/node_modules/@cloudcli-ai/cloudcli
 *   node apply-server-overlay.mjs <pkg> --check          (jen kontrola, nic nezapise)
 *   node apply-server-overlay.mjs <pkg> --print-hashes   (preriznuti: before/after)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MEASURED_ON = { package: '@cloudcli-ai/cloudcli', version: '1.37.3' };

const MARK = 'KRYTON OVERLAY (ZA6.3, RD-AUD-0052)';

// The helper the WebSocket edit needs. Same semantics as upstream's HTTP check:
// no API_KEY = no check (the supervisor never starts CloudCLI without one; the
// platform probe's arm A runs without it on purpose).
const WS_HELPER = `// ${MARK}: the loopback key check shared with validateApiKey (auth.middleware.js
// takes API_KEY out of process.env at load and keeps it there).
import { krytonLoopbackKeyOk } from '../../auth/auth.middleware.js';
`;

// lnk2: which error a run ended on. Pure, so the order (assistant, then retry, then no
// answer at all) is testable; `error_status: null` on a retry = the API never answered.
// `unknown` never replaces something more specific, and a message without an error means
// the retry worked, so the code must not survive into a later, unrelated failure.
// A retry that is not the last ANNOUNCED one (attempt < max_retries) sets nothing: the next try
// may succeed, and nothing is sent while the answer is generated, so a code taken from it
// would outlive the success and put a false card on a later crash (review dop1, P2). The last
// announced retry (attempt >= max_retries) is NOT the last try: api_retry is sent BEFORE the
// retry and the CLI makes max_retries + 1 tries, so one more try follows. Accepted residual risk
// (delta review dop1, P3): if that try succeeds, its first assistant row clears the code; only a
// crash while it is still generating shows this code. What this costs: a run that ends with an
// assistant row that carries a specific `error` never uses the api_retry code (that row wins);
// an assistant row with `unknown` keeps it (`unknown` never replaces a specific code). So the
// code, and the `network` card with it, decides for a crash during the last try, or for a run
// whose last assistant row says only `unknown`.
// A message without the counters (older shape) is taken as before.
const NEXT_ERROR_CODE = `// KRYTON OVERLAY (lnk2): the error code of the current run, for the Czech card.
export function krytonNextErrorCode(previous, message) {
    if (message?.type === 'assistant') {
        if (typeof message.error !== 'string' || !message.error) {
            return null;
        }
        return message.error === 'unknown' ? previous : message.error;
    }
    if (message?.type === 'system' && message.subtype === 'api_retry') {
        if (typeof message.attempt === 'number' && typeof message.max_retries === 'number' && message.attempt < message.max_retries) {
            return previous;
        }
        if (message.error_status === null) {
            return 'network';
        }
        return typeof message.error === 'string' && message.error !== 'unknown' ? message.error : previous;
    }
    return previous;
}
`;

/**
 * The edits, per file. `find` must occur exactly `count` times (default 1) in
 * the file as `before` measures it; every occurrence becomes `replace`.
 */
export const EDITS = [
    {
        path: 'dist-server/server/modules/websocket/services/websocket-auth.service.js',
        why: 'WebSocket upgrade bez X-API-Key = odmitnuti (upstream ho v platform modu pousti vzdy)',
        before: '649fa8c533cb709470d0b8036d030a5755bf3b93cda507e8f5f7e60946e27c15',
        after: '7210a0e7d897764826c301b5f9e48ca516b66ada7c272fa633f69c6e9df77812',
        edits: [
            {
                find: '/**\n * Authenticates websocket upgrade requests before the `connection` handler runs.\n */\n',
                replace: `${WS_HELPER}/**\n * Authenticates websocket upgrade requests before the \`connection\` handler runs.\n */\n`,
            },
            {
                find: "    console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);\n",
                replace: "    console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);\n"
                    + `    // ${MARK}\n`
                    + "    if (!krytonLoopbackKeyOk(request.headers['x-api-key'])) {\n"
                    + "        console.log('[WARN] WebSocket refused: missing or wrong X-API-Key');\n"
                    + '        return false;\n'
                    + '    }\n',
            },
        ],
    },
    {
        path: 'dist-server/server/modules/auth/auth.middleware.js',
        why: 'API_KEY se prevezme a smaze z process.env (deti ho nededi); Browser MCP ma vlastni token',
        before: 'a218ca358c600419abb4c3414815e4d0aab27bfd15a91936c72f9d2049819d92',
        after: '809f2f6b758c3d057501b9c6fa21c023f31ce1ec5f7d0ffbbfaf93b0acdae490',
        edits: [
            {
                find: '// Optional API key middleware\nconst validateApiKey = (req, res, next) => {\n    // Skip API key validation if not configured\n    if (!process.env.API_KEY) {\n        return next();\n    }\n',
                replace: `// ${MARK}: API_KEY (the loopback token) is taken out of the\n`
                    + '// environment at load: upstream hands its whole process.env to every child it\n'
                    + '// spawns (Claude, the /shell PTY, Codex, Cursor, OpenCode, git), and a model\n'
                    + '// there would read the token with `printenv`. Nothing else reads API_KEY.\n'
                    + 'const KRYTON_LOOPBACK_API_KEY = process.env.API_KEY || \'\';\n'
                    + 'delete process.env.API_KEY;\n'
                    + 'function krytonLoopbackKeyOk(header) {\n'
                    + '    if (!KRYTON_LOOPBACK_API_KEY) {\n'
                    + '        return true;\n'
                    + '    }\n'
                    + "    if (typeof header !== 'string') {\n"
                    + '        return false;\n'
                    + '    }\n'
                    + '    const a = Buffer.from(header);\n'
                    + '    const b = Buffer.from(KRYTON_LOOPBACK_API_KEY);\n'
                    + '    return a.length === b.length && krytonTimingSafeEqual(a, b);\n'
                    + '}\n'
                    + '// Optional API key middleware\nconst validateApiKey = (req, res, next) => {\n    // Skip API key validation if not configured\n'
                    + '    if (!KRYTON_LOOPBACK_API_KEY) {\n        return next();\n    }\n'
                    + `    // ${MARK}: the Browser MCP bridge authenticates with its own token\n`
                    + '    // (browser-use-mcp.routes.js) and the Claude that calls it does not know API_KEY.\n'
                    + "    if (req.method === 'POST' && /^\\/browser-use-mcp\\/tools\\/[A-Za-z_]+$/.test(req.path)) {\n"
                    + '        return next();\n'
                    + '    }\n',
            },
            {
                find: "    const apiKey = req.headers['x-api-key'];\n    if (apiKey !== process.env.API_KEY) {\n",
                replace: "    const apiKey = req.headers['x-api-key'];\n    if (!krytonLoopbackKeyOk(apiKey)) {\n",
            },
            {
                find: "import jwt from 'jsonwebtoken';\n",
                replace: "import jwt from 'jsonwebtoken';\nimport { timingSafeEqual as krytonTimingSafeEqual } from 'crypto';\n",
            },
            {
                find: 'export { validateApiKey, authenticateToken, generateToken, authenticateWebSocket, JWT_SECRET };',
                replace: 'export { validateApiKey, authenticateToken, generateToken, authenticateWebSocket, JWT_SECRET, krytonLoopbackKeyOk };',
            },
        ],
    },
    {
        path: 'dist-server/server/modules/providers/services/provider-capabilities.service.js',
        why: 'rezim bypassPermissions zmizi z nabidky vsech ctyr poskytovatelu',
        before: '2642c77af13eef535fcd8f5d28968d2b667792dfce4e3caf543ad55569425dc0',
        after: '56bbc6395aafbe387c51d2980b0ae5adc4c002fc81b8b69a08be58208fecda90',
        edits: [
            {
                find: "permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],",
                replace: "permissionModes: ['default', 'auto', 'acceptEdits', 'plan'], // " + MARK,
            },
            {
                find: "permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],",
                replace: "permissionModes: ['default', 'acceptEdits', 'plan'], // " + MARK,
                count: 2,
            },
            {
                find: "permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],",
                replace: "permissionModes: ['default', 'acceptEdits'], // " + MARK,
            },
        ],
    },
    {
        path: 'dist-server/server/modules/providers/list/claude/claude-runtime.provider.js',
        why: 'Claude: bypassPermissions z klienta ani skipPermissions z nastaveni se neuplatni',
        // Zmereno na serveru POSTAVENEM z forku (forkovy overlay nese kontextovy prstenec,
        // Umelainteligence-cz/claudecodeui, commit viz measuredOn.forkCommit), ne na tarballu:
        // prstenec tenhle soubor meni. Tarballove hashe byly before 88c33fb1..., after 3b41909b....
        // Kazdy re-export forkoveho overlaye, ktery soubor zmeni, ho preriznout + SEMANTICKY
        // precist (hlavicka); `semanticGuard` cast toho cteni hlida pri kazdem buildu.
        measuredOn: { source: 'fork-built dist-server (scripts/cloudcli/voice-overlay)', forkCommit: '47a2d955' },
        before: '7a72041be19570e434a7f88708a1cb7fe39e0a851009660f507504fd3a775fab',
        after: '4d1aab4190d9789b3394af71c02ba38f18d5b29cba3e56c00b2ce1cb4725fc87',
        edits: [
            {
                find: "    if (permissionMode && permissionMode !== 'default') {\n        sdkOptions.permissionMode = permissionMode;\n    }\n",
                replace: `    // ${MARK}: bypassPermissions is never applied from CloudCLI. The mode\n`
                    + '    // always goes to the SDK explicitly, so a permissions.defaultMode in the\n'
                    + '    // settings cannot bring bypass back, and the flag-settings layer (highest of\n'
                    + '    // the user-controlled ones) disables the mode itself.\n'
                    + "    sdkOptions.permissionMode = (permissionMode && permissionMode !== 'bypassPermissions') ? permissionMode : 'default';\n"
                    + '    sdkOptions.settings = {\n'
                    + '        ...(sdkOptions.settings || {}),\n'
                    + "        permissions: { ...((sdkOptions.settings && sdkOptions.settings.permissions) || {}), disableBypassPermissionsMode: 'disable' }\n"
                    + '    };\n',
            },
            {
                find: "    if (settings.skipPermissions && permissionMode !== 'plan') {\n        sdkOptions.permissionMode = 'bypassPermissions';\n    }\n",
                replace: `    // ${MARK}: settings.skipPermissions is ignored (no bypass from CloudCLI).\n`,
            },
            {
                find: '/**\n * Transforms SDK messages to WebSocket format expected by frontend\n',
                replace: `${NEXT_ERROR_CODE}/**\n * Transforms SDK messages to WebSocket format expected by frontend\n`,
            },
            {
                find: '    let assistantBudgetSent = false;\n',
                replace: '    let assistantBudgetSent = false;\n'
                    + '    // KRYTON OVERLAY (lnk2): per run on purpose, a second run must not inherit it.\n'
                    + '    let krytonErrorCode = null;\n',
            },
            {
                find: '            // Transform and normalize message via adapter\n',
                replace: '            krytonErrorCode = krytonNextErrorCode(krytonErrorCode, message);\n'
                    + '            // Transform and normalize message via adapter\n',
            },
            {
                find: "ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));\n",
                replace: "ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, errorCode: !installed ? 'not_installed' : (krytonErrorCode || undefined), sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));\n",
            },
        ],
    },
    {
        path: 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js',
        why: 'lnk2: zprava asistenta s chybou nese errorCode (ziva i z historie), klient z nej kresli ceskou kartu',
        // Forkovy overlay tenhle soubor meni, takze hash je z forkoveho buildu (obraz rd-testu
        // 3f6a3c2, 31. 10. 2026). Povolen nulovy pocet prirazeni rezimu: soubor rezim nikdy nenastavuje.
        measuredOn: { source: 'fork-built dist-server (scripts/cloudcli/voice-overlay)', forkCommit: '47a2d955', permissionModeAssignments: 0 },
        before: 'ef9def7196e93e97a539f6840195ee7622a80930401be13de86de82e30cf365c',
        after: '138e6eedf33a106356cb3bc4f8171f5d5674707dd29d009387d81f09b095fab1',
        edits: [
            {
                find: "        const anchorId = typeof raw?.uuid === 'string' && raw.uuid ? raw.uuid : null;\n",
                replace: '        // KRYTON OVERLAY (lnk2): the typed code of a failed turn. This one function draws\n'
                    + '        // the live chat and the history, so a reload shows the same card.\n'
                    + "        if (raw?.type === 'assistant' && typeof raw.error === 'string' && raw.error) {\n"
                    + '            for (const message of messages) {\n'
                    + "                if (message.kind === 'text' && message.role === 'assistant') {\n"
                    + '                    message.errorCode = raw.error;\n'
                    + '                }\n'
                    + '            }\n'
                    + '        }\n'
                    + "        const anchorId = typeof raw?.uuid === 'string' && raw.uuid ? raw.uuid : null;\n",
            },
        ],
    },
    {
        path: 'dist-server/server/modules/providers/list/codex/codex-runtime.provider.js',
        why: 'Codex: bypassPermissions (danger-full-access) padne do vychoziho sandboxu',
        before: '297ac7095dd88fbbe78a6a04fd64cb3f9c1f00fd87a904d887d1228b1df4b248',
        after: '9e8e39965672fa7bcf06d843484a43620752e002eb43c7c78f691d19b3b0fd73',
        edits: [
            {
                find: "        case 'bypassPermissions':\n            return {\n                sandboxMode: 'danger-full-access',\n                approvalPolicy: 'never'\n            };\n",
                replace: `        // ${MARK}: bypassPermissions falls through to the default sandbox.\n`,
            },
        ],
    },
    {
        path: 'dist-server/server/modules/providers/list/opencode/opencode-runtime.provider.js',
        why: 'OpenCode: bypassPermissions (--auto) padne do vychoziho rezimu',
        before: '51b69b33d11cb141c187eeeb8dfb0373eeb94d8645481b86859d1c106d12de01',
        after: '01bf9c483a7e0a5020210c02dd33835ef92cbe21a70d9c1dead5e8d8feb861ff',
        edits: [
            {
                find: "        case 'bypassPermissions':\n            return { args: ['--auto'], env: {} };\n",
                replace: `        // ${MARK}: bypassPermissions (--auto) falls through to the default.\n`,
            },
        ],
    },
    {
        path: 'dist-server/server/modules/providers/list/cursor/cursor-runtime.provider.js',
        why: 'Cursor: skipPermissions (-f) se neuplatni',
        before: 'c647f840375a507d19075bcad2f40e78660b2e954bb9eccf837b4b183b74e2c6',
        after: 'e8a2970e644d81cb68c412e5f2918d9b07b49a10441432cb2b6d1754c3836bd6',
        edits: [
            {
                find: "        // Add skip permissions flag if enabled\n        if (skipPermissions || settings.skipPermissions) {\n            baseArgs.push('-f');\n        }\n",
                replace: `        // ${MARK}: the skip-permissions flag (-f) is never passed from CloudCLI.\n`,
            },
        ],
    },
    {
        path: 'dist-server/server/modules/websocket/services/shell-websocket.service.js',
        why: 'terminal: zatrzitko bypass uz nepripoji --dangerously-skip-permissions',
        before: 'd8b3535ae73ca7fa573896c07b12f524de10b7a136ca5d321dc9b983a55f95e8',
        after: '39381d26da8a9e75b0665a6560d72342c84ab0d9cf949cf3926ff77b04f4e248',
        edits: [
            {
                find: "    const bypassFlag = readBoolean(message.bypassPermissions)\n        ? ' --dangerously-skip-permissions'\n        : '';\n",
                replace: `    // ${MARK}: the terminal's bypass checkbox adds nothing.\n`
                    + "    const bypassFlag = '';\n",
            },
        ],
    },
    {
        path: 'dist-server/server/index.js',
        why: '/api/agent (neinteraktivni agent, vzdy bypass) = 403; samoaktualizace /api/system/update = 403 (CC9)',
        before: '49dc54d788ec1b91e72d046f89a58433a1a5fb813e670d538363149fdda77d43',
        after: 'd2b165dac00181c2b534ca4bd93c50e0b83dc879865dc63298f78b7191781ba9',
        edits: [
            {
                find: "// Agent API Routes (uses API key authentication)\napp.use('/api/agent', agentRoutes);\n",
                replace: `// ${MARK}: the agent API runs every provider with bypassed permissions and\n`
                    + '// nothing in this workspace calls it - refused.\n'
                    + "app.use('/api/agent', (req, res) => {\n"
                    + "    res.status(403).json({ error: 'The agent API is disabled in this workspace.', code: 'KRYTON_AGENT_API_DISABLED' });\n"
                    + '});\n',
            },
            {
                // CC9 (operator Q1670 = A1, 24. 10. 2026): CloudCLI comes with the
                // workspace image (pinned, with our overlays and Czech); the in-app
                // update would `npm run update:platform` / `npm install -g` past all
                // of that. The client never offers it (brand overlay, useVersionCheck),
                // this refuses a request that arrives anyway.
                find: "app.use('/api/system', authenticateToken, systemRoutes);\n",
                replace: '// KRYTON OVERLAY (CC9, Q1670 = A1): CloudCLI is updated with the workspace image, never from\n'
                    + '// the app (the update would bypass the pinned image and its overlays).\n'
                    + "app.post('/api/system/update', (req, res) => {\n"
                    + "    res.status(403).json({ success: false, error: 'CloudCLI is updated with the workspace image, not from the app.', code: 'KRYTON_SELF_UPDATE_DISABLED' });\n"
                    + '});\n'
                    + "app.use('/api/system', authenticateToken, systemRoutes);\n",
            },
        ],
    },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function countOf(text, find) {
    let n = 0;
    let at = text.indexOf(find);
    while (at !== -1) {
        n += 1;
        at = text.indexOf(find, at + find.length);
    }
    return n;
}

/** Apply one file's edits to its text. Throws ANCHOR_* with the file and the anchor. */
export function editText(entry, text) {
    let out = text;
    for (const e of entry.edits) {
        const want = e.count || 1;
        const n = countOf(out, e.find);
        if (n === 0) throw new OverlayError('ANCHOR_MISSING', `${entry.path}: kotva nenalezena: ${JSON.stringify(e.find.slice(0, 80))}`);
        if (n !== want) throw new OverlayError('ANCHOR_COUNT', `${entry.path}: kotva ${n}x, ocekavano ${want}x: ${JSON.stringify(e.find.slice(0, 80))}`);
        out = out.split(e.find).join(e.replace);
    }
    return out;
}

// `sdkOptions.permissionMode` jako cil prirazeni: `=`, `||=`, `&&=`, `??=`, ne `==`/`===`
// (lookahead) a ne `!=`/`!==`/`<=`/`>=` (mezi jmenem a `=` stoji jiny znak, regex nesedi).
const PERMISSION_MODE_ASSIGN = /sdkOptions\s*(?:\.\s*permissionMode|\[\s*['"`]permissionMode['"`]\s*\])\s*(?:\|\||&&|\?\?)?=(?!=)/g;
// 'bypassPermissions' jako prirazovana hodnota: za `=`, ktere neni soucasti `==`, `!=`, `===`,
// `!==`, `<=`, `>=`, nebo jako hodnota vlastnosti / vetve ternaru (`: 'bypassPermissions'`).
const BYPASS_ASSIGN = /(?:(?<![=!<>])=(?!=)|:)\s*['"`]bypassPermissions['"`]/g;

const countMatches = (text, re) => (text.match(re) || []).length;

/** Pocty, ze kterych `semanticGuard` soudi (export kvuli mereni a testum). */
export function semanticCounts(text) {
    return {
        permissionModeAssignments: countMatches(text, PERMISSION_MODE_ASSIGN),
        allowDangerouslySkipPermissions: countOf(text, 'allowDangerouslySkipPermissions'),
        bypassAssignments: countMatches(text, BYPASS_ASSIGN),
    };
}

/**
 * Semanticka brana (H4) pro soubory postavene z forku (polozky s `measuredOn`): hash tam
 * potvrzuje, co fork zkompiloval, takze se UPRAVENY text jeste cte - prave jedno prirazeni
 * `sdkOptions.permissionMode` (to ze ZA6.3), zadne `allowDangerouslySkipPermissions`, zadne
 * prirazeni 'bypassPermissions'. Porovnani (`===`, `!==`) se nepocitaji. Hazi SEMANTIC_GUARD.
 */
export function semanticGuard(entry, text) {
    if (!entry.measuredOn) return;
    const c = semanticCounts(text);
    const fail = (rule) => { throw new OverlayError('SEMANTIC_GUARD', `${entry.path}: ${rule} - precist rozdil proti tarballu (hlavicka), nepreriznout naslepo`); };
    const want = entry.measuredOn.permissionModeAssignments ?? 1;
    if (c.permissionModeAssignments !== want) fail(`sdkOptions.permissionMode prirazeno ${c.permissionModeAssignments}x, ocekavano ${want}x (jen ZA6.3)`);
    if (c.allowDangerouslySkipPermissions !== 0) fail(`allowDangerouslySkipPermissions ${c.allowDangerouslySkipPermissions}x, ocekavano 0x`);
    if (c.bypassAssignments !== 0) fail(`'bypassPermissions' prirazeno ${c.bypassAssignments}x, ocekavano 0x`);
}

export class OverlayError extends Error {
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}

/**
 * Plan (and, unless `check`, write) the overlay over a package root. Every file
 * is checked before anything is written. `hashes: false` skips the before/after
 * pins - only the synthetic-tree tests use it, never the build.
 */
export function applyOverlay(root, { check = false, hashes = true, edits = EDITS } = {}) {
    const plan = [];
    for (const entry of edits) {
        const file = path.join(root, entry.path);
        if (!fs.existsSync(file)) throw new OverlayError('FILE_MISSING', `${entry.path} ve strome neni`);
        const text = fs.readFileSync(file, 'utf8');
        const now = sha256(text);
        if (hashes && now === entry.after) {
            semanticGuard(entry, text);
            plan.push({ entry, file, skip: true });
            continue;
        }
        if (hashes && now !== entry.before) {
            throw new OverlayError('MANIFEST_MISMATCH', `${entry.path}: sha256 ${now} neni ani before ani after - upstream se zmenil, preriznout`);
        }
        const out = editText(entry, text);
        if (hashes && sha256(out) !== entry.after) {
            throw new OverlayError('EDIT_RESULT_MISMATCH', `${entry.path}: vysledek ${sha256(out)} neni after`);
        }
        semanticGuard(entry, out);
        plan.push({ entry, file, out });
    }
    if (!check) {
        for (const step of plan) {
            if (step.skip) continue;
            const mode = fs.statSync(step.file).mode & 0o777;
            const tmp = `${step.file}.kryton-overlay-${process.pid}`;
            fs.writeFileSync(tmp, step.out, { mode });
            fs.renameSync(tmp, step.file);
        }
    }
    return plan.map((s) => ({ path: s.entry.path, action: s.skip ? 'already' : (check ? 'would-apply' : 'applied') }));
}

/** For a re-cut: before = the tree as it is, after = the edited text. Writes nothing. */
export function printHashes(root, edits = EDITS) {
    return edits.map((entry) => {
        const text = fs.readFileSync(path.join(root, entry.path), 'utf8');
        return { path: entry.path, before: sha256(text), after: sha256(editText(entry, text)) };
    });
}

function main(argv) {
    const args = argv.slice(2);
    const root = args.find((a) => !a.startsWith('--'));
    if (!root) {
        process.stderr.write('pouziti: apply-server-overlay.mjs <koren balicku @cloudcli-ai/cloudcli> [--check|--print-hashes]\n');
        return 2;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (args.includes('--print-hashes')) {
        process.stdout.write(`${JSON.stringify({ version: pkg.version, files: printHashes(root) }, null, 2)}\n`);
        return 0;
    }
    if (pkg.name !== MEASURED_ON.package || pkg.version !== MEASURED_ON.version) {
        process.stderr.write(`server overlay: strom je ${pkg.name}@${pkg.version}, overlay je zmereny na ${MEASURED_ON.package}@${MEASURED_ON.version} - preriznout\n`);
        return 1;
    }
    try {
        const res = applyOverlay(root, { check: args.includes('--check') });
        for (const r of res) process.stdout.write(`server overlay: ${r.action} ${r.path}\n`);
        return 0;
    } catch (e) {
        process.stderr.write(`server overlay: ${e.message}\n`);
        return 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv);
}
