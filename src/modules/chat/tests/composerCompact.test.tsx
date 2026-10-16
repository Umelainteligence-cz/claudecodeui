import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetAuthoredPrompts } from '@/modules/chat/voice/authoredPrompts';
import { installAudioFakes } from '@/modules/chat/voice/tests/kit';
import { readDraftText, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * The context ring's compact action sends `/compact` on its own path. These
 * tests drive the real composer hook, because the regression they guard is the
 * draft: a compact must never clear, queue or edit what the user was typing.
 */

// The composer only reaches the network through these; stubbing them keeps the
// tests about the send path rather than fetch behaviour in jsdom.
vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      voice: { health: () => okJson({ configured: true }) },
    },
    authenticatedFetch: () => okJson({}),
    synthesizeVoice: () => okJson({}),
    transcribeVoice: () => okJson({ text: '' }),
    voiceConfigSignature: () => '',
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

type ComposerProps = {
  session: ProjectSession | null;
  hasMessages?: boolean;
  isConnected?: boolean;
  tokenBudget?: Record<string, unknown> | null;
};

type RenderOptions = {
  isLoading?: boolean;
  /**
   * Whether `onSessionProcessing` raises `isLoading`, as ChatInterface's
   * processing map does. Off models a send that never started a turn.
   */
  raisesProcessing?: boolean;
};

/**
 * Renders the composer with `isLoading` held in state, so `onSessionProcessing`
 * raises it in the same event as `onCompact` sets its key — the batching the
 * real app relies on.
 */
function renderComposer(initial: ComposerProps, options: RenderOptions = {}) {
  const sendMessage = vi.fn();
  const addMessage = vi.fn<(message: ChatMessage) => void>();
  const onSessionProcessing = vi.fn();
  const raisesProcessing = options.raisesProcessing ?? true;
  const view = renderHook(
    ({ session, hasMessages, isConnected, tokenBudget }: ComposerProps) => {
      const [isLoading, setIsLoading] = useState(options.isLoading ?? false);
      const composer = useChatComposerState({
        selectedProject: PROJECT,
        selectedSession: session,
        currentSessionId: session?.id ?? null,
        provider: 'claude',
        permissionMode: 'default',
        cyclePermissionMode: () => undefined,
        resolvePermissionModeForProvider: () => 'default' as PermissionMode,
        currentProviderModel: 'test-model',
        currentProviderEffort: 'medium',
        isLoading,
        canAbortSession: false,
        tokenBudget: tokenBudget ?? null,
        sendMessage,
        onSessionProcessing: (...args) => {
          onSessionProcessing(...args);
          if (raisesProcessing) setIsLoading(true);
        },
        scrollToBottom: () => undefined,
        addMessage,
        setIsUserScrolledUp: () => undefined,
        setPendingPermissionRequests: () => undefined,
        ...(hasMessages === undefined ? {} : { hasMessages }),
        ...(isConnected === undefined ? {} : { isConnected }),
      });
      return { ...composer, isLoading, setIsLoading };
    },
    { initialProps: initial },
  );
  return { view, sendMessage, addMessage, onSessionProcessing };
}

const compactSends = (sendMessage: ReturnType<typeof vi.fn>) => sendMessage.mock.calls
  .map(([message]) => message as { content?: string })
  .filter((message) => message.content === '/compact');

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetAuthoredPrompts();
  installAudioFakes();
});

describe('the compact send path', () => {
  test('sends exactly /compact and leaves the draft, attachments and stored draft untouched', async () => {
    const { view, sendMessage, addMessage, onSessionProcessing } = renderComposer({ session: { id: 'session-a' } });
    const file = new File(['obsah'], 'poznamka.txt', { type: 'text/plain' });
    await act(async () => view.result.current.setInput('rozepsaný text'));
    await act(async () => view.result.current.setAttachedFiles([file]));

    await act(async () => view.result.current.onCompact());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][0] as { type: string; sessionId: string; content: string; options: Record<string, unknown> };
    expect(sent.type).toBe('chat.send');
    expect(sent.sessionId).toBe('session-a');
    expect(sent.content).toBe('/compact');
    expect(sent.options.attachments).toEqual([]);
    expect(sent.options.model).toBe('test-model');

    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'user', content: '/compact' }));
    expect(onSessionProcessing).toHaveBeenCalledWith('session-a', { statusText: null, canInterrupt: true });

    expect(view.result.current.input).toBe('rozepsaný text');
    expect(view.result.current.attachedFiles).toEqual([file]);
    expect(readDraftText('session-a')).toBe('rozepsaný text');
    expect(view.result.current.queuedDraft).toBeNull();
    expect(view.result.current.editingAnchorId).toBeNull();
  });

  test('the notification summary never reads "/compact" for a session without a summary', async () => {
    const { view, sendMessage } = renderComposer({ session: { id: 'session-a' } });
    await act(async () => view.result.current.onCompact());
    const sent = sendMessage.mock.calls[0][0] as { options: Record<string, unknown> };
    expect(sent.options.sessionSummary).not.toBe('/compact');
  });

  test('sends nothing while a turn is running', async () => {
    const { view, sendMessage } = renderComposer({ session: { id: 'session-a' } }, { isLoading: true });
    expect(view.result.current.compactAvailability).toEqual({ canCompact: false, blockedReason: 'busy' });
    await act(async () => view.result.current.onCompact());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('sends nothing without a session and reports noSession', async () => {
    const { view, sendMessage } = renderComposer({ session: null });
    expect(view.result.current.compactAvailability).toEqual({ canCompact: false, blockedReason: 'noSession' });
    await act(async () => view.result.current.onCompact());
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('the token breakdown action', () => {
  test('keeps one identity while the user types', async () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    const first = view.result.current.showCostModal;
    await act(async () => view.result.current.setInput('a'));
    await act(async () => view.result.current.setInput('ab'));
    expect(view.result.current.input).toBe('ab');
    expect(view.result.current.showCostModal).toBe(first);
  });
});

describe('compact availability', () => {
  test('a session with no messages reports noMessages', () => {
    const { view } = renderComposer({ session: { id: 'session-a' }, hasMessages: false });
    expect(view.result.current.compactAvailability).toEqual({ canCompact: false, blockedReason: 'noMessages' });
  });

  test('a disconnected websocket reports offline and sends nothing', async () => {
    const { view, sendMessage } = renderComposer({ session: { id: 'session-a' }, isConnected: false });
    expect(view.result.current.compactAvailability).toEqual({ canCompact: false, blockedReason: 'offline' });
    await act(async () => view.result.current.onCompact());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('a queued message reports queued and sends nothing', async () => {
    writeQueuedMessage('session-a', { content: 'čeká ve frontě', options: {}, attachments: [] });
    const { view, sendMessage } = renderComposer({ session: { id: 'session-a' } });
    expect(view.result.current.queuedDraft?.content).toBe('čeká ve frontě');
    expect(view.result.current.compactAvailability).toEqual({ canCompact: false, blockedReason: 'queued' });
    await act(async () => view.result.current.onCompact());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('editing a sent message reports editing, and the edit survives', async () => {
    const { view, sendMessage } = renderComposer({ session: { id: 'session-a' } });
    await act(async () => view.result.current.beginEditMessage({
      type: 'user',
      content: 'původní zpráva',
      timestamp: Date.now(),
      transcriptAnchorId: 'anchor-1',
    }));
    expect(view.result.current.compactAvailability).toEqual({ canCompact: false, blockedReason: 'editing' });
    await act(async () => view.result.current.onCompact());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(view.result.current.editingAnchorId).toBe('anchor-1');
    expect(view.result.current.input).toBe('původní zpráva');
  });

  test('blocked reasons follow the documented precedence', () => {
    const { view } = renderComposer({ session: { id: 'session-a' }, hasMessages: false, isConnected: false });
    expect(view.result.current.compactAvailability.blockedReason).toBe('noMessages');
  });

  test('omitting hasMessages and isConnected leaves an idle session compactable', () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    expect(view.result.current.compactAvailability).toEqual({ canCompact: true, blockedReason: null });
  });

  test('exposes the session key the composer is bound to', async () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    expect(view.result.current.compactSessionKey).toBe('session-a');
    await act(async () => view.rerender({ session: { id: 'session-b' } }));
    expect(view.result.current.compactSessionKey).toBe('session-b');
  });
});

describe('the compacting state', () => {
  test('is on from confirm while the turn runs and off when it ends', async () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    expect(view.result.current.isCompacting).toBe(false);
    await act(async () => view.result.current.onCompact());
    expect(view.result.current.isLoading).toBe(true);
    expect(view.result.current.isCompacting).toBe(true);
    await act(async () => view.result.current.setIsLoading(false));
    expect(view.result.current.isCompacting).toBe(false);
  });

  test('ends when the turn ends even if the budget went null meanwhile', async () => {
    // Lane A may send a null budget after a manual compact, until the next reading.
    const budget = { used: 150_000, total: 200_000 };
    const { view } = renderComposer({ session: { id: 'session-a' }, tokenBudget: budget });
    await act(async () => view.result.current.onCompact());
    expect(view.result.current.isCompacting).toBe(true);
    await act(async () => view.rerender({ session: { id: 'session-a' }, tokenBudget: null }));
    expect(view.result.current.isCompacting).toBe(true);
    await act(async () => view.result.current.setIsLoading(false));
    expect(view.result.current.isCompacting).toBe(false);
    await act(async () => view.result.current.setIsLoading(true));
    expect(view.result.current.isCompacting).toBe(false);
  });

  test('clears when the websocket disconnects', async () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    await act(async () => view.result.current.onCompact());
    expect(view.result.current.isCompacting).toBe(true);
    await act(async () => view.rerender({ session: { id: 'session-a' }, isConnected: false }));
    expect(view.result.current.isCompacting).toBe(false);
    await act(async () => view.rerender({ session: { id: 'session-a' }, isConnected: true }));
    expect(view.result.current.isCompacting).toBe(false);
  });

  test('clears on a session change and does not revive on switching back', async () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    await act(async () => view.result.current.onCompact());
    expect(view.result.current.isCompacting).toBe(true);

    await act(async () => view.rerender({ session: { id: 'session-b' } }));
    expect(view.result.current.isCompacting).toBe(false);

    await act(async () => view.result.current.setIsLoading(false));
    await act(async () => view.rerender({ session: { id: 'session-a' } }));
    expect(view.result.current.isCompacting).toBe(false);
    // A later ordinary turn in the compacted session must not inherit the pulse.
    await act(async () => view.result.current.setIsLoading(true));
    expect(view.result.current.isCompacting).toBe(false);
  });

  test('coming back to a compact still running shows it again', async () => {
    const { view } = renderComposer({ session: { id: 'session-a' } });
    await act(async () => view.result.current.onCompact());
    // session-b is busy too, so isLoading stays true across both switches.
    await act(async () => view.rerender({ session: { id: 'session-b' } }));
    expect(view.result.current.isCompacting).toBe(false);
    await act(async () => view.rerender({ session: { id: 'session-a' } }));
    expect(view.result.current.isCompacting).toBe(true);
  });

  test('a send whose turn never starts never reports compacting, nor does a later ordinary turn', async () => {
    const { view, sendMessage } = renderComposer({ session: { id: 'session-a' } }, { raisesProcessing: false });
    await act(async () => view.result.current.onCompact());
    expect(compactSends(sendMessage)).toHaveLength(1);
    expect(view.result.current.isCompacting).toBe(false);
    await act(async () => view.result.current.setIsLoading(true));
    expect(view.result.current.isCompacting).toBe(false);
  });

  test('a protocol_error-driven idle clears it', async () => {
    // onSessionIdle (protocol_error, e.g. RUN_IN_PROGRESS) lowers isLoading:
    // the same true-to-false edge as a normal turn end.
    const { view } = renderComposer({ session: { id: 'session-a' } });
    await act(async () => view.result.current.onCompact());
    expect(view.result.current.isCompacting).toBe(true);
    await act(async () => view.result.current.setIsLoading(false));
    expect(view.result.current.isCompacting).toBe(false);
    expect(view.result.current.compactAvailability.canCompact).toBe(true);
  });
});
