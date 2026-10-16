import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import '@/modules/chat/composer/contextRingI18n';
import { i18n } from '@/modules/i18n';
import { Composer, composerProps } from '@/modules/chat/voice/tests/composerFixture';
import { setUiPreferences } from '@/modules/chat/voice/tests/kit';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { resetUserPreferences } from '@/shared/userSettings';
import type { CompactAvailability } from '@/shared/types';
import type * as SharedApi from '@/shared/api';

/**
 * The context ring in the composer toolbar (U5): ChatComposer shows the ring in
 * the token pill's place for Claude sessions with a usable reading, the pill
 * exactly as before otherwise, and passes the compact props through.
 */

// Writing a preference queues a server save; keep it off the network.
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      user: { ...actual.api.user, savePreferences: async () => ({ ok: true, json: async () => ({}) }) },
    },
  };
});

const BUDGET = { used: 50_000, total: 160_000 };
const IDLE: CompactAvailability = { canCompact: true, blockedReason: null };

const ring = () => screen.queryByRole('button', { name: /context used — click to compact|Compacting conversation/ });
const draftBox = () => document.querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
const pill = () => screen.queryByRole('button', { name: 'Show token usage' });

/** Props a Claude session with a reading passes, minus whatever the test overrides. */
const claudeProps = (onCompact = vi.fn()) => ({
  provider: 'claude',
  tokenBudget: BUDGET,
  onCompact,
  isCompacting: false,
  compactAvailability: IDLE,
  compactSessionKey: 'session-1',
});

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatComposer context ring slot', () => {
  test('a Claude session with a reading shows the ring and no pill', () => {
    render(<Composer {...claudeProps()} />);
    expect(ring()).not.toBeNull();
    expect(ring()?.getAttribute('aria-label')).toBe('31% context used — click to compact');
    expect(pill()).toBeNull();
  });

  test('the ring sits in the left tool group, where the pill sits', () => {
    render(<Composer {...claudeProps()} />);
    const tools = screen.getByRole('button', { name: 'Attach files' }).closest('[data-slot="prompt-input-tools"]');
    expect(tools).not.toBeNull();
    expect(ring()?.closest('[data-slot="prompt-input-tools"]')).toBe(tools);
  });

  test('with the preference off the pill shows and no ring', async () => {
    await setUiPreferences({ showContextRing: false });
    render(<Composer {...claudeProps()} />);
    expect(pill()).not.toBeNull();
    expect(ring()).toBeNull();
  });

  test('a Codex session with a budget shows the pill', () => {
    render(<Composer {...claudeProps()} provider="codex" />);
    expect(pill()).not.toBeNull();
    expect(ring()).toBeNull();
  });

  test('a null budget shows the pill and no status region', () => {
    render(<Composer {...claudeProps()} tokenBudget={null} />);
    expect(pill()).not.toBeNull();
    expect(ring()).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('a compact that ends with a null budget leaves the pill, no 0% ring, and announces the end', () => {
    const props = claudeProps();
    const view = render(
      <UiPreferencesProvider>
        <ChatComposer {...composerProps({ ...props, isCompacting: true, compactAvailability: { canCompact: false, blockedReason: 'busy' } })} />
      </UiPreferencesProvider>,
    );
    expect(ring()?.getAttribute('aria-busy')).toBe('true');

    view.rerender(
      <UiPreferencesProvider>
        <ChatComposer {...composerProps({ ...props, tokenBudget: null, isCompacting: false })} />
      </UiPreferencesProvider>,
    );
    expect(ring()).toBeNull();
    expect(screen.queryByRole('button', { name: /0% context used/ })).toBeNull();
    expect(pill()).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('The conversation has been compacted.');
  });

  test('confirming a compact with a draft typed calls onCompact once and keeps the draft', async () => {
    const onCompact = vi.fn();
    const onSubmit = vi.fn();
    render(<Composer {...claudeProps(onCompact)} input="Rozepsaná zpráva" hasInput onSubmit={onSubmit} />);
    expect(draftBox().value).toBe('Rozepsaná zpráva');

    await act(async () => {
      fireEvent.click(ring() as HTMLElement);
    });
    const dialog = screen.getByRole('dialog', { name: 'Compact conversation?' });
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));

    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog.isConnected).toBe(false);
    expect(draftBox().value).toBe('Rozepsaná zpráva');
  });
});
