export interface CodexCacheFreshnessOptions {
  changed(stale: boolean): void;
  now?(): number;
  staleAfterMs?: number;
}

type ObservedSource = { fingerprint: string; revision: number };

/** A lightweight hint fingerprint, never an integrity or authorization check.
 * The native source store still verifies complete file bytes with SHA-256. */
function fingerprint(text: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    first = Math.imul(first ^ value, 0x01000193);
    second = Math.imul(second ^ value, 0x85ebca6b);
  }
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

/** Page-local freshness hints. Age alone never makes a project cache stale:
 * an observed source must differ from the last successful complete capture. */
export class CodexCacheFreshness {
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private baseline = new Map<string, string>();
  private observed = new Map<string, ObservedSource>();
  private revision = 0;
  private syncedAt?: number;
  private stale = false;
  private retired = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: CodexCacheFreshnessOptions) {
    this.now = options.now ?? Date.now;
    const duration = options.staleAfterMs ?? 300_000;
    this.staleAfterMs = Number.isFinite(duration) && duration >= 0 ? duration : 300_000;
  }

  observe(path: string, text: string): void {
    if (this.retired) return;
    const value = fingerprint(text);
    if (this.observed.get(path)?.fingerprint !== value) {
      this.observed.set(path, { fingerprint: value, revision: ++this.revision });
    }
    this.refresh();
  }

  /** Take this boundary before requesting any editor/export data. */
  beginSync(): number { return this.revision; }

  synced(files: Array<{ path: string; content: string }>, captureRevision: number): void {
    if (this.retired) return;
    this.baseline = new Map(files.map(file => [file.path, fingerprint(file.content)]));
    this.syncedAt = this.now();
    // Old, previously visited editor buffers are not evidence against a fresh
    // collaborative export. Keep only observations made during this capture.
    for (const [path, source] of this.observed) {
      if (source.revision <= captureRevision) this.observed.delete(path);
    }
    this.refresh();
  }

  /** Also call on focus/visibility restoration: background timers may be late. */
  refresh(): void {
    if (this.retired) return;
    clearTimeout(this.timer); this.timer = undefined;
    const dirty = this.syncedAt !== undefined && [...this.observed].some(([path, source]) => this.baseline.get(path) !== source.fingerprint);
    const age = this.syncedAt === undefined ? 0 : Math.max(0, this.now() - this.syncedAt);
    const stale = dirty && age >= this.staleAfterMs;
    if (dirty && !stale) {
      this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, Math.min(2_147_483_647, this.staleAfterMs - age));
    }
    if (this.stale !== stale) {
      this.stale = stale;
      try { this.options.changed(stale); }
      catch { /* A presentation callback must not fail an otherwise valid sync. */ }
    }
  }

  destroy(): void {
    this.retired = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.baseline.clear(); this.observed.clear();
  }
}
