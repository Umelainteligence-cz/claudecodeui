import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import VoiceRateSetting from '@/modules/chat/voice/VoiceRateSetting';
import csVoice from '@/modules/chat/voice/locales/cs/voice.json';
import enVoice from '@/modules/chat/voice/locales/en/voice.json';
import { voiceI18n } from '@/modules/chat/voice/voiceI18n';
import { fakeResponse, setUiPreferences } from '@/modules/chat/voice/tests/kit';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { resetUserPreferences } from '@/shared/userSettings';
import type * as SharedApi from '@/shared/api';

const h = vi.hoisted(() => ({ health: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      voice: { ...actual.api.voice, health: () => h.health() },
      user: { ...actual.api.user, savePreferences: async () => ({ ok: true, json: async () => ({}) }) },
    },
  };
});

const renderSetting = (variant: 'quick' | 'settings') =>
  render(<UiPreferencesProvider><VoiceRateSetting variant={variant} /></UiPreferencesProvider>);

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  h.health.mockReset();
  h.health.mockImplementation(async () => fakeResponse(200, { configured: true }));
  await voiceI18n.changeLanguage('cs');
});

describe('the voiceRate setting („Tempo řeči")', () => {
  test('in Settings it is shown but disabled, with its explanation, while voice is off', () => {
    renderSetting('settings');
    const slider = screen.getByRole('slider', { name: csVoice.rate.label }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(screen.getByText(csVoice.rate.unavailable)).toBeTruthy();
  });

  test('once voice is on it is enabled without asking the voice service, and shows 1x the Czech way', async () => {
    await setUiPreferences({ voiceEnabled: true });
    renderSetting('settings');
    const slider = screen.getByRole('slider', { name: csVoice.rate.label }) as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(slider.min).toBe('1');
    expect(slider.max).toBe('1.5');
    expect(slider.step).toBe('0.05');
    expect(slider.value).toBe('1');
    expect(screen.getByText('1,00×')).toBeTruthy();
    expect(slider.getAttribute('aria-valuetext')).toBe('1,00násobek běžného tempa');
    expect(screen.getByText(csVoice.rate.hint)).toBeTruthy();
    expect(h.health).not.toHaveBeenCalled();
  });

  test('it takes keyboard focus, and moving it stores the rate and shows the new value', async () => {
    await setUiPreferences({ voiceEnabled: true });
    renderSetting('settings');
    const slider = screen.getByRole('slider', { name: csVoice.rate.label }) as HTMLInputElement;
    slider.focus();
    expect(document.activeElement).toBe(slider);

    fireEvent.change(slider, { target: { value: '1.25' } });
    await waitFor(() => expect(readStoredUiPreferences().voiceRate).toBe(1.25));
    expect(screen.getByText('1,25×')).toBeTruthy();
    expect(slider.getAttribute('aria-valuetext')).toBe('1,25násobek běžného tempa');
  });

  test('a stored rate is shown, formatted for the interface language', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceRate: 1.4 });
    await voiceI18n.changeLanguage('en');
    renderSetting('settings');
    const slider = screen.getByRole('slider', { name: enVoice.rate.label }) as HTMLInputElement;
    expect(slider.value).toBe('1.4');
    expect(screen.getByText('1.40×')).toBeTruthy();
  });

  test('the Quick Settings row is absent while voice is off and a labelled slider once it is on', async () => {
    const off = renderSetting('quick');
    expect(off.container.innerHTML).toBe('');
    off.unmount();

    await setUiPreferences({ voiceEnabled: true, voiceRate: 1.15 });
    renderSetting('quick');
    const slider = screen.getByRole('slider', { name: csVoice.rate.label }) as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(screen.getByText('1,15×')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '1.5' } });
    await waitFor(() => expect(readStoredUiPreferences().voiceRate).toBe(1.5));
  });
});
