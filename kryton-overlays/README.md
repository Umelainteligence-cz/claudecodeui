# Brain Chat - modified CloudCLI UI (source offer, AGPL-3.0-or-later)

This branch is the complete corresponding source of the CloudCLI UI served as "Brain Chat" in
Kryton workspaces (Red Dwarf), client AND server. It is CloudCLI UI
(https://github.com/siteboon/claudecodeui), version 1.37.3, commit 70e57859b6224ff0eb0539fcde7d13a3186c9c93,
by Siteboon AI B.V., modified.

The tree is that commit with three overlays applied in the order the image build applies them:
the Czech locale, the fork overlay (voice + context-usage ring, client and server half; exported
from Umelainteligence-cz/claudecodeui `feat/voice-overlay-v1.37.3` @ 47a2d955), and the brand and
palette overlay. The scripts and data that apply them are in `kryton-overlays/scripts/cloudcli/`,
including the palette generator (`brand-overlay/generate-palette.mjs`) and its source
`palette.source.json`.

The image then builds the client and the server from this tree and, on the built server, applies
one more edit: the server overlay ZA6.3 (`kryton-overlays/scripts/cloudcli/server-overlay/`:
loopback API key taken out of the environment, WebSocket key check, no bypassPermissions,
`/api/agent` disabled). It edits the compiled `dist-server/` text, so its source is that script.

Built from red-dwarf commit 1e71fa4a7e370b020efb54ed45c1d3bb2159071f (`scripts/cloudcli/`).
Client build: `npm ci && VITE_IS_PLATFORM=true npm run build:client`.
Server build: `npm run build:server`, then
`node kryton-overlays/scripts/cloudcli/server-overlay/apply-server-overlay.mjs <installed package root>`
on the installed package after `dist-server/` is replaced by the build.
