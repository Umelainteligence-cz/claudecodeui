// Kryton PDF overlay (E474): the export menu's fourth item.
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { ChatMessage } from '@/shared/types';

const printMock = vi.hoisted(() => ({
  openPdfPrintWindow: vi.fn(),
  closePdfPrintWindow: vi.fn(),
  printTranscriptAsPdf: vi.fn(async () => {}),
}));
vi.mock('@/modules/chat/export/printTranscript', () => printMock);

import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';

const MESSAGES = [{ type: 'user', content: 'Ahoj', timestamp: new Date('2026-11-25T10:00:00Z') }] as unknown as ChatMessage[];

function renderMenu(onLoadFullTranscript?: () => Promise<ChatMessage[]>) {
  return render(
    <ChatExportMenu
      messages={MESSAGES}
      sessionTitle="Konverzace"
      provider="claude"
      selectedProject={null}
      createDiff={() => []}
      onLoadFullTranscript={onLoadFullTranscript}
    />,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:export.trigger') }));
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  printMock.openPdfPrintWindow.mockClear();
  printMock.closePdfPrintWindow.mockClear();
  printMock.printTranscriptAsPdf.mockClear();
});

describe('ChatExportMenu with the PDF overlay', () => {
  it('lists PDF (print) right after Web page (.html)', () => {
    renderMenu();
    openMenu();
    const labels = ['Web page (.html)', 'PDF (print)', 'Markdown (.md)', 'JSON (.json)'];
    const positions = labels.map((label) => {
      const el = screen.getByText(label);
      return Array.from(document.body.querySelectorAll('*')).indexOf(el);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(screen.getByText("Saves the conversation as a PDF through the browser's print dialog")).toBeTruthy();
  });

  it('opens the print tab inside the click, before the full transcript has loaded', async () => {
    let release: (messages: ChatMessage[]) => void = () => {};
    const onLoadFullTranscript = vi.fn(() => new Promise<ChatMessage[]>((resolve) => { release = resolve; }));
    renderMenu(onLoadFullTranscript);
    openMenu();
    fireEvent.click(screen.getByText('PDF (print)'));
    // Synchronous with the click: the transcript is still loading.
    expect(printMock.openPdfPrintWindow).toHaveBeenCalledTimes(1);
    expect(printMock.printTranscriptAsPdf).not.toHaveBeenCalled();
    release(MESSAGES);
    await vi.waitFor(() => expect(printMock.printTranscriptAsPdf).toHaveBeenCalledTimes(1));
  });

  it('prints the FULL transcript the menu loaded, through the .html builder', async () => {
    const full = [
      { type: 'user', content: 'Celý přepis A', timestamp: new Date('2026-11-25T09:00:00Z') },
      { type: 'assistant', content: 'Celý přepis B', timestamp: new Date('2026-11-25T09:00:01Z') },
    ] as unknown as ChatMessage[];
    renderMenu(() => Promise.resolve(full));
    openMenu();
    fireEvent.click(screen.getByText('PDF (print)'));
    await vi.waitFor(() => expect(printMock.printTranscriptAsPdf).toHaveBeenCalledTimes(1));
    const calls = printMock.printTranscriptAsPdf.mock.calls as unknown as Array<[() => Promise<string>]>;
    const html = await calls[0][0]();
    expect(html).toContain('Celý přepis A');
    expect(html).toContain('Celý přepis B');
    expect(html).toContain('2 messages · exported');
    expect(html).not.toContain('Ahoj');
  });

  it('closes the print tab when loading the transcript fails', async () => {
    const onLoadFullTranscript = vi.fn(() => Promise.reject(new Error('offline')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderMenu(onLoadFullTranscript);
    openMenu();
    fireEvent.click(screen.getByText('PDF (print)'));
    await vi.waitFor(() => expect(printMock.closePdfPrintWindow).toHaveBeenCalledTimes(1));
    expect(printMock.printTranscriptAsPdf).not.toHaveBeenCalled();
  });

  it('does not open a tab for the file exports', () => {
    renderMenu(() => new Promise(() => {}));
    openMenu();
    fireEvent.click(screen.getByText('Markdown (.md)'));
    expect(printMock.openPdfPrintWindow).not.toHaveBeenCalled();
  });
});
