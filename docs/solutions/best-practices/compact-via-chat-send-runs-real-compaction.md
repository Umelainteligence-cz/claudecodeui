---
module: chat composer (context ring overlay)
date: 2026-10-16
problem_type: best_practice
component: frontend
severity: medium
applies_when:
  - "Triggering Claude Code slash commands such as /compact from the web composer"
  - "Building any button that sends a fixed command instead of the user's draft"
related_components:
  - messaging
tags:
  - compact
  - claude-agent-sdk
  - slash-commands
  - chat-send
  - context-ring
---

# `/compact` sent as plain `chat.send` content runs a real compaction; typed `/compact` is unreliable

## Context

Brain Chat has no built-in `/compact` command (`server/modules/commands/commands.routes.ts` lists only help, models, cost, memory, config, status). Before building the context ring's "Zkomprimovat" button it was unknown whether `/compact` reaching the Claude runtime as ordinary message content would compact, or just be read by the model as text. The server passes `chat.send` content to the provider unchanged, and the Claude runtime feeds every turn to the Agent SDK as a streaming user message.

## Guidance

- **It compacts.** A live spike and a later ring-driven run both wrote, in the session JSONL under `~/.claude/projects/<project>/`, a `system` record with `subtype: compact_boundary` and `compactMetadata.trigger: "manual"` (observed 45,188 → 6,458 and 93,252 → 6,180 tokens), followed by an `isCompactSummary` user row and `<command-name>/compact</command-name>` local-command rows. The turn ends with the normal `complete` frame.
- **Verify by the transcript, not the reply.** The pass criterion is the `isCompactSummary` row (or `compact_boundary`) after reload; a plain assistant reply about compacting would mean the SDK treated the text as a prompt.
- **Send it directly, not through the composer's typed path.** Typing `/compact` and pressing Enter is unreliable: the slash-command menu fuzzy-matched `/compact` to an unrelated user command (`/boris`) and Enter would have run that instead. The context ring sends `{type: 'chat.send', content: '/compact', options: {...buildSendOptions(''), attachments: []}}` on its own path (`src/modules/chat/hooks/useCompactAction.ts`), which also keeps the user's draft and attachments out of the frame.
- **Codex, Cursor and OpenCode do not compact this way.** Their runtimes receive `/compact` as plain prompt text, so the ring is gated to `provider === 'claude'`.
- **QA gotcha on Windows Git Bash:** an argument `"/compact"` passed to a CLI (for example gstack `browse type`) is rewritten into a bogus Windows path (C:/Git/compact, illustrative, not a repo file) by MSYS path conversion; set `MSYS_NO_PATHCONV=1`.

## Applicability

Holds for the Claude Agent SDK version pinned in this fork at the time of writing. Re-run the transcript check after an SDK upgrade before relying on it.
