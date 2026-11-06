import type { CodexEvent, CodexModel } from './types';

export type ConnectionState = 'unknown' | 'checking' | 'connected' | 'reconnecting' | 'offline' | 'auth-required';
export interface CatalogueState {
  models?: CodexModel[];
  loading: boolean;
  connection?: ConnectionState;
  error?: string;
  message?: string;
  diagnostic?: string;
}
export function transientConnectionError(message: string): boolean {
  return /workspace (?:routing discovery|connection) timed out|routing.*(?:timeout|timed out)|account\/read.*(?:timeout|timed out)|Codex request timed out|Codex did not respond|(?:connection|port|helper|process).*(?:disconnect|closed|interrupted)|receiving end does not exist|could not establish connection/i.test(message);
}
/** Only read-only status discovery is retried. No questions or history writes
 * are replayed, and no catalogue survives an unsuccessful account check. */
export class CodexCatalogue {
  private state: CatalogueState = { loading: false, connection: 'unknown' };
  private pending?: Promise<void>;
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
    if (this.destroyed || this.pending) return this.pending ?? Promise.resolve();
    if (!automatic) { this.clearRetry(); this.retries = 0; }
    if (!force && this.loadedAt !== undefined && this.now() - this.loadedAt < 300_000) return Promise.resolve();
    if (this.busy() || !this.active()) {
      this.deferred = true;
      if (this.active()) this.publish({ ...this.state, loading: true, connection: 'checking' });
      return Promise.resolve();
    }
    this.deferred = false;
    const generation = this.generation;
    this.publish({ ...this.state, loading: true, connection: automatic ? 'reconnecting' : 'checking', error: undefined });
    const operation = (async () => {
      try {
        const result = await Promise.resolve().then(() => this.request());
        if (this.destroyed || generation !== this.generation) return;
        if (!result.available || !result.authenticated || !result.models?.length) {
          const error = result.message || 'Sign in to local Codex and try again.';
          const auth = result.errorCode === 'auth_required' || result.available === true && result.authenticated === false;
          this.fail(error, result.diagnostic, !auth && (result.retryable ?? transientConnectionError(error)), auth);
          return;
        }
        this.loadedAt = this.now(); this.retries = 0;
        this.publish({ loading: false, connection: 'connected', models: result.models, message: result.message });
      } catch (error) {
        if (!this.destroyed && generation === this.generation) {
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
    if (this.destroyed || this.pending || this.retryTimer || this.state.connection === 'reconnecting') return;
    const message = error instanceof Error ? error.message : String(error);
    if (/open Codex.*sign in|sign in.*Codex|authentication.*(?:required|expired)/i.test(message)) this.fail(message, undefined, false, true);
    else if (/native.*(?:not found|not installed)|specified native messaging host|not registered/i.test(message)) this.fail(message);
    else if (transientConnectionError(message)) this.fail(message, undefined, this.retries < 2);
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
  reset() { this.generation++; this.pending = undefined; this.clearRetry(); this.retries = 0; this.loadedAt = undefined; this.deferred = false; this.publish({loading:false,connection:'unknown'}); }
  destroy() { this.reset(); this.destroyed = true; }
  whenIdle(): Promise<void> { return this.pending ?? Promise.resolve(); }
  resume() { if (this.deferred && !this.busy() && this.active()) void this.refresh(true, true); }
  private publish(state: CatalogueState) { this.state = state; this.changed(state); }
}
