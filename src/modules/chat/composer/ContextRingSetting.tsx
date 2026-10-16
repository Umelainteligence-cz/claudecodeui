import { Gauge } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { CONTEXT_RING_NS } from '@/modules/chat/composer/contextRingI18n';
import { SETTING_ROW_CLASS } from '@/shared/constants';
import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';

/**
 * Consumer: Quick Settings' input-settings section (via `@/modules/chat`).
 * The `showContextRing` preference as a self-contained checkbox row, so the
 * shared toggle rows and settings locales stay untouched (KTD8). Always shown,
 * unlike the voice rows.
 */
export default function ContextRingSetting() {
  const { t } = useTranslation(CONTEXT_RING_NS);
  const { showContextRing } = useUiPreferences();
  const setPreference = useSetUiPreference();
  const hintId = useId();

  return (
    <div className="space-y-1">
      <label className={`${SETTING_ROW_CLASS} cursor-pointer`}>
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('setting.label')}
        </span>
        <input
          type="checkbox"
          checked={showContextRing}
          aria-describedby={hintId}
          onChange={(event) => setPreference('showContextRing', event.target.checked)}
          className="h-4 w-4 rounded border-gray-300 bg-gray-100 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
        />
      </label>
      <p id={hintId} className="ml-3 text-xs text-muted-foreground">{t('setting.description')}</p>
    </div>
  );
}
