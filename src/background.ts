import { registerAPISettingsTransport } from './codex/provider-background';
import type { TexHostStatus, TexRenderRequest, TexRenderResult } from './preview/tex-types';
import { isOverleafOrigin } from './overleaf/origin';
import { registerCloudCoordinator } from './cloud-coordinator-background';
import { registerCodexTransport, registerCodexHistory } from './codex/background';

export const TEX_NATIVE_HOST = 'com.overleaf.personal_tools';
const TIMEOUT_MS = 30_000;
const MAX_SOURCE_CHARS = 8 * 1024 * 1024;
const MAX_PDF_BASE64_CHARS = 1024 * 1024;
type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined;
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
export interface NativeRuntime {
  id: string;
  readonly lastError?: { message?: string };
  connectNative(name: string): NativePort;
  onMessage: { addListener(listener: Listener): void; removeListener(listener: Listener): void };
}
export interface TabRemoval {
  addListener(listener: (tabId: number) => void): void;
  removeListener(listener: (tabId: number) => void): void;
}
type Pending = { tabId: number; finish(value: TexRenderResult | TexHostStatus): void; cancel(reason: string): void };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function allowedNativeSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (!extensionId || sender.id !== extensionId || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0 || !sender.url) return false;
  // Only the top-level Overleaf editor content script may reach the native host.
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return isOverleafOrigin(url.origin) && !url.username && !url.password && /^\/project\/[a-f\d]{24}\/?$/i.test(url.pathname);
  } catch { return false; }
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length < 1000 && !path.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(path)
    && !/^[a-z]:/i.test(path) && path.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

export function validTexRequest(value: unknown): value is TexRenderRequest {
  const request = object(value);
  if (!request || !onlyKeys(request, ['version', 'op', 'id', 'compiler', 'document'])
    || request.version !== 1 || request.op !== 'render' || typeof request.id !== 'string' || !/^[\w-]{1,100}$/.test(request.id)
    || !['pdflatex', 'xelatex', 'lualatex'].includes(String(request.compiler))) return false;
  const document = object(request.document);
  if (!document || !onlyKeys(document, ['entryPath', 'files', 'diagnostics'])
    || !validPath(document.entryPath) || !Array.isArray(document.files) || document.files.length < 1 || document.files.length > 2000
    || !Array.isArray(document.diagnostics) || document.diagnostics.length > 100 || !document.diagnostics.every(item => typeof item === 'string' && item.length <= 4000)) return false;
  const paths = new Set<string>();
  let size = 0;
  for (const value of document.files) {
    const file = object(value);
    if (!file || !onlyKeys(file, ['path', 'content']) || !validPath(file.path) || paths.has(file.path) || typeof file.content !== 'string' || file.content.includes('\0')) return false;
    size += file.content.length;
    if (size > MAX_SOURCE_CHARS) return false;
    paths.add(file.path);
  }
  return paths.has(document.entryPath);
}

function diagnostics(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 8000)
    ? value as string[] : undefined;
}

function statusResult(message: unknown, id: string): TexHostStatus | undefined {
  const data = object(message);
  if (!data || data.id !== id || typeof data.available !== 'boolean' || typeof data.message !== 'string' || data.message.length > 4000) return undefined;
  if (data.compilers !== undefined && (!Array.isArray(data.compilers) || !data.compilers.every(value => typeof value === 'string' && ['pdflatex', 'xelatex', 'lualatex'].includes(value)))) return undefined;
  return {
    available: data.available, message: data.message,
    ...(typeof data.version === 'string' && data.version.length <= 100 ? { version: data.version } : {}),
    ...(Array.isArray(data.compilers) ? { compilers: data.compilers as string[] } : {}),
    ...(typeof data.sandbox === 'boolean' ? { sandbox: data.sandbox } : {}),
  };
}

function renderResult(message: unknown, id: string): TexRenderResult | undefined {
  const data = object(message);
  const messages = diagnostics(data?.diagnostics);
  if (!data || data.id !== id || !messages) return undefined;
  if (data.pdfBase64 !== undefined) {
    if (typeof data.pdfBase64 !== 'string' || data.pdfBase64.length > MAX_PDF_BASE64_CHARS || data.pdfBase64.length % 4 !== 0
      || !/^[A-Za-z\d+/]+={0,2}$/.test(data.pdfBase64) || !data.pdfBase64.startsWith('JVBERi0')) return undefined;
  }
  return {
    id, diagnostics: data.pdfBase64 || messages.length ? messages : ['本机 TeX 没有返回预览 PDF。'],
    ...(typeof data.pdfBase64 === 'string' ? { pdfBase64: data.pdfBase64 } : {}),
    ...(typeof data.elapsedMs === 'number' && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 ? { elapsedMs: data.elapsedMs } : {}),
  };
}

/** Registers one broker. Tests inject ports; no native executable is launched by importing this module outside Chrome. */
export function registerNativeTransport(runtime: NativeRuntime, tabRemoval?: TabRemoval): () => void {
  const renders = new Map<number, Pending>();
  const all = new Set<Pending>();
  const statusWaiters = new Map<number, Array<(response: unknown) => void>>();

  function open(tabId: number, status: boolean, request: { id: string; op: 'status'; version: 1 } | TexRenderRequest, respond: (response: unknown) => void): void {
    let port: NativePort | undefined;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: string): TexRenderResult | TexHostStatus => status
      ? { available: false, message: reason }
      : { id: request.id, diagnostics: [reason] };
    const pending: Pending = {
      tabId,
      finish(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        all.delete(pending);
        if (renders.get(tabId) === pending) renders.delete(tabId);
        // Finish first: disconnect synchronously fires in some mocks/browser failure paths.
        try { respond(value); } catch { /* The originating tab may already be closed. */ }
        try { port?.disconnect(); } catch { /* Port already disconnected. */ }
      },
      cancel(reason) { pending.finish(fail(reason)); },
    };
    all.add(pending);
    if (!status) renders.set(tabId, pending);
    timer = setTimeout(() => pending.cancel('本机 TeX 处理超过 30 秒，已停止本次预览。'), TIMEOUT_MS);
    try {
      port = runtime.connectNative(TEX_NATIVE_HOST);
      port.onMessage.addListener(message => {
        const result = status ? statusResult(message, request.id) : renderResult(message, request.id);
        pending.finish(result ?? fail('本机 TeX 辅助程序返回了无效或不匹配的响应。'));
      });
      port.onDisconnect.addListener(() => {
        // Read lastError inside this listener to consume Chrome's error and avoid unchecked errors.
        const reason = runtime.lastError?.message;
        pending.cancel(reason ? `本机 TeX 辅助程序未连接：${reason.slice(0, 500)}` : '本机 TeX 辅助程序已断开，预览未完成。');
      });
      port.postMessage(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : '连接失败';
      pending.cancel(`无法连接本机 TeX 辅助程序：${reason}`);
    }
  }

  const listener: Listener = (message, sender, respond) => {
    const data = object(message);
    if (!data || !['opt:local-status', 'opt:local-render', 'opt:local-cancel'].includes(String(data.type))) return undefined;
    const status = data.type === 'opt:local-status';
    const fail = (reason: string) => respond(status ? { available: false, message: reason } : { diagnostics: [reason] });
    if (!allowedNativeSender(sender, runtime.id)) { fail('已拒绝来自非 Overleaf 编辑页面的本机 TeX 请求。'); return false; }
    const tabId = sender.tab!.id!;
    if (status) {
      const waiters = statusWaiters.get(tabId);
      if (waiters) { waiters.push(respond); return true; }
      statusWaiters.set(tabId, [respond]);
      open(tabId, true, { op: 'status', version: 1, id: crypto.randomUUID() }, response => {
        const waiting = statusWaiters.get(tabId) ?? [];
        statusWaiters.delete(tabId);
        for (const reply of waiting) { try { reply(response); } catch { /* An individual caller may have closed. */ } }
      });
      return true;
    }
    if (data.type === 'opt:local-cancel') {
      renders.get(tabId)?.cancel('本机 TeX 预览已取消。');
      respond({ diagnostics: [] });
      return false;
    }
    if (!validTexRequest(data.request)) { fail('本机 TeX 请求格式、文件路径或大小无效。'); return false; }
    renders.get(tabId)?.cancel('已开始新的预览，旧的本机 TeX 请求已取消。');
    open(tabId, false, data.request, respond);
    return true;
  };
  const removed = (tabId: number) => {
    for (const pending of [...all]) if (pending.tabId === tabId) pending.cancel('页面已关闭，本机 TeX 预览已取消。');
  };
  runtime.onMessage.addListener(listener);
  tabRemoval?.addListener(removed);
  return () => {
    runtime.onMessage.removeListener(listener);
    tabRemoval?.removeListener(removed);
    for (const pending of [...all]) pending.cancel('本机 TeX 连接已关闭。');
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) registerNativeTransport(chrome.runtime, chrome.tabs?.onRemoved);
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.local && chrome.storage?.session) {
  registerCloudCoordinator(chrome.runtime, chrome.storage, allowedNativeSender);
  registerCodexHistory(chrome.runtime, chrome.storage.local, allowedNativeSender);
}
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) registerCodexTransport(chrome.runtime, allowedNativeSender);

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) registerAPISettingsTransport(chrome.runtime);
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if (raw?.type !== 'opt:open-api-settings') return;
  if (!allowedNativeSender(sender, chrome.runtime.id)) { respond({ok:false}); return false; }
  void (async () => { try { await chrome.runtime.openOptionsPage(); respond({ok:true}); } catch { respond({ok:false}); } })();
  return true;
});
