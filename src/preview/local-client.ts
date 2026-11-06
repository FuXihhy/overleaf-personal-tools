import type { TexHostStatus, TexRenderRequest, TexRenderResult } from './tex-types';
import { RuntimeConnectionError, retryRuntimeRead, runtimeConnectionError } from '../runtime-connection';

function transportError(error: unknown, onContextInvalidated?: () => void): string {
  const failure = runtimeConnectionError(error);
  if (failure.kind === 'context-invalidated') {
    try { onContextInvalidated?.(); } catch { /* Teardown must not hide the transport failure. */ }
    return '扩展已更新，当前 Overleaf 页面仍使用旧连接。请刷新 Overleaf 页面后重试。';
  }
  if (failure.kind === 'timeout') return '本机 TeX 服务响应超时，请重试。';
  const message = failure.message.slice(0, 300);
  return failure.kind === 'disconnected'
    ? `与本机 TeX 服务的连接暂时中断，请重试${message ? `（${message}）` : '。'}`
    : `无法连接本机 TeX 服务，请检查本机服务是否已安装${message ? `（${message}）` : '。'}`;
}

/** Callback form consumes runtime.lastError, including a missing/reloaded service worker. */
function send(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) { reject(new Error('Chrome 扩展运行环境不可用')); return; }
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new RuntimeConnectionError('timeout', '本机 TeX 服务响应超时')); }, 32_000);
    try {
      chrome.runtime.sendMessage(message, response => {
        // A reply can arrive after Chrome invalidates the calling context.
        // Reading lastError can itself throw outside sendMessage's try block.
        try {
          const error = chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(new Error(error.message ?? '扩展消息发送失败'));
          else resolve(response);
        } catch(error) { settled=true;clearTimeout(timer);reject(error); }
      });
    } catch (error) { settled = true; clearTimeout(timer); reject(error); }
  });
}

export async function getLocalStatus(onContextInvalidated?: () => void): Promise<TexHostStatus> {
  try {
    const response = await retryRuntimeRead(() => send({ type: 'opt:local-status' })) as TexHostStatus | undefined;
    if (!response || typeof response.available !== 'boolean' || typeof response.message !== 'string') {
      return { available: false, message: '本机 TeX 服务未返回有效的状态。' };
    }
    return response;
  } catch (error) { return { available: false, message: transportError(error, onContextInvalidated) }; }
}

export async function renderLocalTex(request: TexRenderRequest, onContextInvalidated?: () => void): Promise<TexRenderResult> {
  try {
    const response = await send({ type: 'opt:local-render', request }) as TexRenderResult | undefined;
    if (!response || !Array.isArray(response.diagnostics) || !response.diagnostics.every(value => typeof value === 'string')
      || (response.id !== undefined && response.id !== request.id)) return { id: request.id, diagnostics: ['本机 TeX 服务未返回有效的预览结果。'] };
    return { ...response, id: request.id };
  } catch (error) { return { id: request.id, diagnostics: [transportError(error, onContextInvalidated)] }; }
}

export async function cancelLocalTex(): Promise<void> {
  try { await send({ type: 'opt:local-cancel' }); } catch { /* Cancellation remains safe after tab/extension teardown. */ }
}
