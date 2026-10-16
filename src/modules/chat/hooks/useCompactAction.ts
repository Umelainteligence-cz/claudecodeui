import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { beforeUserSend, noteOwnPromptSent } from '@/modules/chat/voice/autoSpeak';
import type {
  ChatMessage,
  CompactAvailability,
  CompactBlockedReason,
  MarkSessionProcessing,
  QueuedDraft,
  QueuedSendOptions,
} from '@/shared/types';

type UseCompactActionArgs = {
  /** The session the composer is bound to, or null for a chat not sent yet. */
  sessionKey: string | null;
  isLoading: boolean;
  /** False while the open session has no messages yet. */
  hasMessages: boolean;
  /** False while the websocket is disconnected. */
  isConnected: boolean;
  /** Read only, to block compacting while a sent message is being replaced. */
  editingAnchorId: string | null;
  /** Read only, to block compacting while a queued message waits. */
  queuedDraft: QueuedDraft | null;
  buildSendOptions: (currentInput: string) => QueuedSendOptions;
  sendMessage: (message: unknown) => void;
  addMessage: (msg: ChatMessage) => void;
  onSessionProcessing?: MarkSessionProcessing;
};

const COMPACT_COMMAND = '/compact';

/**
 * Sends `/compact` for the context ring on its own path, never through the
 * composer's submit, so the draft, attachments, edit state and queued message
 * are left exactly as they were. Used by `useChatComposerState`, which spreads
 * the result into its return value for the ring.
 */
export function useCompactAction({
  sessionKey,
  isLoading,
  hasMessages,
  isConnected,
  editingAnchorId,
  queuedDraft,
  buildSendOptions,
  sendMessage,
  addMessage,
  onSessionProcessing,
}: UseCompactActionArgs) {
  // The session a `/compact` was sent to, until its turn ends. Compacting is
  // derived from it plus `isLoading`, so the pulse cannot outlive the turn.
  const [compactingSessionKey, setCompactingSessionKey] = useState<string | null>(null);
  const previousIsLoadingRef = useRef(isLoading);
  // Set by `onCompact` so the next commit can tell whether the turn started.
  const awaitingStartRef = useRef(false);

  const compactAvailability = useMemo<CompactAvailability>(() => {
    let blockedReason: CompactBlockedReason | null = null;
    if (!sessionKey) blockedReason = 'noSession';
    else if (!hasMessages) blockedReason = 'noMessages';
    else if (!isConnected) blockedReason = 'offline';
    else if (isLoading) blockedReason = 'busy';
    else if (editingAnchorId) blockedReason = 'editing';
    else if (queuedDraft) blockedReason = 'queued';
    return { canCompact: blockedReason === null, blockedReason };
  }, [editingAnchorId, hasMessages, isConnected, isLoading, queuedDraft, sessionKey]);

  useEffect(() => {
    const wasLoading = previousIsLoadingRef.current;
    previousIsLoadingRef.current = isLoading;
    const awaitingStart = awaitingStartRef.current;
    awaitingStartRef.current = false;
    if (compactingSessionKey === null) return;

    const turnEnded = wasLoading && !isLoading;
    // The first commit after onCompact still idle: the send never started a
    // turn, so a later ordinary turn must not inherit the compacting state.
    const neverStarted = awaitingStart && !isLoading;
    // A session switch needs no reset: the derived comparison below is false
    // for any other session, and coming back to a compact still running shows
    // it again. Leaving a running turn for an idle session is itself the
    // true-to-false edge that clears the key.
    if (turnEnded || neverStarted || !isConnected) {
      setCompactingSessionKey(null);
    }
  }, [compactingSessionKey, isConnected, isLoading]);

  const onCompact = useCallback(() => {
    if (!compactAvailability.canCompact || !sessionKey) return;

    beforeUserSend();
    addMessage({ type: 'user', content: COMPACT_COMMAND, timestamp: new Date() });
    // Raised in the same event as the key is set, so React commits both
    // together and the never-started check sees the turn as running.
    onSessionProcessing?.(sessionKey, { statusText: null, canInterrupt: true });
    noteOwnPromptSent(sessionKey);
    awaitingStartRef.current = true;
    setCompactingSessionKey(sessionKey);
    sendMessage({
      type: 'chat.send',
      sessionId: sessionKey,
      content: COMPACT_COMMAND,
      // The empty input keeps a notification summary from reading "/compact".
      options: { ...buildSendOptions(''), attachments: [] },
    });
  }, [addMessage, buildSendOptions, compactAvailability.canCompact, onSessionProcessing, sendMessage, sessionKey]);

  return {
    onCompact,
    isCompacting: compactingSessionKey !== null && compactingSessionKey === sessionKey && isLoading,
    compactAvailability,
    // The session the composer is bound to, so the ring can close its popover
    // when the user switches sessions.
    compactSessionKey: sessionKey,
  };
}
