import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import QuickSettingsContent from '@/modules/quick-settings-panel/QuickSettingsContent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { QuickSettingsPreferences } from '@/shared/types';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/shared/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DarkModeToggle: () => null,
}));
vi.mock('@/modules/i18n', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LanguageSelector: () => null,
}));

const preferences = {
  showRawParameters: false,
  showThinking: false,
  sendByCtrlEnter: false,
  voiceEnabled: false,
} as unknown as QuickSettingsPreferences;

describe('QuickSettingsContent input settings order', () => {
  test('the Ctrl+Enter hint comes before the Context ring row, not under it', () => {
    const { getByText, container } = render(
      <UiPreferencesProvider>
        <QuickSettingsContent isDarkMode={false} preferences={preferences} onPreferenceChange={() => {}} />
      </UiPreferencesProvider>,
    );
    const row = getByText('quickSettings.sendByCtrlEnter');
    const hint = getByText('quickSettings.sendByCtrlEnterDescription');
    const ring = getByText('setting.label');
    expect(container.contains(ring)).toBe(true);
    expect(row.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hint.compareDocumentPosition(ring) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
