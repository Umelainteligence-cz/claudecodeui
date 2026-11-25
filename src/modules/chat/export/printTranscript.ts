/**
 * Kryton PDF overlay (E474): "Export as › PDF (print)" in the chat transcript menu.
 *
 * The PDF is the browser's own: the transcript HTML the "Web page (.html)" export already
 * builds is adapted for print (`toPrintableHtml`) and handed to the print dialog, where the
 * person picks "Save as PDF". No library, no server.
 *
 * Path, measured in the step-0 harness (Chromium 148, the Schejbal OS frame sandbox):
 *   1. MAIN: a NEW TAB. `openPdfPrintWindow()` opens it SYNCHRONOUSLY in the menu click
 *      (the export menu calls it before its first `await`); a window opened after an
 *      `await` is a popup the browser may block. The tab escapes the frame sandbox
 *      (`allow-popups-to-escape-sandbox`), and Chrome names the PDF after the tab's
 *      `<title>` - the conversation title. A tab the person CLOSES before the page is ready
 *      cancels the print.
 *   2. FALLBACK, only when the tab is null (blocked): a hidden `srcdoc` frame. It prints
 *      too, but the PDF is named after the TOP tab (the app page), not the conversation,
 *      and `contentWindow.print()` returns BEFORE the dialog opens - so the frame is
 *      removed on `afterprint`, with a long backstop armed only after `print()`.
 *
 * SECURITY (review E474 #1): the tab is `about:blank` and the frame `srcdoc` - both SAME-ORIGIN
 * with the app, and the app has no script CSP. The transcript holds model- and tool-authored
 * markup (a markdown link can render as `href="javascript:..."`), so every page written here
 * starts with a `<meta>` Content-Security-Policy `script-src 'none'` as the FIRST thing in
 * `<head>` - no inline script, no handler attribute and no `javascript:` URL runs in it. A page
 * without `<head>` is not printed at all (fail closed). The tab also loses `opener`, and the
 * fallback frame is sandboxed without `allow-scripts`.
 * Foreign `https:` images do not load in either (the edge CSP `img-src 'self' blob: data:`
 * is inherited); `data:`/`blob:` and same-origin images do.
 */
import { i18n } from '@/modules/i18n';
import '@/modules/chat/export/pdfExportI18n';

import { PRINT_CSS } from '@/modules/chat/export/printTranscriptCss';

/** How long to wait for fonts and images before opening the dialog anyway. */
export const ASSET_WAIT_MS = 10_000;
/** Backstop for removing the fallback frame when `afterprint` never comes - armed after print(). */
export const FRAME_BACKSTOP_MS = 10 * 60_000;
/** The policy every page written into the tab or the frame carries first. */
export const PRINT_CSP = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
/** The fallback frame's sandbox: same-origin (the parent calls its print()) and modals (print), never scripts. */
export const FRAME_SANDBOX = 'allow-same-origin allow-modals';

let pendingWindow: Window | null = null;
/** True when the last `openPdfPrintWindow()` got a tab: a tab gone later means the person cancelled. */
let pendingOpened = false;

/** The UI language as a bare primary tag (`cs`, `en`), for `<html lang>`. */
function printLanguage(): string {
  const lng = i18n.resolvedLanguage || i18n.language || 'en';
  return lng.split('-')[0] || 'en';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Puts the script-blocking CSP `<meta>` first in `<head>`. Throws when the page has no `<head>`:
 * a page we cannot fence is not written anywhere (fail closed).
 */
export function withPrintCsp(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) throw new Error('print page has no <head>; refusing to write it without its CSP');
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${CSP_META}${html.slice(at)}`;
}

/**
 * Opens the print tab NOW, inside the click that chose "PDF". Must be called before the
 * menu's first `await`. A null result (popup blocked) is not an error: the print falls back
 * to a hidden frame. Never throws: a tab that cannot take the placeholder is closed and the
 * fallback runs, so the menu's busy state always clears.
 */
export function openPdfPrintWindow(): Window | null {
  closePending();
  let opened: Window | null = null;
  try {
    opened = window.open('', '_blank');
  } catch {
    opened = null;
  }
  if (opened) {
    try {
      // Keep our handle (noopener would return null and force the fallback), cut the tab's way back.
      opened.opener = null;
      const text = escapeHtml(i18n.t('chat:export.pdf.preparing'));
      opened.document.open();
      opened.document.write(`<!DOCTYPE html><html lang="${printLanguage()}"><head>${CSP_META}<meta charset="utf-8"><title>${text}</title></head><body><p style="font-family:sans-serif">${text}</p></body></html>`);
      opened.document.close();
    } catch {
      try {
        opened.close();
      } catch {
        // already gone
      }
      opened = null;
    }
  }
  pendingWindow = opened;
  pendingOpened = opened !== null;
  return opened;
}

/** The pending tab, and whether one had been opened (so a closed tab reads as a cancel). */
function takePending(): { w: Window | null; opened: boolean } {
  const w = pendingWindow;
  const opened = pendingOpened;
  pendingWindow = null;
  pendingOpened = false;
  return { w: w && !w.closed ? w : null, opened };
}

/** Closes a print tab the menu opened when the export failed before printing. */
export function closePdfPrintWindow(): void {
  closePending();
}

function closePending(): void {
  const w = pendingWindow;
  pendingWindow = null;
  pendingOpened = false;
  try {
    if (w && !w.closed) w.close();
  } catch {
    // already gone
  }
}

/**
 * Adapts the "Web page (.html)" transcript for print. Pure. The CSP step is MANDATORY (throws
 * without `<head>`); every other step is anchored on what the upstream builder writes and is
 * SKIPPED when its anchor is missing, so a drifted builder prints a less polished page instead
 * of no page. The build test (`printTranscript.test.ts`) runs it over the real builder output.
 */
export function toPrintableHtml(html: string, opts: { lang: string; meta?: (count: number, exportedAt: string) => string }): string {
  let out = withPrintCsp(html);
  // Always light: drop `dark` from the root and keep the language of the UI.
  out = out.replace(/<html lang="[^"]*" class="[^"]*">/, `<html lang="${escapeHtml(opts.lang)}" class="">`);
  out = out.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="color-scheme" content="light">');
  // The theme toggle carries an inline onclick and has no place on paper.
  out = out.replace(/<button type="button" class="chat-export-theme-toggle"[^>]*>[^<]*<\/button>/, '');
  // A lazy image below the fold would hold the asset wait for its full limit and may miss the PDF.
  out = out.replace(/ loading="lazy"/g, ' loading="eager"');
  if (opts.meta) {
    const meta = opts.meta;
    out = out.replace(
      /<p class="chat-export-meta">(\d+) messages · exported ([^<]*)<\/p>/,
      (_m, count: string, exportedAt: string) => `<p class="chat-export-meta">${escapeHtml(meta(Number(count), exportedAt))}</p>`,
    );
  }
  const idx = out.lastIndexOf('</head>');
  if (idx !== -1) out = `${out.slice(0, idx)}<style id="kryton-pdf-print">\n${PRINT_CSS}\n</style>\n${out.slice(idx)}`;
  return out;
}

function translatedMeta(count: number, exportedAt: string): string {
  // `exportedAt` is already HTML-escaped by the builder; unescape it here, the caller escapes the whole line.
  const date = exportedAt.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  return i18n.t('chat:export.pdf.meta', { count, date });
}

/** Resolves when fonts and images of `doc` are ready, or after `ASSET_WAIT_MS`. */
export function waitForAssets(doc: Document, timeoutMs = ASSET_WAIT_MS): Promise<void> {
  const images = Array.from(doc.images ?? []).filter((img) => !img.complete);
  const imageLoads = images.map((img) => new Promise<void>((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  }));
  const fonts = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve();
  const all = Promise.all([fonts, ...imageLoads]).then(() => undefined, () => undefined);
  return Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

async function printInWindow(w: Window, printable: string): Promise<void> {
  w.document.open();
  w.document.write(printable);
  w.document.close();
  await waitForAssets(w.document);
  w.focus();
  w.print();
}

function printInFrame(printable: string, doc: Document = document): Promise<void> {
  return new Promise((resolve) => {
    const frame = doc.createElement('iframe');
    // Not display:none - a hidden frame with no box prints nothing in some engines.
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      frame.remove();
      resolve();
    };
    frame.addEventListener('load', () => {
      const win = frame.contentWindow;
      if (!win) {
        remove();
        return;
      }
      // print() from a frame returns before the dialog opens: remove only after it closes,
      // and arm the backstop only once print() has been called, so a slow save never loses its frame.
      win.addEventListener('afterprint', remove, { once: true });
      void waitForAssets(win.document).then(() => {
        win.focus();
        win.print();
        setTimeout(remove, FRAME_BACKSTOP_MS);
      });
    }, { once: true });
    frame.srcdoc = printable;
    doc.body.appendChild(frame);
  });
}

/**
 * The "PDF (print)" export. `buildHtml` is the upstream "Web page (.html)" builder for the
 * same input, so the PDF carries exactly what that export carries (the full conversation the
 * menu loaded, and on newer releases its side-question choice).
 */
export async function printTranscriptAsPdf(buildHtml: () => Promise<string>): Promise<void> {
  let printable: string;
  try {
    printable = toPrintableHtml(await buildHtml(), { lang: printLanguage(), meta: translatedMeta });
  } catch (error) {
    closePending();
    throw error;
  }
  const { w, opened } = takePending();
  if (w) {
    await printInWindow(w, printable);
    return;
  }
  // A tab was opened and the person closed it while the page was being built: that is a cancel.
  if (opened) return;
  await printInFrame(printable);
}

/** Test hook: the frame fallback on its own. */
export const __printInFrameForTest = printInFrame;
