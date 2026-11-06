import type { CodexEvent, CodexModel } from './types';

export type ConnectionState = 'unknown' | 'checking' | 'connected' | 'reconnecting' | 'offline' | 'auth-required';
export interface CatalogueState {
  models?: CodexModel[];
  loading: boolean;
  connection?: ConnectionState;
  error?: string;
  message?: string;
  diagnostic?: string;
  connectionKind?: CodexEvent['connectionKind'];
  projectReaderReady?: boolean;
  readerError?: string;
  checkedAt?: number;
}
export function transientConnectionError(message: string): boolean {
  return /workspace (?:routing discovery|connection) timed out|routing.*(?:timeout|timed out)|account\/read.*(?:timeout|timed out)|Codex request timed out|Codex did not respond|Project cache coordination timed out|(?:connection|port|helper|process).*(?:disconnect|closed|interrupted|lost)|receiving end does not exist|could not establish connection/i.test(message);
}
/** Only read-only status discovery is retried. No questions or history writes
 * are replayed, and no catalogue survives an unsuccessful account check. */
export class CodexCatalogue {
  private state: CatalogueState = { loading: false, connection: 'unknown' };
  private pending?: Promise<void>;
  private forced?: Promise<void>;
  private failureRevision = 0;
  private loadedAt?: number;
  private deferred = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private generation = 0;
  private destroyed = false;
  constructor(
    private readonly request: () => Promise<CodexEvent>,
    private readonly busy: () => boolean,
    private readonly changed: (state: CatalogueState) => void,
    private readonly now: () => number = Date.now,
    private readonly active: () => boolean = () => true,
  ) {}
  refresh(force = false, automatic = false): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.pending) {
      if(!force)return this.pending;
      // A manual check must observe failures that happened after an older
      // discovery began. Coalesce forced clicks into one subsequent probe.
      if(this.forced)return this.forced;
      const generation=this.generation;
      const forced=this.pending.then(()=>{
        if(this.forced===forced)this.forced=undefined;
        if(!this.destroyed&&generation===this.generation)return this.refresh(true,automatic);
      }).finally(()=>{if(this.forced===forced)this.forced=undefined;});
      this.forced=forced;return forced;
    }
    if (!automatic) { this.clearRetry(); this.retries = 0; }
    if (!force && this.loadedAt !== undefined && this.now() - this.loadedAt < 300_000) return Promise.resolve();
    if (this.busy() || !this.active()) {
      this.deferred = true;
      if (this.active()) this.publish({ ...this.state, loading: true, connection: 'checking' });
      return Promise.resolve();
    }
    this.deferred = false;
    const generation = this.generation, failureRevision=this.failureRevision;
    this.publish({ ...this.state, loading: true, connection: automatic ? 'reconnecting' : 'checking', error: undefined });
    const operation = (async () => {
      try {
        const result = await Promise.resolve().then(() => this.request());
        if (this.destroyed || generation !== this.generation || failureRevision!==this.failureRevision) return;
        if (!result.available || !result.authenticated || !result.models?.length) {
          const error = result.message || 'Sign in to local Codex and try again.';
          const auth = result.errorCode === 'auth_required' || result.available === true && result.authenticated === false;
          this.fail(error, result.diagnostic, !auth && (result.retryable ?? transientConnectionError(error)), auth);
          return;
        }
        this.loadedAt = this.now(); this.retries = 0;
        this.publish({ loading: false, connection: 'connected', models: result.models, message: result.message,
          checkedAt:this.loadedAt,connectionKind:result.connectionKind,projectReaderReady:result.projectReaderReady,readerError:result.readerError });
      } catch (error) {
        if (!this.destroyed && generation === this.generation && failureRevision===this.failureRevision) {
          const message = error instanceof Error ? error.message : String(error);
          this.fail(message, undefined, transientConnectionError(message));
        }
      } finally { if (generation === this.generation) this.pending = undefined; }
    })();
    this.pending = operation;
    return operation;
  }
  /** Surface transport failures from other operations without resending them. */
  reportFailure(error: unknown) {
    if (this.destroyed) return;
    const message = error instanceof Error ? error.message : String(error);
    const auth=/open Codex.*sign in|sign in.*Codex|authentication.*(?:required|expired)/i.test(message);
    const unavailable=/native.*(?:not found|not installed)|specified native messaging host|(?:native (?:messaging )?host|(?:local )?Codex helper).*not registered/i.test(message);
    const transient=transientConnectionError(message);
    if(!auth&&!unavailable&&!transient)return;
    ++this.failureRevision;this.clearRetry();
    this.fail(message,undefined,!auth&&transient&&this.retries<2,auth);
  }
  private fail(error: string, diagnostic?: string, retryable = false, auth = false) {
    this.loadedAt = undefined;
    const retry = retryable && this.retries < 2;
    this.publish({ loading: false, connection: auth ? 'auth-required' : retry ? 'reconnecting' : 'offline', error, diagnostic });
    if (!retry) return;
    const delay = [5000, 15000][this.retries++];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.active() || this.busy()) { this.deferred = true; return; }
      void this.refresh(true, true);
    }, delay);
  }
  private clearRetry() { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  reset() { this.generation++; this.pending = this.forced = undefined; this.clearRetry(); this.retries = 0; this.loadedAt = undefined; this.deferred = false; this.publish({loading:false,connection:'unknown'}); }
  destroy() { this.reset(); this.destroyed = true; }
  whenIdle(): Promise<void> { return this.forced ?? this.pending ?? Promise.resolve(); }
  resume() { if (this.deferred && !this.busy() && this.active()) void this.refresh(true, true); }
  private publish(state: CatalogueState) { this.state = state; this.changed(state); }
}
