import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  readStoredUiPreferences,
  uiPreferencesReducer,
} from '@/shared/uiPreferences';
import { writeUserPreference, resetUserPreferences } from '@/shared/userSettings';

/** The composer's context ring is on until a person switches it off in Quick Settings. */

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

const storeUiPreferences = (value: unknown) => {
  writeUserPreference('uiPreferences', value);
};

test('an empty stored blob parses to showContextRing on', () => {
  storeUiPreferences({});
  assert.equal(readStoredUiPreferences().showContextRing, true);
});

test('a stored false and a stored "false" both parse to off', () => {
  storeUiPreferences({ showContextRing: false });
  assert.equal(readStoredUiPreferences().showContextRing, false);

  storeUiPreferences({ showContextRing: 'false' });
  assert.equal(readStoredUiPreferences().showContextRing, false);
});

test('a garbage stored value falls back to on', () => {
  storeUiPreferences({ showContextRing: 42 });
  assert.equal(readStoredUiPreferences().showContextRing, true);
});

test('set returns a new state with the key off, and the same object for the same value', () => {
  const state = readStoredUiPreferences();
  const off = uiPreferencesReducer(state, { type: 'set', key: 'showContextRing', value: false });
  assert.notEqual(off, state);
  assert.equal(off.showContextRing, false);
  assert.equal(uiPreferencesReducer(off, { type: 'set', key: 'showContextRing', value: false }), off);
});
