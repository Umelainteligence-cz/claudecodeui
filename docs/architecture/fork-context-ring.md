# Context ring (fork-only overlay)

*Brain Chat fork of CloudCLI. Not upstreamed: upstream removed its own percentage pie in siteboon #807.*

## What users see

For a **Claude** session whose context window is known, a small ring replaces the "12.3K tokens" pill in the composer toolbar. It fills green, then amber from 60 %, then red from 85 % (judged on the rounded percentage the label shows). The percentage is `used / (autoCompactLimit ?? total)`, clamped to 0–100.

- **Hover or long-press** shows used/total in K and how much is left (until auto-compact when the server sends `autoCompactLimit`).
- **Click** opens a short confirmation: "Zkomprimovat konverzaci? Claude shrne dosavadní průběh, aby uvolnil místo v kontextu." with Zkomprimovat / Zrušit, plus **Podrobnosti**, which opens the token breakdown (`/cost`) that the pill used to open directly.
- **Zkomprimovat** sends exactly `/compact` to the session. The draft text and attachments stay in the composer. The ring pulses until the compact turn ends; screen readers hear when it starts and ends.
- Zkomprimovat is disabled, with the reason shown, while Claude is answering, without a session or messages, when the connection is down, while a sent message is being edited, or while a queued message waits.
- **Escape** closes the confirmation and never stops a running answer.

The pill comes back for Codex, Cursor and OpenCode sessions, when there is no reading yet (or the server sends none after a compact), and when the ring is switched off.

## Switching it off

Quick Settings → Input settings → **Ukazatel kontextu** (Context ring). On by default; stored with the other UI preferences (`showContextRing` in `src/shared/uiPreferences.ts`).

## Where it lives

| Piece | File |
| --- | --- |
| Ring, confirmation, slot (visibility, status region) | `src/modules/chat/composer/ContextUsageRing.tsx` |
| Send path and compacting state | `src/modules/chat/hooks/useCompactAction.ts` (wired through `useChatComposerState.ts`) |
| Toolbar slot | `src/modules/chat/composer/ChatComposer.tsx` (`ContextRingSlot` with the pill as fallback) |
| Left-aligned popover anchor | `src/modules/chat/hooks/useComposerMenuAnchor.ts` (`align: 'start'`) |
| Quick Settings toggle | `src/modules/chat/composer/ContextRingSetting.tsx` |
| Strings (own `contextRing` namespace, en + cs) | `src/modules/chat/composer/contextRingI18n.ts`, `locales/{en,cs}/contextRing.json` |

The server side (token budget numbers, per-model window, `autoCompactLimit`, the compact row in the transcript) belongs to the companion data change, not to this overlay.

## Gotchas

- The compacting state ends on the compact's own `complete`/`protocol_error` frame, not on `isLoading`; see `docs/solutions/ui-bugs/turn-scoped-ui-state-ends-on-terminal-frame.md`.
- Typed `/compact` can be captured by the slash-command menu; the ring sends it directly. See `docs/solutions/best-practices/compact-via-chat-send-runs-real-compaction.md`.
- Plan and decisions: `docs/plans/2026-10-16-context-ring-ui-plan.md`; build report: `docs/plans/2026-10-16-context-ring-ui-report.md`.
