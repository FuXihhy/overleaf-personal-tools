import { createExtensionContext, type ExtensionContext } from '../extension-context';
import { getLocale, observeLocale } from '../i18n';
import { emptyIndex, type ProjectIndex } from '../core/types';
import type { CodexSelection, CodexAnswerQuote } from './types';
import { codexPanelStyles } from './panel-styles';
import { renderAssistantMessage, getRenderedMathSource } from './message-renderer';
import { copyRenderedMathSelection, readRenderedSelection, writeClipboardText } from './clipboard';
import { mathFeedbackStyles, createMathSelectionFeedback, createFormulaCopyToast } from './selection-feedback';
import type { QueuedPrompt, CapturedPrompt } from './prompt-queue';
import { createConversationHistory, type CodexConversationPage } from './conversation-history';
export type { CodexPanelConversation, CodexConversationPage } from './conversation-history';

export interface CodexPanelMessage { messageId?: string; role: 'user' | 'assistant'; text: string; selection?: CodexSelection; answerQuote?: CodexAnswerQuote }
export interface CodexConnectionState {
  state: 'unknown' | 'checking' | 'connected' | 'reconnecting' | 'offline' | 'auth-required';
  message?: string;
  detail?: string;
  connectionKind?: 'standalone';
  projectReaderReady?: boolean;
  readerError?: string;
  checkedAt?: number;
}
export interface CodexPanelOptions {
  projectId: string;
  position?: 'left' | 'right';
  onPositionChange?(position: 'left' | 'right'): void | Promise<void>;
  getSettings(): { enabled: boolean; contextMode?: 'selection' | 'project'; clickToCopy?: boolean; copyToast?: boolean; providerId?: string; providerName?: string; busyMessageBehavior?: 'queue' | 'steer' };
  onVisibilityChange?(open: boolean): void;
  getIndex?(): ProjectIndex;
  onSend(question: string, selection?: CodexSelection, answerQuote?: CodexAnswerQuote): Promise<void>;
  onQueue?(question: string, selection?: CodexSelection, answerQuote?: CodexAnswerQuote): Promise<void>;
  onSteer?(question: string, selection?: CodexSelection, answerQuote?: CodexAnswerQuote): Promise<void>;
  onSteerQueued?(id: string): Promise<void>;
  onRemoveQueued?(id: string): CapturedPrompt | undefined;
  onResumeQueue?(): void;
  onCancel(): void;
  onNewChat(): Promise<void>;
  onOpenSettings?(): void;
  onReconnect?(): void | Promise<void>;
  onListConversations?(cursor?: string): Promise<CodexConversationPage>;
  onSelectConversation?(id: string): Promise<void>;
  onOpenConversationInCodex?(id: string): Promise<void>;
  onLoadOlderMessages?(): Promise<void>;
  onRevealSource?(selection: CodexSelection): Promise<void>;
  context?: ExtensionContext;
}
const labels = {
  en: { newChat: 'New conversation', settings: 'Codex Assistant settings', close: 'Close', send: 'Send', stop: 'Stop generating', queue:'Queue', steer:'Steer now', showMore:'Show more', showLess:'Show less', queued:'Queued messages', queuePaused:'Queue paused', resumeQueue:'Resume queue', editQueued:'Edit queued message', removeQueued:'Remove queued message', queuedSource:'Captured context', steeringUnavailable:'Steering is unavailable for this connection. Queue a follow-up instead.', queueEditingBlocked:'Keep or send your current draft before editing a queued message.', queuedFailed:'Not sent again. Review the conversation before editing or removing this item.',
    input: 'Ask about your project…', empty: 'Select a passage in the editor, then ask a question here.',
    cacheSaved: 'Using the complete project saved on Overleaf. Unsaved editor changes could not be verified; wait for Overleaf to save, then sync the project cache if needed.',
    cacheStale: 'Recent edits may not be in the project cache yet. To sync manually, go to Settings → Extension → Codex Assistant → Sync project cache.',
    cacheError: 'The project cache could not be read or restored. Sync it manually in Settings → Extension → Codex Assistant → Sync project cache.',
    dismissCacheNotice: 'Dismiss this notice',
    removeSelection: 'Remove selected passage', selected: 'Selected passage', user: 'You',
    quoteAnswer: 'Quote selected text', answerSource: 'Codex answer', removeAnswerQuote: 'Remove quoted answer', expandAnswerQuote: 'Show full quoted answer', collapseAnswerQuote: 'Collapse quoted answer',
    thinking: 'Thinking…', resize: 'Resize Codex Assistant', failed: 'Unable to send the message.',
    newFailed: 'Unable to start a new conversation.', selectionSource: 'Selected source',
    goToSource: 'Go to source', sourceLoading: 'Finding the quoted message…', sourceMissing: 'The quoted source is no longer available in this conversation.', sourceAmbiguous: 'Several messages match this quote. The original cannot be identified safely.', sourceBusy: 'The source is in earlier messages. Try again when the current reply finishes.', sourceMore: 'The source is further back. Load earlier messages, then try again.', sourceFailed: 'Unable to return to the quoted source.',
    expandSelection: 'Show full selected passage', collapseSelection: 'Collapse selected passage', latest: 'Jump to latest',
    history: 'Conversation history', back: 'Back to conversation', earlier: 'Load earlier messages', loadingEarlier: 'Loading earlier messages…', earlierFailed: 'Unable to load earlier messages.', retry: 'Retry', moveLeft: 'Move panel to the left', moveRight: 'Move panel to the right', positionFailed: 'Unable to save panel position.', copySource: 'Copy source (Markdown / LaTeX)', copied: 'Copied', copyFailed: 'Unable to copy. Check clipboard access.', remoteActive: 'Codex desktop is replying…', remoteUnknown: 'Sync temporarily unavailable. Retrying automatically…', remotePending: 'Waiting for the other page. Sync will resume automatically.' },
  zh: { newChat: '新建对话', settings: 'Codex Assistant 设置', close: '关闭', send: '发送', stop: '停止生成', queue:'排队', steer:'立即引导', showMore:'展开', showLess:'收起', queued:'排队消息', queuePaused:'队列已暂停', resumeQueue:'继续队列', editQueued:'编辑排队消息', removeQueued:'移除排队消息', queuedSource:'已保存上下文', steeringUnavailable:'当前连接不支持引导，请将追问加入队列。', queueEditingBlocked:'请先保留或发送当前草稿，再编辑排队消息。', queuedFailed:'没有自动重发。请检查对话后编辑或移除此项。',
    input: '向 Codex 提问…', empty: '在编辑器中选中一段内容，然后在这里提问。',
    cacheSaved: '已使用 Overleaf 上保存的完整项目，暂未确认编辑器中尚未保存的修改。请等待 Overleaf 保存完成，必要时同步项目缓存。',
    cacheStale: '检测到修改，项目缓存可能尚未同步。请前往 Settings → Extension → Codex Assistant → Sync project cache 手动同步。',
    cacheError: '项目缓存读取或恢复失败。请前往 Settings → Extension → Codex Assistant → Sync project cache 手动同步。',
    dismissCacheNotice: '关闭本次提示',
    removeSelection: '移除引用选区', selected: '已引用选区', user: '你',
    quoteAnswer: '引用所选内容', answerSource: 'Codex 回答', removeAnswerQuote: '移除回答引用', expandAnswerQuote: '展开完整回答引用', collapseAnswerQuote: '收起回答引用',
    thinking: '正在思考…', resize: '调整 Codex Assistant 宽度', failed: '暂时无法发送问题。',
    newFailed: '暂时无法新建对话。', selectionSource: '选中的原文',
    goToSource: '回到引用位置', sourceLoading: '正在查找被引用的消息…', sourceMissing: '当前对话中已找不到这条引用的原始消息。', sourceAmbiguous: '有多条消息与引用相同，无法确定原始位置。', sourceBusy: '引用位于更早的消息中，请在当前回复完成后重试。', sourceMore: '引用位于更早的历史中，请加载更早的消息后重试。', sourceFailed: '暂时无法回到引用位置。',
    expandSelection: '展开完整选区', collapseSelection: '收起选区', latest: '回到最新回复',
    history: '对话历史', back: '返回对话', earlier: '加载更早的消息', loadingEarlier: '正在读取更早的消息…', earlierFailed: '暂时无法读取更早的消息。', retry: '重试', moveLeft: '将面板移到左侧', moveRight: '将面板移到右侧', positionFailed: '暂时无法保存面板位置。', copySource: '复制原文（Markdown / LaTeX）', copied: '已复制', copyFailed: '暂时无法复制，请检查剪贴板权限。', remoteActive: 'Codex 桌面端正在回复…', remoteUnknown: '暂时无法同步，正在自动重试…', remotePending: '正在等待另一个页面，随后会自动同步。' },
};
type IconName = 'close' | 'new' | 'send' | 'stop' | 'settings' | 'history' | 'back' | 'position' | 'copy' | 'check' | 'source';
const icons: Record<IconName, string[]> = {
  close: ['m6 6 12 12', 'M18 6 6 18'],
  new: ['M20 14v6H4V4h9', 'm13 6 5-5 5 5-5 5', 'm12 12 6-6'],
  send: ['m5 3 16 9-16 9 3-9-3-9', 'M8 12h13'],
  stop: ['M6 6h12v12H6Z'],
  settings: ['M4 7h16', 'M4 17h16', 'M8 4v6', 'M16 14v6'],
  history: ['M12 3a9 9 0 1 1-9 9 9 9 0 0 1 9-9', 'M12 7v5l3 2'],
  back: ['m14 5-7 7 7 7', 'M7 12h14'],
  position: ['M3 4h18v16H3Z', 'M15 4v16'],
  copy: ['M9 8h11v13H9Z', 'M15 8V3H4v13h5'],
  check: ['m5 12 4 4L19 6'],
  source: ['M19 20v-7a4 4 0 0 0-4-4H5', 'm10 4-5 5 5 5'],
};
function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of icons[name]) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
}

/** Mounts only beside a detected Overleaf rail. No fixed overlay covers source. */
export function mountCodexAssistant(options: CodexPanelOptions) {
  const context = options.context ?? createExtensionContext();
  let destroyed = false, isOpen = false, busy = false, sending = false;
  let followupSubmitting = false, canSteer = false;
  let queued: readonly QueuedPrompt[] = [], queuePaused = false;
  let busyKind: 'generation' | 'history' = 'generation';
  let remoteState: 'idle' | 'active' | 'unknown' = 'idle';
  let remoteSyncPending = false;
  let cacheNoticeKind: 'stale' | 'error' | 'saved' | null = null;
  let cacheNoticeDismissed = false;
  let selected: CodexSelection | undefined;
  let answerQuote: CodexAnswerQuote | undefined, answerQuoteExpanded = false;
  let quoteCandidate: { value: CodexAnswerQuote; body: HTMLElement } | undefined;
  let quoteFrame = 0;
  let dismissedQuoteRange: Range | undefined;
  let selectionExpanded = false, statusMessage = '', width = 340, mountQueued = false;
  let connectionState: CodexConnectionState = { state: 'unknown' }, reconnectPending = false;
  let connectionProviderId = options.getSettings().providerId, announcedConnection = '';
  let followLatest = true, lastScrollTop = 0, layoutDepth = 0;
  let showingConversations = false, historySwitching = false, loadingOlder = false;
  let position: 'left' | 'right' = options.position === 'right' ? 'right' : 'left', moving = false;
  let historyPaging: { hasOlder: boolean; loading?: boolean; error?: string } = { hasOlder: false };
  let sourceRequest = 0, sourceLoading = false, sourceScrolling = false, sourcePausedFollowing = false;
  let manuscriptSourcePending = false;
  let sourceState: 'sourceLoading' | 'sourceMissing' | 'sourceAmbiguous' | 'sourceBusy' | 'sourceMore' | 'sourceFailed' | undefined;
  let sourceError = '';
  let draftAnswerOrigin: Message | undefined;
  let draftOriginQuote: CodexAnswerQuote | undefined;
  let highlightedSource: HTMLElement | undefined, sourceHighlightTimer: ReturnType<typeof setTimeout> | undefined;
  let finishSourceScroll: (() => void) | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let tooltipTimer: ReturnType<typeof setTimeout> | undefined;
  let tooltipTarget: HTMLElement | undefined;
  let resizeCleanup: (() => void) | undefined;
  let themeBody: HTMLElement | undefined;
  let formulaClickTimer: ReturnType<typeof setTimeout> | undefined;
  let formulaGesture: { formula: HTMLElement; x: number; y: number; dragged: boolean } | undefined;
  const copyTimers = new Set<ReturnType<typeof setTimeout>>();
  type Message = CodexPanelMessage & { element: HTMLElement; body: HTMLElement; roleName: HTMLElement; activity: HTMLElement; quote?: HTMLDetailsElement; answerCard?: HTMLDetailsElement; copy?: HTMLButtonElement; expand?:HTMLButtonElement; userExpanded?:boolean; dispose?: () => void };
  const messages: Message[] = [];
  const userSizeObserver=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(entries=>{for(const entry of entries){const message=messages.find(message=>message.body===entry.target);if(message)updateUserOverflow(message);}});
  const baselineIndex = emptyIndex();
  let mathIndex: ProjectIndex | undefined;
  const formulaCache = new Map<string, Promise<string>>();
  let renderer: Promise<typeof import('../preview/render')> | undefined;
  const text = () => labels[getLocale()];
  const alive = () => !destroyed && context.alive();
  const style = node('style'); style.dataset.optCodexStyle = ''; style.textContent = codexPanelStyles + mathFeedbackStyles;
  const button = node('button', 'ide-rail-tab-link nav-link');
  button.id = 'opt-codex-tab'; button.type = 'button'; button.setAttribute('role', 'tab');
  button.setAttribute('aria-label', 'Codex Assistant');
  button.setAttribute('aria-controls', 'opt-codex-panel'); button.setAttribute('aria-selected', 'false');
  const logo = node('img', 'opt-codex-logo'); logo.src = context.assetURL('assets/codex-app.png') || '';
  logo.alt = ''; logo.setAttribute('aria-hidden', 'true'); button.append(logo);
  const panel = node('section'); panel.id = 'opt-codex-panel'; panel.hidden = true;
  panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
  const header = node('header', 'opt-codex-header');
  const title = node('h2', 'opt-codex-title', 'Codex Assistant');
  const iconButton = (name: IconName) => {
    const control = node('button', 'opt-codex-icon-button'); control.type = 'button'; control.append(icon(name)); return control;
  };
  const newChat = iconButton('new'), historyButton = iconButton('history'), backButton = iconButton('back'), settings = iconButton('settings'), closeButton = iconButton('close');
  const positionButton = iconButton('position'); positionButton.hidden = !options.onPositionChange;
  historyButton.hidden = !options.onListConversations || !options.onSelectConversation; backButton.hidden = true;
  settings.hidden = !options.onOpenSettings; header.append(backButton, title, newChat, historyButton, positionButton, settings, closeButton);
  const history = node('div', 'opt-codex-history');
  const transcript = node('div', 'opt-codex-messages'); transcript.tabIndex = 0; transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-live', 'off');
  const earlier = node('div', 'opt-codex-earlier'); earlier.hidden = true;
  const earlierButton = node('button', 'opt-codex-history-more'); earlierButton.type = 'button';
  const earlierStatus = node('span', 'opt-codex-earlier-status'); earlierStatus.setAttribute('role', 'status'); earlierStatus.setAttribute('aria-live', 'polite');
  earlier.append(earlierButton, earlierStatus);
  const empty = node('p', 'opt-codex-empty'); transcript.append(earlier, empty);
  const latest = node('button', 'opt-codex-latest'); latest.type = 'button'; latest.hidden = true; history.append(transcript, latest);
  const compose = node('form', 'opt-codex-compose');
  const remoteStatus = node('div', 'opt-codex-remote-status'); remoteStatus.hidden = true;
  remoteStatus.setAttribute('role', 'status'); remoteStatus.setAttribute('aria-live', 'polite');
  const cacheNotice = node('div', 'opt-codex-cache-notice'); cacheNotice.hidden = true;
  cacheNotice.setAttribute('role', 'status'); cacheNotice.setAttribute('aria-live', 'polite'); cacheNotice.setAttribute('aria-atomic', 'true');
  const cacheNoticeText = node('span', 'opt-codex-cache-notice-text');
  const dismissCacheNotice = iconButton('close');dismissCacheNotice.classList.add('opt-codex-cache-dismiss');
  cacheNotice.append(cacheNoticeText,dismissCacheNotice);
  const selectionCard = node('div', 'opt-codex-selection'); selectionCard.hidden = true;
  const selectionHeading = node('div', 'opt-codex-selection-heading');
  const selectionLabel = node('button', 'opt-codex-selection-label'); selectionLabel.type = 'button';
  const removeSelection = iconButton('close'), revealSelection = iconButton('source'); revealSelection.classList.add('opt-codex-source-button');
  revealSelection.dataset.sourceKind = 'manuscript';
  const selectionSource = node('div', 'opt-codex-selection-source');
  selectionHeading.append(selectionLabel, revealSelection, removeSelection); selectionCard.append(selectionHeading, selectionSource);
  const quoteSelected = node('button', 'opt-codex-quote-selected'); quoteSelected.type = 'button'; quoteSelected.hidden = true;
  const answerCard = node('div', 'opt-codex-selection opt-codex-answer-quote'); answerCard.hidden = true;
  const answerHeading = node('div', 'opt-codex-selection-heading');
  const answerLabel = node('button', 'opt-codex-selection-label'); answerLabel.type = 'button';
  const removeAnswer = iconButton('close'), revealAnswer = iconButton('source'), answerSource = node('div', 'opt-codex-selection-source'); revealAnswer.classList.add('opt-codex-source-button');
  answerHeading.append(answerLabel, revealAnswer, removeAnswer); answerCard.append(answerHeading, answerSource);
  const queueView = node('section', 'opt-codex-queue'); queueView.hidden = true;
  const queueHeading = node('div', 'opt-codex-queue-heading'), queueTitle = node('span'), queueResume = node('button', 'opt-codex-queue-action'); queueResume.type = 'button';
  const queueList = node('ol', 'opt-codex-queue-list'); queueHeading.append(queueTitle, queueResume); queueView.append(queueHeading, queueList);
  const inputWrap = node('div', 'opt-codex-input-wrap');
  const input = node('textarea'); input.id = 'opt-codex-input'; input.name = 'question'; input.rows = 3; input.maxLength = 16_000;
  const inputLabel = node('label', 'opt-codex-input-label'); inputLabel.htmlFor = input.id;
  const actions = node('div', 'opt-codex-input-actions');
  const status = node('span', 'opt-codex-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const connection = node('button', 'opt-codex-connection'); connection.type = 'button';
  const connectionDot = node('span', 'opt-codex-connection-dot'); connectionDot.setAttribute('aria-hidden', 'true');
  const connectionLabel = node('span', 'opt-codex-connection-label'); connection.append(connectionDot, connectionLabel);
  const connectionAnnouncement = node('span', 'opt-codex-connection-announcement');
  connectionAnnouncement.setAttribute('role', 'status'); connectionAnnouncement.setAttribute('aria-live', 'polite'); connectionAnnouncement.setAttribute('aria-atomic', 'true');
  const send = iconButton('send'), stop = iconButton('stop'); send.type = 'submit';
  const submitActions = node('div', 'opt-codex-submit-actions');
  const sourceNotice = node('div', 'opt-codex-source-notice'); sourceNotice.hidden = true; sourceNotice.setAttribute('role', 'status'); sourceNotice.setAttribute('aria-live', 'polite');
  submitActions.append(send, stop); actions.append(status, connection, connectionAnnouncement, submitActions); inputWrap.append(inputLabel, input, actions); compose.append(remoteStatus, cacheNotice, queueView, quoteSelected, selectionCard, answerCard, sourceNotice, inputWrap);
  const resize = node('div', 'opt-codex-resize'); resize.tabIndex = 0;
  resize.setAttribute('role', 'separator'); resize.setAttribute('aria-orientation', 'vertical');
  const copyNotice = node('span', 'opt-codex-copy-notice'); copyNotice.setAttribute('role', 'status'); copyNotice.setAttribute('aria-live', 'polite');
  panel.append(header, history, compose, resize, copyNotice);
  const selectionFeedback=createMathSelectionFeedback(transcript,{enabled:()=>alive() && isOpen && !showingConversations});
  const copyToast=createFormulaCopyToast(panel);
  const tooltip = node('div', 'opt-codex-tooltip'); tooltip.id = 'opt-codex-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  const conversations = options.onListConversations && options.onSelectConversation ? createConversationHistory({
    list: options.onListConversations, select: options.onSelectConversation, openInCodex: options.onOpenConversationInCodex,
    canOpenInCodex: () => !options.getSettings().providerId,
    onSelected: changed => { showConversation(); if (changed) { followLatest = true; scrollToLatest(); } },
    onSwitching: value => { historySwitching = value; updateLabels(); }, bindTooltip,
  }) : undefined;
  if (conversations) history.after(conversations.element);

  function hideTooltip() {
    clearTimeout(tooltipTimer); tooltipTimer = undefined;
    tooltipTarget?.removeAttribute('aria-describedby'); tooltipTarget = undefined; tooltip.hidden = true;
  }
  function showTooltip(target: HTMLElement, right: boolean) {
    if (!alive() || !target.isConnected || target.hidden || (target as HTMLButtonElement).disabled) return;
    const label = target.dataset.tooltip || target.getAttribute('aria-label'); if (!label) return;
    hideTooltip(); tooltipTarget = target; tooltip.textContent = label; tooltip.hidden = false;
    if (!tooltip.isConnected) document.body.append(tooltip);
    tooltip.style.fontFamily = panel.style.fontFamily || getComputedStyle(target).fontFamily;
    const rect = target.getBoundingClientRect(), tip = tooltip.getBoundingClientRect();
    const left = right ? rect.right + 9 : rect.left + (rect.width - tip.width) / 2;
    let top = right ? rect.top + (rect.height - tip.height) / 2 : rect.bottom + 8;
    if (top + tip.height > window.innerHeight - 6) top = rect.top - tip.height - 8;
    tooltip.style.left = `${Math.max(6, Math.min(left, window.innerWidth - tip.width - 6))}px`;
    tooltip.style.top = `${Math.max(6, top)}px`;
    target.setAttribute('aria-describedby', tooltip.id);
  }
  function bindTooltip(target: HTMLElement, right = false) {
    target.addEventListener('pointerenter', () => { hideTooltip(); tooltipTimer = setTimeout(() => showTooltip(target, right), 250); });
    target.addEventListener('pointerleave', hideTooltip);
    target.addEventListener('focus', () => showTooltip(target, right));
    target.addEventListener('blur', hideTooltip);
    target.addEventListener('click', hideTooltip);
    target.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
  }
  for (const control of [newChat, historyButton, backButton, positionButton, settings, closeButton, dismissCacheNotice, removeSelection, send, stop, connection, selectionLabel, answerLabel, removeAnswer, revealSelection, revealAnswer, resize]) bindTooltip(control);
  bindTooltip(button, true);
  function setLabel(control: HTMLElement, value: string) { control.setAttribute('aria-label', value); control.removeAttribute('title'); }
  function cancelFormulaClick() { clearTimeout(formulaClickTimer); formulaClickTimer = undefined; formulaGesture = undefined; }
  async function copyFormula(formula: HTMLElement) {
    const source = getRenderedMathSource(formula);
    if (!alive() || !isOpen || !options.getSettings().clickToCopy || !formula.isConnected || !source) return;
    copyNotice.textContent = '';
    let copied = true;
    try { await writeClipboardText(source.source); } catch { copied = false; }
    if (!alive() || !formula.isConnected) return;
    copyNotice.textContent = copied ? text().copied : text().copyFailed;
    formula.dataset.copyFeedback = copied ? 'copied' : 'error';
    if(copied && options.getSettings().copyToast)copyToast.show(formula,getLocale()==='zh'?'公式已复制':'Formula copied');
    const timer = setTimeout(() => { copyTimers.delete(timer); delete formula.dataset.copyFeedback; copyNotice.textContent = ''; }, 1100);
    copyTimers.add(timer);
  }
  async function copyValue(value: string, control: HTMLButtonElement) {
    try {
      await writeClipboardText(value); if (!alive() || !control.isConnected) return;
      control.dataset.copied = 'true'; setLabel(control, text().copied);
      control.replaceChildren(icon('check'));
      showTooltip(control, false);
      const timer = setTimeout(() => {
        copyTimers.delete(timer); delete control.dataset.copied;
        if (!alive()) return;
        control.replaceChildren(icon('copy'));
        hideTooltip(); updateLabels();
      }, 1500); copyTimers.add(timer);
    } catch { if (alive()) { statusMessage = text().copyFailed; updateLabels(); } }
  }
  function location(selection: CodexSelection) {
    const lines = selection.startLine === selection.endLine ? String(selection.startLine) : `${selection.startLine}–${selection.endLine}`;
    return selection.path ? `${selection.path} · ${lines}` : text().selected;
  }
  function updateFollowing() { latest.hidden = followLatest || !messages.length || !!quoteCandidate; }
  let historyProviderId: string | undefined;
  const assistantName = () => options.getSettings().providerId ? options.getSettings().providerName || 'API Assistant' : 'Codex';
  function updateConnection() {
    const providerId = options.getSettings().providerId;
    if (connectionProviderId !== providerId) {
      connectionProviderId = providerId; connectionState = { state: 'unknown' }; announcedConnection = '';
      connectionAnnouncement.textContent = '';
    }
    const zh = getLocale() === 'zh', projectMode=options.getSettings().contextMode==='project';
    const cacheBlocked=projectMode&&cacheNoticeKind==='error';
    const readerBlocked=projectMode&&!providerId&&connectionState.state==='connected'&&connectionState.projectReaderReady!==true;
    const blocked=(cacheBlocked||readerBlocked)&&!['offline','auth-required'].includes(connectionState.state);
    const words = zh
      ? { unknown: '未检查', checking: '检查中', connected: providerId?'已连接':'本机后台已检查', reconnecting: '重连中', offline: '连接中断', 'auth-required': '请登录',blocked:cacheBlocked?'项目同步失败':connectionState.projectReaderReady===false?'项目读取不可用':'项目读取待检查' }
      : { unknown: 'Not checked', checking: 'Checking', connected: providerId?'Connected':'Local service checked', reconnecting: 'Reconnecting', offline: 'Disconnected', 'auth-required': 'Sign in',blocked:cacheBlocked?'Project sync failed':connectionState.projectReaderReady===false?'Project reader unavailable':'Project reader not verified' };
    const state = blocked?'blocked':connectionState.state;
    const label = `${assistantName()} · ${!blocked&&connectionState.message?.slice(0, 80) || words[state]}`;
    const disabled = !options.onReconnect || reconnectPending || connectionState.state === 'checking' || connectionState.state === 'reconnecting';
    connection.dataset.state = state; connection.setAttribute('aria-disabled', String(disabled));
    if (connectionLabel.textContent !== label) connectionLabel.textContent = label;
    setLabel(connection, label);
    const serviceDetail=!providerId&&connectionState.connectionKind==='standalone'
      ? zh?'已检查扩展启动的独立 Codex CLI 后台，与 Codex 桌面窗口是否打开无关。此检查未运行模型推理，也不代表当前问题已经成功发送。':'Checked the independent Codex CLI service started by this extension. It does not depend on the Codex desktop window being open. This check did not run model inference or confirm that the current question was sent.' : '';
    const blockedDetail=cacheBlocked?text().cacheError:readerBlocked?connectionState.readerError||(zh?'本机连接尚未验证项目读取工具，请更新辅助程序后重新检查。普通上下文仍可使用。':'The local connection has not verified project reading tools. Update the helper and check again. Normal context remains available.') : '';
    const checked=connectionState.checkedAt!==undefined?(zh?'最近检查：':'Last checked: ')+new Date(connectionState.checkedAt).toLocaleString():'';
    connection.dataset.tooltip = [blockedDetail,connectionState.detail?.slice(0, 800),serviceDetail,checked, options.onReconnect && !disabled ? zh ? '点击重新检查连接' : 'Click to check the connection again' : ''].filter(Boolean).join('\n') || label;
    // Only meaningful settled transitions are announced. Spinner states and
    // changing retry details stay visual, so streaming updates cannot chatter.
    if (['connected', 'offline', 'auth-required','blocked'].includes(state)) {
      const announcement = `${assistantName()} · ${words[state]}`;
      if (announcedConnection !== announcement) { announcedConnection = announcement; connectionAnnouncement.textContent = announcement; }
    }
  }
  const answerSourceLabel = () => options.getSettings().providerId ? getLocale()==='zh' ? '回答引用' : 'Quoted answer' : text().answerSource;
  const generating = () => busy && busyKind === 'generation';
  const steeringAvailable = () => generating() && canSteer && !options.getSettings().providerId;
  function submissionMode(): 'send' | 'queue' | 'steer' {
    if (!options.onQueue || !(generating() || remoteState === 'active' || queued.length)) return 'send';
    return options.getSettings().busyMessageBehavior === 'steer' && steeringAvailable() && options.onSteer ? 'steer' : 'queue';
  }
  function submissionBlocked() {
    return !alive() || !input.value.trim() || followupSubmitting || historySwitching || showingConversations || loadingOlder || !!historyPaging.loading
      || remoteState === 'unknown' || busy && busyKind === 'history' || submissionMode() === 'send' && (busy || sending || remoteState !== 'idle');
  }
  function updateLabels() {
    const t = text();
    if(!options.getSettings().copyToast || !isOpen)copyToast.hide();selectionFeedback.refresh();
    const providerId=options.getSettings().providerId;
    updateConnection();
    const customProvider=!!providerId;
    if(historyProviderId!==providerId){historyProviderId=providerId;cancelSourceNavigation();conversations?.update();}
    setLabel(newChat, t.newChat); setLabel(settings, t.settings); setLabel(closeButton, t.close);
    setLabel(historyButton, t.history); setLabel(backButton, t.back); title.textContent = showingConversations ? t.history : customProvider ? assistantName() : 'Codex Assistant';
    setLabel(positionButton, position === 'left' ? t.moveRight : t.moveLeft); positionButton.disabled = moving;
    positionButton.dataset.position = position;
    historyButton.hidden = !conversations || showingConversations; backButton.hidden = !showingConversations;
    historyButton.disabled = queued.length > 0 || busy || sending || historySwitching || loadingOlder || !!historyPaging.loading;
    backButton.disabled = historySwitching;
    const isGenerating = generating();
    remoteStatus.hidden = remoteState === 'idle';
    const remoteText = remoteState === 'active' ? customProvider ? (getLocale()==='zh' ? '正在回复…' : 'Replying…') : t.remoteActive : remoteState === 'unknown' ? remoteSyncPending ? t.remotePending : t.remoteUnknown : '';
    // Lock contention is ordinary waiting, not a repeating error announcement.
    remoteStatus.setAttribute('aria-live',remoteSyncPending?'off':'polite');
    if(remoteSyncPending)remoteStatus.removeAttribute('role');else remoteStatus.setAttribute('role','status');
    if(remoteStatus.textContent!==remoteText)remoteStatus.textContent=remoteText;
    const cacheText = cacheNoticeKind === 'stale' ? t.cacheStale : cacheNoticeKind === 'error' ? t.cacheError : cacheNoticeKind === 'saved' ? t.cacheSaved : '';
    // Meaningful state changes are announced once; streamed/status updates must
    // not repeatedly replace this persistent guidance or steal input focus.
    if(cacheNoticeText.textContent!==cacheText)cacheNoticeText.textContent=cacheText;
    if(dismissCacheNotice.getAttribute('aria-label')!==t.dismissCacheNotice)setLabel(dismissCacheNotice,t.dismissCacheNotice);
    const hideCacheNotice=!cacheNoticeKind || cacheNoticeDismissed;
    if(cacheNotice.hidden!==hideCacheNotice)cacheNotice.hidden=hideCacheNotice;
    panel.dataset.clickToCopy = String(!!options.getSettings().clickToCopy);
    if (!options.getSettings().clickToCopy) cancelFormulaClick();
    setLabel(removeSelection, t.removeSelection); setLabel(resize, t.resize); setLabel(send, t.send); setLabel(stop, t.stop);
    send.hidden=false; send.dataset.mode=submissionMode(); stop.hidden=!isGenerating; stop.disabled=false;
    renderQueue();
    latest.textContent = `↓ ${t.latest}`; input.placeholder = customProvider && getLocale()==='zh' ? '针对项目提问…' : t.input; inputLabel.textContent=input.placeholder; input.setAttribute('aria-label', input.placeholder); empty.textContent = t.empty;
    // Progress belongs beside the active assistant's name, never below the draft.
    status.textContent = busy ? '' : statusMessage; status.hidden = busy || !statusMessage;
    const active = messages.at(-1);
    for (const message of messages) {
      message.roleName.textContent = message.role === 'user' ? t.user : assistantName();
      const working = isGenerating && message === active && message.role === 'assistant';
      message.activity.hidden = !working; message.activity.textContent = working ? statusMessage || t.thinking : '';
      if (message.quote) message.quote.setAttribute('aria-label', t.selectionSource);
      if (message.answerCard) { message.answerCard.setAttribute('aria-label', answerSourceLabel()); message.answerCard.querySelector('summary > span')!.textContent = answerSourceLabel(); }
      if(message.expand){message.expand.textContent=message.userExpanded?t.showLess:t.showMore;message.expand.setAttribute('aria-expanded',String(!!message.userExpanded));}
      if (message.copy) { setLabel(message.copy, message.copy.dataset.copied ? t.copied : t.copySource); message.copy.disabled = !message.text; }
    }
    send.disabled = submissionBlocked();
    removeSelection.disabled = busy && busyKind === 'history';
    newChat.disabled = queued.length > 0 || busy || sending || historySwitching || loadingOlder || !!historyPaging.loading;
    earlier.hidden = !options.onLoadOlderMessages || !(historyPaging.hasOlder || historyPaging.error || historyPaging.loading || loadingOlder);
    earlierButton.textContent = historyPaging.error ? t.retry : t.earlier;
    earlierButton.disabled = busy || sending || historySwitching || loadingOlder || !!historyPaging.loading;
    earlierStatus.textContent = historyPaging.error || (loadingOlder || historyPaging.loading ? t.loadingEarlier : '');
    earlierStatus.hidden = !earlierStatus.textContent;
    conversations?.setBusy(busy || sending || loadingOlder || !!historyPaging.loading);
    quoteSelected.textContent = t.quoteAnswer;
    quoteSelected.hidden = !quoteCandidate || !isOpen || showingConversations;
    quoteSelected.disabled = historySwitching || busy && busyKind === 'history';
    sourceNotice.textContent = sourceError || (sourceState ? t[sourceState] : ''); sourceNotice.hidden = !sourceNotice.textContent;
    for (const control of panel.querySelectorAll<HTMLButtonElement>('.opt-codex-source-button')) {
      setLabel(control, t.goToSource);
      control.disabled = historySwitching || busy && busyKind === 'history' || sourceLoading || control.dataset.sourceKind === 'manuscript' && !options.onRevealSource;
    }
    setLabel(removeAnswer, t.removeAnswerQuote); removeAnswer.disabled = busy && busyKind === 'history';
    answerCard.hidden = !answerQuote;
    if (answerQuote) {
      answerLabel.textContent = answerSourceLabel(); setLabel(answerLabel, answerQuoteExpanded ? t.collapseAnswerQuote : t.expandAnswerQuote);
      answerLabel.setAttribute('aria-expanded', String(answerQuoteExpanded)); answerCard.classList.toggle('expanded', answerQuoteExpanded);
      answerSource.textContent = answerQuote.text; answerSource.setAttribute('aria-label', answerSourceLabel());
    }
    selectionCard.hidden = !selected;
    if (selected) {
      selectionLabel.textContent = location(selected); setLabel(selectionLabel, selectionExpanded ? t.collapseSelection : t.expandSelection);
      selectionLabel.setAttribute('aria-expanded', String(selectionExpanded)); selectionCard.classList.toggle('expanded', selectionExpanded);
      selectionSource.textContent = selected.text; selectionSource.setAttribute('aria-label', t.selectionSource);
    }
    updateFollowing();
    if (tooltipTarget?.matches(':disabled')) hideTooltip();
    else if (tooltipTarget && !tooltip.hidden) tooltip.textContent = tooltipTarget.getAttribute('aria-label') || '';
  }
  function updateTheme() {
    const rail = document.querySelector<HTMLElement>('nav.ide-rail');
    const reference = document.querySelector<HTMLElement>('.ide-rail-content') ?? rail;
    if (!reference) return;
    const computed = getComputedStyle(reference);
    panel.style.fontFamily = computed.fontFamily || getComputedStyle(document.body).fontFamily;
    panel.style.fontSize = computed.fontSize || getComputedStyle(document.body).fontSize;
    const nativeTitle = document.querySelector<HTMLElement>('#ide-rail-tabs-tabpane-workbench h4');
    if (nativeTitle) panel.style.setProperty('--opt-codex-title-size', getComputedStyle(nativeTitle).fontSize);
    if (computed.color) panel.style.setProperty('--opt-codex-fg', computed.color);
    for (let current: HTMLElement | null = reference; current; current = current.parentElement) {
      const background = getComputedStyle(current).backgroundColor;
      if (background && !['transparent', 'rgba(0, 0, 0, 0)'].includes(background)) {
        panel.style.setProperty('--opt-codex-bg', background);
        const channels = background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        const light = channels && channels.reduce((sum, n) => sum + n, 0) > 450;
        panel.style.setProperty('--opt-codex-muted', light ? '#687482' : '#a5afbc'); panel.style.setProperty('--opt-codex-border', light ? '#d9dfe5' : '#354252'); break;
      }
    }
  }
  function mount() {
    mountQueued = false;
    if (!alive()) { destroy(); return; }
    if (themeBody !== document.body) {
      themeObserver.disconnect(); themeBody = document.body;
      const config = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme'] };
      themeObserver.observe(document.documentElement, config);
      if (themeBody) themeObserver.observe(themeBody, config);
    }
    const rail = document.querySelector<HTMLElement>('nav.ide-rail'), wrapper = rail?.querySelector<HTMLElement>('.ide-rail-tabs-wrapper');
    const layout = rail?.closest<HTMLElement>('.ide-redesign-inner'); if (!rail || !wrapper || !layout) return;
    if (!style.isConnected) document.head.append(style);
    const ai = wrapper.querySelector<HTMLElement>('#ide-rail-tabs-tab-workbench');
    if (ai) { if (ai.nextElementSibling !== button) ai.after(button); } else if (button.parentElement !== wrapper) wrapper.append(button);
    panel.dataset.position = position;
    if (position === 'right') { if (panel.parentElement !== layout || layout.lastElementChild !== panel) layout.append(panel); }
    else if (panel.parentElement !== layout || rail.nextElementSibling !== panel) rail.after(panel);
    button.hidden = !options.getSettings().enabled; if (button.hidden) close(); updateTheme();
  }
  function queueMount() { if (destroyed || mountQueued) return; mountQueued = true; queueMicrotask(mount); }
  function open() {
    if (!alive() || !options.getSettings().enabled) return; mount(); if (!panel.isConnected || isOpen) return;
    if (position === 'left') document.querySelector<HTMLButtonElement>('nav.ide-rail .ide-rail-tabs-wrapper button.open-rail:not(#opt-codex-tab)')?.click();
    isOpen = true; panel.hidden = false; button.classList.add('open-rail'); button.setAttribute('aria-selected', 'true');
    document.dispatchEvent(new CustomEvent('opt:request-selection'));
    applyWidth(width); updateTheme(); if (showingConversations) backButton.focus(); else input.focus();
    selectionFeedback.refresh();options.onVisibilityChange?.(true);
  }
  function showConversation() {
    showingConversations = false; conversations?.hide(); history.hidden = false; compose.hidden = false;
    updateLabels(); input.focus();
  }
  function showConversations() {
    if (!conversations || busy || sending || historySwitching || loadingOlder || historyPaging.loading) return;
    clearQuoteCandidate(); showingConversations = true; history.hidden = true; compose.hidden = true; hideTooltip(); cancelFormulaClick();
    conversations.show(); updateLabels(); backButton.focus();
  }
  function close() { clearQuoteCandidate(); const wasOpen = isOpen; isOpen = false; selectionFeedback.refresh();copyToast.hide();panel.hidden = true; button.classList.remove('open-rail'); button.setAttribute('aria-selected', 'false'); resizeCleanup?.(); hideTooltip(); cancelFormulaClick(); if (wasOpen) options.onVisibilityChange?.(false); }
  function nativeNavigation(event: MouseEvent) {
    if (!isOpen || position === 'right' || !(event.target instanceof Element)) return;
    // Revealing a source may temporarily mount Overleaf's native file tree.
    // Its synthetic rail clicks must not close this panel; user clicks still do.
    if (sourceLoading && !event.isTrusted) return;
    const target = event.target.closest('nav.ide-rail button'); if (target && target !== button && target.closest('.ide-rail-tabs-wrapper')) close();
  }
  function applyWidth(value: number) {
    withViewport(() => {
      width = Math.max(250, Math.min(value, Math.max(250, Math.min(720, window.innerWidth * .65))));
      panel.style.setProperty('--opt-codex-width', `${width}px`); resize.setAttribute('aria-valuenow', String(Math.round(width)));
      resize.setAttribute('aria-valuemin', '250'); resize.setAttribute('aria-valuemax', '720');
    });
  }
  function beginResize(event: PointerEvent) {
    if (event.button !== 0) return; event.preventDefault(); const start = event.clientX, initial = width;
    const direction = position === 'right' ? -1 : 1;
    const move = (next: PointerEvent) => applyWidth(initial + (next.clientX - start) * direction);
    const finish = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish); resizeCleanup = undefined; };
    resizeCleanup?.(); resizeCleanup = finish; document.addEventListener('pointermove', move); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish);
  }
  function setPosition(value: 'left' | 'right') {
    if (!alive()) return;
    const next = value === 'right' ? 'right' : 'left'; if (position === next) return;
    resizeCleanup?.(); hideTooltip(); cancelFormulaClick();
    if (next === 'left' && isOpen) document.querySelector<HTMLButtonElement>('nav.ide-rail .ide-rail-tabs-wrapper button.open-rail:not(#opt-codex-tab)')?.click();
    withViewport(() => { position = next; mount(); updateLabels(); });
  }
  function interruptSourceScroll() {
    if (!sourceScrolling) return;
    sourceRequest++; sourceScrolling = false; finishSourceScroll?.();
  }
  function scrollToLatest() { interruptSourceScroll(); sourcePausedFollowing = false; transcript.scrollTop = transcript.scrollHeight; lastScrollTop = transcript.scrollTop; updateFollowing(); }
  function withViewport(mutate: () => void) {
    if (layoutDepth) { mutate(); return; }
    const previousTop = transcript.scrollTop, bounds = transcript.getBoundingClientRect();
    // Prefer the first block/formula that starts inside the viewport. A tall
    // outer list item can cover the whole viewport while its own top never
    // moves as an earlier formula inside it grows, so it is not an anchor.
    const visible = !followLatest ? [...transcript.querySelectorAll<HTMLElement>('.opt-codex-message-body p,.opt-codex-message-body pre,.opt-codex-message-body .opt-codex-math,.opt-codex-message-role')]
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) : [];
    const anchor = (visible.find(({ rect }) => rect.top >= bounds.top) ?? visible.at(-1))?.element;
    const anchorTop = anchor?.getBoundingClientRect().top;
    layoutDepth++;
    try { mutate(); }
    finally {
      layoutDepth--;
      // Assigning scrollTop, even to its current value, cancels a native smooth
      // scroll. Streaming/render callbacks must not restore the old viewport
      // while source navigation owns the scroll; it rechecks its target below.
      if (sourceScrolling) { lastScrollTop = transcript.scrollTop; updateFollowing(); }
      else if (followLatest) scrollToLatest();
      else {
        transcript.scrollTop = anchor?.isConnected && anchorTop !== undefined ? previousTop + anchor.getBoundingClientRect().top - anchorTop : previousTop;
        lastScrollTop = transcript.scrollTop; updateFollowing();
      }
    }
  }
  function pauseFollowing() { followLatest = false; updateFollowing(); }
  transcript.addEventListener('wheel', event => { interruptSourceScroll(); if (event.deltaY < 0) pauseFollowing(); else if (event.deltaY > 0) sourcePausedFollowing = false; }, { passive: true });
  transcript.addEventListener('keydown', event => { if (['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) interruptSourceScroll(); if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollowing(); else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) sourcePausedFollowing = false; });
  transcript.addEventListener('pointerdown', interruptSourceScroll, { passive: true });
  let touchY = 0;
  transcript.addEventListener('touchstart', event => { interruptSourceScroll(); touchY = event.touches[0]?.clientY ?? 0; }, { passive: true });
  transcript.addEventListener('touchmove', event => { const next = event.touches[0]?.clientY ?? touchY; if (next > touchY) pauseFollowing(); else if (next < touchY) sourcePausedFollowing = false; touchY = next; }, { passive: true });
  transcript.addEventListener('scroll', () => {
    const top = transcript.scrollTop;
    if (!layoutDepth) {
      if (top < lastScrollTop - .5) followLatest = false;
      else if (!sourceScrolling && !sourcePausedFollowing && top > lastScrollTop + .5 && transcript.scrollHeight - top - transcript.clientHeight <= 3) followLatest = true;
    }
    lastScrollTop = top; updateFollowing(); hideTooltip(); cancelFormulaClick();
  }, { passive: true });
  function clearQuoteCandidate() {
    if (quoteFrame) cancelAnimationFrame(quoteFrame); quoteFrame = 0;
    quoteCandidate = undefined; quoteSelected.hidden = true; updateFollowing();
  }
  function dismissQuoteCandidate() {
    const selection = document.getSelection();
    dismissedQuoteRange = selection?.rangeCount === 1 ? selection.getRangeAt(0).cloneRange() : undefined;
    clearQuoteCandidate();
  }
  function refreshQuoteCandidate() {
    quoteFrame = 0;
    if (!alive() || !isOpen || showingConversations || historySwitching) { clearQuoteCandidate(); return; }
    // Keyboard focus on the action must not discard the selection it acts on.
    if (document.activeElement === quoteSelected && quoteCandidate?.body.isConnected) return;
    const selection = document.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount === 1 ? selection.getRangeAt(0) : undefined;
    if (range && dismissedQuoteRange && range.startContainer === dismissedQuoteRange.startContainer && range.startOffset === dismissedQuoteRange.startOffset && range.endContainer === dismissedQuoteRange.endContainer && range.endOffset === dismissedQuoteRange.endOffset) return;
    dismissedQuoteRange = undefined;
    const message = range && messages.find(message => message.role === 'assistant' && message.body.contains(range.startContainer) && message.body.contains(range.endContainer));
    const value = message && readRenderedSelection(message.body, range);
    const next = value && message ? { value: { text: value, ...(message.messageId ? { messageId: message.messageId } : {}) }, body: message.body } : undefined;
    if (quoteCandidate?.body === next?.body && quoteCandidate?.value.text === next?.value.text) return;
    if (next) pauseFollowing();
    withViewport(() => { quoteCandidate = next; updateLabels(); });
  }
  function scheduleQuoteCandidate() {
    if (!alive() || !isOpen || quoteFrame) return;
    quoteFrame = requestAnimationFrame(refreshQuoteCandidate);
  }
  document.addEventListener('selectionchange', scheduleQuoteCandidate);
  transcript.addEventListener('pointerup', scheduleQuoteCandidate);
  transcript.addEventListener('keyup', scheduleQuoteCandidate);
  quoteSelected.addEventListener('mousedown', event => event.preventDefault());
  quoteSelected.onclick = () => {
    const candidate = quoteCandidate;
    if (!alive() || !candidate?.body.isConnected || !messages.some(message => message.role === 'assistant' && message.body === candidate.body) || quoteSelected.disabled) return;
    answerQuote = { ...candidate.value }; answerQuoteExpanded = false; draftAnswerOrigin = messages.find(message => message.body === candidate.body); draftOriginQuote = answerQuote;
    dismissQuoteCandidate(); cancelFormulaClick(); withViewport(updateLabels); input.focus({ preventScroll: true });
  };
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') dismissQuoteCandidate(); });
  transcript.addEventListener('copy', event => { copyRenderedMathSelection(event, transcript); });
  const formulaFrom = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('.opt-codex-math') : undefined;
  transcript.addEventListener('pointerdown', event => {
    cancelFormulaClick();
    const formula = formulaFrom(event.target);
    if (options.getSettings().clickToCopy && event.button === 0 && formula) formulaGesture = { formula, x: event.clientX, y: event.clientY, dragged: false };
  });
  transcript.addEventListener('pointermove', event => {
    if (formulaGesture && Math.hypot(event.clientX - formulaGesture.x, event.clientY - formulaGesture.y) > 4) formulaGesture.dragged = true;
  });
  transcript.addEventListener('pointercancel', cancelFormulaClick);
  transcript.addEventListener('dblclick', cancelFormulaClick);
  transcript.addEventListener('click', event => {
    const formula = formulaFrom(event.target), gesture = formulaGesture; cancelFormulaClick();
    if (!options.getSettings().clickToCopy || !formula || event.button !== 0 || event.detail > 1 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || gesture?.dragged || gesture && gesture.formula !== formula || document.getSelection()?.isCollapsed === false) return;
    // Leave selection and double-click gestures to the browser. No overlay or
    // preventDefault is involved, even when optional single-click copy is on.
    formulaClickTimer = setTimeout(() => {
      formulaClickTimer = undefined;
      if (document.getSelection()?.isCollapsed !== false) void copyFormula(formula);
    }, 250);
  });
  transcript.addEventListener('keydown', event => {
    const formula = formulaFrom(event.target);
    if (options.getSettings().clickToCopy && formula && event.key === 'Enter' && !event.repeat) { event.preventDefault(); cancelFormulaClick(); void copyFormula(formula); }
  });
  latest.onclick = () => { followLatest = true; scrollToLatest(); };
  async function renderMath(source: string, display: boolean) {
    const index = options.getIndex?.() ?? baselineIndex;
    if (index !== mathIndex) { mathIndex = index; formulaCache.clear(); }
    const key = `${display}:${source}`; let result = formulaCache.get(key);
    if (!result) {
      result = (async () => { const url = context.assetURL('renderer.js'); if (!url) return ''; renderer ??= import(/* @vite-ignore */ url); return (await (await renderer).renderFormula(source, index, display, { tolerant: true })).svg; })().catch(() => '');
      if (formulaCache.size >= 96) formulaCache.delete(formulaCache.keys().next().value!); formulaCache.set(key, result);
    }
    return result;
  }
  function updateUserOverflow(message:Message){
    if(!alive() || !message.expand || !message.element.isConnected)return;
    const overflow=message.userExpanded || (message.body.clientHeight>0 ? message.body.scrollHeight>message.body.clientHeight+1 : message.text.length>240 || message.text.split('\n').length>6);
    message.expand.hidden=!overflow;
  }
  function renderMessage(message: Message) {
    if (quoteCandidate?.body === message.body) clearQuoteCandidate();
    message.dispose?.();
    if (message.role === 'user') {message.body.textContent = message.text;requestAnimationFrame(()=>updateUserOverflow(message));}
    else message.dispose = renderAssistantMessage(message.body, message.text, { renderMath, isCurrent: () => !destroyed, onLayout: withViewport });
  }
  function cancelSourceNavigation() {
    // A replaced chat invalidates lookup effects, but the native file navigator
    // still owns its temporary rail until its finally block finishes restoring it.
    sourceRequest++; sourceLoading = manuscriptSourcePending; sourceScrolling = false; sourceState = undefined; sourceError = '';
    finishSourceScroll?.();
    clearTimeout(sourceHighlightTimer); highlightedSource?.classList.remove('opt-codex-source-highlight'); highlightedSource = undefined;
  }
  function comparableQuote(value: string) {
    // Rendered selections preserve TeX. Treat delimiter spelling and paragraph
    // whitespace as equivalent, without guessing equivalent mathematical content.
    return value.replace(/\\[()[\]]|\${1,2}/g, '').replace(/\s+/g, ' ').trim();
  }
  function renderedText(element: HTMLElement) {
    const range = document.createRange(); range.selectNodeContents(element);
    return readRenderedSelection(element, range, 500_000) ?? element.textContent ?? '';
  }
  async function highlightAnswerSource(message: Message, value: CodexAnswerQuote, request: number) {
    const needle = comparableQuote(value.text);
    const firstLine = comparableQuote(value.text.split(/\r?\n/).find(line => line.trim()) ?? '');
    const sourceBlock = () => {
      const blocks = [...message.body.querySelectorAll<HTMLElement>('p,li,pre,blockquote,h3,h4,h5,h6,.opt-codex-math-display')];
      return blocks.find(block => needle && comparableQuote(renderedText(block)).includes(needle))
        ?? blocks.find(block => firstLine && comparableQuote(renderedText(block)).includes(firstLine)) ?? message.body;
    };
    let target = sourceBlock();
    pauseFollowing(); sourceScrolling = true; sourcePausedFollowing = true;
    const top = Math.max(0, transcript.scrollTop + target.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 24);
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    if (typeof transcript.scrollTo === 'function') {
      finishSourceScroll?.();
      const completion = transcript.scrollTo({ top, behavior }) as unknown;
      // Chrome 150+ returns a completion Promise. Earlier Chrome can wait for
      // scrollend with an idle fallback (also covers already-visible targets).
      if (completion && typeof (completion as Promise<void>).then === 'function') await completion;
      else if (behavior === 'smooth') await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => { clearTimeout(timer); transcript.removeEventListener('scrollend', finish); transcript.removeEventListener('scroll', moved); if (finishSourceScroll === finish) finishSourceScroll = undefined; resolve(); };
        const moved = () => { clearTimeout(timer); timer = setTimeout(finish, 100); };
        finishSourceScroll = finish; transcript.addEventListener('scrollend', finish, { once: true }); transcript.addEventListener('scroll', moved, { passive: true }); moved();
      });
    } else transcript.scrollTop = top;
    if (!alive() || request !== sourceRequest) return;
    if (!messages.includes(message)) { sourceScrolling = false; return; }
    if (!target.isConnected) target = sourceBlock();
    // Hydrated formulas or prepended pages may move the target during motion.
    // Check actual geometry before flashing; never highlight an offscreen source.
    if (target.isConnected && transcript.clientHeight > 0) {
      const correctedTop = Math.max(0, Math.min(transcript.scrollHeight - transcript.clientHeight,
        transcript.scrollTop + target.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 24));
      if (Math.abs(correctedTop - transcript.scrollTop) > 1) transcript.scrollTop = correctedTop;
    }
    sourceScrolling = false; lastScrollTop = transcript.scrollTop; pauseFollowing();
    clearTimeout(sourceHighlightTimer); highlightedSource?.classList.remove('opt-codex-source-highlight');
    highlightedSource = target; target.classList.add('opt-codex-source-highlight');
    // A focus target supports keyboard navigation without changing Selection or
    // stealing the user's quoted/draft text, and must not scroll the page again.
    message.body.tabIndex = -1; message.body.focus({ preventScroll: true });
    sourceHighlightTimer = setTimeout(() => { target.classList.remove('opt-codex-source-highlight'); if (highlightedSource === target) highlightedSource = undefined; }, 1800);
  }
  async function revealQuotedSource(value: CodexSelection | CodexAnswerQuote, localOrigin?: Message) {
    if (!alive() || sourceLoading || historySwitching || busy && busyKind === 'history') return;
    const request = ++sourceRequest; sourceState = undefined; sourceError = ''; hideTooltip(); cancelFormulaClick();
    const current = () => alive() && request === sourceRequest;
    if ('path' in value) {
      if (!options.onRevealSource) return;
      sourceLoading = true; manuscriptSourcePending = true; updateLabels();
      try { await options.onRevealSource({ ...value }); }
      catch (error) { if (current()) { sourceState = 'sourceFailed'; sourceError = error instanceof Error ? error.message : ''; } }
      finally { manuscriptSourcePending = false; sourceLoading = false; if (alive()) updateLabels(); }
      return;
    }
    const identified = () => messages.find(message => message.role === 'assistant' && value.messageId && message.messageId === value.messageId)
      ?? (localOrigin && messages.includes(localOrigin) ? localOrigin : undefined);
    let target = identified();
    if (target) { updateLabels(); await highlightAnswerSource(target, value, request); return; }
    if (historyPaging.hasOlder && (busy || sending || loadingOlder || historyPaging.loading)) { sourceState = 'sourceBusy'; updateLabels(); return; }
    if (historyPaging.hasOlder && options.onLoadOlderMessages) {
      pauseFollowing(); sourceLoading = true; loadingOlder = true; sourceState = 'sourceLoading'; updateLabels();
      try {
        // Bounded reads: never resume/fork a remote chat to reveal a quote.
        for (let page = 0; page < 8 && historyPaging.hasOlder; page++) {
          const previousCount = messages.length;
          await options.onLoadOlderMessages();
          if (!current()) return;
          if (historyPaging.error) throw new Error(historyPaging.error);
          target = identified(); if (target) break;
          if (messages.length <= previousCount) break;
        }
      } catch (error) {
        if (current()) { sourceState = 'sourceFailed'; sourceError = error instanceof Error ? error.message : ''; }
        return;
      } finally {
        loadingOlder = false;
        if (current()) sourceLoading = false;
        if (alive()) updateLabels();
      }
    }
    if (!current()) return;
    if (!target && historyPaging.hasOlder) { sourceState = 'sourceMore'; updateLabels(); return; }
    if (!target) {
      const needle = comparableQuote(value.text);
      const matches = needle ? messages.filter(message => message.role === 'assistant' && comparableQuote(renderedText(message.body)).includes(needle)) : [];
      if (matches.length !== 1) { sourceState = matches.length ? 'sourceAmbiguous' : 'sourceMissing'; updateLabels(); return; }
      target = matches[0];
    }
    sourceState = undefined; updateLabels(); await highlightAnswerSource(target, value, request);
  }
  function quoteCard(value: CodexSelection | CodexAnswerQuote) {
    const isAnswer = !('path' in value);
    const quote = node('details', 'opt-codex-message-selection' + (isAnswer ? ' opt-codex-message-answer-quote' : '')); quote.setAttribute('aria-label', isAnswer ? answerSourceLabel() : text().selectionSource);
    const summary = node('summary'); summary.append(node('span', '', isAnswer ? answerSourceLabel() : location(value as CodexSelection)));
    const reveal = iconButton('source'); reveal.classList.add('opt-codex-source-button'); reveal.dataset.sourceKind = isAnswer ? 'answer' : 'manuscript'; setLabel(reveal, text().goToSource); bindTooltip(reveal);
    // The action must not expand/collapse the surrounding disclosure.
    reveal.onclick = event => { event.preventDefault(); event.stopPropagation(); void revealQuotedSource(value); };
    const preview = node('span', 'opt-codex-quote-preview', value.text); summary.append(reveal, preview);
    const full = node('div', 'opt-codex-quote-full', value.text); quote.append(summary, full);
    summary.addEventListener('click', pauseFollowing); return quote;
  }
  function createMessage(value: CodexPanelMessage): Message {
    const { role, selection } = value;
    const element = node('article', 'opt-codex-message'); element.dataset.role = role;
    const roleRow = node('div', 'opt-codex-message-role'), roleName = node('span', 'opt-codex-role-name', role === 'user' ? text().user : assistantName());
    const activity = node('span', 'opt-codex-activity'); activity.hidden = true; activity.setAttribute('role', 'status'); activity.setAttribute('aria-live', 'polite'); roleRow.append(roleName, activity);
    const copy = role === 'assistant' ? iconButton('copy') : undefined;
    if (copy) { copy.classList.add('opt-codex-message-copy'); bindTooltip(copy); roleRow.append(copy); }
    const body = node('div', 'opt-codex-message-body'); const quote = role === 'user' && selection ? quoteCard(selection) : undefined;
    const answerCard = role === 'user' && value.answerQuote ? quoteCard(value.answerQuote) : undefined;
    element.append(roleRow); if (quote) element.append(quote); if (answerCard) element.append(answerCard); element.append(body);
    const expand=role==='user'?node('button','opt-codex-user-expand'):undefined;
    const message: Message = { ...value, element, body, roleName, activity, quote, answerCard, copy, expand, userExpanded:false };
    if(expand){
      body.id='opt-codex-user-'+crypto.randomUUID();body.dataset.expanded='false';expand.type='button';expand.hidden=true;expand.textContent=text().showMore;expand.setAttribute('aria-expanded','false');expand.setAttribute('aria-controls',body.id);element.append(expand);
      expand.onclick=()=>{pauseFollowing();withViewport(()=>{message.userExpanded=!message.userExpanded;body.dataset.expanded=String(message.userExpanded);updateLabels();});};userSizeObserver?.observe(body);
    }
    if (copy) copy.onclick = () => void copyValue(message.text, copy);
    renderMessage(message); return message;
  }
  function appendMessage(role: 'user' | 'assistant', value: string, selection?: CodexSelection, answerQuote?: CodexAnswerQuote) {
    if (!alive()) return;
    withViewport(() => { empty.hidden = true; const message = createMessage({ role, text: value, selection, answerQuote }); messages.push(message); transcript.append(message.element); updateLabels(); });
  }
  function flushStream() {
    clearTimeout(streamTimer); streamTimer = undefined;
    const message = messages.at(-1); if (!message || message.role !== 'assistant' || destroyed) return;
    withViewport(() => renderMessage(message));
  }
  function setAssistantText(value: string) {
    if (!alive()) return; const message = messages.at(-1);
    if (!message || message.role !== 'assistant') { appendMessage('assistant', value); return; }
    if (message.text === value) return; message.text = value;
    if (!busy) flushStream(); else if (!streamTimer) streamTimer = setTimeout(flushStream, 100);
  }
  function setMessages(values: CodexPanelMessage[]) {
    if (!alive()) return;
    cancelSourceNavigation(); draftAnswerOrigin = undefined;
    clearQuoteCandidate(); dismissedQuoteRange = undefined;
    clearTimeout(streamTimer); streamTimer = undefined;
    withViewport(() => {
      for (const message of messages) {message.dispose?.();userSizeObserver?.unobserve(message.body);} messages.length = 0; transcript.replaceChildren(earlier, empty); empty.hidden = values.length > 0;
      for (const value of values) if (['user', 'assistant'].includes(value.role) && typeof value.text === 'string') { const message = createMessage(value); messages.push(message); transcript.append(message.element); }
    });
    updateLabels();
  }
  /** Reconcile a complete displayed snapshot of the same conversation. The
   * caller retains any older pages it already loaded. Drafts are independent. */
  function syncMessages(values: CodexPanelMessage[]) {
    if (!alive()) return;
    clearTimeout(streamTimer); streamTimer = undefined;
    withViewport(() => {
      const previous = [...messages], unused = new Set(previous);
      const byId = new Map(previous.filter(message => message.messageId).map(message => [message.messageId!, message]));
      const next: Message[] = [];
      for (const value of values) {
        if (!['user', 'assistant'].includes(value.role) || typeof value.text !== 'string') continue;
        let message = value.messageId ? byId.get(value.messageId) : undefined;
        const atIndex = previous[next.length];
        if (!message && atIndex && (!atIndex.messageId || !value.messageId) && atIndex.role === value.role) message = atIndex;
        if (message && (!unused.has(message) || message.role !== value.role)) message = undefined;
        if (message) {
          unused.delete(message); message.messageId = value.messageId ?? message.messageId;
          if (JSON.stringify(message.selection) !== JSON.stringify(value.selection)) {
            const expanded = message.quote?.open ?? false; message.quote?.remove();
            message.quote = value.role === 'user' && value.selection ? quoteCard(value.selection) : undefined;
            if (message.quote) { message.quote.open = expanded; message.body.before(message.quote); }
          }
          message.selection = value.selection;
          if (JSON.stringify(message.answerQuote) !== JSON.stringify(value.answerQuote)) {
            const expanded = message.answerCard?.open ?? false; message.answerCard?.remove();
            message.answerCard = value.role === 'user' && value.answerQuote ? quoteCard(value.answerQuote) : undefined;
            if (message.answerCard) { message.answerCard.open = expanded; message.body.before(message.answerCard); }
          }
          message.answerQuote = value.answerQuote;
          if (message.text !== value.text) { message.text = value.text; renderMessage(message); }
        } else message = createMessage(value);
        next.push(message);
      }
      for (const message of unused) { if (quoteCandidate?.body === message.body) clearQuoteCandidate(); message.dispose?.(); userSizeObserver?.unobserve(message.body);message.element.remove(); }
      // Keep already positioned nodes in place: polling must not reset focus,
      // the user's browser selection, expanded quotes or hydrated formulas.
      let after: Element = empty;
      for (const message of next) { if (after.nextElementSibling !== message.element) after.after(message.element); after = message.element; }
      messages.splice(0, messages.length, ...next); empty.hidden = next.length > 0; updateLabels();
    });
  }
  function prependMessages(values: CodexPanelMessage[]) {
    if (!alive() || !values.length) return;
    pauseFollowing();
    withViewport(() => {
      const first = messages[0]?.element ?? empty, count = messages.length;
      for (const value of values) if (['user', 'assistant'].includes(value.role) && typeof value.text === 'string') { const message = createMessage(value); messages.push(message); transcript.append(message.element); }
      const added = messages.splice(count); messages.unshift(...added); first.before(...added.map(message => message.element));
    });
    updateLabels();
  }
  function renderQueue() {
    const t=text(); queueView.hidden=!queued.length; queueTitle.textContent=`${queuePaused?t.queuePaused:t.queued} · ${queued.length}`;
    queueResume.textContent=t.resumeQueue; queueResume.hidden=!queuePaused; queueResume.disabled=busy || followupSubmitting || queued.some(item=>item.state==='failed');
    const canPromote=!!options.onSteerQueued && steeringAvailable() && !followupSubmitting && !historySwitching && !loadingOlder && !historyPaging.loading;
    const key=JSON.stringify([queued.map(item=>({id:item.id,question:item.prompt.question,state:item.state,error:item.error,selection:item.prompt.selection?.path,files:item.prompt.sourceFileCount ?? item.prompt.files.length})),getLocale(),canPromote,followupSubmitting,options.getSettings().providerId]);
    if(queueList.dataset.renderKey===key)return; queueList.dataset.renderKey=key;queueList.replaceChildren();
    for(const item of queued){
      const row=node('li','opt-codex-queued-item'); row.dataset.queueId=item.id;
      const preview=node('div','opt-codex-queued-preview',item.prompt.question); preview.title=item.prompt.question;
      const fileCount=item.prompt.sourceFileCount ?? item.prompt.files.length;
      const meta=node('span','opt-codex-queued-context',`${t.queuedSource}${item.prompt.selection?.path?' · '+item.prompt.selection.path:''}${fileCount?' · '+fileCount+' files':''}`);
      const controls=node('div','opt-codex-queued-controls'),edit=node('button','opt-codex-queue-action'),remove=iconButton('close');edit.type='button';edit.textContent=t.editQueued;setLabel(remove,t.removeQueued);bindTooltip(remove);
      edit.disabled=remove.disabled=item.state==='sending' || followupSubmitting;
      edit.onclick=()=>{
        if(input.value.trim()){statusMessage=t.queueEditingBlocked;updateLabels();input.focus();return;}
        const prompt=options.onRemoveQueued?.(item.id);if(!prompt)return;
        input.value=prompt.question;selected=prompt.selection;answerQuote=prompt.answerQuote;updateLabels();input.focus({preventScroll:true});
      };
      remove.onclick=()=>{options.onRemoveQueued?.(item.id);};
      if(options.onSteerQueued && !options.getSettings().providerId){
        const promote=node('button','opt-codex-queue-action opt-codex-queue-steer',t.steer);promote.type='button';setLabel(promote,t.steer);bindTooltip(promote);
        promote.disabled=!canPromote || item.state!=='queued';promote.onclick=()=>void promoteQueued(item.id);controls.append(promote);
      }
      controls.append(edit,remove);row.append(preview,meta);
      if(item.state==='failed'){const error=node('p','opt-codex-queued-error',`${item.error || ''} ${t.queuedFailed}`);row.append(error);}
      row.append(controls);queueList.append(row);
    }
  }
  async function promoteQueued(id:string) {
    if(!alive() || !options.onSteerQueued || !steeringAvailable() || followupSubmitting || historySwitching || loadingOlder || historyPaging.loading || queued.find(item=>item.id===id)?.state!=='queued')return;
    followupSubmitting=true;updateLabels();
    try{await options.onSteerQueued(id);}
    catch(error){if(alive())statusMessage=error instanceof Error?error.message:text().failed;}
    finally{followupSubmitting=false;if(alive())updateLabels();}
  }
  async function submitFollowup(mode:'queue'|'steer') {
    const action=mode==='steer'?options.onSteer:options.onQueue;
    if(submissionBlocked() || !action || mode==='steer' && !steeringAvailable())return;
    const original=input.value,selection=selected,quote=answerQuote;followupSubmitting=true;updateLabels();
    try{
      await action(original.trim(),selection?{...selection}:undefined,quote?{...quote}:undefined);
      if(!alive())return;
      if(input.value===original)input.value='';if(selected===selection)selected=undefined;if(answerQuote===quote)answerQuote=undefined;clearQuoteCandidate();
    }catch(error){if(alive())statusMessage=error instanceof Error?error.message:text().failed;}
    finally{followupSubmitting=false;if(alive())updateLabels();}
  }
  async function submit() {
    if (submissionBlocked() || busy || remoteState !== 'idle' || sending) return;
    interruptSourceScroll();
    const question = input.value.trim(), snapshot = selected ? { ...selected } : undefined, originalInput = input.value, answerSnapshot = answerQuote ? { ...answerQuote } : undefined;
    input.value = ''; selected = undefined; answerQuote = undefined; clearQuoteCandidate(); followLatest = true; sending = true; updateLabels();
    try { if (answerSnapshot) await options.onSend(question, snapshot, answerSnapshot); else await options.onSend(question, snapshot); }
    catch (error) { statusMessage = error instanceof Error ? error.message : text().failed; if (!input.value) input.value = originalInput; selected ??= snapshot; answerQuote ??= answerSnapshot; }
    finally { sending = false; if (!destroyed) updateLabels(); }
  }
  button.onclick = () => isOpen ? close() : open(); closeButton.onclick = close; settings.onclick = () => options.onOpenSettings?.();
  dismissCacheNotice.onclick=()=>{
    if(!alive() || cacheNotice.hidden)return;
    const restoreFocus=document.activeElement===dismissCacheNotice;
    hideTooltip();cacheNoticeDismissed=true;withViewport(updateLabels);
    if(restoreFocus)input.focus({preventScroll:true});
  };
  historyButton.onclick = showConversations; backButton.onclick = () => { if (!historySwitching) showConversation(); };
  positionButton.onclick = async () => {
    if (moving || !options.onPositionChange || !alive()) return;
    const previous = position, next = previous === 'left' ? 'right' : 'left'; moving = true; setPosition(next);
    try { await options.onPositionChange(next); }
    catch (reason) { if (alive()) { setPosition(previous); statusMessage = reason instanceof Error ? reason.message : text().positionFailed; } }
    finally { moving = false; if (alive()) updateLabels(); }
  };
  earlierButton.onclick = async () => {
    if (!options.onLoadOlderMessages || busy || sending || loadingOlder || historyPaging.loading || historySwitching) return;
    pauseFollowing(); loadingOlder = true; historyPaging.error = undefined; withViewport(updateLabels);
    try { await options.onLoadOlderMessages(); }
    catch (reason) { if (alive()) historyPaging.error = reason instanceof Error ? reason.message : text().earlierFailed; }
    finally { loadingOlder = false; if (alive()) withViewport(updateLabels); }
  };
  removeSelection.onclick = () => { selected = undefined; updateLabels(); input.focus(); };
  removeAnswer.onclick = () => { answerQuote = undefined; draftAnswerOrigin = undefined; updateLabels(); input.focus(); };
  revealSelection.onclick = () => { if (selected) void revealQuotedSource(selected); };
  revealAnswer.onclick = () => { if (answerQuote) void revealQuotedSource(answerQuote, answerQuote === draftOriginQuote ? draftAnswerOrigin : undefined); };
  answerLabel.onclick = () => withViewport(() => { answerQuoteExpanded = !answerQuoteExpanded; updateLabels(); });
  selectionLabel.onclick = () => withViewport(() => { selectionExpanded = !selectionExpanded; updateLabels(); });
  newChat.onclick = async () => {
    if (busy || sending || historySwitching || loadingOlder || historyPaging.loading || !alive()) return; newChat.disabled = true;
    try { await options.onNewChat(); answerQuote = undefined; clearQuoteCandidate(); showConversation(); followLatest = true; scrollToLatest(); }
    catch (error) { statusMessage = error instanceof Error ? error.message : text().newFailed; }
    finally { if (!destroyed) updateLabels(); }
  };
  const submitCurrent=()=>{const mode=submissionMode();return mode==='send'?submit():submitFollowup(mode);};
  compose.onsubmit = event => { event.preventDefault(); void submitCurrent(); };
  stop.onclick=()=>options.onCancel();
  connection.onclick = async () => {
    if (!alive() || connection.getAttribute('aria-disabled') === 'true' || !options.onReconnect) return;
    const providerId = options.getSettings().providerId;
    reconnectPending = true; updateConnection();
    try { await options.onReconnect(); }
    catch (error) {
      if (alive() && options.getSettings().providerId === providerId) connectionState = { state: 'offline', detail: error instanceof Error ? error.message : String(error) };
    } finally { reconnectPending = false; if (alive()) updateConnection(); }
  };
  queueResume.onclick=()=>options.onResumeQueue?.();input.oninput=()=>updateLabels();
  input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); compose.requestSubmit(); } };
  resize.onpointerdown = beginResize;
  resize.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); applyWidth(width + (event.key === 'ArrowRight' ? 20 : -20) * (position === 'right' ? -1 : 1)); } };
  const observer = new MutationObserver(queueMount), themeObserver = new MutationObserver(updateTheme); let stopLocale = () => {};
  function update() { if (!alive()) { destroy(); return; } mount(); updateLabels(); }
  function destroy() {
    if (destroyed) return; destroyed = true; cancelSourceNavigation(); close(); clearTimeout(streamTimer);
    selectionFeedback.destroy();copyToast.destroy();userSizeObserver?.disconnect();
    for (const timer of copyTimers) clearTimeout(timer); copyTimers.clear();
    for (const message of messages) message.dispose?.(); conversations?.destroy(); observer.disconnect(); themeObserver.disconnect(); stopLocale();
    document.removeEventListener('selectionchange', scheduleQuoteCandidate);
    context.signal.removeEventListener('abort', destroy); document.removeEventListener('click', nativeNavigation, true); window.removeEventListener('resize', hideTooltip); window.removeEventListener('resize', cancelFormulaClick);
    button.remove(); panel.remove(); style.remove(); tooltip.remove(); formulaCache.clear();
  }
  if (context.alive()) {
    context.signal.addEventListener('abort', destroy, { once: true }); document.addEventListener('click', nativeNavigation, true); window.addEventListener('resize', hideTooltip); window.addEventListener('resize', cancelFormulaClick);
    // React/navigation may replace the body itself; watching the old body
    // cannot discover the new rail or restore this panel after that happens.
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopLocale = observeLocale(() => { updateLabels(); conversations?.update(); }); updateLabels(); mount();
  } else destroy();
  return {
    setSelection(value?: CodexSelection) {
      if (!alive()) return;
      if (value?.text) { if (selected?.path !== value.path || selected?.text !== value.text) selectionExpanded = false; selected = { ...value }; withViewport(updateLabels); }
    },
    clearSelection() { if (!alive()) return; selected = undefined; withViewport(updateLabels); },
    clearAnswerQuote() { if (!alive()) return; answerQuote = undefined; clearQuoteCandidate(); withViewport(updateLabels); },
    setStatus(value: string) { if (!alive()) return; statusMessage = value; withViewport(updateLabels); },
    setCacheNotice(value: 'stale' | 'error' | 'saved' | null) { if (!alive() || value === cacheNoticeKind) return; cacheNoticeKind = value; cacheNoticeDismissed = false; withViewport(updateLabels); },
    setConnection(value: CodexConnectionState) {
      if (!alive()) return;
      connectionProviderId = options.getSettings().providerId; connectionState = { ...value }; updateConnection();
    },
    setBusy(value: boolean, kind: 'generation' | 'history' = 'generation') { if (!alive()) return; busy = value; busyKind = kind; withViewport(updateLabels); if (!busy) flushStream(); },
    setQueue(items:readonly QueuedPrompt[],paused=false){if(!alive())return;queued=structuredClone(items);queuePaused=paused;withViewport(updateLabels);},
    setSteering(value:boolean){if(!alive())return;canSteer=value;updateLabels();},
    setRemoteState(value: 'idle' | 'active' | 'unknown', syncPending = false) { if (!alive()) return; remoteState = value; remoteSyncPending=value==='unknown' && syncPending; withViewport(updateLabels); },
    setHistoryPaging(value: { hasOlder: boolean; loading?: boolean; error?: string }) { if (!alive()) return; withViewport(() => { historyPaging = { ...value }; updateLabels(); }); },
    insertSteeringMessage(value:CodexPanelMessage,beforeActive=true){
      if(!alive())return;withViewport(()=>{const message=createMessage(value),last=messages.at(-1);if(beforeActive && last?.role==='assistant'){messages.splice(messages.length-1,0,message);last.element.before(message.element);}else{messages.push(message);transcript.append(message.element);}updateLabels();});
    },
    appendMessage, setAssistantText, setMessages, syncMessages, prependMessages, setPosition, open, close, isOpen: () => isOpen, update, destroy,
  };
}
