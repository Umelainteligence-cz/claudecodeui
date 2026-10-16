---
title: Claude SDK compaction gives no honest context reading unless you ask for it
date: 2026-10-16
category: integration-issues
module: claude runtime provider (server/modules/providers/list/claude)
problem_type: integration_issue
component: service_layer
symptoms:
  - "After a manual /compact the context counter dropped to 0, then snapped back to the pre-compact size on the history refresh"
  - "A 1M-context model showed over 100% of a 160,000 window"
  - "compact_metadata.post_tokens reported 1,722 when the next real request carried 79,941 (live probe)"
  - "getContextUsage() returned totalTokens 0 right at the compact_boundary"
  - "A second 'Compacted PostCompact ... completed successfully' bubble appeared next to the compaction row"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
retire_when: "The Agent SDK reports post-compact usage itself (an assistant usage after compaction, or a non-zero getContextUsage().totalTokens at the boundary). Check by re-running the probe described below on the new SDK version."
tags: [claude-agent-sdk, compaction, compact-boundary, getcontextusage, token-budget, context-window]
---

# Claude SDK compaction gives no honest context reading unless you ask for it

## Problem
CloudCLI's context counter, and the composer ring built on it, read every number from the Claude Agent SDK stream. Around a compaction, none of the obvious fields mean what they appear to mean. The counter either showed a false 0, or restored the pre-compact size right after the user compacted to free room.

## Symptoms
- A manual `/compact` turn published `used: 0`. The history refresh after `complete` then put the old, nearly full number back.
- Every Claude model was measured against `CONTEXT_WINDOW` (default 160,000), so 1M models read over 100%.
- `compact_metadata.post_tokens` badly understated what the next request carried. In the live probe it was 1,722 against 79,941. In recorded transcripts it was 15,577 against 93,115 and 34,982 against 122,883.
- With a PostCompact hook installed (for example Orca's agent hook), the transcript showed a stray "Compacted PostCompact … completed successfully" bubble.

## What Didn't Work
- **Using the turn's `result.usage` as occupancy.** On a `/compact` turn it is all zeros with `num_turns: 0`, because the compaction call runs outside the main loop. On ordinary multi-request turns it is the turn's summed bill, not what the context holds.
- **Using `compact_metadata.post_tokens`.** It counts only the messages kept. It excludes the system prompt, tools and memory files, so it came out 3–9× below the first real request in recorded transcripts. In the live probe it was about 46× below, because tool definitions dominated that context. It is fine as a transcript label and wrong as `used`.
- **Using `getContextUsage().totalTokens`.** At the boundary it is `0`, and `apiUsage` is all zeros, because no API response has happened since the compaction. The coordinator had initially approved `{used: totalTokens}`; publishing it would have shown a false 0.
- **Using `getContextUsage().maxTokens` or `rawMaxTokens` as the model window.** Both follow `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: a live probe with that env set reported 100,000 while `modelUsage.contextWindow` stayed 200,000.
- **Matching the CLI acknowledgement exactly (`/^Compacted\.?$/`).** With a PostCompact hook, the local-command output is "Compacted" followed by the hook's own line, so the exact match leaked a bubble.

## Solution
- **Window:** read `result.modelUsage[mainModel].contextWindow`, ported from upstream siteboon/claudecodeui#1557. Remember it per provider session, and keep `CONTEXT_WINDOW` only as a labelled fallback (`contextWindowSource: 'sdk' | 'env' | 'default'`). When the requested model carries a variant suffix such as `[1m]`, prefer the key that ends with that suffix, so a bare-id subagent entry cannot win (`readReportedContextWindow`, `server/modules/providers/list/claude/claude-runtime.provider.js:480`).
- **Post-compact reading:** on a main-thread `compact_boundary`, await `Query.getContextUsage()` inside the stream loop.
  - The call is bounded by a 3 s timeout (`CONTEXT_USAGE_TIMEOUT_MS`, `claude-runtime.provider.js:83`; `readContextUsage` at `:93`).
  - `used` is `totalTokens` when it is positive. Otherwise it is the sum of `categories[].tokens` excluding `UNUSED_CONTEXT_CATEGORIES` = `'Free space'`, `'Autocompact buffer'` (`:672`).
  - Only a recognised category shape counts; otherwise the budget clears to `null` (`buildPostCompactTokenBudget`, `:691`).
  - The await sits in the loop, so the reading lands before `result`/`complete`. A run that was superseded or aborted while waiting publishes nothing (`:1238`).
- **Never publish a compaction turn's `result`:** `canPublishResultBudget` (`:944`) only allows a single-request, non-compaction turn's usage.
- **History agrees with live:** remember the reading under the boundary's uuid. The summarizer stops at the newest boundary and returns that reading, or `null`. Invalidating the history cache also drops the in-flight load (`server/modules/providers/services/session-history-cache.service.ts:120-123`).
- **Transcript noise:** treat the acknowledgement as "Compacted" at the *start* of a local-command stdout row, with hook output allowed after it (`COMPACTION_NOTICE`, `src/shared/constants.ts:234`). Keep the `isLocalCommandStdout` gate so a genuine one-word reply is never hidden.

## Why This Works
`getContextUsage()` is a control request to the still-running CLI. Judging from its latency and the absence of any cost change, it appears to be answered locally; network traffic was not traced. Awaiting it inside the `for await` loop did not deadlock in the probe: it resolved in 265–470 ms. Right after a compaction, its per-category breakdown is the only SDK number that includes the system prompt and tools without a new request. In the manual probe the category sum was 79,768 against 79,941 on the next real request. The live `compact_boundary` uuid equals the uuid the CLI writes to the JSONL, so a reading remembered under it is found again when history is read back.

## Prevention
- Treat the probe findings as the contract, and re-probe on every SDK bump. The probe is a standalone script using the SDK's `query()` with an empty temp `cwd`, `settingSources: []`, no MCP and a cheap model, and it never resumes a real session. Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (plus a low `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) to force an auto-compaction; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` alone was ignored by this build.
- Keep the tests that pin this behaviour:
  - success, failure → `null`, and a zero result ignored (`server/modules/providers/tests/claude-compaction-budget.test.ts`);
  - an unknown category shape → `null`;
  - history parity (`server/modules/providers/tests/claude-history-token-usage-parity.test.ts`);
  - the hook-suffixed acknowledgement (`src/modules/chat/tests/compactionRows.test.ts`).
- Never derive the auto-compact threshold on the server. Env and settings overrides are invisible to it; use `getContextUsage().autoCompactThreshold`.
- The live summary arrives as a `user` message with `isSynthetic: true` and no `isCompactSummary` flag; only the JSONL row carries the flag. Any code that recognises the summary must handle both shapes.

## Related Issues
- Upstream siteboon/claudecodeui#1557 (window from `modelUsage`, merged), #1295 (compaction row, merged), #1288 (complete-usage guard; open as of 2026-10-16), #1566 (mid-turn usage; open as of 2026-10-16; only its per-turn reset was taken).
- Plans: `docs/plans/2026-10-16-context-data-plan.md` and `docs/plans/2026-10-16-context-data-hardening-plan.md`.
