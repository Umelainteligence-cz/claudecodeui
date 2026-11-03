import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import MessageCopyControl from '@/modules/chat/transcript/MessageCopyControl';
import csVoice from '@/modules/chat/voice/locales/cs/voice.json';
import enVoice from '@/modules/chat/voice/locales/en/voice.json';
import { classifyMicError, iosBrowserKind, micErrorHoldMs, micErrorKey } from '@/modules/chat/voice/voiceErrors';
import { voiceI18n } from '@/modules/chat/voice/voiceI18n';
import { shiftIntoViewport } from '@/modules/chat/voice/viewportShift';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

/**
 * Narrow phones (mic1): the microphone refusal must say what is true on an
 * iPhone, and neither the red strip above the mic nor the copy-format menu may
 * leave the screen on a 375-390 px wide viewport.
 */

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FB_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const nav = (userAgent: string, extra: Record<string, unknown> = {}) =>
  ({ userAgent, maxTouchPoints: 5, mediaDevices: {}, ...extra }) as unknown as Navigator;
const denied = Object.assign(new Error('x'), { name: 'NotAllowedError' });
const allowingDoc = { permissionsPolicy: { allowsFeature: () => true } } as unknown as Document;
const blockingDoc = { permissionsPolicy: { allowsFeature: () => false } } as unknown as Document;

describe('iOS browser detection', () => {
  test('tells Safari, an app-embedded browser and other browsers apart', () => {
    expect(iosBrowserKind(nav(SAFARI))).toBe('safari');
    expect(iosBrowserKind(nav(FB_APP))).toBe('embedded');
    expect(iosBrowserKind(nav(CHROME_IOS))).toBe('other');
    expect(iosBrowserKind(nav(IPAD_DESKTOP))).toBe('safari');
    expect(iosBrowserKind(nav(IPAD_DESKTOP, { maxTouchPoints: 0 }))).toBeNull();
    expect(iosBrowserKind(nav(ANDROID))).toBeNull();
    expect(iosBrowserKind(undefined)).toBeNull();
  });

  test('a home-screen web app is not an embedded browser', () => {
    expect(iosBrowserKind(nav(FB_APP, { standalone: true }))).toBe('other');
  });
});

describe('microphone refusal classes', () => {
  test('an iPhone embedded browser is told to open Safari; Safari-like gets the iOS settings path', () => {
    expect(classifyMicError(denied, allowingDoc, nav(FB_APP))).toBe('embeddedBrowser');
    expect(classifyMicError(denied, allowingDoc, nav(SAFARI))).toBe('deniedIos');
  });

  test('missing mediaDevices on an iPhone means Safari is needed', () => {
    const typeError = Object.assign(new TypeError("undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')"), { name: 'TypeError' });
    expect(classifyMicError(typeError, allowingDoc, nav(SAFARI, { mediaDevices: undefined }))).toBe('embeddedBrowser');
    expect(classifyMicError(typeError, allowingDoc, nav(ANDROID, { mediaDevices: undefined }))).toBe('generic');
  });

  test('a TypeError that is not about mediaDevices stays generic, on any iPhone browser', () => {
    const typeError = Object.assign(new TypeError('x'), { name: 'TypeError' });
    expect(classifyMicError(typeError, allowingDoc, nav(SAFARI))).toBe('generic');
    expect(classifyMicError(typeError, allowingDoc, nav(FB_APP))).toBe('generic');
    expect(classifyMicError(typeError, allowingDoc, nav(CHROME_IOS, { mediaDevices: undefined }))).toBe('generic');
  });

  test('the two iPhone instructions stay on screen longer than a short refusal', () => {
    expect(micErrorHoldMs('dictation.deniedIos')).toBeGreaterThan(micErrorHoldMs('dictation.denied'));
    expect(micErrorHoldMs('dictation.embeddedBrowser')).toBeGreaterThan(4000);
    expect(micErrorHoldMs('dictation.denied')).toBe(4000);
  });

  test('everything else is unchanged', () => {
    expect(classifyMicError(denied, allowingDoc, nav(ANDROID))).toBe('denied');
    expect(classifyMicError(denied, allowingDoc, nav(CHROME_IOS))).toBe('denied');
    expect(classifyMicError(denied, blockingDoc, nav(FB_APP))).toBe('policyBlocked');
    expect(micErrorKey('embeddedBrowser')).toBe('dictation.embeddedBrowser');
    expect(micErrorKey('deniedIos')).toBe('dictation.deniedIos');
  });

  test('the copy names Safari, the compass and aA, and no longer the lock icon', () => {
    expect(csVoice.dictation.embeddedBrowser).toBe('Otevři stránku v Safari (ikona kompasu dole), vestavěný prohlížeč aplikace mikrofon nepustí.');
    expect(csVoice.dictation.deniedIos).toContain('aA → Nastavení webu → Mikrofon');
    expect(csVoice.dictation.deniedIos).not.toMatch(/zámk/);
    expect((enVoice.dictation as Record<string, string>).embeddedBrowser).toMatch(/Safari/);
    expect((enVoice.dictation as Record<string, string>).deniedIos).toMatch(/Website Settings/);
  });
});

describe('shiftIntoViewport', () => {
  test('pulls a box back in from either edge and left-aligns one that is wider than the screen', () => {
    expect(shiftIntoViewport(-230, 150, 390, 8)).toBe(238);
    expect(shiftIntoViewport(300, 420, 390, 8)).toBe(-38);
    expect(shiftIntoViewport(20, 200, 390, 8)).toBe(0);
    expect(shiftIntoViewport(-230, 366, 390, 8)).toBe(238);
    expect(shiftIntoViewport(-100, 600, 390, 8)).toBe(108);
  });
});

describe('placement on a narrow screen', () => {
  const realRect = Element.prototype.getBoundingClientRect;
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  beforeEach(async () => {
    await voiceI18n.changeLanguage('cs');
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 390 });
  });
  afterEach(() => {
    cleanup();
    Element.prototype.getBoundingClientRect = realRect;
  });

  const renderStrip = (anchor: DOMRect, strip: DOMRect, key = 'dictation.denied') => {
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const cls = String(this.className);
      if (cls.includes('bg-red-600')) return strip;
      if (cls.includes('inline-flex') && cls.includes('relative')) return anchor;
      return realRect.call(this);
    };
    return render(
      <UiPreferencesProvider>
        <VoiceInputButton state="idle" onToggle={() => undefined} errorMsg={key} />
      </UiPreferencesProvider>,
    );
  };

  test('the red strip leaves the clipping composer, wraps, and sits fully on screen above the mic', () => {
    // mic button 20 px wide at x=60: a 380 px strip centred on it would start at x=-120
    renderStrip(box(60, 600, 20, 32), box(0, 0, 380, 40));
    const strip = screen.getByText(csVoice.dictation.denied);
    expect(strip.parentElement).toBe(document.body);
    expect(strip.className).not.toMatch(/whitespace-nowrap/);
    expect(strip.className).toMatch(/max-w-\[calc\(100vw-1rem\)\]/);
    expect(strip.style.left).toBe('8px');
    expect(strip.style.top).toBe('556px');
  });

  test('a strip that already fits is only centred on the mic', () => {
    renderStrip(box(190, 600, 20, 32), box(0, 0, 100, 24));
    const strip = screen.getByText(csVoice.dictation.denied);
    expect(strip.style.left).toBe('150px');
  });

  test('it follows the mic when the layout moves (resize)', () => {
    let anchor = box(60, 600, 20, 32);
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const cls = String(this.className);
      if (cls.includes('bg-red-600')) return box(0, 0, 100, 24);
      if (cls.includes('inline-flex') && cls.includes('relative')) return anchor;
      return realRect.call(this);
    };
    render(
      <UiPreferencesProvider>
        <VoiceInputButton state="idle" onToggle={() => undefined} errorMsg="dictation.denied" />
      </UiPreferencesProvider>,
    );
    const strip = screen.getByText(csVoice.dictation.denied);
    expect(strip.style.left).toBe('20px');
    anchor = box(300, 600, 20, 32);
    window.dispatchEvent(new Event('resize'));
    expect(strip.style.left).toBe('260px');
  });

  test('no strip, nothing in <body>', () => {
    render(
      <UiPreferencesProvider>
        <VoiceInputButton state="idle" onToggle={() => undefined} errorMsg={null} />
      </UiPreferencesProvider>,
    );
    expect(document.body.querySelector('.bg-red-600')).toBeNull();
  });

  test('the copy-format menu is moved right when it would leave the left edge', () => {
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      if (String(this.className).includes('min-w-36')) return box(-68, 520, 144, 80);
      return realRect.call(this);
    };
    render(<MessageCopyControl content="text" messageType="assistant" />);
    fireEvent.click(screen.getAllByRole('button').find((b) => /format|formát/i.test(b.getAttribute('aria-label') ?? ''))!);
    const menu = document.body.querySelector('div[class*="min-w-36"]') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.left).toBe('8px');
    expect(menu.style.right).toBe('auto');
    expect(menu.className).toMatch(/max-w-\[calc\(100vw-1rem\)\]/);
  });

  test('a menu that already fits is left where the original code put it', () => {
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      if (String(this.className).includes('min-w-36')) return box(100, 520, 144, 80);
      return realRect.call(this);
    };
    render(<MessageCopyControl content="text" messageType="assistant" />);
    fireEvent.click(screen.getAllByRole('button').find((b) => /format|formát/i.test(b.getAttribute('aria-label') ?? ''))!);
    const menu = document.body.querySelector('div[class*="min-w-36"]') as HTMLElement;
    expect(menu.style.left).toBe('');
  });
});
