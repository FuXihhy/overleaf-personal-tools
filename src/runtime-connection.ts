export type RuntimeFailureKind = 'context-invalidated' | 'disconnected' | 'timeout' | 'closed' | 'unavailable';

export class RuntimeConnectionError extends Error {
  constructor(readonly kind: RuntimeFailureKind, message: string) { super(message); this.name = 'RuntimeConnectionError'; }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return '';
}

export function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof RuntimeConnectionError && error.kind === 'context-invalidated'
    || /extension context (?:has been )?invalidated/i.test(messageOf(error));
}

/** A sleeping MV3 worker is available on demand. Only a retired content script
 * needs a page refresh; an interrupted port can reconnect to the same worker. */
export function runtimeConnectionError(error: unknown, fallback: RuntimeFailureKind = 'unavailable'): RuntimeConnectionError {
  if (error instanceof RuntimeConnectionError) return error;
  const message = messageOf(error);
  if (isExtensionContextInvalidated(error)) return new RuntimeConnectionError('context-invalidated',
    'This Overleaf tab is using an older extension version. Refresh the Overleaf page to reconnect.');
  if (/native.*(?:not found|not installed)|specified native messaging host|forbidden|not allowed|access.*denied/i.test(message)) {
    return new RuntimeConnectionError('unavailable', message);
  }
  if (/Codex request timed out|本机 TeX 服务响应超时/i.test(message)) return new RuntimeConnectionError('timeout', message);
  if (/receiving end does not exist|could not establish connection|(?:message (?:port|channel)|connection).*(?:closed|disconnect)|disconnect(?:ed)? (?:port|native)|port.*disconnect|native (?:host|messaging host).*(?:exited|closed|disconnect)|local Codex helper disconnected/i.test(message)) {
    return new RuntimeConnectionError('disconnected', message);
  }
  return new RuntimeConnectionError(fallback, message || 'The extension connection was interrupted. Try again.');
}

/** Retry only operations whose caller guarantees they are read-only. Mutating
 * requests must never use this helper: a lost reply does not imply no effect. */
export async function retryRuntimeRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const delays = [150, 500];
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new RuntimeConnectionError('closed', 'The connection was closed.');
    try { return await read(); }
    catch (raw) {
      const error = runtimeConnectionError(raw);
      if (!['disconnected', 'timeout'].includes(error.kind) || attempt >= delays.length || signal?.aborted) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new RuntimeConnectionError('closed', 'The connection was closed.')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delays[attempt]);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
