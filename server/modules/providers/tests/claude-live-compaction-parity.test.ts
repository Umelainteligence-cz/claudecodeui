import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * A `/compact` must read the same live and after a reload. The rows below copy
 * a real Claude Code 2.1 session (one prompt, `/compact`, one more prompt) and
 * the SDK messages its `/compact` turn streamed.
 *
 * The CLI also writes an `api-request-blob` row per API request: a copy of the
 * context it sent, `role: 'user'`, no uuid and no timestamp. The one after a
 * compaction carries the summary, the `/compact` command rows and the next
 * prompt. History used to read it as a turn, and the chat's refresh after the
 * turn ended showed each part as a raw user bubble stamped with the read time.
 */

const SESSION_ID = 'live-compaction-parity';
const PROMPT = 'Write ten short sentences about the history of the bicycle. Do not use any tools.';
const NEXT_PROMPT = 'Now write three more.';
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Bicycles.';
const CAVEAT = '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user.</local-command-caveat>';
const COMMAND = '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>';
const STDOUT = '<local-command-stdout>Compacted PostCompact [hook.cmd] completed successfully: {}</local-command-stdout>';
const REMINDER = '<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>';

const userRow = (uuid: string, timestamp: string, content: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid,
  sessionId: SESSION_ID,
  timestamp,
  message: { role: 'user', content },
  ...extra,
});
const assistantRow = (uuid: string, timestamp: string, text: string) => ({
  type: 'assistant',
  uuid,
  sessionId: SESSION_ID,
  timestamp,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const requestBlob = (texts: string[], role = 'user') => ({
  type: 'api-request-blob',
  sessionId: SESSION_ID,
  hash: 'blob',
  message: { role, content: texts.map((text) => ({ type: 'text', text })) },
});

const TRANSCRIPT = [
  userRow('prompt-1', '2026-10-16T15:41:55.555Z', PROMPT),
  { type: 'last-prompt', lastPrompt: PROMPT, sessionId: SESSION_ID },
  requestBlob([REMINDER, PROMPT]),
  assistantRow('answer-1', '2026-10-16T15:42:01.857Z', '1. In 1817 Karl Drais built the running machine.'),
  userRow('caveat-1', '2026-10-16T15:43:56.553Z', CAVEAT, { isMeta: true }),
  userRow('command-1', '2026-10-16T15:43:56.553Z', COMMAND),
  {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'boundary-1',
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: '2026-10-16T15:44:04.839Z',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 46_415, postTokens: 6_364, durationMs: 8_285 },
  },
  userRow('summary-1', '2026-10-16T15:44:04.837Z', SUMMARY, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  userRow('stdout-1', '2026-10-16T15:44:05.505Z', STDOUT),
  { type: 'last-prompt', lastPrompt: '', sessionId: SESSION_ID },
  userRow('prompt-2', '2026-10-16T15:45:00.000Z', NEXT_PROMPT),
  requestBlob([REMINDER, SUMMARY, CAVEAT, COMMAND, STDOUT, NEXT_PROMPT]),
  // The request also replays earlier assistant turns.
  requestBlob(['1. In 1817 Karl Drais built the running machine.'], 'assistant'),
  assistantRow('answer-2', '2026-10-16T15:45:03.000Z', '11. Folding bikes came later.'),
];

/** What the SDK streamed for the `/compact` turn, field for field. */
const LIVE_COMPACT_TURN = [
  { type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION_ID, uuid: 'status-1' },
  {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: SESSION_ID,
    uuid: 'boundary-1',
    compact_metadata: { trigger: 'manual', pre_tokens: 46_415, post_tokens: 6_364, duration_ms: 8_285 },
  },
  {
    type: 'user',
    message: { role: 'user', content: SUMMARY },
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: 'summary-1',
    timestamp: '2026-10-16T15:44:04.837Z',
    isReplay: false,
    isSynthetic: true,
  },
  {
    type: 'user',
    message: { role: 'user', content: STDOUT },
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: 'stdout-1',
    timestamp: '2026-10-16T15:44:05.505Z',
    isReplay: true,
  },
];

async function readHistory(): Promise<NormalizedMessage[]> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-live-compaction-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const filePath = path.join(tempDirectory, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, TRANSCRIPT.map((row) => JSON.stringify(row)).join('\n'));
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Parity', now, now, filePath);
    const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, { providerSessionId: SESSION_ID });
    return history.messages;
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The fields a reader sees, minus ids and receive-time stamps. */
const shape = (message: NormalizedMessage) => ({
  role: message.role,
  content: message.content,
  compactPhase: message.compact?.phase,
  isCompactSummary: Boolean(message.isCompactSummary),
  isLocalCommandStdout: Boolean(message.isLocalCommandStdout),
});
const byContent = (a: { content?: string }, b: { content?: string }) => (a.content || '').localeCompare(b.content || '');

test('history reads only the turns: no request copy becomes a user bubble', { concurrency: false }, async () => {
  const messages = await readHistory();
  const fixtureTimes = new Set(TRANSCRIPT.map((row) => (row as { timestamp?: string }).timestamp).filter(Boolean));

  const userTexts = messages
    .filter((message) => message.kind === 'text' && message.role === 'user')
    .map((message) => message.content);
  assert.deepEqual(userTexts, [PROMPT, '/compact', NEXT_PROMPT]);
  assert.ok(messages.every((message) => !(message.content || '').startsWith('<')), 'no raw tagged row');
  assert.ok(messages.every((message) => fixtureTimes.has(message.timestamp)), 'every row keeps its own time');
});

test('the whole session reads the same live and from history', { concurrency: false }, async () => {
  const history = await readHistory();
  const provider = new ClaudeSessionsProvider();
  // Live, the composer draws each prompt the user sends; the rest is streamed.
  const prompt = (content: string) => ({ role: 'user', content, compactPhase: undefined, isCompactSummary: false, isLocalCommandStdout: false });
  const streamed = (rows: unknown[]) => rows.flatMap((raw) => provider.normalizeMessage(raw, SESSION_ID)).map(shape);
  const live = [
    prompt(PROMPT),
    ...streamed([assistantRow('answer-1', '2026-10-16T15:42:01.857Z', '1. In 1817 Karl Drais built the running machine.')]),
    prompt('/compact'),
    // The running row only ever exists live; the boundary replaces it.
    ...streamed(LIVE_COMPACT_TURN).filter((row) => row.compactPhase !== 'running'),
    prompt(NEXT_PROMPT),
    ...streamed([assistantRow('answer-2', '2026-10-16T15:45:03.000Z', '11. Folding bikes came later.')]),
  ];

  assert.deepEqual(history.map(shape).sort(byContent), live.sort(byContent));
});
