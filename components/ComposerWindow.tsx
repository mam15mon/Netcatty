import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useStoredSyncedString } from '../application/state/useStoredSyncedString';
import { useComposerBackend } from '../application/state/useComposerBackend';
import {
  STORAGE_KEY_TERM_COMPOSE_BAR_DRAFT,
  STORAGE_KEY_TERM_COMPOSE_BAR_SEND_TARGET,
} from '../infrastructure/config/storageKeys';
import { useSettingsState } from '../application/state/useSettingsState';
import { TerminalComposeBar } from './terminal/TerminalComposeBar';

type ComposeSendTarget = 'current-tab' | 'current-split' | 'all-sessions';

type ComposerActiveContext = {
  sessionId?: string;
  workspaceId?: string;
  focusedSessionId?: string;
  sessionIds: string[];
  targetNames: string[];
  isBroadcast?: boolean;
};

export const ComposerWindow: React.FC = () => {
  const { t } = useI18n();
  const { currentTerminalTheme } = useSettingsState();
  const { queryActiveSessionContext, sendComposerData, toggleComposer } = useComposerBackend();

  const [draft, setDraft] = useStoredSyncedString(STORAGE_KEY_TERM_COMPOSE_BAR_DRAFT, '');
  const [sendTarget, setSendTarget] = useStoredSyncedString<ComposeSendTarget>(
    STORAGE_KEY_TERM_COMPOSE_BAR_SEND_TARGET,
    'current-split',
    (value): value is ComposeSendTarget =>
      value === 'current-tab' || value === 'current-split' || value === 'all-sessions',
  );
  const [activeContext, setActiveContext] = useState<ComposerActiveContext | null>(null);

  const refreshContext = useCallback(async () => {
    const context = await queryActiveSessionContext();
    setActiveContext(context ?? null);
  }, [queryActiveSessionContext]);

  useEffect(() => {
    void refreshContext();
    window.addEventListener('focus', refreshContext);
    return () => window.removeEventListener('focus', refreshContext);
  }, [refreshContext]);

  const handleSend = useCallback((text: string) => {
    if (!text.trim()) return;
    sendComposerData({ text, sendTarget });
    setDraft('');
  }, [sendComposerData, sendTarget, setDraft]);

  const handleClose = useCallback(() => {
    void toggleComposer();
  }, [toggleComposer]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const sendTargetLabel = useMemo(() => {
    if (sendTarget === 'all-sessions') {
      return t('terminal.composeBar.sendTarget.allSessions');
    }
    if (!activeContext || activeContext.targetNames.length === 0) {
      return '---';
    }
    if (sendTarget === 'current-tab') {
      return activeContext.targetNames.join(', ');
    }
    return activeContext.targetNames[0] || '---';
  }, [activeContext, sendTarget, t]);

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-background p-4 justify-center">
      <div className="w-full max-w-4xl mx-auto">
        <div className="mb-2 px-1 text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          {t('terminal.composeBar.sendTarget')}:
          <span className="text-foreground font-semibold">{sendTargetLabel}</span>
        </div>
        <TerminalComposeBar
          value={draft}
          onValueChange={setDraft}
          sendTarget={sendTarget}
          onSendTargetChange={setSendTarget}
          onSend={handleSend}
          onClose={handleClose}
          showBroadcastToggle={false}
          isBroadcastEnabled={false}
          themeColors={currentTerminalTheme.colors}
        />
      </div>
    </div>
  );
};

export default ComposerWindow;
