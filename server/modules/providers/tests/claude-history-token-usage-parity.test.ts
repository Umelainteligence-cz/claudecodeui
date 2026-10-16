import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  createProviderTokenUsageService,
  rememberClaudePostCompactReading,
} from '@/modules/providers/services/provider-token-usage.service.js';

/**
 * The composer's counter is fed by two paths: the history page's `tokenUsage`
 * and the token-usage route. After a compaction both must say the same thing,
 * or the number jumps when the session is reopened.
 */

const POST_COMPACT_READING = {
  used: 41_000,
  total: 1_000_000,
  autoCompactLimit: 967_000,
  contextWindowSource: 'sdk' as const,
  inputTokens: 41_000,
  outputTokens: 0,
  breakdown: { input: 41_000, output: 0 },
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-parity-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
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

/** Writes a session that ends assistant, compact boundary, summary. */
async function writeCompactedSession(directory: string, sessionId: string, boundaryUuid: string): Promise<string> {
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  const lines = [
    {
      type: 'assistant',
      uuid: 'assistant-1',
      sessionId,
      timestamp: '2026-10-16T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working on it.' }],
        usage: { input_tokens: 950_000, output_tokens: 10 },
      },
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: boundaryUuid,
      parentUuid: null,
      sessionId,
      timestamp: '2026-10-16T10:01:00.000Z',
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'manual', preTokens: 950_000, postTokens: 10_000 },
    },
    {
      type: 'user',
      uuid: 'summary-1',
      parentUuid: boundaryUuid,
      sessionId,
      timestamp: '2026-10-16T10:01:01.000Z',
      isCompactSummary: true,
      message: { role: 'user', content: 'The summary body' },
    },
  ];
  await writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));
  return filePath;
}

async function readBoth(sessionId: string) {
  const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, { providerSessionId: sessionId });
  const fromService = await createProviderTokenUsageService().getSessionTokenUsage(sessionId);
  return { history, fromService };
}

test('history and the token-usage service agree on the remembered post-compact reading', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-parity-'));

  try {
    await withIsolatedDatabase(async () => {
      const sessionId = 'parity-remembered';
      const boundaryUuid = 'parity-remembered-boundary';
      const filePath = await writeCompactedSession(tempRoot, sessionId, boundaryUuid);
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Parity', now, now, filePath);
      rememberClaudePostCompactReading(boundaryUuid, POST_COMPACT_READING);

      const { history, fromService } = await readBoth(sessionId);

      assert.deepEqual(history.tokenUsage, POST_COMPACT_READING);
      assert.deepEqual(fromService, history.tokenUsage);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('history and the token-usage service both report null when no post-compact reading is remembered', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-parity-'));

  try {
    await withIsolatedDatabase(async () => {
      const sessionId = 'parity-unknown';
      const filePath = await writeCompactedSession(tempRoot, sessionId, 'parity-unknown-boundary');
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Parity', now, now, filePath);

      const { history, fromService } = await readBoth(sessionId);

      // The page must have loaded the transcript, so a missing file cannot pass as null.
      assert.ok(history.messages.length > 0, 'the history page must load the transcript');
      // The key must be present with a null value, not absent: a page without it
      // would leave the composer on the pre-compact number.
      assert.ok(Object.hasOwn(history, 'tokenUsage'), 'the page must carry a tokenUsage key');
      assert.equal(history.tokenUsage, null);
      assert.equal(fromService, null);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
