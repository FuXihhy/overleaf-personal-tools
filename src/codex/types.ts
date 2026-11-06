export interface APIProfile { id: string; name: string; baseUrl: string; model: string; hasKey: boolean }
export interface CodexSettings {
  /** Unset legacy project settings use on-demand for new snapshots only. */
  cacheMode?: 'normal' | 'on-demand' | 'persistent';
  providerId?: string;
  apiModel?: string;
  apiMaxReadRounds?: number;
  apiMaxToolCalls?: number;
  apiTimeoutSeconds?: number;
  enabled: boolean;
  model: string;
  effort: string;
  instructions: string;
  contextMode: 'selection' | 'project';
}
export interface CodexSelection {
  path: string;
  text: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  before: string;
  after: string;
}
export interface CodexAnswerQuote { text: string; messageId?: string }
export interface CodexMessage { role: 'user' | 'assistant'; text: string; selection?: CodexSelection; answerQuote?: CodexAnswerQuote; messageId?: string }
export interface CodexModel { id: string; displayName: string; efforts?: string[] }
export interface CodexConversation { id: string; title: string; updatedAt: number; createdAt?: number; current?: boolean; messageCount?: number }
export interface CodexSourceManifestEntry { path: string; bytes: number; sha256: string }
export interface CodexCacheInfo { folder: string | null; snapshotCount: number; totalBytes: number; lastSyncedAt: number; temporaryCount: number; persistentCount: number; legacyCount: number; pageCount: number; pinCount: number; cleanupPending: boolean; cacheRevision: string }
export const CODEX_SOURCE_MAX_FILES = 2000;
export const CODEX_SOURCE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const CODEX_SOURCE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const CODEX_SOURCE_CHUNK_CHARS = 100_000;
export interface CodexRequest {
  version: 1;
  id: string;
  op: 'provider-list' | 'status' | 'ask' | 'steer' | 'cancel' | 'new-chat' | 'history-list' | 'history-read' | 'history-select' | 'source-begin' | 'source-chunk' | 'source-commit' | 'source-check' | 'source-cache-info' | 'source-cache-clear' | 'source-cache-open';
  projectId: string;
  accountId?: string;
  providerId?: string;
  question?: string;
  selection?: CodexSelection;
  answerQuote?: CodexAnswerQuote;
  files?: Array<{ path: string; content: string }>;
  settings?: CodexSettings;
  conversationId?: string;
  cursor?: string;
  limit?: number;
  expectedConversationId?: string | null;
  expectedSyncRevision?: string;
  expectedTurnId?: string;
  snapshotId?: string;
  sourceManifest?: CodexSourceManifestEntry[];
  rootPath?: string;
  uploadId?: string;
  path?: string;
  offset?: number;
  content?: string;
  cacheMode?: 'on-demand' | 'persistent';
  leaseToken?: string;
  cacheRevision?: string;
}
export interface CodexEvent {
  id: string;
  type: 'profiles' | 'status' | 'started' | 'steered' | 'delta' | 'done' | 'error' | 'history' | 'source';
  text?: string;
  message?: string;
  threadId?: string;
  turnId?: string;
  userMessageId?: string;
  canSteer?: boolean;
  notAccepted?: boolean;
  available?: boolean;
  authenticated?: boolean;
  errorCode?: string;
  retryable?: boolean;
  diagnostic?: string;
  models?: CodexModel[];
  profiles?: APIProfile[];
  conversations?: CodexConversation[];
  conversationId?: string;
  activeConversationId?: string;
  messages?: CodexMessage[];
  nextCursor?: string;
  remoteState?: 'idle' | 'active' | 'unknown';
  syncPending?: boolean;
  syncRevision?: string;
  uploadId?: string;
  snapshotId?: string;
  /** Source paths the helper could not reuse from its verified local cache. */
  missingPaths?: string[];
  fileCount?: number;
  totalBytes?: number;
  cacheInfo?: CodexCacheInfo;
}
export const DEFAULT_CODEX_SETTINGS: CodexSettings = { enabled: true, model: '', effort: '', instructions: '', contextMode: 'project' };
export function codexCacheMode(settings?: Pick<CodexSettings, 'contextMode' | 'cacheMode'>): 'normal' | 'on-demand' | 'persistent' {
  return settings?.contextMode === 'selection' ? 'normal' : settings?.cacheMode === 'persistent' ? 'persistent' : 'on-demand';
}
export const API_BUDGET_LIMITS = {
  apiMaxReadRounds: { min: 1, max: 256, default: 64 },
  apiMaxToolCalls: { min: 1, max: 512, default: 128 },
  apiTimeoutSeconds: { min: 90, max: 580, default: 580 },
} as const;
export const CODEX_NATIVE_HOST = 'com.overleaf.personal_tools.codex';
export const CODEX_PORT = 'opt:codex';
const conversationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
export const isCodexSnapshotId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function sourcePath(value: unknown, empty = false): value is string {
  return typeof value === 'string' && (empty && value === '' || value.length > 0 && value.length <= 512
    && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..' && part !== ''));
}
export function validateCodexSettings(value: unknown): CodexSettings {
  const s = record(value) ?? {};
  const budget: Partial<Pick<CodexSettings, keyof typeof API_BUDGET_LIMITS>> = {};
  if (conversationId(s.providerId)) for (const key of Object.keys(API_BUDGET_LIMITS) as Array<keyof typeof API_BUDGET_LIMITS>) {
    const value = s[key], limits = API_BUDGET_LIMITS[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= limits.min && value <= limits.max) budget[key] = value;
  }
  return {
    ...(['normal','on-demand','persistent'].includes(String(s.cacheMode)) ? {cacheMode: (s.contextMode === 'selection' ? 'normal' : s.cacheMode === 'persistent' ? 'persistent' : 'on-demand') as CodexSettings['cacheMode']} : {}),
    ...(conversationId(s.providerId) ? { providerId: s.providerId } : {}),
    ...(conversationId(s.providerId) && typeof s.apiModel === 'string' && /^[A-Za-z0-9._:/@+\-]{1,128}$/.test(s.apiModel) ? { apiModel: s.apiModel } : {}),
    ...budget,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
    model: typeof s.model === 'string' && /^[\w.:-]{0,128}$/.test(s.model) ? s.model : '',
    effort: typeof s.effort === 'string' && ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(s.effort) ? s.effort : '',
    instructions: typeof s.instructions === 'string' ? s.instructions.slice(0, 8000) : '',
    contextMode: s.contextMode === 'selection' ? 'selection' : 'project',
  };
}
export function isCodexSelection(value: unknown): value is CodexSelection {
  const s = record(value);
  return !!s && Object.keys(s).every(key => ['path','text','from','to','startLine','endLine','before','after'].includes(key))
    && sourcePath(s.path, true) && typeof s.text === 'string' && s.text.length > 0 && s.text.length <= 64_000
    && ['from', 'to', 'startLine', 'endLine'].every(key => Number.isSafeInteger(s[key]) && Number(s[key]) >= (key.endsWith('Line') ? 1 : 0))
    && Number(s.to) - Number(s.from) === s.text.length && Number(s.endLine) >= Number(s.startLine)
    && typeof s.before === 'string' && s.before.length <= 16_000 && typeof s.after === 'string' && s.after.length <= 16_000;
}
export function isCodexAnswerQuote(value: unknown): value is CodexAnswerQuote {
  const quote = record(value);
  return !!quote && Object.keys(quote).every(key => key === 'text' || key === 'messageId')
    && typeof quote.text === 'string' && !!quote.text.trim() && quote.text.length <= 64_000 && !/[\0\uD800-\uDFFF]/u.test(quote.text)
    && (quote.messageId === undefined || typeof quote.messageId === 'string' && /^[\w.:-]{1,300}$/.test(quote.messageId));
}
export function codexQuotationBytes(selection?: CodexSelection, answerQuote?: CodexAnswerQuote): number {
  return new TextEncoder().encode(JSON.stringify({ ...(selection ? { selection } : {}), ...(answerQuote ? { answerQuote } : {}) })).byteLength;
}
export function validCodexRequest(value: unknown): value is CodexRequest {
  const r = record(value);
  if (!r || Object.keys(r).some(key => !['version','id','op','projectId','accountId','question','selection','answerQuote','files','settings','conversationId','cursor','limit','expectedConversationId','expectedSyncRevision','expectedTurnId','providerId','snapshotId','sourceManifest','rootPath','uploadId','path','offset','content','cacheMode','leaseToken','cacheRevision'].includes(key))
    || r.version !== 1 || typeof r.id !== 'string' || !/^[\w-]{1,100}$/.test(r.id)
    || !['provider-list','status','ask','steer','cancel','new-chat','history-list','history-read','history-select','source-begin','source-chunk','source-commit','source-check','source-cache-info','source-cache-clear','source-cache-open'].includes(String(r.op)) || typeof r.projectId !== 'string' || !/^[a-f\d]{24}$/i.test(r.projectId)
    || r.accountId !== undefined && (typeof r.accountId !== 'string' || !/^[a-f\d]{24}$/i.test(r.accountId))) return false;
  if (r.providerId !== undefined && !conversationId(r.providerId)) return false;
  if (String(r.op).startsWith('source-')) {
    const envelope = ['version','id','op','projectId','accountId'];
    if (r.op === 'source-cache-info' || r.op === 'source-cache-open') return Object.keys(r).every(key => envelope.includes(key));
    if (r.op === 'source-cache-clear') return Object.keys(r).every(key => [...envelope,'cacheRevision'].includes(key)) && isCodexSnapshotId(r.cacheRevision);
    if (r.op === 'source-check') return Object.keys(r).every(key => [...envelope,'snapshotId'].includes(key)) && isCodexSnapshotId(r.snapshotId);
    if (r.op === 'source-begin') {
      if (Object.keys(r).some(key => ![...envelope,'sourceManifest','rootPath','cacheMode','leaseToken'].includes(key)) || !sourcePath(r.rootPath, true)
        || r.cacheMode !== undefined && (!['on-demand','persistent'].includes(String(r.cacheMode)) || !conversationId(r.leaseToken))
        || r.leaseToken !== undefined && (r.cacheMode === undefined || !conversationId(r.leaseToken))
        || !Array.isArray(r.sourceManifest) || !r.sourceManifest.length || r.sourceManifest.length > CODEX_SOURCE_MAX_FILES) return false;
      let total = 0; const paths = new Set<string>();
      for (const value of r.sourceManifest) {
        const entry = record(value);
        if (!entry || Object.keys(entry).some(key => !['path','bytes','sha256'].includes(key)) || !sourcePath(entry.path) || paths.has(entry.path)
          || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 || Number(entry.bytes) > CODEX_SOURCE_MAX_FILE_BYTES || !isCodexSnapshotId(entry.sha256)) return false;
        paths.add(entry.path); total += Number(entry.bytes);
        if (total > CODEX_SOURCE_MAX_TOTAL_BYTES) return false;
      }
      return !r.rootPath || paths.has(r.rootPath);
    }
    if (!conversationId(r.uploadId)) return false;
    if (r.op === 'source-commit') return Object.keys(r).every(key => [...envelope,'uploadId'].includes(key));
    return Object.keys(r).every(key => [...envelope,'uploadId','path','offset','content'].includes(key)) && sourcePath(r.path)
      && Number.isSafeInteger(r.offset) && Number(r.offset) >= 0 && Number(r.offset) <= CODEX_SOURCE_MAX_FILE_BYTES
      && typeof r.content === 'string' && r.content.length > 0 && r.content.length <= CODEX_SOURCE_CHUNK_CHARS
      && !/[\0\uD800-\uDFFF]/u.test(r.content) && Number(r.offset) + new TextEncoder().encode(r.content).byteLength <= CODEX_SOURCE_MAX_FILE_BYTES;
  }
  if (String(r.op).startsWith('history-')) {
    if (Object.keys(r).some(key => !['version','id','op','projectId','accountId','conversationId','cursor','limit','providerId'].includes(key))) return false;
    if (r.conversationId !== undefined && !conversationId(r.conversationId)) return false;
    if (r.cursor !== undefined && (typeof r.cursor !== 'string' || r.cursor.length > 4096 || !r.cursor.length)) return false;
    if (r.limit !== undefined && (!Number.isInteger(r.limit) || Number(r.limit) < 1 || Number(r.limit) > 50)) return false;
    if (r.op === 'history-list') return r.conversationId === undefined;
    if (r.op === 'history-select') return conversationId(r.conversationId) && r.cursor === undefined && r.limit === undefined;
    return true;
  }
  if (r.op !== 'ask' && r.op !== 'steer') return Object.keys(r).every(key => ['version','id','op','projectId','accountId','providerId'].includes(key));
  if (['sourceManifest','rootPath','uploadId','path','offset','content','cacheMode','leaseToken','cacheRevision'].some(key => r[key] !== undefined)) return false;
  if (r.snapshotId !== undefined && (!isCodexSnapshotId(r.snapshotId) || record(r.settings)?.contextMode === 'selection' || Array.isArray(r.files) && r.files.length > 0)) return false;
  if (r.conversationId !== undefined || r.cursor !== undefined || r.limit !== undefined) return false;
  if (r.op === 'steer' && (r.providerId !== undefined || !conversationId(r.expectedConversationId) || typeof r.expectedTurnId !== 'string' || !/^[\w.:-]{1,300}$/.test(r.expectedTurnId))) return false;
  if (r.op !== 'steer' && r.expectedTurnId !== undefined) return false;
  if (r.expectedConversationId !== undefined && r.expectedConversationId !== null && !conversationId(r.expectedConversationId)) return false;
  if (r.expectedSyncRevision !== undefined && (typeof r.expectedSyncRevision !== 'string' || !/^[a-f\d]{64}$/.test(r.expectedSyncRevision))) return false;
  if (typeof r.question !== 'string' || !r.question.trim() || r.question.length > 16_000) return false;
  if (r.selection !== undefined && !isCodexSelection(r.selection)) return false;
  if (r.answerQuote !== undefined && !isCodexAnswerQuote(r.answerQuote)) return false;
  // Leave room for a maximum escaped question inside one native history page.
  if (codexQuotationBytes(r.selection as CodexSelection | undefined, r.answerQuote as CodexAnswerQuote | undefined) > 560_000) return false;
  if (Object.keys(API_BUDGET_LIMITS).some(key => record(r.settings)?.[key] !== undefined)
    && (!conversationId(r.providerId) || record(r.settings)?.providerId !== r.providerId)) return false;
  if (r.settings !== undefined && JSON.stringify(validateCodexSettings(r.settings)) !== JSON.stringify(r.settings)) {
    // Compare values rather than key order when validating an untrusted request.
    const s = record(r.settings); const clean = validateCodexSettings(s);
    if (!s || Object.keys(s).length !== Object.keys(clean).length || Object.entries(clean).some(([key,v]) => s[key] !== v)) return false;
  }
  if (r.files !== undefined) {
    if (!Array.isArray(r.files) || r.files.length > 64) return false;
    let total = 0; const seen = new Set<string>();
    for (const raw of r.files) {
      const f = record(raw);
      if (!f || Object.keys(f).some(k => k !== 'path' && k !== 'content') || !sourcePath(f.path) || seen.has(f.path)
        || typeof f.content !== 'string' || f.content.includes('\0')) return false;
      seen.add(f.path); total += f.content.length;
      if (total > 240_000) return false;
    }
  }
  return true;
}
export function parseCodexEvent(value: unknown): CodexEvent | undefined {
  const r = record(value);
  if (!r || typeof r.id !== 'string' || !/^[\w-]{1,100}$/.test(r.id) || !['profiles','status','started','steered','delta','done','error','history','source'].includes(String(r.type))) return;
  const event: CodexEvent = { id: r.id, type: r.type as CodexEvent['type'] };
  if (r.cacheInfo !== undefined) {
    const c = record(r.cacheInfo);
    if (r.type !== 'source' || !c || !(c.folder === null || typeof c.folder === 'string' && c.folder.length <= 4096)
      || !isCodexSnapshotId(c.cacheRevision) || typeof c.cleanupPending !== 'boolean') return;
    for (const key of ['snapshotCount','totalBytes','lastSyncedAt','temporaryCount','persistentCount','legacyCount','pageCount','pinCount']) {
      if (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || Number(c[key]) < 0) return;
      if (key !== 'lastSyncedAt' && !Number.isSafeInteger(c[key])) return;
    }
    event.cacheInfo = c as unknown as CodexCacheInfo;
  }
  if (r.uploadId !== undefined) { if (r.type !== 'source' || !conversationId(r.uploadId)) return; event.uploadId = r.uploadId; }
  if (r.snapshotId !== undefined) { if (r.type !== 'source' || !isCodexSnapshotId(r.snapshotId)) return; event.snapshotId = r.snapshotId; }
  if (r.missingPaths !== undefined) {
    if (r.type !== 'source' || !Array.isArray(r.missingPaths) || r.missingPaths.length > CODEX_SOURCE_MAX_FILES
      || r.missingPaths.some(path => !sourcePath(path)) || new Set(r.missingPaths).size !== r.missingPaths.length) return;
    event.missingPaths = [...r.missingPaths];
  }
  for (const key of ['fileCount','totalBytes'] as const) if (r[key] !== undefined) {
    if (r.type !== 'source' || !Number.isSafeInteger(r[key]) || Number(r[key]) < 0 || Number(r[key]) > (key === 'fileCount' ? CODEX_SOURCE_MAX_FILES : CODEX_SOURCE_MAX_TOTAL_BYTES)) return;
    event[key] = Number(r[key]);
  }
  if (r.notAccepted !== undefined) {
    if (r.type !== 'error' || typeof r.notAccepted !== 'boolean') return;
    event.notAccepted = r.notAccepted;
  }
  if(r.remoteState!==undefined){if(!['idle','active','unknown'].includes(String(r.remoteState)))return;event.remoteState=r.remoteState as CodexEvent['remoteState'];}
  if(r.syncPending!==undefined){if(r.type!=='history' || typeof r.syncPending!=='boolean' || r.syncPending && r.remoteState!=='unknown')return;event.syncPending=r.syncPending;}
  if(r.syncRevision!==undefined){if(typeof r.syncRevision!=='string' || !/^[a-f\d]{64}$/.test(r.syncRevision))return;event.syncRevision=r.syncRevision;}
  for (const key of ['text','message','threadId','turnId','userMessageId','diagnostic','errorCode'] as const) {
    if (r[key] !== undefined) { if (typeof r[key] !== 'string' || r[key].length > (key === 'text' ? 500_000 : 4000)) return; event[key] = r[key]; }
  }
  for (const key of ['available','authenticated','canSteer','retryable'] as const) if (r[key] !== undefined) { if (typeof r[key] !== 'boolean') return; event[key] = r[key]; }
  for (const key of ['conversationId', 'activeConversationId'] as const) if (r[key] !== undefined && r[key] !== null) {
    if (!conversationId(r[key])) return; event[key] = r[key];
  }
  if (r.nextCursor !== undefined && r.nextCursor !== null) {
    if (typeof r.nextCursor !== 'string' || !r.nextCursor.length || r.nextCursor.length > 4096) return;
    event.nextCursor = r.nextCursor;
  }
  if (r.conversations !== undefined) {
    if (!Array.isArray(r.conversations) || r.conversations.length > 50) return;
    event.conversations = [];
    for (const rawConversation of r.conversations) {
      const c = record(rawConversation);
      if (!c || !conversationId(c.id) || typeof c.title !== 'string' || c.title.length > 300 || !Number.isSafeInteger(c.updatedAt) || Number(c.updatedAt) < 0) return;
      const entry: CodexConversation = { id: c.id, title: c.title, updatedAt: Number(c.updatedAt) };
      for (const key of ['createdAt', 'messageCount'] as const) if (c[key] !== undefined) { if (!Number.isSafeInteger(c[key]) || Number(c[key]) < 0) return; entry[key] = Number(c[key]); }
      if (c.current !== undefined) { if (typeof c.current !== 'boolean') return; entry.current = c.current; }
      event.conversations.push(entry);
    }
  }
  if (r.messages !== undefined) {
    if (!Array.isArray(r.messages) || r.messages.length > 100) return;
    event.messages = []; let length = 0;
    for (const rawMessage of r.messages) {
      const m = record(rawMessage);
      if (!m || !['user','assistant'].includes(String(m.role)) || typeof m.text !== 'string' || m.text.length > 500_000) return;
      if (m.selection !== undefined && (m.role !== 'user' || !isCodexSelection(m.selection))) return;
      if (m.answerQuote !== undefined && (m.role !== 'user' || !isCodexAnswerQuote(m.answerQuote))) return;
      const message: CodexMessage = { role: m.role as CodexMessage['role'], text: m.text };
      if(m.messageId!==undefined){if(typeof m.messageId!=='string' || !/^[\w.:-]{1,300}$/.test(m.messageId))return;message.messageId=m.messageId;}
      if (m.selection !== undefined) message.selection = m.selection as unknown as CodexSelection;
      if (m.answerQuote !== undefined) message.answerQuote = { ...(m.answerQuote as unknown as CodexAnswerQuote) };
      length += message.text.length + (message.selection ? JSON.stringify(message.selection).length : 0) + (message.answerQuote ? JSON.stringify(message.answerQuote).length : 0); if (length > 900_000) return;
      event.messages.push(message);
    }
  }
  if (r.profiles !== undefined) {
    if (!Array.isArray(r.profiles) || r.profiles.length > 30) return;
    event.profiles = [];
    for (const value of r.profiles) {
      const p = record(value);
      if (!p || !conversationId(p.id) || typeof p.name !== 'string' || p.name.length > 100 || typeof p.baseUrl !== 'string' || p.baseUrl.length > 2048 || typeof p.model !== 'string' || p.model.length > 128 || typeof p.hasKey !== 'boolean') return;
      event.profiles.push({id:p.id,name:p.name,baseUrl:p.baseUrl,model:p.model,hasKey:p.hasKey});
    }
  }
  if (r.models !== undefined) {
    if (!Array.isArray(r.models) || r.models.length > 200) return;
    event.models = [];
    for (const rawModel of r.models) {
      const m = record(rawModel);
      if (!m || typeof m.id !== 'string' || m.id.length > 128 || typeof m.displayName !== 'string' || m.displayName.length > 200) return;
      const model: CodexModel = { id: m.id, displayName: m.displayName };
      if (m.efforts !== undefined) {
        if (!Array.isArray(m.efforts) || m.efforts.length > 16 || m.efforts.some(e => typeof e !== 'string' || !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(e))) return;
        model.efforts = [...new Set(m.efforts as string[])];
      }
      event.models.push(model);
    }
  }
  return event;
}
