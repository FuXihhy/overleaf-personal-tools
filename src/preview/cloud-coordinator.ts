import type { CloudProjectBinding } from '../overleaf/cloud-client';

export interface SharedCloudFile {
  path: string;
  id: string;
  type: 'doc' | 'file';
  digest: string;
}
export interface SharedCloudWorkspace {
  sourceProjectId: string;
  files: SharedCloudFile[];
  compiler?: 'pdflatex' | 'xelatex' | 'lualatex';
  texLiveVersion?: string;
  /** A failed synchronization must never be treated as a matching cache. */
  dirty?: boolean;
  /** Paths journaled before upload, so unknown outcomes can be reconciled. */
  pendingPaths?: string[];
}
export interface SharedCloudState {
  binding?: CloudProjectBinding;
  workspace?: SharedCloudWorkspace;
  nextCompileAt?: number;
  /** A missing response must not silently cause another cloud project creation. */
  creationPending?: { name: string; startedAt: number };
}
export interface SharedCloudSession {
  readonly state: SharedCloudState;
  /** Synchronous lifetime check, suitable for the cloud client's isActive. */
  alive(): boolean;
  /** Verify/renew the fencing token immediately before each network operation. */
  checkpoint(): Promise<void>;
  saveState(state: SharedCloudState): Promise<void>;
  /** Keep the workspace unavailable after an uncertain remote request outcome. */
  quarantine(): void;
}

type Reply = { ok: boolean; error?: string; granted?: boolean; token?: string; activeUntil?: number; retryAfterMs?: number; state?: SharedCloudState };
type Send = (message: Record<string, unknown>) => Promise<Reply>;
export interface CoordinatorClientOptions {
  send?: Send;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  requestId?: string;
}
const HEARTBEAT_MS = 10_000;
const MESSAGE_TIMEOUT_MS = 15_000;
const canceled = () => new DOMException('公式已改变或云端预览连接已失效。', 'AbortError');

async function sendMessage(message: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('云端预览协调器没有响应，请刷新页面后重试。')), MESSAGE_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(message, value => {
        clearTimeout(timer);
        try {
          const error = chrome.runtime.lastError;
          if (error) { reject(new Error(error.message || '云端预览协调器已断开。')); return; }
          if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') { reject(new Error('云端预览协调器返回了无效响应。')); return; }
          resolve(value as Reply);
        } catch (error) { reject(error); }
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

function request(send: Send, accountId: string, requestId: string, op: string, extra: Record<string, unknown> = {}) {
  return send({ type: 'opt:shared-cloud', accountId, requestId, op, ...extra }).then(reply => {
    if (!reply.ok) throw new Error(reply.error || '云端预览协调请求被拒绝。');
    return reply;
  });
}

/** Reads account metadata only. No project is created by inspection or startup. */
export async function readSharedCloudState(accountId: string, options: CoordinatorClientOptions = {}): Promise<SharedCloudState> {
  const result = await request(options.send ?? sendMessage, accountId, options.requestId ?? crypto.randomUUID(), 'read');
  return result.state ?? {};
}

/** One account-wide transaction spans synchronization, compilation and output download.
 * Idle tabs send nothing. A heartbeat exists only while a transaction owns the lease.
 * Queued calls recheck the formula before acquiring, so obsolete typing is discarded.
 */
export async function withSharedCloudLock<T>(accountId: string, isCurrent: () => boolean, operation: (session: SharedCloudSession) => Promise<T>, options: CoordinatorClientOptions = {}): Promise<T> {
  const send = options.send ?? sendMessage;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const requestId = options.requestId ?? crypto.randomUUID();
  let token: string | undefined;
  let activeUntil = 0;
  let active = true;
  let uncertain = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending = false;
  let state: SharedCloudState = {};
  const alive = () => active && Boolean(token) && now() < activeUntil;
  const checkpoint = async () => {
    if (!alive()) { active = false; throw canceled(); }
    try {
      const result = await request(send, accountId, requestId, 'renew', { token });
      if (!active || typeof result.activeUntil !== 'number' || now() >= result.activeUntil) { active = false; throw canceled(); }
      activeUntil = result.activeUntil;
    } catch (error) { active = false; throw error; }
  };
  try {
    while (!token) {
      if (!isCurrent()) throw canceled();
      const result = await request(send, accountId, requestId, 'acquire');
      if (result.granted) {
        if (typeof result.token !== 'string' || typeof result.activeUntil !== 'number') throw new Error('云端预览锁响应无效。');
        token = result.token; activeUntil = result.activeUntil; state = result.state ?? {};
      } else {
        await pause(Math.min(1000, Math.max(100, result.retryAfterMs || 500)));
      }
    }
    if (!alive() || !isCurrent()) throw canceled();
    heartbeat = setInterval(() => {
      if (!active || heartbeatPending) return;
      heartbeatPending = true;
      // A changed formula must not release a transaction while its fetch is still
      // in flight. Renew the lease until operation settles, but block further work.
      void request(send, accountId, requestId, 'renew', { token }).then(result => {
        if (typeof result.activeUntil !== 'number' || now() >= result.activeUntil) active = false;
        else activeUntil = result.activeUntil;
      }).catch(() => { active = false; }).finally(() => { heartbeatPending = false; });
    }, HEARTBEAT_MS);
    const session: SharedCloudSession = {
      get state() { return state; }, alive, checkpoint,
      async saveState(next) {
        // Save bookkeeping for a completed upload even if selection changed.
        // It remains fenced by token and lifetime, independently of isCurrent.
        if (!active || now() >= activeUntil) throw canceled();
        const result = await request(send, accountId, requestId, 'save', { token, state: next });
        state = result.state ?? next;
      },
      quarantine() { uncertain = true; },
    };
    return await operation(session);
  } finally {
    clearInterval(heartbeat);
    active = false;
    // No lease is released until operation's awaited network work has settled.
    // A failed release leaves its persisted quarantine deadline in place.
    try { await request(send, accountId, requestId, token ? 'release' : 'cancel', token ? { token, uncertain } : {}); }
    catch { /* A retired content context cannot repair its own connection. */ }
  }
}
