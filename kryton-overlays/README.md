# Brain Chat - modified CloudCLI UI (source offer, AGPL-3.0-or-later)

This branch is the complete corresponding source of the CloudCLI UI client served as
"Brain Chat" in Kryton workspaces (Red Dwarf). It is CloudCLI UI
(https://github.com/siteboon/claudecodeui), version 1.37.3, commit 70e57859b6224ff0eb0539fcde7d13a3186c9c93,
by Siteboon AI B.V., modified.

The tree is that commit with three overlays applied in the order the image build applies
them: the Czech locale, the voice overlay, and the brand and palette overlay. The scripts and
data that apply them are in `kryton-overlays/scripts/cloudcli/`, including the palette
generator (`brand-overlay/generate-palette.mjs`) and its source `palette.source.json`.

Built from red-dwarf commit 66170ab4a723f74cd59b8abd4d6c7c0efaadc030 (`scripts/cloudcli/`).
Client build: `npm ci && VITE_IS_PLATFORM=true npm run build:client`.
