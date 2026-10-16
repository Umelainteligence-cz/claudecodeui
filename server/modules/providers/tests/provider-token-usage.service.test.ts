import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  createProviderTokenUsageService,
  rememberClaudePostCompactReading,
  summarizeClaudeTokenUsage,
} from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'app-session',
    provider: 'claude',
    provider_session_id: 'provider-session',
    project_path: null,
    jsonl_path: null,
    custom_name: null,
    model: null,
    effort: null,
    forked_from_session_id: null,
    isArchived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('token usage lookup requires only the app-facing session id for Claude', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 30,
          },
        },
      }),
      '{incomplete',
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 155,
      total: 180_000,
      contextWindowSource: 'env',
      inputTokens: 125,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      breakdown: { input: 125, output: 30 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage uses the latest token_count snapshot', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 49,
      total: 250_000,
      inputTokens: 40,
      outputTokens: 9,
      breakdown: { input: 40, output: 9 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage resolves its provider-native id from the session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Cursor returns an explicit unsupported token usage result', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'cursor' }),
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result?.unsupported, true);
  assert.equal(result?.used, 0);
  assert.equal(result?.total, 0);
});

test('token usage reports SESSION_NOT_FOUND for an unknown app session id', async () => {
  const service = createProviderTokenUsageService({ getSessionById: () => null });

  await assert.rejects(
    () => service.getSessionTokenUsage('missing-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'SESSION_NOT_FOUND'
      && error.statusCode === 404
    ),
  );
});

test('the Claude summarizer reads the newest assistant turn, not the whole conversation', () => {
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 50 } } },
    { type: 'user', message: { role: 'user', content: 'next' } },
    // The newest turn's prompt is the whole context, so its cache_read already
    // includes everything before it. Summing turns would double-count.
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 80 } } },
  ];

  assert.deepEqual(summarizeClaudeTokenUsage(entries, '200000'), {
    used: 4183,
    total: 200_000,
    contextWindowSource: 'env',
    inputTokens: 4103,
    outputTokens: 80,
    cacheReadTokens: 4000,
    cacheCreationTokens: 100,
    cacheTokens: 4100,
    breakdown: { input: 4103, output: 80 },
  });
});

test('the Claude summarizer skips synthetic rows that carry an all-zero usage block', () => {
  // Interrupts, API errors and "No response requested." are written as
  // assistant rows with a fully zeroed usage block. Reading one as the newest
  // turn dropped the composer counter to 0 until the next turn pushed it back.
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 80 } } },
    {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];

  assert.equal(summarizeClaudeTokenUsage(entries, '200000')?.used, 4083);
});

test('the Claude summarizer skips a subagent sidechain turn', () => {
  // A sidechain turn reports the subagent's own context window. Reading it
  // made the counter drop to the subagent's number mid-run.
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 80 } } },
    {
      type: 'assistant',
      isSidechain: true,
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 5 } },
    },
  ];

  assert.equal(summarizeClaudeTokenUsage(entries, '200000')?.used, 4083);
});

test('the Claude summarizer reports zero for a transcript with no assistant turn yet', () => {
  const usage = summarizeClaudeTokenUsage([{ type: 'user', message: { role: 'user', content: 'hi' } }], '200000');

  assert.equal(usage?.used, 0);
  assert.equal(usage?.total, 200_000);
});

/** Padding rows large enough to push earlier rows out of the 4MB tail window. */
function paddingLines(totalBytes: number): string {
  const line = JSON.stringify({ type: 'attachment', filler: 'x'.repeat(4096) });
  return Array.from({ length: Math.ceil(totalBytes / line.length) }, () => line).join('\n');
}

test('Claude token usage reads only the tail of a large transcript', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      paddingLines(5 * 1024 * 1024),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 7, output_tokens: 2 } } }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
      // Reading the whole file here would defeat the tail read; fail loudly.
      readTextFile: () => { throw new Error('full read must not happen when the tail has usage'); },
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage?.inputTokens, 7);
    assert.equal(usage?.outputTokens, 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude token usage falls back to the whole file when the tail has no usage row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-fallback-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 11, output_tokens: 3 } } }),
      paddingLines(5 * 1024 * 1024),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage?.inputTokens, 11);
    assert.equal(usage?.outputTokens, 3);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage reads only the tail of a large rollout', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      paddingLines(5 * 1024 * 1024),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 21, output_tokens: 8, total_tokens: 29 },
            model_context_window: 150_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
      readTextFile: () => { throw new Error('full read must not happen when the tail has usage'); },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      total: 150_000,
      inputTokens: 21,
      outputTokens: 8,
      breakdown: { input: 21, output: 8 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage falls back to the whole file when the tail has no token_count row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-fallback-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
        },
      }),
      paddingLines(5 * 1024 * 1024),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage?.used, 6);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

const POST_COMPACT_READING = {
  used: 41_000,
  total: 1_000_000,
  autoCompactLimit: 967_000,
  contextWindowSource: 'sdk' as const,
  inputTokens: 41_000,
  outputTokens: 0,
  breakdown: { input: 41_000, output: 0 },
};

function assistantRow(input: number, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { usage: { input_tokens: input, output_tokens: 0 } }, ...extra };
}

function boundaryRow(uuid: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    parentUuid: null,
    compactMetadata: { trigger: 'manual', preTokens: 950_000, postTokens: 10_000 },
    ...extra,
  };
}

function summaryRow(parentUuid: string) {
  return { type: 'user', isCompactSummary: true, parentUuid, message: { role: 'user', content: 'summary' } };
}

const lookupFrom = (readings: Record<string, unknown>) =>
  (uuid: string) => readings[uuid] as typeof POST_COMPACT_READING | null | undefined;

test('history usage after a compaction is the remembered post-compact reading, never the pre-compact assistant', () => {
  const entries = [assistantRow(950_000), boundaryRow('b1'), summaryRow('b1')];

  assert.deepEqual(
    summarizeClaudeTokenUsage(entries, '1000000', undefined, lookupFrom({ b1: POST_COMPACT_READING })),
    POST_COMPACT_READING,
  );
});

test('history usage after a compaction with no remembered reading is null', () => {
  const entries = [assistantRow(950_000), boundaryRow('b1'), summaryRow('b1')];

  assert.equal(summarizeClaudeTokenUsage(entries, '1000000', undefined, lookupFrom({})), null);
});

test('history usage after a compaction whose reading was cleared is null', () => {
  const entries = [assistantRow(950_000), boundaryRow('b1'), summaryRow('b1')];

  assert.equal(summarizeClaudeTokenUsage(entries, '1000000', undefined, lookupFrom({ b1: null })), null);
});

test('a main-thread assistant after the compaction summary is the usage again', () => {
  const entries = [assistantRow(950_000), boundaryRow('b1'), summaryRow('b1'), assistantRow(93_000)];

  assert.equal(
    summarizeClaudeTokenUsage(entries, '1000000', undefined, lookupFrom({ b1: POST_COMPACT_READING }))?.used,
    93_000,
  );
});

test('with two compactions only the latest boundary decides, not the first reading', () => {
  const entries = [
    assistantRow(950_000),
    boundaryRow('b1'),
    summaryRow('b1'),
    assistantRow(500_000),
    boundaryRow('b2'),
    summaryRow('b2'),
  ];

  assert.equal(
    summarizeClaudeTokenUsage(entries, '1000000', undefined, lookupFrom({ b1: POST_COMPACT_READING })),
    null,
  );
});

test('a subagent sidechain boundary is ignored like a sidechain assistant', () => {
  const entries = [assistantRow(4_000), boundaryRow('side', { isSidechain: true })];

  assert.equal(
    summarizeClaudeTokenUsage(entries, '200000', undefined, lookupFrom({ side: POST_COMPACT_READING }))?.used,
    4_000,
  );
});

test('a boundary stored with the snake_case metadata key still stops the walk', () => {
  const entries = [assistantRow(950_000), { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: {} }];

  assert.equal(summarizeClaudeTokenUsage(entries, '1000000', undefined, lookupFrom({})), null);
});

test('the default lookup is the runtime-recorded post-compact reading', () => {
  rememberClaudePostCompactReading('default-lookup-boundary', POST_COMPACT_READING);
  const entries = [assistantRow(950_000), boundaryRow('default-lookup-boundary')];

  assert.deepEqual(summarizeClaudeTokenUsage(entries, '1000000'), POST_COMPACT_READING);
});

test('Claude token usage resolves a boundary-and-summary tail without a full-file read', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-boundary-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify(assistantRow(950_000)),
      paddingLines(5 * 1024 * 1024),
      JSON.stringify(boundaryRow('b1')),
      JSON.stringify(summaryRow('b1')),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '1000000',
      getClaudePostCompactReading: (uuid) => (uuid === 'b1' ? POST_COMPACT_READING : undefined),
      // Reading the whole file would find the pre-compact 950k assistant row.
      readTextFile: () => { throw new Error('full read must not happen when the tail holds a boundary'); },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), POST_COMPACT_READING);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
