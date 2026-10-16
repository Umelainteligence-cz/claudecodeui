import { readUserPreference } from '@/shared/userSettings';

/**
 * The UI preferences (booleans, plus the voice overlay's `voiceRate`) and their reducer, kept separate from the provider
 * so the state transitions are unit-testable without rendering anything.
 *
 * The values are stored in `auth.db` through the preference store, so a toggle
 * made on one device is in effect on the next.
 */

/** Toggles the user controls from Quick Settings and the Settings dialog. */
export type UiPreferences = {
  showRawParameters: boolean;
  showThinking: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  voiceEnabled: boolean;
  /** Speak the reply's spoken line when a turn this page started finishes. Off by default. */
  autoSpeak: boolean;
  /** Playback rate of spoken replies (voice overlay, „Tempo řeči"): 1 to 1.5, 1 by default. */
  voiceRate: number;
  /**
   * A person has set `voiceEnabled` themselves (voice overlay, hv1). The whole
   * blob is stored on every change, so a stored `voiceEnabled: false` alone does
   * not say anyone chose it; this does. Only a person's choice ever sets it.
   */
  voiceChosen: boolean;
};

export type UiPreferenceKey = keyof UiPreferences;

export type UiPreferencesAction =
  | { type: 'set'; key: UiPreferenceKey; value: unknown }
  | { type: 'set_many'; value?: Partial<Record<UiPreferenceKey, unknown>> }
  /** Voice overlay (hv1): the platform delivered voice and nobody has chosen - switch it on, unrecorded. */
  | { type: 'adopt_platform_voice' };

const DEFAULTS: UiPreferences = {
  showRawParameters: false,
  showThinking: true,
  sendByCtrlEnter: false,
  sidebarVisible: true,
  voiceEnabled: false,
  autoSpeak: false,
  voiceRate: 1,
  voiceChosen: false,
};

const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
/** Prevents an unknown key from being written into the blob. */
const VALID_KEYS = new Set<UiPreferenceKey>(PREFERENCE_KEYS);

/** Values were historically stored as both real booleans and the strings. */
const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
};

/** The bounds of `voiceRate`: the browser plays at 1x to 1.5x, never slower than the vendor's own tempo. */
export const VOICE_RATE_MIN = 1;
export const VOICE_RATE_MAX = 1.5;
export const VOICE_RATE_STEP = 0.05;

/**
 * A stored or offered rate: a finite number, clamped to the bounds and rounded
 * to two decimals (so 1.2500000001 from a slider and 1.25 compare equal);
 * anything else keeps `fallback`.
 */
export const parseVoiceRate = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const clamped = Math.min(VOICE_RATE_MAX, Math.max(VOICE_RATE_MIN, value));
  return Math.round(clamped * 100) / 100;
};

const parsePreference = <K extends UiPreferenceKey>(
  key: K,
  value: unknown,
  fallback: UiPreferences[K],
): UiPreferences[K] => (
  key === 'voiceRate'
    ? parseVoiceRate(value, fallback as number)
    : parseBoolean(value, fallback as boolean)
) as UiPreferences[K];

/**
 * Reads the stored preferences, filling in a default for anything the user has
 * never toggled. Synchronous, because the sidebar's visibility and the composer's
 * send-key are needed on the very first render.
 */
export const readStoredUiPreferences = (): UiPreferences => (
  parseUiPreferences(readUserPreference<Record<string, unknown>>('uiPreferences', {}))
);

/** A stored blob (from the store, or straight from the server) read the same way, defaults filled in. */
export const parseUiPreferences = (stored: unknown): UiPreferences => {
  const record = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {};

  return PREFERENCE_KEYS.reduce((acc, key) => {
    (acc as Record<UiPreferenceKey, unknown>)[key] = parsePreference(key, record[key], DEFAULTS[key]);
    return acc;
  }, { ...DEFAULTS });
};

/**
 * Voice overlay (hv1): nobody has decided about voice yet. Off, never chosen,
 * and none of the traces a person leaves only while voice is on (read-aloud
 * switched on, a tempo moved) - those mean it was on once and someone switched
 * it off before `voiceChosen` existed.
 */
export const isVoiceUndecided = (preferences: UiPreferences): boolean => (
  !preferences.voiceEnabled
  && !preferences.voiceChosen
  && !preferences.autoSpeak
  && preferences.voiceRate === DEFAULTS.voiceRate
);

export function uiPreferencesReducer(
  state: UiPreferences,
  action: UiPreferencesAction,
): UiPreferences {
  switch (action.type) {
    case 'set': {
      const { key, value } = action;
      if (!VALID_KEYS.has(key)) {
        return state;
      }

      const nextValue = parsePreference(key, value, state[key]);
      // Returning the same object keeps consumers from re-rendering on a no-op.
      return state[key] === nextValue ? state : { ...state, [key]: nextValue };
    }
    case 'set_many': {
      const updates = action.value || {};
      let changed = false;
      const nextState = { ...state };

      for (const key of PREFERENCE_KEYS) {
        if (!(key in updates)) continue;

        const nextValue = parsePreference(key, updates[key], state[key]);
        if (nextState[key] !== nextValue) {
          (nextState as Record<UiPreferenceKey, unknown>)[key] = nextValue;
          changed = true;
        }
      }

      return changed ? nextState : state;
    }
    case 'adopt_platform_voice':
      // Judged against the state at dispatch time, so a choice made while the
      // health check was in flight wins over the default.
      return isVoiceUndecided(state) ? { ...state, voiceEnabled: true } : state;
    default:
      return state;
  }
}
