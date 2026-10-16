import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import csVoice from '@/modules/chat/voice/locales/cs/voice.json';
import enVoice from '@/modules/chat/voice/locales/en/voice.json';
import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import { voiceI18n } from '@/modules/chat/voice/voiceI18n';
import { resetVoiceHealth } from '@/modules/chat/voice/voiceState';
import { resetVoiceUiStore } from '@/modules/chat/voice/voiceUiStore';
import { Composer } from '@/modules/chat/voice/tests/composerFixture';
import { fakeResponse, installAudioFakes, installRecorderFakes, setUiPreferences } from '@/modules/chat/voice/tests/kit';
import { useVoiceRecordingNotice } from '@/modules/chat/voice/VoiceNotice';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type * as SharedApi from '@/shared/api';

/**
 * Voice overlay, hv2 (Q519 = A1): hv1 switches voice on by itself where the
 * platform delivered it, so the first press of the microphone must say where the
 * recording goes before anything is recorded. Once per person: the answer is a UI
 * preference (the whole blob is stored on the server, like `voiceChosen`), so it
 * follows the person to another browser. Cancel records nothing and asks again
 * on the next press. Someone who used the microphone before this existed has no
 * answer stored and is asked once as well.
 */

const MESSAGE_CS = 'Nahrávka se pošle k přepisu službě ElevenLabs; text se vloží do zprávy. Pokračovat?';
const MESSAGE_EN = 'The recording is sent to ElevenLabs for transcription; the text is inserted into your message. Continue?';

const h = vi.hoisted(() => ({
  health: vi.fn(),
  transcribe: vi.fn(),
  server: { preferences: {} as Record<string, unknown> },
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      voice: { ...actual.api.voice, health: () => h.health() },
      user: {
        ...actual.api.user,
        preferences: async () => fakeResponse(200, { preferences: h.server.preferences }),
        savePreferences: async (updates: Record<string, unknown>) => {
          h.saved.push(updates);
          return fakeResponse(200, {});
        },
      },
    },
    transcribeVoice: (blob: Blob, filename: string) => h.transcribe(blob, filename),
  };
});

let rec: ReturnType<typeof installRecorderFakes>;

const micButton = () => screen.findByRole('button', { name: 'Voice input' });
const notice = () => screen.queryByRole('dialog');
const lastSavedBlob = () => h.saved.map((u) => u.uiPreferences).filter(Boolean).pop() as Record<string, unknown> | undefined;

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  resetVoiceHealth();
  resetVoiceUiStore();
  installAudioFakes();
  voicePlayer.stop();
  rec = installRecorderFakes();
  h.health.mockReset();
  h.health.mockImplementation(async () => fakeResponse(200, { configured: true }));
  h.transcribe.mockReset();
  h.transcribe.mockImplementation(async () => fakeResponse(200, { text: 'ahoj' }));
  h.server.preferences = {};
  h.saved = [];
  await voiceI18n.changeLanguage('en');
});

afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  await voiceI18n.changeLanguage('en');
});

describe('platform mode: the first press of the microphone asks first (hv2)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_IS_PLATFORM', 'true');
  });

  test('used the microphone before this change (voice chosen, no answer stored): asked once, nothing recorded yet', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await micButton());

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(MESSAGE_EN);
    expect(rec.getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();
  });

  test('Continue: the answer is stored (whole blob, to the server) and recording starts from that press', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await micButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(rec.getUserMedia).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Stop recording' });
    expect(notice()).toBeNull();
    expect(readStoredUiPreferences().voiceNoticeAccepted).toBe(true);
    await waitFor(() => expect(lastSavedBlob()).toMatchObject({ voiceEnabled: true, voiceChosen: true, voiceNoticeAccepted: true }));
  });

  test('after Continue it is never asked again, also after a reload from the server copy', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    const first = render(<Composer />);
    fireEvent.click(await micButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    await waitFor(() => expect(h.transcribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastSavedBlob()).toBeDefined());

    // The same page, the next press: straight to recording.
    await screen.findByRole('button', { name: 'Voice input' });
    fireEvent.click(await micButton());
    await waitFor(() => expect(rec.getUserMedia).toHaveBeenCalledTimes(2));
    expect(notice()).toBeNull();
    first.unmount();

    // A reload in another browser: nothing local, the server holds what this page saved.
    h.server.preferences = { uiPreferences: lastSavedBlob() };
    localStorage.clear();
    resetUserPreferences();
    resetVoiceHealth();
    await hydrateUserPreferences();
    render(<Composer />);
    fireEvent.click(await micButton());
    await waitFor(() => expect(rec.getUserMedia).toHaveBeenCalledTimes(3));
    expect(notice()).toBeNull();
  });

  test('Cancel: nothing is recorded or stored, and the next press asks again', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await micButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(notice()).toBeNull());
    expect(rec.getUserMedia).not.toHaveBeenCalled();
    expect(readStoredUiPreferences().voiceNoticeAccepted).toBe(false);
    expect(h.saved.filter((u) => 'uiPreferences' in u)).toEqual([]);

    fireEvent.click(await micButton());
    expect(await screen.findByRole('dialog')).not.toBeNull();
    expect(rec.getUserMedia).not.toHaveBeenCalled();
  });

  test('Escape closes it like Cancel', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await micButton());
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(notice()).toBeNull());
    expect(rec.getUserMedia).not.toHaveBeenCalled();
    expect(readStoredUiPreferences().voiceNoticeAccepted).toBe(false);
  });

  test('voice switched on by the platform default (hv1), never chosen: asked as well, and Continue is not a voice choice', async () => {
    render(<Composer />);
    await act(async () => {
      await hydrateUserPreferences();
    });
    fireEvent.click(await micButton());

    expect((await screen.findByRole('dialog')).textContent).toContain(MESSAGE_EN);
    expect(rec.getUserMedia).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(rec.getUserMedia).toHaveBeenCalledTimes(1));
    // Still the platform's default: hv1 can take it back when the admin withdraws voice.
    expect(readStoredUiPreferences()).toMatchObject({ voiceEnabled: true, voiceChosen: false, voiceNoticeAccepted: true });
  });

  test('Escape while Claude is working closes the question and does not stop Claude', async () => {
    // The chat's own handler (ChatInterface): Escape reaching `document` in capture aborts the turn.
    const abort = vi.fn();
    const chatEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) abort();
    };
    document.addEventListener('keydown', chatEscape, { capture: true });
    try {
      await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
      render(<Composer isLoading />);
      fireEvent.click(await micButton());
      await screen.findByRole('dialog');
      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => expect(notice()).toBeNull());
      expect(abort).not.toHaveBeenCalled();
      expect(rec.getUserMedia).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', chatEscape, { capture: true });
    }
  });

  test('a click outside closes it like Cancel', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await micButton());
    await screen.findByRole('dialog');
    const overlay = document.body.querySelector('.animate-dialog-overlay-show');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);

    await waitFor(() => expect(notice()).toBeNull());
    expect(rec.getUserMedia).not.toHaveBeenCalled();
    expect(readStoredUiPreferences().voiceNoticeAccepted).toBe(false);
  });

  test('Cancel is focused when it opens, so Enter never records by accident', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await micButton());
    await screen.findByRole('dialog');

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })));
  });

  test('when the microphone goes away while it is open (a question panel takes the composer), it closes for good', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    const view = render(<Composer />);
    fireEvent.click(await micButton());
    await screen.findByRole('dialog');

    const question = { requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [] } };
    view.rerender(<Composer pendingPermissionRequests={[question] as never} />);
    await waitFor(() => expect(notice()).toBeNull());
    view.rerender(<Composer />);
    await micButton();
    expect(notice()).toBeNull();
    expect(rec.getUserMedia).not.toHaveBeenCalled();
  });

  test('a press that STOPS a recording never asks, even with no answer stored', () => {
    const toggle = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <UiPreferencesProvider>{children}</UiPreferencesProvider>;
    const { result } = renderHook(() => useVoiceRecordingNotice('recording', toggle, true), { wrapper });
    act(() => result.current.onToggle());

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(result.current.noticeOpen).toBe(false);
  });

  test('already answered: the press records straight away', async () => {
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true, voiceNoticeAccepted: true });
    render(<Composer />);
    fireEvent.click(await micButton());

    await waitFor(() => expect(rec.getUserMedia).toHaveBeenCalledTimes(1));
    expect(notice()).toBeNull();
  });

  test('Czech: the approved sentence and the two buttons', async () => {
    await voiceI18n.changeLanguage('cs');
    await setUiPreferences({ voiceEnabled: true, voiceChosen: true });
    render(<Composer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hlasový vstup' }));
    await waitFor(() => expect(notice()).not.toBeNull());

    expect(notice()?.textContent).toContain(MESSAGE_CS);
    expect(screen.getByRole('button', { name: 'Pokračovat' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Zrušit' })).not.toBeNull();
  });
});

describe('outside platform mode nothing changes (R16)', () => {
  test('no question: the press records straight away and nothing new is stored', async () => {
    vi.stubEnv('VITE_IS_PLATFORM', 'false');
    await setUiPreferences({ voiceEnabled: true });
    render(<Composer />);
    fireEvent.click(await micButton());

    await waitFor(() => expect(rec.getUserMedia).toHaveBeenCalledTimes(1));
    expect(notice()).toBeNull();
    expect(readStoredUiPreferences().voiceNoticeAccepted).toBe(false);
  });
});

describe('texts', () => {
  test('the approved Czech wording and its English translation, the same keys in both', () => {
    expect(csVoice.notice.message).toBe(MESSAGE_CS);
    expect(enVoice.notice.message).toBe(MESSAGE_EN);
    expect(csVoice.notice.continue).toBe('Pokračovat');
    expect(csVoice.notice.cancel).toBe('Zrušit');
    expect(Object.keys(csVoice.notice).sort()).toEqual(Object.keys(enVoice.notice).sort());
  });
});
