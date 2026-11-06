export type EditorConnectionFailure = 'editor-unavailable' | 'editor-reconnect-timeout' | 'editor-connection-disposed';

export class EditorConnectionError extends Error {
  constructor(readonly code: EditorConnectionFailure) { super(code); this.name = 'EditorConnectionError'; }
}

type ConnectionState = 'connected' | 'detached' | 'unavailable';
const REQUEST = 'opt:connection-request';
const STATUS = 'opt:connection-status';

/** Recover the host's editor integration without replacing its document/state.
 * A ready event alone is insufficient: every check has its own request ID and
 * MAIN verifies the live plugin on the currently visible editor. */
export function createEditorConnection({ signal }: { signal?: AbortSignal } = {}) {
  let disposed = false;
  let reconnecting: Promise<void> | undefined;
  let reconnectRevision = 0;
  let automaticTimer: ReturnType<typeof setTimeout> | undefined;
  let automaticPending = false;
  let lastAutomaticAttempt = -Infinity;
  const requests = new Map<string, { resolve: (state: ConnectionState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pauses = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>();

  function status(event: Event) {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string' || detail.length > 500) return;
    try {
      const value = JSON.parse(detail);
      if (!value || !['connected', 'detached', 'unavailable'].includes(value.state)) return;
      const pending = requests.get(value.requestId);
      if (!pending) return;
      requests.delete(value.requestId); clearTimeout(pending.timer); pending.resolve(value.state);
    } catch { /* Ignore other page messages. */ }
  }

  function probe(timeout: number): Promise<ConnectionState> {
    if (disposed) return Promise.reject(new EditorConnectionError('editor-connection-disposed'));
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { requests.delete(requestId); reject(new EditorConnectionError('editor-reconnect-timeout')); }, timeout);
      requests.set(requestId, { resolve, reject, timer });
      window.dispatchEvent(new CustomEvent(REQUEST, { detail: JSON.stringify({ requestId }) }));
    });
  }

  function pause(ms: number): Promise<void> {
    if (disposed) return Promise.reject(new EditorConnectionError('editor-connection-disposed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pauses.delete(timer); resolve(); }, ms);
      pauses.set(timer, reject);
    });
  }

  async function performReconnect() {
    const deadline = Date.now() + 2000;
    window.dispatchEvent(new Event('editor:extension-loaded'));
    // Host reconfiguration constructs the plugin synchronously; its initial
    // source/ready publication is a microtask. Let that publication complete.
    await Promise.resolve();
    while (!disposed && Date.now() < deadline) {
      let state: ConnectionState | undefined;
      try { state = await probe(Math.min(250, deadline - Date.now())); }
      catch (error) {
        if (disposed) throw error;
      }
      if (disposed) throw new EditorConnectionError('editor-connection-disposed');
      if (state === 'connected') return;
      if (state === 'unavailable') throw new EditorConnectionError('editor-unavailable');
      const remaining = deadline - Date.now();
      if (remaining > 0) await pause(Math.min(100, remaining));
    }
    throw new EditorConnectionError(disposed ? 'editor-connection-disposed' : 'editor-reconnect-timeout');
  }

  function reconnect(): Promise<void> {
    if (disposed) return Promise.reject(new EditorConnectionError('editor-connection-disposed'));
    if (reconnecting) return reconnecting;
    reconnectRevision++;
    const pending = performReconnect();
    reconnecting = pending;
    void pending.finally(() => { if (reconnecting === pending) reconnecting = undefined; }).catch(() => {});
    return pending;
  }

  async function checkAutomatically() {
    automaticTimer = undefined;
    if (disposed || automaticPending || reconnecting || document.visibilityState === 'hidden'
      || !document.querySelector('.cm-editor') || Date.now() - lastAutomaticAttempt < 2000) return;
    automaticPending = true;
    lastAutomaticAttempt = Date.now();
    const revision = reconnectRevision;
    try {
      const state = await probe(250);
      if (state === 'detached' && !disposed && revision === reconnectRevision) await reconnect();
    } catch { /* Manual reconnect exposes the result; automatic recovery stays quiet. */ }
    finally { automaticPending = false; }
  }

  function scheduleCheck() {
    if (disposed || automaticTimer !== undefined) return;
    automaticTimer = setTimeout(() => { void checkAutomatically(); }, Math.max(40, 2000 - (Date.now() - lastAutomaticAttempt)));
  }
  const focus = (event: Event) => { if (event.target instanceof Element && event.target.closest('.cm-editor')) scheduleCheck(); };
  const visible = () => { if (document.visibilityState === 'visible') scheduleCheck(); };
  const observer = new MutationObserver(records => {
    const changedEditor = (node: Node) => node instanceof Element && (node.matches('.cm-editor') || !!node.querySelector('.cm-editor'));
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(changedEditor))) scheduleCheck();
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(automaticTimer); observer.disconnect();
    window.removeEventListener(STATUS, status);
    document.removeEventListener('focusin', focus);
    document.removeEventListener('pointerdown', focus);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pageshow', scheduleCheck);
    signal?.removeEventListener('abort', dispose);
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new EditorConnectionError('editor-connection-disposed')); }
    requests.clear();
    for (const [timer, reject] of pauses) { clearTimeout(timer); reject(new EditorConnectionError('editor-connection-disposed')); }
    pauses.clear();
  }

  window.addEventListener(STATUS, status);
  document.addEventListener('focusin', focus);
  // Clicking another formula need not change focus if this editor already has
  // it. A coalesced health probe still covers that common recovery gesture.
  document.addEventListener('pointerdown', focus);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pageshow', scheduleCheck);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return { reconnect, dispose };
}
