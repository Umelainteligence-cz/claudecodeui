---
title: Context Data Hardening - Plan
type: fix
date: 2026-10-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Context Data Hardening - Plan

**Target repo:** the CloudCLI fork `Umelainteligence-cz/claudecodeui` (Brain Chat). Branch `mmmirusss/ctx-data` at HEAD `720d3ff0`. Parent plan: `docs/plans/2026-10-16-context-data-plan.md` (R1-R11, KTD1-KTD11).

---

## Goal Capsule

- **Objective:** Fix the findings from the Lane A code review that still let a context number, a transcript row, or a voice cue come out wrong in edge cases, and close the test gaps the reviews named. Behaviour the parent plan already delivers stays unchanged.
- **Means:** Small, test-first fixes on the existing Lane A code (U10-U13), each tied to a review finding.
- **Authority:** the parent plan's Product Contract (R1-R11) and settled decisions outrank this plan. This plan outranks the review reports' suggested fixes.
- **Stop conditions:**
  - a fix would need to change a Lane B file (importing one unchanged, e.g. `UiPreferencesProvider` in a test harness, is fine) (`src/modules/chat/composer/**`, `useChatComposerState.ts`, `src/shared/uiPreferences.ts` and its context, settings toggles);
  - a fix would change the `tokenBudget` shape.

  Either way, stop and `ask` the coordinator.
- **Execution profile:** TypeScript/JS, with node:test on the server and vitest on the client. Work test-first.
- **Finishing and shipping:** this worker finishes the work and includes it in the Lane A PR into `feat/context-ring`.

---

## Product Contract

### Summary

Four small hardening units:
- move the shared compaction-acknowledgement constant to the shared constants file;
- make a `[1m]` session's window immune to a same-named subagent entry;
- stop hiding a genuine one-word "Compacted" reply, and stop dropping a user message that repeats a folded summary;
- add the missing tests (compaction row render, history parity, the measured live order).

### Problem Frame

The full code review (run `20261016-161225-5e53c25e`, verdict "Ready with fixes") found one confirmed P3 and a set of residual risks and test gaps. Most were judged rare or harmless and are recorded under Scope Boundaries below. Four survive validation. Each is either a confirmed standards violation, a reachable wrong number for a shipped model option (`sonnet[1m]`), or a case where the transcript hides content the user wrote or received.

### Requirements

- R12. The compaction-acknowledgement pattern lives in `src/shared/constants.ts` with a documenting comment. `useChatMessages.ts` and `voice/autoSpeak.ts` both import it from there. (Review finding #3; frontend module standards.)
- R13. When the session requested a variant model (an id ending in a `[...]` suffix such as `[1m]`), its window is read from that variant's `modelUsage` entry, even if a subagent billed under the bare id also reports a window. (Parent R2.)
- R14. The transcript drops a bare "Compacted" acknowledgement only when it is the CLI's local-command output (`isLocalCommandStdout`). A genuine one-word assistant reply "Compacted" is always shown. This matches voice auto-speak's existing rule.
- R15. The transcript never drops a **user** message because its text equals a folded compaction summary.
- R16. The compaction row's rendering, the parity between history `tokenUsage` and the token-usage service, and the measured live frame order each have a test.

### Scope Boundaries

Considered and not built:
- **Labelling the `maxTokens` fallback as anything other than `'sdk'`.** This was already ruled in parent plan U4. It is reachable only when no window was ever reported and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, and the coordinator's ruling counts `maxTokens` as an SDK source.
- **A transient null from a history fetch that runs during the up-to-3 s `getContextUsage` await.** The refresh at `complete` corrects it, and nobody has shown the client fetches history in the middle of a turn. Evidence that would change this: a client path that does fetch mid-turn.
- **Loss of remembered windows and readings after a restart.** This is an accepted parent-plan Scope Boundary. After a restart, history shows the `CONTEXT_WINDOW` fallback labelled `'env'` or `'default'` until the session's next turn. A session whose newest event is a compaction boundary shows `null` (unknown) until then, per the clear-to-null decision.
- **Splitting `claude-runtime.provider.js`.** That would conflict with parent plan KTD11 (upstream merge parity), and a new JS module conflicts with the backend standard.
- **A client test for an in-flight history race.** The server's history-cache invalidation test covers the persisted path, and on the client the effect is only transient.
- **Deleting the unused `TokenBudget` alias.** The review rejected this finding: the alias is a planned cross-lane contract (parent plan U6, KTD10).
- **Keeping the live summary row's React key across the boundary swap**, so an open "full summary" `<details>` does not close. This is cosmetic, lasts only for the live window, and is an upstream #1295 shape.

---

## Planning Contract

### Key Technical Decisions

- KTD12. **The requested model is passed into the window lookup.** `queryClaudeSDK` already resolves the session's requested model (`resolvedModel || options.model`). It passes that to `readReportedContextWindow`. All matching still compares against the main thread's resolved `message.model` (for example `claude-sonnet-5-5`); the requested id only picks the order.
  - **Variant request** (the id ends in a `[...]` suffix such as `[1m]`): the preferred entry is a `modelUsage` key that **itself ends with that same suffix** and whose suffix-stripped key, or `canonicalModel`, equals the main model. A bare key never counts as this variant match, so the result does not depend on key order. If no such key exists, fall back to the existing order.
  - **Any other request:** the existing #1557 order is unchanged: exact match, then variant match, then the only entry.

  This is the smallest change that closes the subagent case.
- KTD13. **The acknowledgement filter requires `isLocalCommandStdout`.** The live probe covered both triggers. In the manual `/compact` run, the "Compacted" ack arrived as a local-command stdout replay, which the server normalizes with that flag. The auto-compaction run emitted no ack at all. Requiring the flag therefore loses nothing. Voice auto-speak already applies the same `isLocalCommandStdout` rule and stays unchanged in this plan.
- KTD14. **Only non-user rows are deduplicated against folded summaries.** User rows are never dropped by the summary dedup. This one-line role gate is a deliberate, commented divergence from upstream #1295's fold.

### Sequencing

U10 → U11 → U12 → U13. U13 runs last, because its tests run against the final code.

---

## Implementation Units

### U10. Shared compaction-acknowledgement constant

- **Goal:** Satisfy review finding #3.
- **Requirements:** R12.
- **Dependencies:** none.
- **Files:**
  - `src/shared/constants.ts`
  - `src/modules/chat/hooks/useChatMessages.ts`
  - `src/modules/chat/voice/autoSpeak.ts`
- **Approach:**
  1. Move the constant into a grouped section of `src/shared/constants.ts`, with a comment saying it matches the CLI's one-word compaction acknowledgement and naming both consumers.
  2. Import it from `@/shared/constants` in both files.
  3. While touching `useChatMessages.ts`, move the compaction helpers (`appendCompactionRow` and its comment) above the `normalizedToChatMessages` JSDoc, so that JSDoc sits directly on its function again (review residual #2).
- **Test expectation:** none new. This is a pure move; the existing `compactionRows` and `autoSpeak` suites must stay green.
- **Verification:** typecheck and lint are clean, and both suites pass.

### U11. Variant window wins for a variant request

- **Goal:** Make sure a `[1m]` session's window cannot be taken from a bare-id subagent entry.
- **Requirements:** R13; KTD12.
- **Dependencies:** none.
- **Files:**
  - `server/modules/providers/list/claude/claude-runtime.provider.js`
  - `server/modules/providers/tests/claude-context-window.test.ts`
- **Execution note:** write the failing test first.
- **Test scenarios:**
  - Requested `sonnet[1m]`, main `message.model` `claude-sonnet-5-5`, and `modelUsage` `{ 'claude-sonnet-5-5[1m]': 1,000,000, 'claude-sonnet-5-5': 200,000 }`: the last `token_budget.total` is 1,000,000 and the source is `'sdk'`.
  - The same `modelUsage` with the keys in reversed order (bare `claude-sonnet-5-5` first), requested `sonnet[1m]`: the result is still 1,000,000.
  - Requested bare `sonnet`, with the same `modelUsage`: the exact match (200,000) still wins, so behaviour is unchanged.
  - The existing #1557 cases (subagent haiku vs main `opus[1m]`, the `canonicalModel` key, a single entry) still pass.
- **Verification:** the new and existing context-window tests pass.

### U12. Transcript filters only what is compaction noise

- **Goal:** Never hide user-written or genuine assistant content in a session that has compacted.
- **Requirements:** R14, R15; KTD13, KTD14.
- **Dependencies:** U10.
- **Files:**
  - `src/modules/chat/hooks/useChatMessages.ts`
  - `src/modules/chat/tests/compactionRows.test.ts`
- **Execution note:** write the failing tests first. The existing `compactionRows.test.ts` case "drops the CLI's one-word acknowledgement beside a real row" uses an unflagged ack, which contradicts R14:
  - give its dropped ack `isLocalCommandStdout: true`;
  - turn its unflagged form into the new "shown" scenario below.
- **Test scenarios:**
  - A session with a compaction row, plus a later assistant text row "Compacted" without `isLocalCommandStdout`: that row is shown.
  - The same session with the `isLocalCommandStdout` "Compacted" ack: the ack is still dropped.
  - A summary that was folded into the row, followed later by a user row whose text equals that summary: the user row is shown.
  - An unflagged assistant copy of the summary is still dropped, as today.
- **Verification:** `compactionRows` and the full client suite are green.

### U13. Missing tests

- **Goal:** Close the test gaps the reviews named.
- **Requirements:** R16.
- **Dependencies:** U10-U12 (the tests run against the final code).
- **Files:**
  - `src/modules/chat/tests/compactionRowRender.test.tsx` (new; follow the `messageStreamEnd.test.tsx` harness that renders `MessageComponent`)
  - `src/modules/chat/tests/compactionRows.test.ts`, plus correcting the comment in `useChatMessages.ts` that misstates the live order
  - `server/modules/providers/tests/claude-compaction.test.ts`, or a new `claude-history-token-usage-parity.test.ts`
- **Test scenarios:**
  - **Render, done:** a done compaction row shows its content text, the grey dot and a "full summary" disclosure whose body is the folded summary.
  - **Render, failed:** a failed row shows the red dot.
  - **Render, running:** a running row shows the pulsing amber dot.
  - **Render, empty content:** a row with empty content shows the "Compacted" fallback label.
  - **Measured live order:** running → boundary → summary → `isLocalCommandStdout` "Compacted" ack gives exactly one row, and the summary is folded in once. Build the summary in the shape the client receives after server normalization: assistant with `isCompactSummary: true`. The raw SDK shape (user, `isSynthetic`) is covered by the server's `claude-compaction` tests.
  - **History parity:** a JSONL ending in assistant → boundary → summary gives `fetchHistory(...).tokenUsage` equal to `getSessionTokenUsage(...)`. Both are the remembered reading when one is stored, and both are `null` when none is. The history page object has an own `tokenUsage` key whose value is `null`.
- **Verification:** the new tests pass and fail when the behaviour they name is broken. The client and server suites are green.

---

## Verification Contract

| Gate | Command | Pass condition |
|---|---|---|
| Server tests | `npm test` | Only the 10 failures already on base (checkCredentials ×5, createProject, projectsDb.createProjectPath, providerSkillsService ×2, agent.routes). |
| Client tests | `npm run test:client` | All pass (594 before this plan, plus the new tests). |
| Typecheck | `npm run typecheck` | Exit 0, with the local `cs/tasks.json` present. |
| Lint | `npm run lint` | Only the 2 pre-existing errors in `platformVoiceDefault.test.tsx`. |

---

## Definition of Done

- U10-U13 are committed as small conventional commits (author Miroslav Michalko, no trailers, LF line endings).
- Every R12-R16 scenario has a passing test, and the gates above hold.
- No Lane B file is changed and the `tokenBudget` shape is unchanged.
