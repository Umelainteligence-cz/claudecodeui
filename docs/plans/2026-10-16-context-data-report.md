# Lane A (context-data) — report

**Branch:** `mmmirusss/ctx-data`, with 22 commits on top of `feat/context-ring` @ `ba1638e2`. The PR goes into `feat/context-ring`.
**Plans:** `docs/plans/2026-10-16-context-data-plan.md` (U1-U9, R1-R11) and `docs/plans/2026-10-16-context-data-hardening-plan.md` (U10-U13, R12-R16).
**Learning:** `docs/solutions/integration-issues/claude-sdk-compaction-context-usage-readings.md`, plus a seeded `CONCEPTS.md`.

## What was built

| Area | Result |
|---|---|
| **Per-model window** (upstream #1557, adapted) | `tokenBudget.total` is the SDK's `result.modelUsage[mainModel].contextWindow`, live and in history. It is remembered per provider session, and the most recent report wins. `CONTEXT_WINDOW` (then 160,000) is only a fallback. A variant request such as `sonnet[1m]` prefers the matching `[1m]` key, so a bare-id subagent entry cannot win. |
| **`contextWindowSource`** | Optional `'sdk' \| 'env' \| 'default'` on every Claude budget. One shared parse, so live and history agree. |
| **Honest `used`** | The #1288 guard: zero or incomplete usage never publishes. `assistantBudgetSent` and the compaction flag reset per turn (taken from #1566). The `result` fallback publishes only a single-request, non-compaction turn, so a cumulative or zero bill is never shown as occupancy. |
| **Post-compact refresh** | On a main-thread `compact_boundary`, the runtime awaits `Query.getContextUsage()` with a 3 s timeout, before `result`/`complete`. It emits `{used, total, autoCompactLimit, contextWindowSource:'sdk'}`. If no honest number is available, it emits a clear (`tokenBudget: null`). The reading is remembered under the boundary uuid. |
| **`autoCompactLimit`** | Optional. Taken from the SDK's own `autoCompactThreshold` when auto-compact is on; never derived on the server. |
| **History** | The summarizer stops at the newest boundary and returns the remembered reading, or `null`; it never returns the pre-compact usage. History-cache `invalidate` also drops the in-flight load. |
| **Compaction row** (upstream #1295) | One transcript row ("Compacted · manual · 48k → 7k tokens · 8s") with the summary folded into "full summary", live and from history. The live synthetic summary is recognised. The CLI's "Compacted" acknowledgement, including trailing PostCompact hook output, is hidden only when it is local-command stdout. |
| **Voice** | Auto-speak stays silent after a compaction turn and posts no `no_summary` note. This is a minimal edit to `src/modules/chat/voice/autoSpeak.ts`, which neither lane owns. |
| **`/cost`** | The "Context window" row shows only for an SDK-reported Claude window. Codex and OpenCode keep today's rule. A cleared budget shows "Total tokens used: Unknown", never 0. |
| **Frontend** | A `token_budget` frame with `tokenBudget: null` clears the viewed session's budget and never reaches `onSessionProcessing`. A type-only `TokenBudget` alias exists for Lane B. The state, setter and handler types are unchanged. |

**Contract for Lane B, unchanged:** `{used, total, ...}` is backward compatible, and the only additions are the optional `contextWindowSource` and `autoCompactLimit`. `null` means unknown, so hide the ring. A post-compact `token_budget` (or the clear) always arrives before the turn's `complete`.

## Upstream PRs: taken or declined

- **#1557, taken.** Hand-ported the two import hunks. Added history-cache `invalidate` (with in-flight safety) and a `createQuery` test seam. Did not take its `CommandResultModal` comment hunk; U8 rewrote that file.
- **#1295, taken.** It applied cleanly. Fixed the type placement, and added handling for the live summary that SDK 0.3.165 sends unflagged.
- **#1288, taken.** The complete-usage guard.
- **#1566, partially taken.** Took only the per-turn reset. Declined the transcript-read fallback: it fixes a gateway-only problem the maintainer has not reproduced, and it puts file I/O in the stream loop.
- **#1541, declined.** Summing every `modelUsage` entry makes a bill-as-occupancy reading larger, and that branch never runs on SDK 0.3.165.

## Key decisions and rulings

- **Clear-to-null fallback** after a compaction, approved by the coordinator. The rejected alternative was `post_tokens`, which understates real context 3–9×.
- **Post-compact `used`**, coordinator-approved after the live probe: `totalTokens` is **0** at the boundary. So `used` = `totalTokens` when it is positive, otherwise the category sum excluding "Free space" and "Autocompact buffer" (79,768 against the next real turn's 79,941). An unknown or zero shape clears. The excluded names are one named constant citing the probe, and tests pin both the exclusion and the null path.
- **Post-compact `total`:** the SDK-reported model window, not `maxTokens`. The probe showed `maxTokens` follows `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- **Other rulings, recorded in the SDD ledgers** (`.superpowers/sdd/*/progress.md`, machine-local), each with its cost if wrong:
  - implementers committed path-limited and serially;
  - U4's probe ran in parallel with U3 (scratchpad only);
  - U11 ran in parallel with U10+U12 (disjoint files);
  - the `maxTokens` fallback is labelled `'sdk'` only when no window was ever reported;
  - the live summary is matched on its opening text (`normalizeMessage` is stateless, and the probe showed no live flag);
  - the scripted harness gained a `model` option instead of a duplicated helper;
  - the acknowledgement match allows trailing hook output, still gated on `isLocalCommandStdout`.

## Verification

**Base defect, already present on `feat/context-ring` @ `ba1638e2`:** `.gitignore:134`'s bare `tasks.json` rule hides `src/modules/i18n/locales/cs/tasks.json`. Without that file, the base fails typecheck and lint, and 11 client test files fail to load. Lane B owns the fix. Every run below used a local, uncommitted copy (`git show 7fb91f00:…`), as the coordinator instructed.

| Gate | Command | Base `ba1638e2` (with the local file) | This branch, HEAD `7700ebef` (final run) |
|---|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 | exit 0 |
| Lint | `npm run lint` | 2 errors, both in `src/modules/chat/voice/tests/platformVoiceDefault.test.tsx` | the same 2 errors, none added |
| Server tests | `npm test` | 414 tests: 402 pass, 10 fail, 2 skipped | 488 tests: 476 pass, the same 10 fail, 2 skipped |
| Client tests | `npm run test:client` | 567 / 567 | 603 / 603 |

The 10 base server failures:
- checkCredentials ×5;
- createProject conflict;
- projectsDb.createProjectPath;
- providerSkillsService ×2;
- agent.routes, which is flaky: it passed on some runs.

These are environment-dependent and outside this lane. They show the same set on base and on this branch.

The tests that prove the lane's behaviour:
- `claude-context-window`: the window, its source, the variant key and key order.
- `claude-budget-honesty`: the guard, the per-turn reset and the narrowed fallback.
- `claude-compaction-budget`, including the three cases the coordinator pinned:
  - success;
  - failure or timeout → `null`;
  - zero result ignored.

  It also covers an unknown category shape → `null`, abort or supersede during the await, and timer cleanup.
- `provider-token-usage.service` and `claude-history-token-usage-parity`: the boundary-aware history and history/service parity.
- `session-history-cache.service`: invalidation during an in-flight load.
- `claude-compaction` and `compactionRows`: live and history order, the hook-suffixed acknowledgement, and the user row never being dropped.
- `compactionRowRender`, `costContextWindowRow`, `commands`, `tokenBudgetSessionScope`, `tokenUsageFreshness`, `autoSpeak`.

### Reviews

- **Plan:** Miro-replanning (4 reviewers), a mitigation `ce-plan` pass, and two `ce-doc-review` rounds. Hardening plan: one `ce-doc-review` round.
- **Implementation:** subagent-driven development with a task review per unit. Fix rounds: U4 1, U8 1, U11 1. The final whole-branch review passed clean.
- **`ce-code-review` (full)**, run `20261016-161225-5e53c25e`:
  - verdict "Ready with fixes": 1 P3, now fixed as U10;
  - residual risks and testing gaps were triaged into the hardening plan (U10-U13);
  - the hardening got its own final review and fix wave.
- **Cross-model passes:** none ran. The Codex route failed before any content left the machine (npm `ETARGET` for the Codex ACP adapter) in doc-review rounds 1 and 2 and in the code review. No other attested-different route is installed. The adversarial lens therefore used the in-process fallback, and the reports name this.

## QA (browser)

QA used gstack `/browse` against a local dev server (`SERVER_PORT=3411`, `VITE_PORT=5411`, throwaway `DATABASE_PATH`). It ran one short real Claude session on Haiku 5.5 in a scratch project, then `/compact`.

| Step | Result |
|---|---|
| Pill and `/cost` before compaction | Pill 46K (46,298). `/cost` Context window **1,000,000**, the SDK window for Haiku 5.5, not 160,000. **Pass.** |
| After `/compact` | One row, "Compacted · manual · 48k → 7k tokens · 8s", with the summary folded once. Pill **36K (35,812)**: lower, never 0, never the pre-compact number. **Pass** after the fix: the first run exposed a hook-suffixed acknowledgement bubble, fixed in `eba1ef92` and re-checked. |
| `/cost` after compaction | Total 35,812, Context window 1,000,000. **Pass.** |
| Full reload | The row, folded summary, pill and `/cost` are unchanged. **Pass.** |

Screenshots and the full QA report are local-only:
- Folder: `C:\Users\micha\orca\workspaces\claudecodeui\qa-evidence\ctx-data-2026-10-16\`.
- Key shots: `qa-recheck-1-compaction-row.png`, `qa-recheck-2-summary-expanded.png`, `qa-recheck-3-pill.png`, `33-cost-modal-post.png` and `14-cost-modal-pre.png`.
- Write-ups in the same folder: `QA-REPORT.md` and `SDK-PROBE-FINDINGS.md`.

The screenshots are not committed, because the sidebar shows the user's private project names.

## Docs

- `.env.example` and the `CONTEXT_WINDOW` CLI help now say it is a fallback.
- New: the plans, this report, `docs/solutions/` (a new directory, holding the learning above) and `CONCEPTS.md`.
- No README or CHANGELOG change. That follows the voice overlay's precedent, and the CHANGELOG is upstream-release generated.

## Open risks and follow-ups (for the coordinator)

1. **Duplicate prompt bubble**, out of lane and seen in QA. A copy of the first user prompt reappears with the current time and survives reload. The session JSONL holds timestamp-less `last-prompt` rows that the sessions provider does not handle. Lane A did not touch prompt rows. The root cause is not investigated.
2. **Row and pill mismatch.** The compaction row shows `post_tokens` (messages kept, for example 7k) while the pill shows the measured occupancy (36K). This is honest but may confuse users. It is a copy question for the row label, upstream #1295 shape.
3. **Readings are process memory only.** After a restart, a session whose newest event is a compaction shows `null` until its next turn. Other sessions show the `CONTEXT_WINDOW` fallback, labelled `env` or `default`.
4. **Measured on SDK 0.3.165 only.** `getContextUsage` category names are pinned to this SDK. A rename clears the reading to `null` rather than inflating it.
5. **External clients of `/api/providers/sessions/:id/token-usage`** can now receive `null` for Claude after an unmeasured compaction.
6. **Mid-turn auto-compact** pauses the UI stream for up to about 0.5 s while the measurement is taken (3 s worst case). The SDK buffers frames, so nothing is lost.
