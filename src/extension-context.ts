import { isExtensionContextInvalidated } from './runtime-connection';

export type ExtensionRetirementReason = 'extension-updated' | 'pagehide' | 'manual';

export interface ExtensionContext {
  alive(): boolean;
  assetURL(path: string): string | undefined;
  readonly signal: AbortSignal;
  readonly reason?: ExtensionRetirementReason;
  invalidate(reason?: ExtensionRetirementReason): void;
}

/** An old content script must retire after its extension has been reloaded.
 * Checks are made at work boundaries; there is no polling or worker heartbeat.
 */
export function createExtensionContext(): ExtensionContext {
  const controller = new AbortController();
  let reason: ExtensionRetirementReason | undefined;
  const invalidate = (nextReason: ExtensionRetirementReason = 'manual') => {
    if (controller.signal.aborted) return;
    reason = nextReason; controller.abort(nextReason);
  };
  const alive = () => {
    if (controller.signal.aborted) return false;
    try {
      if (typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string' && chrome.runtime.id) return true;
    } catch { /* Reloaded runtimes may throw when their properties are read. */ }
    invalidate('extension-updated');
    return false;
  };
  return {
    signal: controller.signal,
    get reason() { return reason; },
    alive,
    invalidate,
    assetURL(path) {
      if (!alive()) return undefined;
      try { return chrome.runtime.getURL(path); }
      catch (error) {
        // A missing resource or temporary API failure is not evidence that the
        // content script was retired. Only identity loss/invalidation is final.
        if (isExtensionContextInvalidated(error)) invalidate('extension-updated');
        else alive();
        return undefined;
      }
    },
  };
}
