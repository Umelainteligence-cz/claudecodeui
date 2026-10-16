import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import { voiceI18n } from '@/modules/chat/voice/voiceI18n';
import { resetVoiceHealth } from '@/modules/chat/voice/voiceState';
import { resetVoiceUiStore } from '@/modules/chat/voice/voiceUiStore';
import { Composer } from '@/modules/chat/voice/tests/composerFixture';
import { fakeResponse } from '@/modules/chat/voice/tests/kit';
import { UiPreferencesProvider, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type * as SharedApi from '@/shared/api';

/**
 * Voice overlay, hv1 (Q517 = A1): when the platform turned voice on for this
 * workspace (the relay reports `configured: true`, which it does only where the
 * admin delivered VOICE_ENABLED=1), the microphone is there without anyone
 * finding the switch in Settings. A person who switches voice off keeps it off:
 * "never chosen" and "switched off by a person" are told apart by `voiceChosen`,
 * because the provider writes the WHOLE preferences blob, so a stored
 * `voiceEnabled: false` alone does not mean anyone chose it.
 */

const h = vi.hoisted(() => ({
  health: vi.fn(),
  server: { preferences: {} as Record<string, unknown>, status: [] as number[], reads: 0 },
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      voice: { ...actual.api.voice, health: () => h.health() },
      user: {
        ...actual.api.user,
        // `status` queues one-off answers (a failed hydrate), then the server answers 200.
        preferences: async () => {
          h.server.reads += 1;
          const status = h.server.status.shift() ?? 200;
          return status === 200
            ? fakeResponse(200, { preferences: h.server.preferences })
            : fakeResponse(status, { error: 'boom' });
        },
        savePreferences: async (updates: Record<string, unknown>) => {
          h.saved.push(updates);
          return fakeResponse(200, {});
        },
      },
    },
  };
});

const micButton = () => screen.queryByRole('button', { name: 'Voice input' });

/** Lets the hydrate, the health answer and the effects after them all settle. */
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
});

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  resetVoiceHealth();
  resetVoiceUiStore();
  h.health.mockReset();
  h.health.mockImplementation(async () => fakeResponse(200, { configured: true }));
  h.server.preferences = {};
  h.server.status = [];
  h.server.reads = 0;
  h.saved = [];
  await i18n.changeLanguage('en');
  await voiceI18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('platform mode, voice delivered by the platform', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_IS_PLATFORM', 'true');
  });

  test('never chosen (a fresh browser, nothing stored): the microphone is there without a manual step', async () => {
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });

    await waitFor(() => expect(micButton()).not.toBeNull());
    expect(readStoredUiPreferences().voiceEnabled).toBe(true);
    // Read-aloud is a separate choice and stays off.
    expect(readStoredUiPreferences().autoSpeak).toBe(false);
    // The default is not a person's choice, so it is not recorded as one.
    expect(readStoredUiPreferences().voiceChosen).toBe(false);
  });

  test('a blob written by an older build (voiceEnabled false, no voiceChosen) counts as never chosen', async () => {
    h.server.preferences = { uiPreferences: { sidebarVisible: false, voiceEnabled: false } };
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });

    await waitFor(() => expect(micButton()).not.toBeNull());
    expect(readStoredUiPreferences().sidebarVisible).toBe(false);
  });

  test('hydrated before the composer mounts (the usual order): the microphone still appears', async () => {
    await hydrateUserPreferences();
    render(<Composer />);

    await waitFor(() => expect(micButton()).not.toBeNull());
  });

  test.each([
    ['read-aloud left on', { voiceEnabled: false, autoSpeak: true }],
    ['a tempo moved', { voiceEnabled: false, voiceRate: 1.25 }],
  ])('traces of voice switched off before voiceChosen existed (%s): stays off', async (_label, blob) => {
    h.server.preferences = { uiPreferences: blob };
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await settle();

    expect(micButton()).toBeNull();
    expect(h.health).not.toHaveBeenCalled();
    expect(readStoredUiPreferences().voiceEnabled).toBe(false);
  });

  test.each([
    ['a person chose off', { voiceEnabled: false, voiceChosen: true }],
    ['other preferences only', { voiceEnabled: false, sidebarVisible: false, showThinking: false }],
  ])('the server failed the hydrate (%s): nothing is switched on and nothing is written over it', async (_label, blob) => {
    h.server.preferences = { uiPreferences: blob };
    h.server.status = [500];
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    // Positive signal first: the hook got as far as its fresh read of the server
    // copy (the hydrate is read one), so the checks below are not vacuous.
    await waitFor(() => expect(h.server.reads).toBe(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    expect(micButton()).toBeNull();
    expect(readStoredUiPreferences().voiceEnabled).toBe(false);
    expect(h.saved.filter((u) => 'uiPreferences' in u)).toEqual([]);
  });

  test('a workspace without voice asks the relay once per page load, not on every composer mount', async () => {
    h.health.mockImplementation(async () => fakeResponse(200, { configured: false }));
    await hydrateUserPreferences();
    const first = render(<Composer />);
    await settle();
    first.unmount();
    render(<Composer />);
    await settle();

    expect(h.health).toHaveBeenCalledTimes(1);
    expect(micButton()).toBeNull();
  });

  test('any toggle a person reaches (Quick Settings and Settings both write through setPreference) records the choice', async () => {
    let setPreference: ReturnType<typeof useSetUiPreference> | null = null;
    const Probe = () => {
      setPreference = useSetUiPreference();
      return null;
    };
    render(<UiPreferencesProvider><Probe /></UiPreferencesProvider>);
    await act(async () => {
      setPreference!('voiceEnabled', true);
    });
    expect(readStoredUiPreferences()).toMatchObject({ voiceEnabled: true, voiceChosen: true });
    await act(async () => {
      setPreference!('voiceEnabled', false);
    });
    expect(readStoredUiPreferences()).toMatchObject({ voiceEnabled: false, voiceChosen: true });
  });

  test('the admin took voice away: a default nobody chose is taken back, so no disabled microphone stays behind', async () => {
    h.server.preferences = { uiPreferences: { voiceEnabled: true } };
    h.health.mockImplementation(async () => fakeResponse(200, { configured: false }));
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });

    await waitFor(() => expect(readStoredUiPreferences().voiceEnabled).toBe(false));
    expect(readStoredUiPreferences().voiceChosen).toBe(false);
    expect(screen.queryByRole('button', { name: /voice/i })).toBeNull();
  });

  test('the admin took voice away from a person who chose voice: their choice stays', async () => {
    h.server.preferences = { uiPreferences: { voiceEnabled: true, voiceChosen: true } };
    h.health.mockImplementation(async () => fakeResponse(200, { configured: false }));
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await waitFor(() => expect(h.health).toHaveBeenCalled());
    await settle();

    expect(readStoredUiPreferences()).toMatchObject({ voiceEnabled: true, voiceChosen: true });
  });

  test('switched off by a person: stays off, and the relay is not even asked', async () => {
    h.server.preferences = { uiPreferences: { voiceEnabled: false, voiceChosen: true } };
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await settle();

    expect(micButton()).toBeNull();
    expect(h.health).not.toHaveBeenCalled();
    expect(readStoredUiPreferences().voiceEnabled).toBe(false);
  });

  test('switching voice off in Settings records the choice, and it survives a reload', async () => {
    const view = render(
      <UiPreferencesProvider>
        <VoiceSettingsTab />
      </UiPreferencesProvider>,
    );
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await waitFor(() => expect(micButton()).not.toBeNull());

    const toggle = view.getByRole('switch', { name: 'Enable voice' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);

    await waitFor(() => expect(micButton()).toBeNull());
    expect(readStoredUiPreferences()).toMatchObject({ voiceEnabled: false, voiceChosen: true });

    // A reload: the server now holds what this page saved.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    const savedBlob = h.saved.map((u) => u.uiPreferences).filter(Boolean).pop() as Record<string, unknown>;
    expect(savedBlob).toMatchObject({ voiceEnabled: false, voiceChosen: true });
    cleanup();
    resetUserPreferences();
    resetVoiceHealth();
    h.health.mockClear();
    h.server.preferences = { uiPreferences: savedBlob };
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await settle();
    expect(micButton()).toBeNull();
    expect(h.health).not.toHaveBeenCalled();
  });

  test('the relay reports no backend: voice stays off and nothing is written', async () => {
    h.health.mockImplementation(async () => fakeResponse(200, { configured: false }));
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await settle();

    expect(micButton()).toBeNull();
    expect(readStoredUiPreferences().voiceEnabled).toBe(false);
  });

  test('the health check fails: voice stays off', async () => {
    h.health.mockImplementation(async () => fakeResponse(503, { error: 'No voice backend configured' }));
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await settle();

    expect(micButton()).toBeNull();
    expect(readStoredUiPreferences().voiceEnabled).toBe(false);
  });

  test('before the server copy arrives nothing is decided (it could hold a choice made on another device)', async () => {
    render(<Composer />);
    await settle();

    expect(h.health).not.toHaveBeenCalled();
    expect(micButton()).toBeNull();
  });
});

describe('outside platform mode', () => {
  test('nothing changes: voice stays off and the relay is not asked', async () => {
    vi.stubEnv('VITE_IS_PLATFORM', 'false');
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    await settle();

    expect(h.health).not.toHaveBeenCalled();
    expect(micButton()).toBeNull();
  });
});
