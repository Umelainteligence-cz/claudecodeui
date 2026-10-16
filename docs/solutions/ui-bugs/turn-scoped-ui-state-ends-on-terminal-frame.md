---
module: chat composer (context ring overlay)
date: 2026-10-16
problem_type: ui_bug
component: frontend
severity: medium
symptoms:
  - "A per-turn UI state (the context ring's compacting pulse) keeps showing through the next, unrelated turn"
  - "The screen-reader 'compacted' announcement fires only when a later queued turn ends"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - messaging
tags:
  - react-batching
  - websocket
  - turn-lifecycle
  - session-activity
  - context-ring
---

# Turn-scoped UI state must end on the run's own terminal frame

## Problem

The context ring shows a "compacting" pulse from the moment `/compact` is sent until that turn ends. The first version ended it on the `isLoading` true→false edge (`src/modules/chat/hooks/useCompactAction.ts`, `turnEnded = wasLoading && !isLoading`). A full code review found the edge can be skipped: the composer lets the user queue a prompt while a compact runs, and the server dispatches that queued draft milliseconds after the compact's `complete`. The idle frame (`onSessionIdle`) and the next run's processing frame can then land in one React commit, so `isLoading` never renders false and the pulse carries into the queued turn.

## Root cause

Two facts about this fork's session activity make "has the turn ended?" unanswerable from React state alone:

- **Batching.** Separate websocket frames dispatched back to back can be committed together, so an edge observed through rendered props (`isLoading`) is not guaranteed to appear.
- **`startedAt` is not a run identity.** `SessionActivity.startedAt` looks like a per-run key (deleted on idle, recreated with `Date.now()` on the next run), but the running-sessions poll in `src/shared/context/SessionProtectionContext.tsx` runs every 5 s and `syncProcessingSessions` (`src/shared/hooks/useSessionProtection.ts`, `startedAt: snapshotStartedAt ?? existing?.startedAt ?? now`) overwrites it mid-run with the server's start time. A key built on it breaks within 5 s, and comparing client and server clocks is fragile in this repo.

## Solution

End the state on the run's own terminal websocket frame, not on derived props. `useCompactAction` subscribes through the websocket `subscribe` (passed in from `ChatInterface` so hook tests without a provider still work) only while a compact is pending, and clears the state on the first `complete` or `protocol_error` for the compacting session:

```ts
const TERMINAL_FRAME_KINDS = new Set(['complete', 'protocol_error']);
// ...
if (!subscribe || compactingSessionKey === null) return undefined;
return subscribe((frame) => { /* matching session + terminal kind -> clear */ });
```

`complete` is the unified terminal event every provider run ends with exactly once (comment in `src/modules/chat/hooks/useChatRealtimeHandlers.ts`), and `/compact` can only be sent while the session is idle, so the first terminal frame for that session is the compact's own. The `isLoading` edge, the disconnect clear and the never-started clear stay as fallbacks. Landed with the Lane B context-ring change (PR into `feat/context-ring`, pending at the time of writing).

## Prevention

Any UI state scoped to "this turn" (a pulse, a pending marker, an announcement) should end on the turn's terminal frame for its session. Do not infer the end from `isLoading`/processing-map edges, and do not key it on `SessionActivity.startedAt`.
