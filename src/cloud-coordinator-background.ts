import type { SharedCloudState } from './preview/cloud-coordinator';

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | undefined;
export interface CoordinatorRuntime { id: string; onMessage: { addListener(listener: Listener): void; removeListener(listener: Listener): void } }
export interface CoordinatorStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
export interface CoordinatorStorage { local: CoordinatorStorageArea; session: CoordinatorStorageArea }
export interface CoordinatorOptions { now?: () => number; token?: () => string }
interface Lease { token: string; owner: string; activeUntil: number; blockedUntil: number }
interface Waiting { owner: string; seenAt: number }
interface LockRecord { lease?: Lease; waiters: Waiting[] }
const ID = /^[a-f\d]{24}$/i;
const KEY = /^[\w-]{1,100}$/;
const ACTIVE_MS = 30_000;
/** The longest HTTP compile deadline is five minutes; include that full window
 * after the final active deadline before a crashed owner can be replaced. */
const QUARANTINE_MS = 300_000;
const WAITING_MS = 15_000;
const stateKey = (account: string) => 'shared-cloud:v1:' + account;
const lockKey = (account: string) => 'shared-cloud-lock:v1:' + account;
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(value)
    && !/^[a-z]:/i.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).every(key => keys.includes(key)); }
function optionalCompiler(value: unknown) { return value === undefined || ['pdflatex', 'xelatex', 'lualatex'].includes(String(value)); }
function optionalVersion(value: unknown) { return value === undefined || typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\r\n\0]/.test(value); }

/** Persistence is deliberately limited to identities, hashes and scheduling metadata. */
export function validSharedCloudState(value: unknown, accountId: string): value is SharedCloudState {
  const state = object(value);
  if (!state || !onlyKeys(state, ['binding', 'workspace', 'nextCompileAt', 'creationPending'])) return false;
  if (state.nextCompileAt !== undefined && (typeof state.nextCompileAt !== 'number' || !Number.isFinite(state.nextCompileAt) || state.nextCompileAt < 0)) return false;
  if (state.creationPending !== undefined) {
    const pending = object(state.creationPending);
    if (!pending || !onlyKeys(pending, ['name', 'startedAt']) || typeof pending.name !== 'string' || !pending.name.trim() || pending.name.length > 200
      || typeof pending.startedAt !== 'number' || !Number.isFinite(pending.startedAt) || pending.startedAt < 0) return false;
  }
  if (state.binding !== undefined) {
    const binding = object(state.binding);
    if (!binding || !onlyKeys(binding, ['kind', 'accountId', 'projectId', 'name', 'rootFolderId', 'compiler', 'texLiveVersion'])
      || binding.kind !== 'shared-v1' || binding.accountId !== accountId || typeof binding.projectId !== 'string' || !ID.test(binding.projectId)
      || typeof binding.name !== 'string' || !binding.name.trim() || binding.name.length > 200
      || binding.rootFolderId !== undefined && (typeof binding.rootFolderId !== 'string' || !ID.test(binding.rootFolderId))
      || !optionalCompiler(binding.compiler) || !optionalVersion(binding.texLiveVersion)) return false;
  }
  if (state.workspace !== undefined) {
    const workspace = object(state.workspace);
    if (!state.binding || !workspace || !onlyKeys(workspace, ['sourceProjectId', 'files', 'compiler', 'texLiveVersion', 'dirty', 'pendingPaths'])
      || typeof workspace.sourceProjectId !== 'string' || !ID.test(workspace.sourceProjectId)
      || !Array.isArray(workspace.files) || workspace.files.length > 2000
      || !optionalCompiler(workspace.compiler) || !optionalVersion(workspace.texLiveVersion)
      || workspace.dirty !== undefined && typeof workspace.dirty !== 'boolean') return false;
    if (workspace.pendingPaths !== undefined && (!Array.isArray(workspace.pendingPaths) || workspace.pendingPaths.length > 2000
      || !workspace.pendingPaths.every(path) || new Set(workspace.pendingPaths).size !== workspace.pendingPaths.length)) return false;
    const paths = new Set<string>();
    for (const raw of workspace.files) {
      const file = object(raw);
      if (!file || !onlyKeys(file, ['path', 'id', 'type', 'digest']) || !path(file.path) || paths.has(file.path)
        || typeof file.id !== 'string' || !ID.test(file.id) || !['doc', 'file'].includes(String(file.type))
        || typeof file.digest !== 'string' || file.digest !== '' && !/^[a-f\d]{64}$/i.test(file.digest)) return false;
      paths.add(file.path);
    }
  }
  return true;
}

function readLock(value: unknown): LockRecord {
  const data = object(value);
  if (!data) return { waiters: [] };
  const rawLease = object(data.lease);
  const lease: Lease | undefined = rawLease && typeof rawLease.token === 'string' && typeof rawLease.owner === 'string'
    && typeof rawLease.activeUntil === 'number' && Number.isFinite(rawLease.activeUntil)
    && typeof rawLease.blockedUntil === 'number' && Number.isFinite(rawLease.blockedUntil)
    ? rawLease as unknown as Lease : undefined;
  const waiters = Array.isArray(data.waiters) ? data.waiters.filter((item): item is Waiting => {
    const w = object(item); return Boolean(w && typeof w.owner === 'string' && typeof w.seenAt === 'number' && Number.isFinite(w.seenAt));
  }).slice(0, 100) : [];
  return { lease, waiters };
}

export function registerCloudCoordinator(runtime: CoordinatorRuntime, storage: CoordinatorStorage, allowedSender: (sender: chrome.runtime.MessageSender, extensionId: string) => boolean, options: CoordinatorOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const randomToken = options.token ?? (() => crypto.randomUUID());
  // A single queue makes storage read/modify/write atomic across concurrent
  // messages, including two language domains arriving in the same event turn.
  let serial: Promise<unknown> = Promise.resolve();
  let stopped = false;
  async function state(account: string): Promise<SharedCloudState> {
    const saved = (await storage.local.get(stateKey(account)))[stateKey(account)];
    if (saved === undefined) return {};
    if (!validSharedCloudState(saved, account)) throw new Error('共享云端预览绑定无效，请检查扩展存储。');
    return saved;
  }
  async function handle(data: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
    if (stopped) throw new Error('云端预览协调器已停止。');
    if (!allowedSender(sender, runtime.id)) throw new Error('已拒绝来自非 Overleaf 编辑页面的云端协调请求。');
    if (typeof data.accountId !== 'string' || !ID.test(data.accountId) || typeof data.requestId !== 'string' || !KEY.test(data.requestId)
      || !['read', 'acquire', 'renew', 'save', 'release', 'cancel'].includes(String(data.op))) throw new Error('无效的云端预览协调请求。');
    const account = data.accountId.toLowerCase();
    if (data.op === 'read') return { ok: true, state: await state(account) };
    const owner = String(sender.tab!.id) + ':' + (sender.documentId ?? sender.url) + ':' + data.requestId;
    const key = lockKey(account);
    // Local storage also survives a full browser restart. It contains identities
    // and deadlines only; a previous cloud request may outlive the browser.
    // Session storage is a mirror for diagnostics, never an authority to unlock.
    const lock = readLock((await storage.local.get(key))[key]);
    const saveLock = async () => {
      await storage.local.set({ [key]: lock });
      await storage.session.set({ [key]: lock });
    };
    const time = now();
    lock.waiters = lock.waiters.filter(waiter => time - waiter.seenAt <= WAITING_MS);
    if (lock.lease && time >= lock.lease.blockedUntil) lock.lease = undefined;
    if (data.op === 'cancel') {
      lock.waiters = lock.waiters.filter(waiter => waiter.owner !== owner);
      await saveLock();
      return { ok: true };
    }
    if (data.op === 'acquire') {
      if (lock.lease?.owner === owner && time < lock.lease.activeUntil) {
        return { ok: true, granted: true, token: lock.lease.token, activeUntil: lock.lease.activeUntil, state: await state(account) };
      }
      const waiter = lock.waiters.find(waiter => waiter.owner === owner);
      if (waiter) waiter.seenAt = time;
      else {
        if (lock.waiters.length >= 100) throw new Error('等待云端预览的页面过多。');
        lock.waiters.push({ owner, seenAt: time });
      }
      if (!lock.lease && lock.waiters[0]?.owner === owner) {
        lock.waiters.shift();
        lock.lease = { token: randomToken(), owner, activeUntil: time + ACTIVE_MS, blockedUntil: time + ACTIVE_MS + QUARANTINE_MS };
        await saveLock();
        return { ok: true, granted: true, token: lock.lease.token, activeUntil: lock.lease.activeUntil, state: await state(account) };
      }
      await saveLock();
      return { ok: true, granted: false, retryAfterMs: 500 };
    }
    const lease = lock.lease;
    if (!lease || lease.owner !== owner || typeof data.token !== 'string' || lease.token !== data.token || time >= lease.activeUntil) {
      throw new Error('云端预览锁已失效；旧请求不能继续写入共享项目。');
    }
    if (data.op === 'renew') {
      lease.activeUntil = time + ACTIVE_MS;
      lease.blockedUntil = lease.activeUntil + QUARANTINE_MS;
      await saveLock();
      return { ok: true, activeUntil: lease.activeUntil };
    }
    if (data.op === 'save') {
      if (!validSharedCloudState(data.state, account)) throw new Error('共享预览工作区元数据无效；未保存。');
      await storage.local.set({ [stateKey(account)]: data.state });
      return { ok: true, state: data.state };
    }
    if (data.op === 'release') {
      if (data.uncertain === true) {
        lease.activeUntil = time; // Revoke immediately; keep the remote quarantine.
        lease.blockedUntil = Math.max(lease.blockedUntil, time + QUARANTINE_MS);
      } else lock.lease = undefined;
      await saveLock();
      return { ok: true };
    }
    throw new Error('不支持的云端预览协调操作。');
  }
  const listener: Listener = (message, sender, respond) => {
    const data = object(message);
    if (data?.type !== 'opt:shared-cloud') return undefined;
    const run = () => handle(data, sender);
    const response = serial.then(run, run);
    serial = response.catch(() => undefined);
    void response.then(value => { try { respond(value); } catch { /* Closed tab. */ } }, error => {
      try { respond({ ok: false, error: error instanceof Error ? error.message : '云端预览协调失败。' }); } catch { /* Closed tab. */ }
    });
    return true;
  };
  runtime.onMessage.addListener(listener);
  return () => { stopped = true; runtime.onMessage.removeListener(listener); };
}
