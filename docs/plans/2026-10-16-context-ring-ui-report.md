# Context Ring UI (Lane B) - Report

Date: 2026-10-16 · Branch: `mmmirusss/ctx-ring-ui` → PR into `feat/context-ring` · Plan: `docs/plans/2026-10-16-context-ring-ui-plan.md`

## What was built

A fork-only context ring in the Brain Chat composer (user-facing description: `docs/architecture/fork-context-ring.md`).

- **Ring** (`ContextUsageRing.tsx`): 20px SVG, continuous arc, green <60 / amber ≥60 / red ≥85 on the rounded percentage, `pct = used / (autoCompactLimit ?? total)` clamped 0–100. It shows only for Claude sessions with a finite `total > 0` and the preference on; otherwise the original token pill renders unchanged. Labels: cs "N % kontextu využito — kliknutím zkomprimujete" / en "N% context used — click to compact". The tooltip shows used/total in K and how much remains (until auto-compact when `autoCompactLimit` exists).
- **Confirmation popover**: role dialog, labelled and described, focus starts on Zrušit, Escape never aborts a running turn. Zkomprimovat sends exactly one `chat.send` with `content: '/compact'` and `attachments: []`; the draft, attachments, edit state and queued message are untouched. Podrobnosti opens the existing `/cost` modal. A visible reason disables Zkomprimovat when the session is busy, has no session, has no messages, is offline, is editing, or has a queued message.
- **Compacting state** (`useCompactAction.ts`): pulse plus `aria-busy` plus a polite status announcement. It ends on the compact's own `complete`/`protocol_error` frame, with `isLoading`-edge, disconnect and never-started fallbacks.
- **Preference** `showContextRing` (default on) with a Quick Settings toggle "Ukazatel kontextu".
- **Own i18n namespace** `contextRing` (en + cs); shared locale files untouched.
- **Left-aligned popover anchor** (`useComposerMenuAnchor(…, 'start')`) so the popover fits at 360px.

## Decisions (with rationale)

- **The ring replaces the pill** rather than sitting beside it. Two indicators repeat the same number and cost ~60px on mobile. `/cost` stays one click away via Podrobnosti, and the pill returns wherever the ring cannot render.
- **Always visible when data exists**, behind a preference, not only above 50% like VS Code (the voice-mic discoverability lesson).
- **Disable during a running turn instead of queueing.** The queue path clears the draft and is dispatched server-side, so a late `/compact` would surprise the user.
- **Claude only.** Verified that Codex (`codex exec`), Cursor and OpenCode receive `/compact` as plain prompt text.
- **Base-bug fix** (coordinator-approved, separate first commit `fix(i18n): track the Czech tasks locale the .gitignore swallowed`). The bare `tasks.json` pattern in `.gitignore` had swallowed `src/modules/i18n/locales/cs/tasks.json`, so vite dev returned 500, and typecheck, build and many client test files failed on `feat/context-ring` itself. Content was taken from upstream `7fb91f00`, with a negation `!src/modules/i18n/locales/*/tasks.json`. **The red-dwarf owner should know.**
- **Test-only flake fix** in `voiceNotice.test.tsx`: the test's own debounced setup write could land in its "nothing stored" assertion under full-suite load. It was latent on base and exposed by this branch's extra tests. Root cause verified; no production change.

## Process (owner's workflow, all steps run)

1. `/ce-plan` produced the plan, then a mandatory `ce-doc-review`: 6 personas, 7 fixes applied. The cross-model pass did not run because the Codex ACP adapter failed to fetch from npm (ETARGET) before egress, and no other independent route is installed.
2. `/Miro-replanning`: 4 reviewers. Findings were validated, and dropped ones were recorded with reasons. `/ce-plan` produced the mitigation plan, and doc review round 2 applied 7 more fixes.
3. `/ce-work` with `superpowers:subagent-driven-development`: U9 live spike, then U1, U2, U4, U6, U3, U7, U5. Each unit was implemented test-first by a fresh subagent and given a spec+quality review. The final whole-branch review led to one fix wave (9 items) and a scoped re-review (all addressed). `ce-simplify-code` followed (2 applied).
4. **Full `/ce-code-review`** (correctness, project-standards, testing, maintainability, frontend-races, adversarial): no code defects survived merge. The cross-model adversarial peer did not run for the same pre-egress npm ETARGET failure, so the in-process adversarial fallback ran. Its residual became mitigation unit **U10** (end the compacting state on the terminal frame). Doc review round 3 caught that the first U10 design, keyed on `startedAt`, would break on the 5s running-sessions poll, and it was redesigned. U10 was implemented and reviewed.
5. QA with gstack `/browse` (below). It found and fixed one bug: in Quick Settings the "Context ring" row had split the Ctrl+Enter row from its hint.
6. `/ce-compound` (lightweight; the session was near its context limit) added two learnings under `docs/solutions/`.
7. Docs: `docs/architecture/fork-context-ring.md` plus an index line. CHANGELOG untouched (it has no fork section).

## Verification evidence

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | exit 0 |
| Client tests | `npm run test:client` | 680/680 pass, three consecutive runs |
| Build | `npm run build:client` | built OK |
| Lint | `npm run lint` | 2 errors, both in `src/modules/chat/voice/tests/platformVoiceDefault.test.tsx`, a file byte-identical to base `ba1638e2`, so **pre-existing** |
| Server tests | `npm test` | 405/416. The 9 failures are **identical on base** (same failure set; this branch has no `server/` diff) |
| Base client suite | `npx vitest run` on `feat/context-ring` | whole files fail at import (missing `cs/tasks.json`); with only that file added, base passes 567/567 ×8 |

New and updated test files: `src/shared/tests/uiPreferencesContextRing.test.ts`, `src/shared/tests/uiPreferences.test.ts`, `src/modules/chat/tests/{contextRingLocales,contextUsageRing,composerCompact,contextUsageRingComposer,composerMenuAnchor,contextRingSetting}.test.*`, `src/modules/quick-settings-panel/tests/quickSettingsContent.test.tsx`, `src/modules/chat/voice/tests/voiceNotice.test.tsx`.

## Browser QA (local dev server, isolated DB, throwaway Claude session)

Screenshots are machine-local (not committed; some show transcript text with personal paths):
`C:\Users\micha\AppData\Local\Temp\claude\C--Users-micha-orca-workspaces-claudecodeui-ctx-ring-ui\3fe83132-c554-4ebd-89f0-e5e977b01c94\scratchpad\qa\` (files `01`–`30`).

- **Low / mid / high**: 28% green (`01`–`04`, `08`–`13`), 71% amber (`24`, `25`), 92% red (`26`–`29`). These are real readings with `CONTEXT_WINDOW` set to 160K, 130K and 100K on the local server.
- **Themes and widths**: light and dark, 1280px desktop and 360px mobile. At 360px the dialog spans x 57–345 with no horizontal overflow (`11`, `13`).
- **Czech copy** exact (`20`); the tooltip reads "Zbývá 42 %". Podrobnosti opens the token modal (`22`).
- **Busy**: during a running answer, Zkomprimovat is disabled with "Wait until Claude finishes the answer." Escape closed the dialog and the answer ran to completion (`14`, `15`).
- **Offline**: with the server stopped, "Spojení se serverem je přerušené." appears and Zkomprimovat is disabled (`23`).
- **Preference off**: the original pill returns, "92K tokenů" (`06`). The Quick Settings order is fixed (`19`/`21`).
- **Live compaction via the ring** (required gate): PASS. The draft "rozepsany koncept - nesmi zmizet" stayed in the composer, and the pulse, `aria-busy` and announcements all worked. The transcript recorded `compact_boundary` `trigger: manual`, 93,252 → 6,180 tokens. After reload: one summary row per compaction, no duplicate `/compact` bubble, draft persisted (`16`–`18`). The earlier U9 spike (typed `/compact`) recorded 45,188 → 6,458.
- **Not done live**: Codex session showing the pill. Driving the model picker in the headless browser stalled. This is covered by a component test (Codex plus budget shows the pill) and the `provider === 'claude'` gate.

## Open risks / for the coordinator

- **Lane A dependency**: after a compact the ring still shows the pre-compact number until Lane A's fresh/`null` budget lands (observed 58% before and after). The integration check "ring ends lower or hidden after compaction; did `autoCompactLimit` arrive?" belongs to the merge of Lane A into `feat/context-ring`. Without `autoCompactLimit` the ring measures against the full window and may turn red only after Claude has already auto-compacted.
- Pre-existing upstream behaviour seen in QA: the first user message can render twice live. The compact summary renders as a long assistant-style block (transcript rendering is Lane A's).
- Parked minors (from the SDD ledger, accepted with rulings):
  - Narrow pulse-revival case when returning to a session.
  - A sessionless terminal frame falls back to the compacting session.
  - Helpers exported from the component file (oxlint fast-refresh warning).
  - Some test gaps listed in the code-review receipt.
- Cross-model reviews could not run on this machine (acpx/npm ETARGET for the Codex ACP adapter). In-process fallbacks covered those lenses.

## Rulings I made (from the SDD ledger)

- Spec: the coordinator's Lane B brief (Product Contract R1–R14 in the plan carries it). Ruling: plan's Product Contract treated as the spec — it was derived from the owner-approved brief — cost if wrong: a requirement drift the final review must catch.
- Ruling: SDD serial implementers that commit their own path-limited commits override ce-work's parallel-wave/orchestrator-commit default — the owner asked for subagent-driven-development — cost if wrong: slower wall-clock only.
- Ruling: U9 (live spike) runs inline in the controller alongside U1, not as an implementer — it is a runtime observation, no code — cost if wrong: none.
- | U2 -> U3 | U2 namespace + keys; U3 consumes keys | U2 key list ends with "…". Ruling: U2 ships the full key set for R5/R7/R10/R11/R13; U3 may add keys but must keep the locale test green |
- Ruling: base bug cs/tasks.json missing — coordinator approved fix as separate first commit ccf59d43; U1 cherry-picked to f7267007 (content identical to f5c67d4f) — cost if wrong: none
- Ruling: compactSessionKey = session key the composer is bound to (not "key it compacted") — fits KTD5's purpose (popover closes on switch) — cost if wrong: U5 popover-close semantics only
- Task U4: parked — narrow pulse revival (compact A, switch to busy B, A ends + new turn starts, return without idle edge) — Ruling: accepted residual; clearing on switch would drop the pulse for a still-running compact, the commoner case
- Ruling: U6 implementer used git stash for RED check (stash list verified empty afterwards); future dispatches forbid git stash — use a temp copy or revert-by-edit instead — cost if wrong: none
- Ruling: U8 (docs) executed at workflow step 7 so docs/report carry review + QA evidence — cost if wrong: none (same content, later)
- Task U10: parked — sessionless terminal frame falls back to compacting session, realtime handler falls back to viewed session — Ruling: terminal frames carry sessionId in practice; worst case pulse ends early (cosmetic); comment wording to be accurate

## Integrated with Lane A

`origin/feat/context-ring` (Lane A merge `de0ebb24`) is merged into this branch as merge commit `8449892d`. It is a merge, not a rebase, it merged cleanly, and the tree has no conflict markers. The `cs/tasks.json` + `.gitignore` commit is kept.

**Types.** There is one token-budget type: Lane A's `TokenBudget` in `src/shared/types.ts` (`{used,total,contextWindowSource?,autoCompactLimit?}`, possibly null after a compact). Lane B never added a duplicate. `ContextUsage` in `ContextUsageRing.tsx` is a derived view (used, limit, pct), not a copy. The session state that Lane A owns still carries the budget as `Record<string, unknown> | null`, so `readContextUsage` reads `TokenBudget`'s fields through a strict runtime guard. It uses `autoCompactLimit` when finite and > 0, and returns null (pill) on a null budget.

**Compacting state in the merged flow.** A compact turn still ends with the unified `complete` frame, so the ring's terminal-frame clear holds. Lane A's null `token_budget` hides the ring and a fresh reading drops it; both are handled. Lane A's other `status` frames keep going to `onSessionProcessing`, as before.

**Gates on the merge.**

| Gate | Merged branch | Base `de0ebb24` |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | — |
| `npm run test:client` | 716/716, two runs | 12 test files fail at import (missing `cs/tasks.json`), 509 tests pass |
| `npm run build:client` | OK | — |
| `npm run lint` | 2 errors, `voice/tests/platformVoiceDefault.test.tsx` | the same 2 plus the unresolved `cs/tasks.json` import, so **pre-existing** |
| `npm test` (server) | 476/487, 9 fail | 474/486, 10 fail; this branch's 9 are a subset, so **pre-existing** |

**Browser QA on the merged state.** Real ring-driven `/compact` in the throwaway session, Claude default model with a 1M window reported by the SDK. Screenshots (machine-local): `C:\Users\micha\AppData\Local\Temp\claude\C--Users-micha-orca-workspaces-claudecodeui-ctx-ring-ui\3fe83132-c554-4ebd-89f0-e5e977b01c94\scratchpad\qa-merged\`

- **Before** (`01`–`03`): "9 % kontextu využito", tooltip "87K / 1000K · Zbývá 91 %". **No `autoCompactLimit`** in the ordinary turn reading.
- **Compacting** (`04`): pulse, `aria-busy`, draft "rozepsany koncept po integraci" kept.
- **After, without reload** (`05`, `06`): the ring **dropped to 4 %**, and the status region announced "Konverzace je zkomprimovaná." **`autoCompactLimit` arrived** in the post-compact reading: "34K / 967K · Kontextové okno 1000K · Zbývá 96 % do automatické komprese".
- **Compaction row** (`08`, after reload): "Compacted · manual · 87k → 6k tokens · 12s" with the summary folded ("úplné shrnutí"), and one `/compact` bubble. The ring persisted at 4 %.
- **Dark mode** (`09`, `10`): the row and the dialog, with the `autoCompactLimit` lines, render correctly.

**Observation for Lane A / coordinator.** Before a reload, the live transcript (`07`) showed Claude Code's raw local-command rows (the `<local-command-caveat>` text, `<command-name>/compact</command-name>`, and the `Compacted PostCompact … completed successfully` stdout) as user bubbles instead of the single compaction row, and re-listed the previous user message below them. After a reload the row renders correctly. This is the live transcript rendering path, not the ring.
