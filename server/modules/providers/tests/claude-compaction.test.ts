import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-compaction-1';

/**
 * Both records that describe a compaction are `system` events, which normalized
 * to nothing before this: the boundary carries the numbers, the status says one
 * is running. Each becomes one ordinary assistant row, so a client that knows
 * nothing of `compact` still reads the sentence.
 */
test('a compact boundary becomes one row carrying its numbers', () => {
  const [row, ...rest] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'u-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 335_402,
      postTokens: 10_120,
      durationMs: 142_000,
    },
  }, SESSION_ID);

  assert.equal(rest.length, 0);
  assert.equal(row.kind, 'text');
  assert.equal(row.role, 'assistant');
  assert.equal(row.content, 'Compacted · manual · 335k → 10k tokens · 2m 22s');
  assert.deepEqual(row.compact, {
    phase: 'done',
    trigger: 'manual',
    preTokens: 335_402,
    postTokens: 10_120,
    durationMs: 142_000,
  });
});

test('the live spelling of the metadata reads the same', () => {
  const [row] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 1_240_000, post_tokens: 18_000, duration_ms: 45_000 },
  }, SESSION_ID);

  assert.equal(row.content, 'Compacted · auto · 1.2M → 18k tokens · 45s');
  assert.equal(row.compact?.trigger, 'auto');
});

test('a boundary with no metadata still says a compaction happened', () => {
  const [row] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
  }, SESSION_ID);

  assert.equal(row.content, 'Compacted · auto');
  assert.equal(row.compact?.phase, 'done');
});

test('a compacting status becomes a running row, and other statuses none', () => {
  const [running] = provider.normalizeMessage({
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  }, SESSION_ID);

  assert.equal(running.content, 'Compacting conversation…');
  assert.equal(running.compact?.phase, 'running');

  assert.deepEqual(
    provider.normalizeMessage({ type: 'system', subtype: 'status', status: 'requesting' }, SESSION_ID),
    [],
  );
});

test('a failed compaction says so, with the reason when there is one', () => {
  const [failed] = provider.normalizeMessage({
    type: 'system',
    subtype: 'status',
    compact_result: 'failed',
    compact_error: 'context still too large',
  }, SESSION_ID);

  assert.equal(failed.content, 'Compaction failed: context still too large');
  assert.equal(failed.compact?.phase, 'failed');
  assert.equal(failed.compact?.error, 'context still too large');
});

test('the summary keeps its flag, so the client can fold it into the row', () => {
  const [row] = provider.normalizeMessage({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
  }, SESSION_ID);

  assert.equal(row.role, 'assistant');
  assert.equal(row.isCompactSummary, true);
});

/**
 * Measured on SDK 0.3.165: the live stream delivers the summary as a *user*
 * message flagged `isSynthetic` (never `isCompactSummary`, which only the
 * persisted row carries), with string content after a manual compaction and a
 * text-part array after an auto one. Unflagged it would render as a user bubble.
 */
const LIVE_SUMMARY = 'This session is being continued from a previous conversation that ran out of context. Summary: the work so far.';

test('the live summary (string content) is flagged like the persisted one', () => {
  const rows = provider.normalizeMessage({
    type: 'user',
    uuid: 'live-1',
    isSynthetic: true,
    isReplay: false,
    message: { role: 'user', content: LIVE_SUMMARY },
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'assistant');
  assert.equal(rows[0].isCompactSummary, true);
  assert.equal(rows[0].content, LIVE_SUMMARY);
});

test('the live summary (text-part array) is flagged like the persisted one', () => {
  const rows = provider.normalizeMessage({
    type: 'user',
    uuid: 'live-2',
    isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: LIVE_SUMMARY }] },
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'assistant');
  assert.equal(rows[0].isCompactSummary, true);
  assert.equal(rows[0].content, LIVE_SUMMARY);
});

test('a user who types the same words is not mistaken for a summary', () => {
  const [row] = provider.normalizeMessage({
    type: 'user',
    message: { role: 'user', content: LIVE_SUMMARY },
  }, SESSION_ID);

  assert.equal(row.role, 'user');
  assert.notEqual(row.isCompactSummary, true);
});
