import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import csContextRing from '@/modules/chat/composer/locales/cs/contextRing.json';
import enContextRing from '@/modules/chat/composer/locales/en/contextRing.json';

/**
 * The context ring overlay's own coverage check: every `contextRing` key the
 * code asks for exists in BOTH languages, the two files carry the same keys,
 * and the Czech copy is actually Czech. A missing `cs` key fails here - i18next
 * would otherwise fall back to English without a sound.
 */

const flatten = (value: unknown, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') Object.assign(out, flatten(child, name));
    else out[name] = String(child);
  }
  return out;
};

const en = flatten(enContextRing);
const cs = flatten(csContextRing);

// Every file that asks for a `contextRing` string. Later units append theirs.
const SOURCES = [
  'src/modules/chat/composer/contextRingI18n.ts',
  'src/modules/chat/composer/ContextUsageRing.tsx',
];

// Keys the overlay's units are specified to use, so the scan below cannot pass vacuously.
const REQUIRED_KEYS = [
  'ring.ariaLabel',
  'ring.compacting',
  'usage.used',
  'usage.usedOfTotal',
  'usage.ofWindow',
  'usage.remaining',
  'usage.remainingUntilAuto',
  'confirm.title',
  'confirm.body',
  'confirm.compact',
  'confirm.cancel',
  'confirm.details',
  'blocked.noSession',
  'blocked.noMessages',
  'blocked.offline',
  'blocked.busy',
  'blocked.editing',
  'blocked.queued',
  'status.started',
  'status.finished',
  'setting.label',
  'setting.description',
];

function keysUsedInCode(): Set<string> {
  const used = new Set<string>(REQUIRED_KEYS);
  for (const entry of SOURCES) {
    const text = fs.readFileSync(path.resolve(process.cwd(), entry), 'utf8');
    for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z]+\.[a-zA-Z_]+)'/g)) used.add(match[1]);
  }
  return used;
}

describe('contextRing locales', () => {
  test('en and cs carry exactly the same keys, none empty', () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(cs)) expect(value.trim(), `cs:${key}`).not.toBe('');
  });

  test('every key the code asks for exists in both languages', () => {
    const missing = [...keysUsedInCode()].filter((key) => !(key in en) || !(key in cs));
    expect(missing).toEqual([]);
  });

  test('interpolation placeholders match between en and cs', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en)) expect(placeholders(cs[key]), key).toEqual(placeholders(en[key]));
  });

  test('the Czech copy is Czech, not a copy of the English', () => {
    // Pure number formats carry no words, so their template is rightly shared.
    const SAME_IN_BOTH = new Set(['usage.used', 'usage.usedOfTotal']);
    const same = Object.keys(cs).filter((key) => cs[key] === en[key] && !SAME_IN_BOTH.has(key));
    expect(same).toEqual([]);
  });

  test('blocked reasons use no technical vocabulary', () => {
    for (const [key, value] of Object.entries(cs)) {
      if (!key.startsWith('blocked.')) continue;
      expect(value, key).not.toMatch(/websocket|session|id\b|API|HTTP|error/i);
    }
  });
});
