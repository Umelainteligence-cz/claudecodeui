// Kryton PDF overlay (E474): the print path of "Export as › PDF (print)".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import '@/modules/chat/export/pdfExportI18n';
import { buildTranscriptHtml } from '@/modules/chat/export/buildTranscriptHtml';
import {
  FRAME_SANDBOX,
  PRINT_CSP,
  __printInFrameForTest,
  closePdfPrintWindow,
  openPdfPrintWindow,
  printTranscriptAsPdf,
  toPrintableHtml,
} from '@/modules/chat/export/printTranscript';
import type { ChatMessage } from '@/shared/types';

const TITLE = 'Příliš žluťoučký kůň úpěl ďábelské ódy';

async function realTranscriptHtml(messages: ChatMessage[] = []): Promise<string> {
  return buildTranscriptHtml({
    messages,
    createDiff: () => [],
    provider: 'claude',
    selectedProject: null,
    sessionTitle: TITLE,
    exportedAt: new Date('2026-11-25T10:00:00Z'),
  });
}

function fakeWindow() {
  const doc = document.implementation.createHTMLDocument('');
  const w = {
    closed: false,
    opener: window as unknown,
    document: doc,
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(() => { w.closed = true; }),
  };
  return w;
}

beforeEach(async () => {
  await i18n.changeLanguage('cs');
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
  closePdfPrintWindow();
  document.querySelectorAll('iframe').forEach((f) => f.remove());
});

describe('toPrintableHtml over the real .html export', () => {
  it('prints light, in the UI language, without the theme toggle, with the print CSS and a Czech meta line', async () => {
    document.documentElement.classList.add('dark');
    const html = await realTranscriptHtml();
    // The anchors the overlay rewrites must still be in the upstream builder's output.
    expect(html).toContain('<html lang="en" class="dark">');
    expect(html).toContain('class="chat-export-theme-toggle"');
    expect(html).toMatch(/<p class="chat-export-meta">0 messages · exported /);

    const out = toPrintableHtml(html, { lang: 'cs', meta: (count, date) => i18n.t('chat:export.pdf.meta', { count, date }) });
    expect(out).toContain('<html lang="cs" class="">');
    expect(out).toContain('<meta name="color-scheme" content="light">');
    expect(out).not.toContain('chat-export-theme-toggle"');
    expect(out).not.toContain('onclick=');
    expect(out).toMatch(/<p class="chat-export-meta">0 zpráv · exportováno /);
    expect(out).toContain('<style id="kryton-pdf-print">');
    expect(out).toContain('@page { size: A4;');
    expect(out).toContain(`<title>${TITLE}</title>`);
  });

  it('uses the Czech plural forms', () => {
    const meta = (count: number) => i18n.t('chat:export.pdf.meta', { count, date: 'd' });
    expect(meta(1)).toBe('1 zpráva · exportováno d');
    expect(meta(3)).toBe('3 zprávy · exportováno d');
    expect(meta(5)).toBe('5 zpráv · exportováno d');
  });

  it('puts the script CSP FIRST in <head>, also over hostile model markdown (javascript: link, onerror)', async () => {
    const hostile = [
      { type: 'user', content: 'Napiš odkaz', timestamp: '2026-11-25T10:00:00Z' },
      { type: 'assistant', content: 'Tady: [javascript:alert(1)//a.js]() a <img src=x onerror=alert(2)>', timestamp: '2026-11-25T10:00:01Z' },
    ] as unknown as ChatMessage[];
    const out = toPrintableHtml(await realTranscriptHtml(hostile), { lang: 'cs' });
    const doc = new DOMParser().parseFromString(out, 'text/html');
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(PRINT_CSP);
    expect(PRINT_CSP).toContain("script-src 'none'");
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<body'));
    expect(doc.body.textContent).toContain('Tady:');
  });

  it('refuses a page without <head> (fail closed: no CSP, no print)', () => {
    expect(() => toPrintableHtml('<p>no head</p>', { lang: 'cs' })).toThrow(/no <head>/);
  });

  it('skips a step whose anchor is gone and keeps the rest', () => {
    const out = toPrintableHtml('<!DOCTYPE html><html><head><title>x</title></head><body>b</body></html>', { lang: 'cs' });
    expect(out).toContain('<style id="kryton-pdf-print">');
    expect(out).toContain('<body>b</body>');
  });
});

describe('printTranscriptAsPdf', () => {
  it('MAIN: writes the printable page into the tab opened in the click and prints it there', async () => {
    const w = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    expect(openPdfPrintWindow()).toBe(w);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(w.opener).toBeNull();
    expect(w.document.body.textContent).toContain('Připravuji PDF');
    expect(w.document.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');

    await printTranscriptAsPdf(realTranscriptHtml);
    expect(w.document.title).toBe(TITLE);
    expect(w.document.documentElement.getAttribute('lang')).toBe('cs');
    expect(w.print).toHaveBeenCalledTimes(1);
    expect(w.document.head.firstElementChild?.getAttribute('content')).toBe(PRINT_CSP);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('a tab the person CLOSED while the page was built cancels the print: no dialog, no frame', async () => {
    const w = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    openPdfPrintWindow();
    w.closed = true;
    await printTranscriptAsPdf(realTranscriptHtml);
    expect(w.print).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('FALLBACK through the public API: a blocked tab prints the adapted page from a sandboxed srcdoc frame', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPdfPrintWindow()).toBeNull();
    // jsdom fires the frame's own load event once it is attached, so stub print/focus on its
    // window at append time, before that event (not after an await, when it has already run).
    const print = vi.fn();
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      const appended = realAppend(node);
      if (node instanceof HTMLIFrameElement && node.contentWindow) {
        Object.assign(node.contentWindow, { print, focus: vi.fn() });
      }
      return appended;
    });
    const done = printTranscriptAsPdf(realTranscriptHtml);
    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe(FRAME_SANDBOX);
    expect(FRAME_SANDBOX).not.toContain('allow-scripts');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('<style id="kryton-pdf-print">');
    expect(srcdoc).toContain('<html lang="cs" class="">');
    expect(srcdoc).toContain(PRINT_CSP);
    const win = frame.contentWindow!;
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    win.dispatchEvent(new Event('afterprint'));
    await done;
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('closes the waiting tab when building the page fails', async () => {
    const w = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    openPdfPrintWindow();
    await expect(printTranscriptAsPdf(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(w.close).toHaveBeenCalled();
  });

  it('closePdfPrintWindow closes a tab the menu opened when the export failed before printing', () => {
    const w = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(w as unknown as Window);
    openPdfPrintWindow();
    closePdfPrintWindow();
    expect(w.close).toHaveBeenCalled();
  });

  it('FALLBACK: a blocked tab (null) prints from a hidden srcdoc frame that stays until afterprint', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPdfPrintWindow()).toBeNull();

    const done = __printInFrameForTest('<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>');
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('srcdoc')).toContain('<title>t</title>');
    expect(frame!.style.display).not.toBe('none');
    const win = frame!.contentWindow!;
    const print = vi.fn();
    (win as unknown as { print: () => void }).print = print;
    frame!.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // print() from a frame returns before the dialog opens: the frame must still be there.
    expect(document.querySelector('iframe')).not.toBeNull();
    win.dispatchEvent(new Event('afterprint'));
    await done;
    expect(document.querySelector('iframe')).toBeNull();
  });
});
