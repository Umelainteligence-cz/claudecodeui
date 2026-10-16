import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import { usePlatformVoiceDefaultActions, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import {
  isVoicePlatformDefault,
  isVoiceUndecided,
  parseUiPreferences,
  readStoredUiPreferences,
} from '@/shared/uiPreferences';
import type { UiPreferences } from '@/shared/uiPreferences';
import { hasHydratedUserPreferences, subscribeToUserPreferences } from '@/shared/userSettings';
import { checkVoiceHealth, isVoicePlatformMode, voiceHealth } from '@/modules/chat/voice/voiceState';

/**
 * Voice on by default where the platform delivered it (hv1, Q517 = A1).
 *
 * In platform mode the relay reports `configured: true` only in a workspace the
 * admin switched voice on for (VOICE_ENABLED=1 is what hands the relay its
 * backend). Upstream's `voiceEnabled` is a stored preference that starts off, so
 * without this a person the admin gave voice to still had to find the switch in
 * Settings before the microphone appeared.
 *
 * The default belongs to the platform, so it follows the platform both ways:
 * switched on while the relay says configured, taken back when it says it is not
 * (otherwise everyone the default switched on would keep a disabled microphone
 * after the admin took voice away). What it never touches:
 *  - a person's choice (`voiceChosen`) or its traces, see `isVoiceUndecided`;
 *    read-aloud (`autoSpeak`) stays off: that is a choice of its own;
 *  - anything outside platform mode: no request is made there at all;
 *  - anything before the server's copy of the preferences arrived, and anything
 *    a fresh read of that copy does not confirm. The store marks itself hydrated
 *    even when the server answered with an error, and the write that follows a
 *    change carries the whole blob - over a failed hydrate it would put the
 *    defaults over a person's real choices. A disagreeing or failed read changes
 *    nothing on this page load.
 * The relay is asked at most once per page load: a workspace without voice
 * answers `false` and is not asked again on every composer mount.
 */
export function usePlatformVoiceDefault(): void {
  const preferences = useUiPreferences();
  const { adoptPlatformVoiceDefault, retractPlatformVoiceDefault } = usePlatformVoiceDefaultActions();
  const hydrated = useSyncExternalStore(subscribeToUserPreferences, hasHydratedUserPreferences, hasHydratedUserPreferences);
  const undecided = isVoiceUndecided(preferences);
  const platformDefault = isVoicePlatformDefault(preferences);

  useEffect(() => {
    if (!isVoicePlatformMode() || !hydrated || !(undecided || platformDefault)) return undefined;
    // The store is read as well as the context: it takes the server's copy the
    // moment it arrives, a render before the provider's state catches up.
    const stored = readStoredUiPreferences();
    const wantOn = isVoiceUndecided(stored);
    if (!wantOn && !isVoicePlatformDefault(stored)) return undefined;

    let active = true;
    const run = async () => {
      const known = voiceHealth();
      const configured = known !== null ? known : await checkVoiceHealth().catch(() => false);
      // Undecided and no voice, or on by default and voice delivered: nothing to do.
      if (!active || configured !== wantOn) return;
      if (!(await serverAgrees(wantOn ? isVoiceUndecided : isVoicePlatformDefault))) return;
      if (!active) return;
      if (wantOn) adoptPlatformVoiceDefault();
      else retractPlatformVoiceDefault();
    };
    void run().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrated, undecided, platformDefault, adoptPlatformVoiceDefault, retractPlatformVoiceDefault]);
}

const sameUiPreferences = (a: UiPreferences, b: UiPreferences): boolean => (
  (Object.keys(a) as Array<keyof UiPreferences>).every((key) => a[key] === b[key])
);

/** The server's copy, read now, is in the expected state and matches what this page holds. */
async function serverAgrees(expected: (preferences: UiPreferences) => boolean): Promise<boolean> {
  const response = await api.user.preferences();
  if (!response.ok) return false;
  const payload = (await response.json()) as { preferences?: { uiPreferences?: unknown } } | null;
  const server = parseUiPreferences(payload?.preferences?.uiPreferences);
  return expected(server) && sameUiPreferences(server, readStoredUiPreferences());
}
