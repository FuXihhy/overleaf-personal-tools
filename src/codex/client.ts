import { CODEX_PORT, parseCodexEvent, type CodexRequest, type CodexEvent } from './types';
import { RuntimeConnectionError, retryRuntimeRead, runtimeConnectionError } from '../runtime-connection';

type RequestData = Partial<Omit<CodexRequest, 'version' | 'id' | 'op' | 'projectId' | 'accountId'>>;
type Pending = { resolve(event: CodexEvent): void; reject(error: Error): void; onEvent?(event: CodexEvent): void; timer: ReturnType<typeof setTimeout> };

export class CodexClient {
  private port?: chrome.runtime.Port;
  private pending = new Map<string, Pending>();
  private recovery = new AbortController();
  private contextInvalidated = false;
  constructor(private readonly projectId: string, private readonly accountId?: string, private readonly onContextInvalidated?: () => void) {}

  request(op: CodexRequest['op'], data: RequestData = {}, onEvent?: (event: CodexEvent) => void): Promise<CodexEvent> {
    if (this.contextInvalidated) return Promise.reject(runtimeConnectionError('Extension context invalidated.'));
    const send = () => this.sendOnce(op, data, onEvent);
    // A port may disappear after the native process accepted a turn. Never
    // replay ask/new-chat/history-select (or cancel) after an uncertain result.
    const result = ['provider-list', 'history-list', 'history-read'].includes(op)
      ? retryRuntimeRead(send, this.recovery.signal) : send();
    return result.catch(error => {
      this.reportInvalidation(error);
      throw error;
    });
  }

  private reportInvalidation(error: unknown) {
    if (!(error instanceof RuntimeConnectionError) || error.kind !== 'context-invalidated' || this.contextInvalidated) return;
    this.contextInvalidated = true;
    try { this.onContextInvalidated?.(); } catch { /* Teardown must not hide the transport failure. */ }
  }

  private connect(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = chrome.runtime.connect({ name: CODEX_PORT }); this.port = port;
    port.onMessage.addListener(raw => {
      if (this.port !== port) return;
      const event = parseCodexEvent(raw); if (!event) return;
      const pending = this.pending.get(event.id); if (!pending) return;
      try { pending.onEvent?.(event); } catch { /* A view callback must not strand the transport. */ }
      if (['profiles', 'status', 'history', 'done', 'steered', 'error', 'source'].includes(event.type)) {
        clearTimeout(pending.timer); this.pending.delete(event.id);
        if (event.type === 'error') pending.reject(runtimeConnectionError(event.message || 'Codex request failed.'));
        else pending.resolve(event);
      }
    });
    port.onDisconnect.addListener(() => {
      let reason: unknown;
      try { reason = chrome.runtime.lastError?.message; } catch (error) { reason = error; }
      if (this.port !== port) return;
      const error = runtimeConnectionError(reason, 'disconnected');
      this.dropConnection(port, error); this.reportInvalidation(error);
    });
    return port;
  }

  private sendOnce(op: CodexRequest['op'], data: RequestData, onEvent?: (event: CodexEvent) => void): Promise<CodexEvent> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let port: chrome.runtime.Port | undefined;
      try {
        port = this.connect();
        const timer = setTimeout(() => {
          const error = new RuntimeConnectionError('timeout', 'Codex request timed out. Try again.');
          // A timed-out read must not terminate an answer sharing the port.
          if (op === 'ask') this.dropConnection(port!, error);
          else {
            this.pending.delete(id); reject(error);
            if (!this.pending.size) this.disconnectPort(port!);
          }
        }, op === 'ask' ? 600_000 : 60_000);
        this.pending.set(id, { resolve, reject, onEvent, timer });
        port.postMessage({ ...data, version: 1, id, op, projectId: this.projectId, ...(this.accountId ? { accountId: this.accountId } : {}) } satisfies CodexRequest);
      } catch (raw) {
        const error = runtimeConnectionError(raw);
        if (port) this.dropConnection(port, error);
        else if (this.port) this.dropConnection(this.port, error);
        reject(error);
      }
    });
  }

  private disconnectPort(port: chrome.runtime.Port) {
    if (this.port !== port) return;
    this.port = undefined;
    try { port.disconnect(); } catch { /* Already disconnected or retired. */ }
  }
  private dropConnection(port: chrome.runtime.Port, error: Error) {
    if (this.port !== port) return;
    this.disconnectPort(port);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  close() {
    const error = new RuntimeConnectionError('closed', 'Codex connection closed.');
    // Explicit closure cancels delayed recovery as well as in-flight requests.
    this.recovery.abort(error); this.recovery = new AbortController();
    if (this.port) this.dropConnection(this.port, error);
  }
}
