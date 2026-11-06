export interface CodexSourceGuardOptions {
  /** False means verified source damage; network/transport failures must throw. */
  check(): Promise<boolean>;
  /** Restore source bytes only. This callback must never replay a model turn. */
  repair(): Promise<unknown>;
  current(): boolean;
  failed(error: Error): void;
  intervalMs?: number;
}

const restorationError = () => new Error('The original source version cannot be restored. The project may have changed; the question was not resent.');
const cancellationError = () => new Error('Project cache verification was cancelled because the conversation changed or ended.');

/** Protect one immutable snapshot for one question. All checks are single-flight,
 * and every repair must be followed by a check of that same snapshot identity. */
export class CodexSourceGuard {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = false;
  private polling = false;
  private reported = false;
  private repairCount = 0;

  constructor(private readonly options: CodexSourceGuardOptions) {}

  private current() { return !this.stopped && this.options.current(); }
  private assertCurrent() { if (!this.current()) throw cancellationError(); }

  ensure(): Promise<void> {
    if (!this.current()) return Promise.reject(cancellationError());
    if (this.pending) return this.pending;
    // Assign pending before calling user callbacks, including synchronous mocks.
    const operation = Promise.resolve().then(() => this.verify()).catch(error => {
      this.assertCurrent();
      throw error;
    });
    this.pending = operation;
    const settled = () => { if (this.pending === operation) this.pending = undefined; };
    void operation.then(settled, settled);
    return operation;
  }

  private async verify() {
    this.assertCurrent();
    const intact = await this.options.check();
    this.assertCurrent();
    if (intact) return;
    if (this.repairCount >= 2) throw restorationError();
    this.repairCount++;
    await this.options.repair();
    this.assertCurrent();
    const restored = await this.options.check();
    this.assertCurrent();
    if (!restored) throw restorationError();
  }

  start(): void {
    if (!this.current() || this.polling || this.reported) return;
    this.polling = true;
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.polling && this.current()) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.options.intervalMs ?? 5000);
  }

  private async poll() {
    try { await this.ensure(); }
    catch (error) {
      if (this.current() && !this.reported) {
        this.reported = true;
        this.polling = false;
        try { this.options.failed(error instanceof Error ? error : new Error(String(error))); }
        catch { /* A UI notification cannot leave an unhandled polling rejection. */ }
      }
    } finally { this.schedule(); }
  }

  /** Retire this guard permanently; in-flight callbacks cannot be aborted but
   * their late results cannot launch repair, recheck, or failure notifications. */
  stop(): void {
    this.stopped = true;
    this.polling = false;
    clearTimeout(this.timer); this.timer = undefined;
  }
}
