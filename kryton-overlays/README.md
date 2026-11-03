# Brain Chat - modified CloudCLI UI (source offer, AGPL-3.0-or-later)

This branch is the complete corresponding source of the CloudCLI UI served as "Brain Chat" in
Kryton workspaces (Red Dwarf), client AND server. It is CloudCLI UI
(https://github.com/siteboon/claudecodeui), version 1.37.3, commit 70e57859b6224ff0eb0539fcde7d13a3186c9c93,
by Siteboon AI B.V., modified.

The tree is that commit with the client overlays applied in the order the image build
(stage `cloudcli-client` of red-dwarf `Dockerfile.server`) applies them:

1. the Czech locale (`apply-cs-locale.mjs`, `locale-cs/`);
2. the fork overlay: voice + context-usage ring, client and server half (`voice-overlay/`,
   exported from Umelainteligence-cz/claudecodeui `feat/voice-overlay-v1.37.3` @ 47a2d955, plus the
   amendments its manifest lists as cut in red-dwarf);
3. the brand and palette overlay (`brand-overlay/`, with the palette generator
   `generate-palette.mjs` and its source `palette.source.json`);
4. the project overlay: the workspace opens on the last project (`project-overlay/`);
5. the Czech card for Claude errors in the chat (`error-overlay/`, applied by the project
   overlay script with `--overlay-dir`);
6. the image overlay: backport of upstream siteboon/claudecodeui#1307 (`image-overlay/`);
7. the client overrides: pinned dependency versions in `package.json` / `package-lock.json`
   (`client-overrides/`).

The scripts and data that apply them are in `kryton-overlays/scripts/cloudcli/` (the whole
`scripts/cloudcli/` directory of red-dwarf at the commit named below). The build marker
`client-build.txt` is left out; `src/modules/i18n/locales/cs/tasks.json` is in the tree although
the upstream `.gitignore` ignores `tasks.json` (the Czech overlay writes it and the build uses it).

The image then builds the client and the server from this tree and, on the built server, applies
one more edit: the server overlay ZA6.3 (`kryton-overlays/scripts/cloudcli/server-overlay/`:
loopback API key taken out of the environment, WebSocket key check, no bypassPermissions,
`/api/agent` disabled, the run error code for the Czech error card). It edits the compiled
`dist-server/` text, so its source is that script.

Built from red-dwarf commit a11782ec4b164d20e9549a3dc620794d1fe977d9 (`scripts/cloudcli/`).
Client build: `npm ci && VITE_IS_PLATFORM=true npm run build:client`.
Server build: `npm run build:server`, then
`node kryton-overlays/scripts/cloudcli/server-overlay/apply-server-overlay.mjs <installed package root>`
on the installed package after `dist-server/` is replaced by the build.
