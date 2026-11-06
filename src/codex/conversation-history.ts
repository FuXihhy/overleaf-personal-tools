import { getLocale } from '../i18n';

export interface CodexPanelConversation { id: string; title: string; updatedAt: number; current?: boolean }
export interface CodexConversationPage { conversations: CodexPanelConversation[]; nextCursor?: string }
export interface ConversationHistoryOptions {
  list(cursor?: string): Promise<CodexConversationPage>;
  select(id: string): Promise<void>;
  openInCodex?(id: string): Promise<void>;
  canOpenInCodex?(): boolean;
  onSelected(changed?: boolean): void;
  onSwitching(value: boolean): void;
  bindTooltip(element: HTMLElement): void;
}
const labels = {
  en: { history: 'Conversation history', loading: 'Loading conversations…', empty: 'No previous conversations in this project.',
    current: 'Current', untitled: 'Untitled conversation', retry: 'Retry', failed: 'Unable to load conversations.',
    selectFailed: 'Unable to open this conversation.', openFailed: 'Unable to open Codex.', open: 'Open in Codex', opening: 'Opening conversation…', more: 'Load more' },
  zh: { history: '对话历史', loading: '正在读取对话…', empty: '此项目还没有历史对话。', current: '当前', untitled: '未命名对话',
    retry: '重试', failed: '暂时无法读取对话历史。', selectFailed: '暂时无法打开此对话。', openFailed: '暂时无法打开 Codex。', open: '在 Codex 中打开', opening: '正在打开对话…', more: '加载更多' },
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
}

/** A project-scoped view; it never chooses or constructs native thread IDs. */
export function createConversationHistory(options: ConversationHistoryOptions) {
  const element = node('section', 'opt-codex-conversations'); element.hidden = true;
  const status = node('p', 'opt-codex-conversation-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = node('button', 'opt-codex-history-retry'); retry.type = 'button'; retry.hidden = true;
  const list = node('ul', 'opt-codex-conversation-list');
  const more = node('button', 'opt-codex-history-more'); more.type = 'button'; more.hidden = true;
  element.append(status, retry, list, more);
  let records: CodexPanelConversation[] = [], loading = false, switching = false, busy = false, destroyed = false;
  let revision = 0, error = '', retryAction: (() => Promise<void>) | undefined;
  let nextCursor: string | undefined, pendingCursor: string | undefined;
  let pendingList: Promise<CodexConversationPage> | undefined;
  const text = () => labels[getLocale()];

  function render() {
    const t = text(); element.setAttribute('aria-label', t.history); element.setAttribute('aria-busy', String(loading || switching));
    status.textContent = error || (switching ? t.opening : loading ? t.loading : !records.length ? t.empty : '');
    status.hidden = !status.textContent; status.classList.toggle('has-error', !!error);
    retry.textContent = t.retry; retry.hidden = !error || !retryAction; retry.disabled = loading || switching || busy;
    more.textContent = t.more; more.hidden = !nextCursor; more.disabled = loading || switching || busy;
    list.replaceChildren();
    for (const record of records) {
      const item = node('li', 'opt-codex-conversation'); item.dataset.conversationId = record.id;
      const choose = node('button', 'opt-codex-conversation-select'); choose.type = 'button'; choose.disabled = loading || switching || busy;
      choose.setAttribute('aria-current', String(!!record.current));
      const title = node('span', 'opt-codex-conversation-title', record.title.trim() || t.untitled);
      const metadata = node('span', 'opt-codex-conversation-meta');
      if (Number.isFinite(record.updatedAt) && record.updatedAt > 0) {
        const date = new Date(record.updatedAt);
        if (!Number.isNaN(date.getTime())) {
          const updated = node('time', '', new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date));
          updated.dateTime = date.toISOString(); metadata.append(updated);
        }
      }
      if (record.current) metadata.append(node('span', 'opt-codex-conversation-current', t.current));
      choose.append(title, metadata); choose.onclick = () => void select(record); item.append(choose);
      if (options.openInCodex && options.canOpenInCodex?.() !== false) {
        const open = node('button', 'opt-codex-icon-button opt-codex-open-conversation'); open.type = 'button'; open.disabled = loading || switching || busy;
        open.setAttribute('aria-label', t.open); const arrow = node('span', '', '↗'); arrow.setAttribute('aria-hidden', 'true'); open.append(arrow);
        options.bindTooltip(open); open.onclick = () => void openInCodex(record.id); item.append(open);
      }
      list.append(item);
    }
  }
  async function load(cursor?: string) {
    if (destroyed || switching || busy) return;
    const request = ++revision; loading = true; error = ''; retryAction = undefined; render();
    if (!pendingList || pendingCursor !== cursor) {
      const earlier = pendingList;
      pendingList = Promise.resolve(earlier).catch(() => undefined).then(() => options.list(cursor)); pendingCursor = cursor;
    }
    const pending = pendingList;
    try {
      const result = await pending;
      if (destroyed || request !== revision || element.hidden) return;
      const merged = new Map((cursor ? records : []).map(record => [record.id, record]));
      for (const record of result.conversations) merged.set(record.id, record);
      records = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt); nextCursor = result.nextCursor;
    } catch (reason) {
      if (destroyed || request !== revision || element.hidden) return;
      error = reason instanceof Error ? reason.message : text().failed; retryAction = () => load(cursor);
    } finally {
      if (pendingList === pending) pendingList = undefined;
      if (!destroyed && request === revision) { loading = false; render(); }
    }
  }
  async function select(record: CodexPanelConversation) {
    if (destroyed || loading || switching || busy) return;
    switching = true; error = ''; retryAction = undefined; options.onSwitching(true); render();
    try {
      await options.select(record.id);
      if (destroyed) return;
      records = records.map(value => ({ ...value, current: value.id === record.id }));
      options.onSelected(true);
    } catch (reason) {
      if (!destroyed) { error = reason instanceof Error ? reason.message : text().selectFailed; retryAction = () => select(record); }
    } finally {
      switching = false;
      if (!destroyed) { options.onSwitching(false); render(); }
    }
  }
  async function openInCodex(id: string) {
    if (!options.openInCodex || options.canOpenInCodex?.() === false || loading || switching || busy || destroyed) return;
    error = ''; retryAction = undefined;
    try { await options.openInCodex(id); }
    catch (reason) { if (!destroyed) { error = reason instanceof Error ? reason.message : text().openFailed; retryAction = () => openInCodex(id); } }
    if (!destroyed) render();
  }
  retry.onclick = () => { if (!busy && !switching && !loading) void retryAction?.(); };
  more.onclick = () => { if (nextCursor) void load(nextCursor); };
  return {
    element,
    show() { if (destroyed) return; element.hidden = false; void load(); },
    hide() { element.hidden = true; revision++; loading = false; },
    update() { if (!destroyed) render(); },
    setBusy(value: boolean) { if (busy === value) return; busy = value; if (!destroyed) render(); },
    destroy() { destroyed = true; revision++; element.remove(); },
  };
}
