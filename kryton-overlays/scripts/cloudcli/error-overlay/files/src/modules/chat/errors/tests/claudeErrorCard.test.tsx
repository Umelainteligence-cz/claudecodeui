import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import cs from '@/modules/chat/errors/locales/cs/claudeErrors.json';
import en from '@/modules/chat/errors/locales/en/claudeErrors.json';
import { CLAUDE_ERROR_CARDS, claudeErrorCard, dropDuplicateErrorRow } from '@/modules/chat/errors/claudeErrorCard';
import ClaudeErrorCard from '@/modules/chat/errors/ClaudeErrorCard';
import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import type { NormalizedMessage } from '@/shared/types';

const CODES = [
  'authentication_failed',
  'cloud_credential_error',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'rate_limit',
  'overloaded',
  'server_error',
  'network',
  'model_not_found',
  'max_output_tokens',
  'not_installed',
];

describe('claudeErrorCard', () => {
  it('knows every code of the plan table and nothing else', () => {
    expect(Object.keys(CLAUDE_ERROR_CARDS).sort()).toEqual([...CODES].sort());
  });

  it('leaves unknown, untranslated and non-string codes to the present bubble', () => {
    for (const code of ['invalid_request', 'unknown', 'toString', 'constructor', '', 42, null, undefined, {}]) {
      expect(claudeErrorCard(code)).toBeNull();
    }
  });

  it('keeps the original text visible only where it carries the answer', () => {
    expect(claudeErrorCard('rate_limit')?.showOriginal).toBe(true);
    expect(claudeErrorCard('max_output_tokens')?.showOriginal).toBe(true);
    expect(claudeErrorCard('server_error')?.showOriginal).toBe(true);
    expect(claudeErrorCard('authentication_failed')?.showOriginal).toBe(false);
  });

  it('has a title and an action in both languages for every code', () => {
    for (const code of CODES) {
      for (const bundle of [cs, en] as unknown as Array<Record<string, Record<string, string>>>) {
        expect(bundle[code]?.title, code).toBeTruthy();
        expect(bundle[code]?.action, code).toBeTruthy();
      }
    }
    expect(cs.details).toBeTruthy();
    expect(en.details).toBeTruthy();
  });

  it('never names the upstream product in the Czech text a builder reads', () => {
    expect(JSON.stringify(cs)).not.toMatch(/CloudCLI|Claude Code UI/);
  });
});

describe('dropDuplicateErrorRow', () => {
  const card = { type: 'assistant', errorCode: 'authentication_failed', content: 'Failed', timestamp: 1 };

  it('drops the error row of a run whose assistant row already became the card', () => {
    expect(dropDuplicateErrorRow('authentication_failed', [card])).toBe(true);
  });

  it('keeps an error row with another code, without a card behind it, or with no card at all', () => {
    expect(dropDuplicateErrorRow('overloaded', [card])).toBe(false);
    expect(dropDuplicateErrorRow('overloaded', [])).toBe(false);
    expect(dropDuplicateErrorRow('unknown', [{ ...card, errorCode: 'unknown' }])).toBe(false);
    expect(dropDuplicateErrorRow(undefined, [card])).toBe(false);
  });
});

describe('ClaudeErrorCard', () => {
  it.each(CODES)('renders %s in Czech with the original under Podrobnosti or in the open', async (code) => {
    await i18n.changeLanguage('cs');
    const html = renderToStaticMarkup(<ClaudeErrorCard code={code} content="Failed to authenticate" />);
    const texts = (cs as unknown as Record<string, { title: string; action: string }>)[code];
    expect(html).toContain(texts.title);
    expect(html).toContain(texts.action);
    expect(html).toContain('Failed to authenticate');
    expect(html.includes('<details')).toBe(!claudeErrorCard(code)?.showOriginal);
  });

  it('renders the English text in the English interface', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<ClaudeErrorCard code="authentication_failed" content="x" />);
    expect(html).toContain(en.authentication_failed.title);
    await i18n.changeLanguage('cs');
  });

  it('escapes the original text', () => {
    const html = renderToStaticMarkup(<ClaudeErrorCard code="overloaded" content="<img src=x onerror=alert(1)>" />);
    expect(html).not.toContain('<img');
  });
});

describe('the chat draws the card, live and after a reload', () => {
  const base = { sessionId: 's', provider: 'claude', timestamp: '2026-10-31T10:00:00.000Z' } as const;
  const assistant = {
    ...base,
    id: 'a',
    kind: 'text',
    role: 'assistant',
    content: 'Failed to authenticate',
    errorCode: 'authentication_failed',
  };
  const errorRow = {
    ...base,
    id: 'e',
    kind: 'error',
    content: 'Claude Code returned an error result: Failed to authenticate',
    errorCode: 'authentication_failed',
  };
  const render = (messages: unknown[]) => {
    const chat = normalizedToChatMessages(messages as NormalizedMessage[]);
    return chat.map((message, i) =>
      renderToStaticMarkup(
        <MessageComponent
          message={message}
          prevMessage={chat[i - 1] ?? null}
          createDiff={() => []}
          provider="claude"
        />,
      ),
    );
  };

  it('live: the two rows of one failed run become one card', async () => {
    await i18n.changeLanguage('cs');
    const rows = render([assistant, errorRow]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(cs.authentication_failed.title);
    expect(rows[0]).toContain('Failed to authenticate');
    expect(rows[0]).toContain('data-message-timestamp');
  });

  it('history: the assistant row alone is the same card', () => {
    const rows = render([assistant]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(cs.authentication_failed.title);
  });

  it('an error with a code and no assistant row is a card too', () => {
    const rows = render([{ ...errorRow, errorCode: 'network' }]);
    expect(rows[0]).toContain(cs.network.title);
  });

  it('an unknown code and no code draw exactly what they drew before', () => {
    for (const row of [{ ...errorRow, errorCode: 'invalid_request' }, { ...errorRow, errorCode: undefined }]) {
      const rows = render([row]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('Claude Code returned an error result');
      expect(rows[0]).not.toContain('<details');
    }
  });

  it('a plain reply is not a card', () => {
    const [chat] = normalizedToChatMessages([{ ...assistant, content: 'Ahoj', errorCode: undefined }] as unknown as NormalizedMessage[]);
    expect(chat.type).toBe('assistant');
    expect(claudeErrorCard(chat.errorCode)).toBeNull();
  });
});
