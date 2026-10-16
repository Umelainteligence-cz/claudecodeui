import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import ContextRingSetting from '@/modules/chat/composer/ContextRingSetting';
import { contextRingI18n } from '@/modules/chat/composer/contextRingI18n';
import csContextRing from '@/modules/chat/composer/locales/cs/contextRing.json';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { resetUserPreferences } from '@/shared/userSettings';
import type * as SharedApi from '@/shared/api';

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

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  await contextRingI18n.changeLanguage('cs');
});

describe('the showContextRing Quick Settings toggle (R13)', () => {
  test('renders checked by default, and switches off and on again', async () => {
    render(<UiPreferencesProvider><ContextRingSetting /></UiPreferencesProvider>);
    const box = screen.getByRole('checkbox', { name: csContextRing.setting.label }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(csContextRing.setting.description)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() => expect(readStoredUiPreferences().showContextRing).toBe(false));
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    await waitFor(() => expect(readStoredUiPreferences().showContextRing).toBe(true));
    expect(box.checked).toBe(true);
  });
});
