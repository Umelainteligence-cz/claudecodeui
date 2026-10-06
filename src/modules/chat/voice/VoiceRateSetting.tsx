import { Gauge } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { SETTING_ROW_CLASS } from '@/shared/constants';
import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { VOICE_RATE_MAX, VOICE_RATE_MIN, VOICE_RATE_STEP } from '@/shared/uiPreferences';
import { VOICE_NS } from '@/modules/chat/voice/voiceI18n';

/**
 * The `voiceRate` preference („Tempo řeči"): how fast spoken replies play, 1x to
 * 1.5x, pitch preserved by the player. A local preference, so it needs only the
 * voice switch - not the workspace's voice service, unlike auto-speak.
 *
 * `settings` sits under "Read replies aloud" in Settings and stays visible but
 * disabled while voice is off; `quick` is the Quick Settings row, rendered only
 * while voice is on (the same rule as the auto-speak row there).
 */
export default function VoiceRateSetting({ variant }: { variant: 'quick' | 'settings' }) {
  const { t, i18n } = useTranslation(VOICE_NS);
  const { voiceEnabled, voiceRate } = useUiPreferences();
  const setPreference = useSetUiPreference();
  const hintId = useId();

  if (variant === 'quick' && !voiceEnabled) return null;

  const number = new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(voiceRate);
  const value = t('rate.value', { rate: number });
  const hint = voiceEnabled ? t('rate.hint') : t('rate.unavailable');

  const slider = (
    <input
      type="range"
      min={VOICE_RATE_MIN}
      max={VOICE_RATE_MAX}
      step={VOICE_RATE_STEP}
      value={voiceRate}
      disabled={!voiceEnabled}
      aria-label={t('rate.label')}
      aria-valuetext={t('rate.valueText', { rate: number })}
      aria-describedby={hintId}
      onChange={(event) => setPreference('voiceRate', Number(event.target.value))}
      className={`w-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${voiceEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
    />
  );

  if (variant === 'quick') {
    return (
      <div className="space-y-1">
        <div className={`${SETTING_ROW_CLASS} flex-wrap gap-y-2`}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {t('rate.label')}
          </span>
          <span className="text-sm tabular-nums text-foreground" aria-hidden="true">{value}</span>
          {slider}
        </div>
        <p id={hintId} className="ml-3 text-xs text-muted-foreground">{hint}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">{t('rate.label')}</div>
        <div className="text-sm tabular-nums text-foreground" aria-hidden="true">{value}</div>
      </div>
      {slider}
      <div id={hintId} className="text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
