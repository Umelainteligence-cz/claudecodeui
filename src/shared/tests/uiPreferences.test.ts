import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  readStoredUiPreferences,
  uiPreferencesReducer,
} from '@/shared/uiPreferences';
import type { UiPreferences } from '@/shared/uiPreferences';
import { writeUserPreference, resetUserPreferences } from '@/shared/userSettings';

/**
 * These preferences were previously held by four independent useReducer
 * instances that reconciled through a CustomEvent, then by one localStorage
 * blob, and now by the server-backed preference store. Consolidating them has
 * to preserve the stored shape and the string/boolean coercion, or users lose
 * settings on upgrade.
 */

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

const storeUiPreferences = (value: unknown) => {
  writeUserPreference('uiPreferences', value);
};

const baseline = (): UiPreferences => readStoredUiPreferences();

test('a fresh install gets the documented defaults', () => {
  assert.deepEqual(readStoredUiPreferences(), {
    showRawParameters: false,
    showThinking: true,
    sendByCtrlEnter: false,
    sidebarVisible: true,
    voiceEnabled: false,
    // Auto-speak is off on a fresh container (voice overlay, KTD8).
    autoSpeak: false,
    // Spoken replies play at the voice service's own tempo until the builder changes it.
    voiceRate: 1,
    // Nobody has chosen about voice yet (voice overlay, hv1).
    voiceChosen: false,
    // Nobody has confirmed where a recording goes yet (voice overlay, hv2).
    voiceNoticeAccepted: false,
  });
});

test('the platform voice default switches voice on only while nobody has decided (voice overlay, hv1)', () => {
  const fresh = baseline();
  const adopted = uiPreferencesReducer(fresh, { type: 'adopt_platform_voice' });
  assert.equal(adopted.voiceEnabled, true);
  // The default is not recorded as a choice, and read-aloud stays off.
  assert.equal(adopted.voiceChosen, false);
  assert.equal(adopted.autoSpeak, false);
  // Already on: nothing to do, same object.
  assert.equal(uiPreferencesReducer(adopted, { type: 'adopt_platform_voice' }), adopted);

  for (const decided of [
    { ...fresh, voiceChosen: true },
    { ...fresh, autoSpeak: true },
    { ...fresh, voiceRate: 1.2 },
  ]) {
    assert.equal(uiPreferencesReducer(decided, { type: 'adopt_platform_voice' }), decided);
  }

  // Taken back only while it is still the platform's unchosen default, and that leaves it undecided again.
  assert.deepEqual(uiPreferencesReducer(adopted, { type: 'retract_platform_voice' }), fresh);
  for (const chosen of [
    { ...adopted, voiceChosen: true },
    { ...adopted, autoSpeak: true },
    { ...adopted, voiceRate: 1.2 },
  ]) {
    assert.equal(uiPreferencesReducer(chosen, { type: 'retract_platform_voice' }), chosen);
  }
});

test('the recording notice is not a voice choice: the platform default comes and goes around it (voice overlay, hv2)', () => {
  const accepted = { ...baseline(), voiceEnabled: true, voiceNoticeAccepted: true };
  // Taken back by the platform: voice goes off, the confirmation stays.
  const retracted = uiPreferencesReducer(accepted, { type: 'retract_platform_voice' });
  assert.equal(retracted.voiceEnabled, false);
  assert.equal(retracted.voiceNoticeAccepted, true);
  // Delivered again: on again, and nobody is asked twice.
  const readopted = uiPreferencesReducer(retracted, { type: 'adopt_platform_voice' });
  assert.equal(readopted.voiceEnabled, true);
  assert.equal(readopted.voiceNoticeAccepted, true);
});

test('voiceNoticeAccepted is read back like any other boolean', () => {
  storeUiPreferences({ voiceNoticeAccepted: 'true' });
  assert.equal(readStoredUiPreferences().voiceNoticeAccepted, true);
  storeUiPreferences({ voiceEnabled: true, voiceChosen: true });
  assert.equal(readStoredUiPreferences().voiceNoticeAccepted, false);
});

test('voiceChosen is read back like any other boolean', () => {
  storeUiPreferences({ voiceChosen: 'true' });
  assert.equal(readStoredUiPreferences().voiceChosen, true);
  storeUiPreferences({ voiceEnabled: false });
  assert.equal(readStoredUiPreferences().voiceChosen, false);
});

test('a stored voiceRate is read back, clamped to 1-1.5 and rounded to two decimals', () => {
  storeUiPreferences({ voiceRate: 1.25 });
  assert.equal(readStoredUiPreferences().voiceRate, 1.25);

  storeUiPreferences({ voiceRate: 3 });
  assert.equal(readStoredUiPreferences().voiceRate, 1.5);

  storeUiPreferences({ voiceRate: 0.5 });
  assert.equal(readStoredUiPreferences().voiceRate, 1);

  storeUiPreferences({ voiceRate: 1.2500000001 });
  assert.equal(readStoredUiPreferences().voiceRate, 1.25);
});

test('a voiceRate that is not a finite number falls back to the default', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '1.3', true, null]) {
    storeUiPreferences({ voiceRate: value });
    assert.equal(readStoredUiPreferences().voiceRate, 1, String(value));
  }
});

test('setting voiceRate clamps it, and an invalid value keeps the current one', () => {
  const state = baseline();
  const faster = uiPreferencesReducer(state, { type: 'set', key: 'voiceRate', value: 1.4 });
  assert.equal(faster.voiceRate, 1.4);
  assert.equal(faster.autoSpeak, state.autoSpeak);

  assert.equal(uiPreferencesReducer(faster, { type: 'set', key: 'voiceRate', value: 9 }).voiceRate, 1.5);
  assert.equal(uiPreferencesReducer(faster, { type: 'set', key: 'voiceRate', value: 'fast' }), faster);
  assert.equal(uiPreferencesReducer(faster, { type: 'set', key: 'voiceRate', value: 1.4 }), faster);
});

test('a cross-tab update carries voiceRate with the booleans', () => {
  const next = uiPreferencesReducer(baseline(), { type: 'set_many', value: { voiceRate: 1.35, voiceEnabled: true } });
  assert.equal(next.voiceRate, 1.35);
  assert.equal(next.voiceEnabled, true);
});

test('the stored blob is read back', () => {
  storeUiPreferences({ showThinking: false, voiceEnabled: true });

  const preferences = readStoredUiPreferences();
  assert.equal(preferences.showThinking, false);
  assert.equal(preferences.voiceEnabled, true);
  assert.equal(preferences.sidebarVisible, true, 'unlisted keys keep their default');
});

test('values stored as strings are coerced, as older versions wrote them', () => {
  storeUiPreferences({ showThinking: 'false', voiceEnabled: 'true' });

  const preferences = readStoredUiPreferences();
  assert.equal(preferences.showThinking, false);
  assert.equal(preferences.voiceEnabled, true);
});

test('a stored value of the wrong type falls back instead of throwing', () => {
  storeUiPreferences('not an object');

  assert.equal(readStoredUiPreferences().showThinking, true);
});

test('setting a preference changes only that key', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, { type: 'set', key: 'showThinking', value: false });

  assert.equal(next.showThinking, false);
  assert.equal(next.sidebarVisible, state.sidebarVisible);
});

test('setting a preference to its current value keeps the same object', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, { type: 'set', key: 'showThinking', value: true });

  assert.equal(next, state, 'a no-op must not wake consumers');
});

test('an unknown key is ignored', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, {
    type: 'set',
    key: 'notAPreference' as never,
    value: true,
  });

  assert.equal(next, state);
});

test('a cross-tab update applies every changed key at once', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, {
    type: 'set_many',
    value: { showThinking: false, voiceEnabled: true },
  });

  assert.equal(next.showThinking, false);
  assert.equal(next.voiceEnabled, true);
});

test('a cross-tab update with nothing new keeps the same object', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, {
    type: 'set_many',
    value: { showThinking: state.showThinking },
  });

  assert.equal(next, state);
});
