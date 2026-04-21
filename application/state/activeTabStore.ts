import { useCallback,useSyncExternalStore } from 'react';

// Simple store for active tab that allows fine-grained subscriptions
type Listener = () => void;

/**
 * Debounce delay for the "committed" tab ID.
 * Heavyweight subscribers (TerminalLayer) use this value so rapid Ctrl+Tab
 * cycling doesn't trigger intermediate expensive re-renders.
 */
const COMMITTED_DEBOUNCE_MS = 90;

class ActiveTabStore {
  private activeTabId: string = 'vault';
  private listeners = new Set<Listener>();
  private pendingNotify = false;

  // --- Committed (debounced) tab ID ---
  // Heavy components subscribe to this to avoid re-rendering on every rapid
  // Ctrl+Tab switch. It is updated with trailing debounce only.
  private committedTabId: string = 'vault';
  private committedListeners = new Set<Listener>();
  private commitTimer: number | null = null;

  getActiveTabId = () => this.activeTabId;
  getCommittedTabId = () => this.committedTabId;

  setActiveTabId = (id: string) => {
    if (this.activeTabId !== id) {
      this.activeTabId = id;
      // Defer listener notification to avoid "setState during render" if called from a render phase
      if (!this.pendingNotify) {
        this.pendingNotify = true;
        Promise.resolve().then(() => {
          this.pendingNotify = false;
          this.listeners.forEach(listener => listener());
        });
      }
      this.scheduleCommit();
    }
  };

  private scheduleCommit() {
    if (this.commitTimer !== null) {
      window.clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      this.flushCommit();
    }, COMMITTED_DEBOUNCE_MS);
  }

  private flushCommit() {
    if (this.committedTabId === this.activeTabId) return;
    this.committedTabId = this.activeTabId;
    // Use microtask to batch with other React updates
    Promise.resolve().then(() => {
      this.committedListeners.forEach(listener => listener());
    });
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeCommitted = (listener: Listener) => {
    this.committedListeners.add(listener);
    return () => this.committedListeners.delete(listener);
  };
}

export const activeTabStore = new ActiveTabStore();

// Hook to read active tab ID - only re-renders when activeTabId changes
export const useActiveTabId = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    activeTabStore.getActiveTabId
  );
};

/**
 * Hook that returns a debounced "committed" active tab ID.
 *
 * During rapid Ctrl+Tab cycling the value stays stable (preventing expensive
 * re-renders of TerminalLayer), and updates once the user pauses or releases
 * the modifier key.  For normal (non-rapid) tab switches, it updates
 * immediately.
 */
export const useCommittedActiveTabId = () => {
  return useSyncExternalStore(
    activeTabStore.subscribeCommitted,
    activeTabStore.getCommittedTabId
  );
};

// Hook to get setter - never causes re-render
export const useSetActiveTabId = () => {
  return activeTabStore.setActiveTabId;
};

// Check if a specific tab is active - only re-renders when this specific tab's active state changes
export const useIsTabActive = (tabId: string) => {
  const getSnapshot = useCallback(() => activeTabStore.getActiveTabId() === tabId, [tabId]);
  return useSyncExternalStore(activeTabStore.subscribe, getSnapshot);
};

// Stable snapshot functions - defined once outside components
const getIsVaultActive = () => activeTabStore.getActiveTabId() === 'vault';
const getIsSftpActive = () => activeTabStore.getActiveTabId() === 'sftp';

// Check if vault is active
export const useIsVaultActive = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    getIsVaultActive
  );
};

// Check if sftp is active
export const useIsSftpActive = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    getIsSftpActive
  );
};

// Check if terminal layer should be visible
export const useIsTerminalLayerVisible = (draggingSessionId: string | null) => {
  const activeTabId = useActiveTabId();
  const isTerminalTab = activeTabId !== 'vault' && activeTabId !== 'sftp';
  return isTerminalTab || !!draggingSessionId;
};
