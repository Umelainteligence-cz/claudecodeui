import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import { useAdoptPlatformVoiceDefault, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { isVoiceUndecided, parseUiPreferences, readStoredUiPreferences } from '@/shared/uiPreferences';
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
 * What it switches on and what it never overrides:
 *  - only in platform mode; outside it nothing here runs and no request is made;
 *  - only after the server's copy of the preferences arrived, and only when a
 *    fresh read of that copy says the same as this page. The store marks itself
 *    hydrated even when the server answered with an error, and the switch-on
 *    writes the whole blob - over a failed hydrate that would put the defaults
 *    over a person's real choices. A disagreeing or failed read switches nothing;
 *  - never over a person's choice, see `isVoiceUndecided`;
 *  - read-aloud (`autoSpeak`) stays off: that is a choice of its own;
 *  - the relay is asked at most once per page load: a workspace without voice
 *    answers `false` and is not asked again on every composer mount.
 */
export function usePlatformVoiceDefault(): void {
  const preferences = useUiPreferences();
  const adopt = useAdoptPlatformVoiceDefault();
  const hydrated = useSyncExternalStore(subscribeToUserPreferences, hasHydratedUserPreferences, hasHydratedUserPreferences);
  const undecided = isVoiceUndecided(preferences);

  useEffect(() => {
    // The store is read as well as the context: it takes the server's copy the
    // moment it arrives, a render before the provider's state catches up.
    if (!isVoicePlatformMode() || !hydrated || !undecided || !isVoiceUndecided(readStoredUiPreferences())) {
      return undefined;
    }

    let active = true;
    const run = async () => {
      const known = voiceHealth();
      const configured = known !== null ? known : await checkVoiceHealth();
      if (!active || !configured) return;
      if (!(await serverAgrees())) return;
      if (active) adopt();
    };
    void run().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrated, undecided, adopt]);
}

const sameUiPreferences = (a: UiPreferences, b: UiPreferences): boolean => (
  (Object.keys(a) as Array<keyof UiPreferences>).every((key) => a[key] === b[key])
);

/** The server's copy, read now, matches what this page holds (and is still undecided). */
async function serverAgrees(): Promise<boolean> {
  const response = await api.user.preferences();
  if (!response.ok) return false;
  const payload = (await response.json()) as { preferences?: { uiPreferences?: unknown } } | null;
  const server = parseUiPreferences(payload?.preferences?.uiPreferences);
  return isVoiceUndecided(server) && sameUiPreferences(server, readStoredUiPreferences());
}
