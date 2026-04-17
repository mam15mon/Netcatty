import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export type ComposerSendTarget = "current-tab" | "current-split" | "all-sessions";

export type ComposerActiveContext = {
  sessionId?: string;
  workspaceId?: string;
  focusedSessionId?: string;
  sessionIds: string[];
  targetNames: string[];
  isBroadcast?: boolean;
};

export const useComposerBackend = () => {
  const toggleComposer = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.toggleComposer?.() ?? false;
  }, []);

  const queryActiveSessionContext = useCallback(async (): Promise<ComposerActiveContext | null> => {
    const bridge = netcattyBridge.get();
    return (await bridge?.queryActiveSessionContext?.()) ?? null;
  }, []);

  const sendComposerData = useCallback((data: { text: string; sendTarget: ComposerSendTarget }) => {
    const bridge = netcattyBridge.get();
    bridge?.sendComposerData?.(data);
  }, []);

  const saveActiveSessionContext = useCallback((context: ComposerActiveContext | null) => {
    const bridge = netcattyBridge.get();
    bridge?.saveActiveSessionContext?.(context);
  }, []);

  return {
    toggleComposer,
    queryActiveSessionContext,
    sendComposerData,
    saveActiveSessionContext,
  };
};
