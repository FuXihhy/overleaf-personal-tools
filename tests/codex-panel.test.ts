// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCodexAssistant, type CodexPanelOptions, type CodexConversationPage } from '../src/codex/panel';
import { renderAssistantMessage, safeMathSvg } from '../src/codex/message-renderer';
import * as messageRenderer from '../src/codex/message-renderer';
import type { QueuedPrompt } from '../src/codex/prompt-queue';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function selectAnswerRange(range?: Range) {
  const selected = document.getSelection()!; selected.removeAllRanges(); if (range) selected.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await flush();
}
function contentsRange(element: Element) { const range = document.createRange(); range.selectNodeContents(element); return range; }
const selection = { path: 'sections/localization.tex', text: '\\phi = 0', from: 10, to: 18, startLine: 3, endLine: 3, before: 'Assume ', after: ' in this vacuum.' };
function nativeRail() {
  const layout = document.createElement('div'); layout.className = 'ide-redesign-inner';
  layout.innerHTML = `<nav class="ide-rail"><div class="ide-rail-tabs-nav"><div class="ide-rail-tabs-wrapper">
    <button id="ide-rail-tabs-tab-file-tree" class="ide-rail-tab-link">Files</button>
    <button id="ide-rail-tabs-tab-workbench" class="ide-rail-tab-link open-rail">AI assistant</button>
  </div></div></nav><div id="ide-redesign-sidebar-panel-workbench"><div class="ide-rail-content">Native AI assistant</div></div><div id="ide-redesign-editor-and-pdf-panel">Editor</div>`;
  const native = layout.querySelector<HTMLButtonElement>('#ide-rail-tabs-tab-workbench')!;
  native.onclick = () => native.classList.toggle('open-rail');
  document.body.append(layout); return layout;
}
describe('Codex Assistant in the Overleaf rail', () => {
  let panel: ReturnType<typeof mountCodexAssistant>;
  let settings: ReturnType<CodexPanelOptions['getSettings']>;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    document.body.replaceChildren(); document.documentElement.lang = 'en';
    vi.stubGlobal('chrome', { runtime: { id: 'test', getURL: (path: string) => 'chrome-extension://test/' + path } });
    settings = { enabled: true }; send = vi.fn(async () => {});
    panel = mountCodexAssistant({ projectId: 'project', getSettings: () => settings, onSend: send, onCancel: vi.fn(), onNewChat: vi.fn(async () => {}) });
  });
  afterEach(() => { panel.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  function remount(extra: Partial<CodexPanelOptions>) {
    panel.destroy();
    panel = mountCodexAssistant({ projectId: 'project', getSettings: () => settings, onSend: send, onCancel: vi.fn(), onNewChat: vi.fn(async () => {}), ...extra });
  }

  it('shows connection status beside send and keeps reconnect separate from the draft and submission', async () => {
    let finish!: () => void;
    const reconnect = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    remount({ onReconnect: reconnect }); nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!;
    input.value = 'Keep my unsent question'; input.dispatchEvent(new Event('input'));
    const badge = document.querySelector<HTMLButtonElement>('.opt-codex-connection')!;
    expect(badge.type).toBe('button'); expect(badge.textContent).toBe('Codex · Not checked');
    const actionChildren = [...badge.parentElement!.children];
    expect(actionChildren.indexOf(badge)).toBeLessThan(actionChildren.indexOf(document.querySelector('.opt-codex-submit-actions')!));
    panel.setConnection({ state: 'offline', message: 'Timed out', detail: 'Account discovery timed out. Your question was not resent.' });
    badge.focus(); expect(document.querySelector('.opt-codex-tooltip')!.textContent).toContain('Account discovery timed out');
    expect(badge.getAttribute('aria-describedby')).toBe('opt-codex-tooltip');
    badge.click(); badge.click(); expect(reconnect).toHaveBeenCalledOnce();
    expect(badge.getAttribute('aria-disabled')).toBe('true');
    expect(input.disabled).toBe(false); expect(input.value).toBe('Keep my unsent question'); expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    input.value = 'A newer draft'; panel.setConnection({ state: 'connected' }); finish(); await flush();
    expect(badge.getAttribute('aria-disabled')).toBe('false'); expect(input.value).toBe('A newer draft');
    expect(badge.textContent).toBe('Codex · Connected'); expect(send).not.toHaveBeenCalled();
  });

  it('keeps the connection visible while replying and announces only settled state changes', async () => {
    remount({ onReconnect: vi.fn() }); nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Working');
    panel.setBusy(true); panel.setStatus('Thinking…'); panel.setConnection({ state: 'reconnecting', detail: 'Retry 1' });
    const badge = document.querySelector<HTMLButtonElement>('.opt-codex-connection')!;
    const announcement = document.querySelector<HTMLElement>('.opt-codex-connection-announcement')!;
    expect(badge.hidden).toBe(false); expect(badge.getAttribute('aria-disabled')).toBe('true');
    expect(announcement.getAttribute('aria-live')).toBe('polite'); expect(announcement.textContent).toBe('');
    expect(document.querySelector('.opt-codex-activity')!.textContent).toBe('Thinking…');
    panel.setConnection({ state: 'connected' }); expect(announcement.textContent).toBe('Codex · Connected');
    const settledText = announcement.firstChild;
    panel.setConnection({ state: 'connected', detail: 'A newer check' }); panel.update();
    expect(announcement.firstChild).toBe(settledText);
    panel.setConnection({ state: 'reconnecting', detail: 'Retry 2' }); expect(announcement.firstChild).toBe(settledText);
    panel.setConnection({ state: 'offline' }); expect(announcement.textContent).toBe('Codex · Disconnected');
  });

  it('resets an old provider connection and uses the new provider name and interface language', async () => {
    remount({ onReconnect: vi.fn() }); nativeRail(); await flush(); panel.open(); panel.setConnection({ state: 'connected' });
    settings.providerId = 'deepseek'; settings.providerName = 'DeepSeek'; panel.update();
    const badge = document.querySelector<HTMLButtonElement>('.opt-codex-connection')!;
    expect(badge.textContent).toBe('DeepSeek · Not checked');
    document.documentElement.lang = 'zh'; panel.update(); panel.setConnection({ state: 'auth-required' });
    expect(badge.textContent).toBe('DeepSeek · 请登录');
    expect(badge.getAttribute('aria-label')).toBe(badge.textContent);
  });

  it('reports reconnect failures without submitting or replacing the draft and ignores completion after disposal', async () => {
    let reject!: (error: Error) => void;
    const reconnect = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    remount({ onReconnect: reconnect }); nativeRail(); await flush(); panel.open();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!; input.value = 'Preserve me';
    const badge = document.querySelector<HTMLButtonElement>('.opt-codex-connection')!; badge.click(); reject(new Error('Service unavailable')); await flush();
    expect(badge.textContent).toBe('Codex · Disconnected'); expect(badge.dataset.tooltip).toContain('Service unavailable');
    expect(input.value).toBe('Preserve me'); expect(send).not.toHaveBeenCalled();
    badge.click(); const priorText = badge.textContent; panel.destroy(); reject(new Error('Late failure')); await flush();
    expect(badge.textContent).toBe(priorText); expect(document.querySelector('#opt-codex-panel')).toBeNull();
  });

  it('does not apply a late reconnect failure to a newly selected provider', async () => {
    let reject!: (error: Error) => void;
    remount({ onReconnect: () => new Promise<void>((_, fail) => { reject = fail; }) }); nativeRail(); await flush(); panel.open();
    document.querySelector<HTMLButtonElement>('.opt-codex-connection')!.click();
    settings.providerId = 'other'; settings.providerName = 'Other API'; panel.update(); panel.setConnection({ state: 'connected' });
    reject(new Error('Old provider timeout')); await flush();
    expect(document.querySelector('.opt-codex-connection')!.textContent).toBe('Other API · Connected');
  });

  it('queues a follow-up without stopping or replacing the current answer and retains a new draft',async()=>{
    let accept!:()=>void;const queue=vi.fn(()=>new Promise<void>(resolve=>{accept=resolve;})),cancel=vi.fn();remount({onQueue:queue,onCancel:cancel});nativeRail();await flush();panel.open();panel.appendMessage('assistant','Existing streamed answer');panel.setBusy(true);panel.setSelection(selection);
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;input.value='Follow-up';input.dispatchEvent(new Event('input'));
    const submit=document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;expect(submit.type).toBe('submit');expect(submit.hidden).toBe(false);submit.click();submit.click();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(queue).toHaveBeenCalledExactlyOnceWith('Follow-up',selection,undefined);expect(input.value).toBe('Follow-up');
    expect(document.querySelector('.opt-codex-followup-actions')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]')!.disabled).toBe(false);input.value='Another draft';accept();await flush();
    expect(input.value).toBe('Another draft');expect(cancel).not.toHaveBeenCalled();expect(document.querySelector('.opt-codex-message-body')!.textContent).toContain('Existing streamed answer');
  });
  it('keeps a failed enqueue draft and selected passage, and enables steering only with capability',async()=>{
    settings.busyMessageBehavior='steer';const queue=vi.fn(async()=>{throw new Error('Storage unavailable');}),steer=vi.fn(async()=>{});remount({onQueue:queue,onSteer:steer});nativeRail();await flush();panel.open();panel.setBusy(true);panel.setSelection(selection);
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;input.value='Question';input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();expect(input.value).toBe('Question');expect(document.querySelector<HTMLElement>('.opt-codex-selection')!.hidden).toBe(false);
    expect(queue).toHaveBeenCalledExactlyOnceWith('Question',selection,undefined);expect(steer).not.toHaveBeenCalled();
    panel.setSteering(true);document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click();await flush();expect(steer).toHaveBeenCalledExactlyOnceWith('Question',selection,undefined);expect(input.value).toBe('');
  });
  it('uses the saved preference for Enter and leaves IME confirmation and Shift+Enter unsent',async()=>{
    const queue=vi.fn(async()=>{}),steer=vi.fn(async()=>{});remount({onQueue:queue,onSteer:steer});nativeRail();await flush();panel.open();panel.setBusy(true);panel.setSteering(true);
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;input.value='正在转换';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}));expect(queue).not.toHaveBeenCalled();expect(steer).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();expect(queue).toHaveBeenCalledWith('正在转换',undefined,undefined);
    settings.busyMessageBehavior='steer';panel.update();input.value='Clarify the proof';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();expect(steer).toHaveBeenCalledWith('Clarify the proof',undefined,undefined);
    panel.setBusy(false);input.value='Next turn';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();expect(send).toHaveBeenCalledExactlyOnceWith('Next turn',undefined);
  });
  it('queues instead of steering for remote activity and API connections, and blocks unknown sync',async()=>{
    settings.busyMessageBehavior='steer';const queue=vi.fn(async()=>{}),steer=vi.fn(async()=>{});remount({onQueue:queue,onSteer:steer});nativeRail();await flush();panel.open();panel.setRemoteState('active');panel.setSteering(true);
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;input.value='Remote follow-up';input.dispatchEvent(new Event('input'));document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click();await flush();
    expect(queue).toHaveBeenCalledWith('Remote follow-up',undefined,undefined);expect(steer).not.toHaveBeenCalled();
    panel.setRemoteState('idle');panel.setBusy(true);settings.providerId='custom-api';panel.update();input.value='API follow-up';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();expect(queue).toHaveBeenCalledWith('API follow-up',undefined,undefined);expect(steer).not.toHaveBeenCalled();
    panel.setBusy(false);panel.setRemoteState('unknown');input.value='Keep this draft';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();expect(queue).toHaveBeenCalledTimes(2);expect(input.value).toBe('Keep this draft');
  });
  it('promotes a queued item by id without changing the current draft, and prevents duplicate promotion',async()=>{
    let finish!:()=>void;const promote=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));remount({onQueue:vi.fn(async()=>{}),onSteerQueued:promote});nativeRail();await flush();panel.open();
    const item:QueuedPrompt={id:'queued-one',state:'queued',prompt:{question:'Captured follow-up',selection,files:[],note:'',settings:{enabled:true,model:'',effort:'',instructions:'',contextMode:'selection'}}};
    panel.setQueue([item]);panel.setBusy(true);
    const promoteButton=()=>document.querySelector<HTMLButtonElement>('.opt-codex-queue-steer')!;expect(promoteButton().disabled).toBe(true);panel.setSteering(true);expect(promoteButton().disabled).toBe(false);
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;input.value='Unsent draft';panel.setSelection({...selection,text:'New selection'});
    const oldButton=promoteButton();oldButton.click();oldButton.click();expect(promote).toHaveBeenCalledExactlyOnceWith('queued-one');expect(promoteButton().disabled).toBe(true);expect(document.querySelector<HTMLButtonElement>('.opt-codex-queued-controls button:nth-child(2)')!.disabled).toBe(true);
    panel.setQueue([]);finish();await flush();expect(input.value).toBe('Unsent draft');expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe('New selection');
  });
  it('never promotes sending or failed rows and retains a rejected promotion for review',async()=>{
    const promote=vi.fn(async()=>{throw new Error('Turn ended');});remount({onQueue:vi.fn(async()=>{}),onSteerQueued:promote});nativeRail();await flush();panel.open();panel.setBusy(true);panel.setSteering(true);
    const prompt={question:'Queued question',files:[],note:'',settings:{enabled:true,model:'',effort:'',instructions:'',contextMode:'selection' as const}};
    panel.setQueue([{id:'failed',state:'failed',prompt},{id:'sending',state:'sending',prompt},{id:'ready',state:'queued',prompt}]);
    const buttons=[...document.querySelectorAll<HTMLButtonElement>('.opt-codex-queue-steer')];expect(buttons.map(x=>x.disabled)).toEqual([true,true,false]);buttons[2].click();await flush();expect(promote).toHaveBeenCalledExactlyOnceWith('ready');expect(document.querySelectorAll('.opt-codex-queued-item')).toHaveLength(3);
    panel.setSteering(false);expect([...document.querySelectorAll<HTMLButtonElement>('.opt-codex-queue-steer')].every(x=>x.disabled)).toBe(true);
  });
  it('collapses long user messages while preserving full text and offers an accessible expansion',async()=>{
    nativeRail();await flush();panel.open();const content='Long user context. '.repeat(100);panel.appendMessage('user',content);panel.appendMessage('assistant','Assistant answer remains fully visible');await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));await flush();
    const body=document.querySelector<HTMLElement>('.opt-codex-message[data-role=user] .opt-codex-message-body')!,expand=document.querySelector<HTMLButtonElement>('.opt-codex-user-expand')!;
    expect(body.textContent).toBe(content);expect(body.dataset.expanded).toBe('false');expect(expand.hidden).toBe(false);expect(expand.getAttribute('aria-controls')).toBe(body.id);
    expand.click();expect(body.dataset.expanded).toBe('true');expect(expand.getAttribute('aria-expanded')).toBe('true');expect(expand.textContent).toBe('Show less');expand.click();expect(body.dataset.expanded).toBe('false');
    expect(document.querySelector('.opt-codex-message[data-role=assistant] .opt-codex-message-body')!.hasAttribute('data-expanded')).toBe(false);
  });
  it('waits for the native rail, inserts below AI, and reserves real layout space', async () => {
    expect(document.getElementById('opt-codex-tab')).toBeNull();
    const layout = nativeRail(); await flush();
    const button = document.getElementById('opt-codex-tab')!;
    expect(layout.querySelector('#ide-rail-tabs-tab-workbench')!.nextElementSibling).toBe(button);
    button.click();
    const aside = document.getElementById('opt-codex-panel')!;
    expect(layout.querySelector('nav')!.nextElementSibling).toBe(aside);
    expect(aside.parentElement).toBe(layout);
    expect(aside.hidden).toBe(false);
    expect(layout.querySelector('#ide-rail-tabs-tab-workbench')!.classList.contains('open-rail')).toBe(false);
    expect(button.getAttribute('aria-selected')).toBe('true');
    (layout.querySelector('#ide-rail-tabs-tab-file-tree') as HTMLButtonElement).click();
    expect(aside.hidden).toBe(true);
    expect(layout.querySelector('#ide-redesign-editor-and-pdf-panel')!.textContent).toBe('Editor');
  });

  it('captures exact selection across focus loss and sends once on Enter', async () => {
    nativeRail(); await flush(); panel.open();
    panel.setSelection(selection); panel.setSelection(undefined);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;
    input.focus(); input.value = 'Why is this zero?'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(send).toHaveBeenCalledExactlyOnceWith('Why is this zero?', selection);
    expect(input.value).toBe('');
    expect(document.querySelector<HTMLElement>('.opt-codex-selection')!.hidden).toBe(true);
    await flush();
  });

  it('can explicitly clear a stale selection when its source is no longer valid', async () => {
    nativeRail(); await flush(); panel.setSelection(selection); panel.clearSelection();
    expect(document.querySelector<HTMLElement>('.opt-codex-selection')!.hidden).toBe(true);
  });

  it('keeps a new draft when an outstanding send finishes', async () => {
    let finish!: () => void; send.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    nativeRail(); await flush(); panel.open();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;
    input.value = 'First question'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.value = 'Next question'; panel.setStatus('Connected'); panel.setBusy(true);
    finish(); await flush();
    expect(input.value).toBe('Next question');
  });

  it('restores a failed question and selection without erasing a new draft', async () => {
    send.mockRejectedValue(new Error('Connection unavailable'));
    nativeRail(); await flush(); panel.setSelection(selection); panel.open();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;
    input.value = 'Question'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    expect(input.value).toBe('Question');
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    expect(document.querySelector('.opt-codex-status')!.textContent).toBe('Connection unavailable');
  });

  it('does not send IME or Shift+Enter and supports an explicit removed reference', async () => {
    nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Question';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(send).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[aria-label="Remove selected passage"]')!.click();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(send).toHaveBeenCalledExactlyOnceWith('Question', undefined);
  });

  it('streams into one assistant message and retains the composer', async () => {
    nativeRail(); await flush(); panel.open(); panel.appendMessage('user', 'Explain this'); panel.setBusy(true);
    panel.setAssistantText('First'); panel.setAssistantText('First paragraph'); panel.setAssistantText('First paragraph.\n\n**Second** paragraph.');
    panel.setBusy(false);
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
    expect(document.querySelector('[data-role="assistant"] strong')!.textContent).toBe('Second');
    expect(document.querySelectorAll('#opt-codex-panel textarea')).toHaveLength(1);
  });

  it('follows site locale and keeps text while controls change', async () => {
    nativeRail(); await flush(); panel.open(); const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;
    input.value = 'Draft'; document.documentElement.lang = 'zh-CN'; await flush();
    expect(input.placeholder).toBe('向 Codex 提问…'); expect(input.value).toBe('Draft');
    expect(document.querySelector('[aria-label="新建对话"]')).not.toBeNull();
  });


  it('shows actual hover and keyboard tooltips for rail and icon controls', async () => {
    nativeRail(); await flush(); panel.open();
    const newConversation = document.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!;
    newConversation.focus();
    expect(document.querySelector<HTMLElement>('[role=tooltip]')!.hidden).toBe(false);
    expect(document.querySelector('[role=tooltip]')!.textContent).toBe('New conversation');
    expect(newConversation.getAttribute('aria-describedby')).toBe('opt-codex-tooltip');
    newConversation.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
    expect(document.querySelector<HTMLElement>('[role=tooltip]')!.hidden).toBe(true);
    vi.useFakeTimers();
    const rail = document.querySelector<HTMLElement>('#opt-codex-tab')!;
    rail.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(251);
    expect(document.querySelector('[role=tooltip]')!.textContent).toBe('Codex Assistant');
    expect(document.querySelector<HTMLElement>('[role=tooltip]')!.hidden).toBe(false);
    rail.dispatchEvent(new Event('pointerleave'));
    expect(document.querySelector<HTMLElement>('[role=tooltip]')!.hidden).toBe(true);
  });

  it('places thinking next to the active Codex label and not below the draft', async () => {
    nativeRail(); await flush(); panel.open();
    panel.appendMessage('assistant', 'Earlier reply'); panel.appendMessage('user', 'Next question'); panel.appendMessage('assistant', '');
    panel.setBusy(true); panel.setStatus('Codex is thinking…');
    const active = document.querySelectorAll<HTMLElement>('.opt-codex-activity');
    expect(active[0].hidden).toBe(true); expect(active[2].hidden).toBe(false);
    expect(active[2].textContent).toBe('Codex is thinking…');
    expect(active[2].parentElement!.querySelector('.opt-codex-role-name')!.textContent).toBe('Codex');
    expect(document.querySelector<HTMLElement>('.opt-codex-status')!.hidden).toBe(true);
    panel.setBusy(false); expect(active[2].hidden).toBe(true);
  });

  it('keeps history operations disabled without presenting them as cancellable generation', async () => {
    const cancel = vi.fn(); remount({ onCancel: cancel }); nativeRail(); await flush(); panel.open();
    panel.appendMessage('assistant', 'Previous answer'); panel.setSelection(selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Draft';
    panel.setBusy(true, 'history');
    expect(document.querySelector<HTMLElement>('.opt-codex-activity')!.hidden).toBe(true);
    expect(document.querySelector('[aria-label="Stop generating"]:not([hidden])')).toBeNull();
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!; expect(button.disabled).toBe(true); button.click();
    expect(cancel).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Remove selected passage"]')!.disabled).toBe(true);
    panel.setBusy(false); expect(button.disabled).toBe(false);
    panel.setBusy(true); expect(document.querySelector('[aria-label="Stop generating"]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('.opt-codex-activity')!.hidden).toBe(false);
  });

  it('keeps exact sent selection in the message and expands both draft and history quotes', async () => {
    nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    const expand = document.querySelector<HTMLButtonElement>('.opt-codex-selection-label')!;
    expand.click(); expect(expand.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    panel.appendMessage('user', 'Explain this', selection); panel.clearSelection();
    const quote = document.querySelector<HTMLDetailsElement>('.opt-codex-message-selection')!;
    expect(quote.querySelector('.opt-codex-quote-full')!.textContent).toBe(selection.text);
    expect(quote.querySelector('summary')!.textContent).toContain('sections/localization.tex · 3');
    quote.open = true; panel.setStatus('Connected');
    expect(quote.open).toBe(true);
    panel.setMessages([{role:'user',text:'Restored question',selection}]);
    expect(document.querySelector('.opt-codex-quote-full')!.textContent).toBe(selection.text);
  });

  it('does not pull a reader down after a small upward scroll, and resumes only on request', async () => {
    nativeRail(); await flush(); panel.open();
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!;
    let height = 1000, top = 0;
    Object.defineProperties(transcript, {
      scrollHeight: {get: () => height}, clientHeight: {get: () => 400},
      scrollTop: {get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 400)); }},
    });
    panel.appendMessage('assistant', 'A long answer');
    expect(top).toBe(600);
    transcript.dispatchEvent(new WheelEvent('wheel', {deltaY:-20})); top = 580; transcript.dispatchEvent(new Event('scroll'));
    height = 1100; panel.setAssistantText('A long answer with more output');
    expect(top).toBe(580);
    const latest = document.querySelector<HTMLButtonElement>('.opt-codex-latest')!;
    expect(latest.hidden).toBe(false);
    height = 1150; panel.setAssistantText('A long answer with more output and another sentence');
    expect(top).toBe(580);
    latest.click(); expect(top).toBe(750); expect(latest.hidden).toBe(true);
    height = 1200; panel.setAssistantText('A long answer with more output and another sentence. Done.');
    expect(top).toBe(800);
  });

  it('preserves a visible text anchor when asynchronous math above it gains height', async () => {
    nativeRail(); await flush(); panel.open();
    const spy = vi.spyOn(messageRenderer, 'renderAssistantMessage');
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!;
    let height = 1000, top = 0, blockTop = 20;
    Object.defineProperties(transcript, {scrollHeight:{get:()=>height},clientHeight:{get:()=>400},scrollTop:{get:()=>top,set:(v:number)=>{top=v;}}});
    vi.spyOn(transcript,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,300,400));
    panel.appendMessage('assistant','Visible paragraph');
    const paragraph = document.querySelector<HTMLElement>('.opt-codex-message-body p')!;
    vi.spyOn(paragraph,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,blockTop,300,40));
    transcript.dispatchEvent(new WheelEvent('wheel',{deltaY:-50})); top=450; transcript.dispatchEvent(new Event('scroll'));
    const onLayout = spy.mock.calls.at(-1)![2]!.onLayout!;
    onLayout(()=>{height+=60;blockTop+=60;});
    expect(top).toBe(510);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-latest')!.hidden).toBe(false);
  });


  it('anchors the visible paragraph inside a tall list item when an earlier formula grows', async () => {
    nativeRail(); await flush(); panel.open();
    const spy = vi.spyOn(messageRenderer, 'renderAssistantMessage');
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!;
    let top = 0, visibleTop = 20, height = 1000;
    Object.defineProperties(transcript, {scrollHeight:{get:()=>height},clientHeight:{get:()=>400},scrollTop:{get:()=>top,set:(v:number)=>{top=v;}}});
    vi.spyOn(transcript,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,300,400));
    panel.appendMessage('assistant','- Earlier formula.\n\n  Paragraph being read.');
    const item = document.querySelector<HTMLElement>('.opt-codex-message-body li')!;
    const paragraphs = item.querySelectorAll<HTMLElement>('p');
    expect(paragraphs).toHaveLength(2);
    // The enclosing li and its long first paragraph both start above the
    // viewport, while the paragraph being read moves when math above grows.
    vi.spyOn(item,'getBoundingClientRect').mockReturnValue(new DOMRect(0,-300,300,800));
    vi.spyOn(paragraphs[0],'getBoundingClientRect').mockReturnValue(new DOMRect(0,-300,300,340));
    vi.spyOn(paragraphs[1],'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,visibleTop,300,80));
    transcript.dispatchEvent(new WheelEvent('wheel',{deltaY:-50})); top=450; transcript.dispatchEvent(new Event('scroll'));
    spy.mock.calls.at(-1)![2]!.onLayout!(()=>{height+=70;visibleTop+=70;});
    expect(top).toBe(520);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-latest')!.hidden).toBe(false);
  });

  it('opens project conversation history in the same panel with native-sized rows and clock tooltip', async () => {
    let finish!: (page: CodexConversationPage) => void;
    const list = vi.fn(() => new Promise<CodexConversationPage>(resolve => { finish = resolve; }));
    remount({ onListConversations: list, onSelectConversation: vi.fn(async () => {}) });
    nativeRail(); await flush(); panel.open();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Unsent draft';
    const historyButton = document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!;
    historyButton.focus(); expect(document.querySelector('[role=tooltip]')!.textContent).toBe('Conversation history');
    historyButton.click(); await flush();
    expect(document.querySelector<HTMLElement>('.opt-codex-conversations')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.opt-codex-compose')!.hidden).toBe(true);
    expect(document.querySelector('.opt-codex-conversation-status')!.textContent).toBe('Loading conversations…');
    finish({ conversations: [{ id: 'current', title: 'Current discussion', updatedAt: 1_793_381_000_000, current: true }, { id: 'older', title: '<img src=x onerror=alert(1)>', updatedAt: 1_793_380_000_000 }] }); await flush();
    expect(list).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(document.querySelectorAll('.opt-codex-conversation')).toHaveLength(2);
    expect(document.querySelector('.opt-codex-conversation-current')!.textContent).toBe('Current');
    expect(document.querySelector('.opt-codex-conversation time')!.getAttribute('datetime')).toBe(new Date(1_793_381_000_000).toISOString());
    expect(document.querySelector('.opt-codex-conversations img')).toBeNull();
    expect(getComputedStyle(document.querySelector('.opt-codex-conversations')!).fontSize).toBe('14px');
    document.querySelector<HTMLButtonElement>('[aria-label="Back to conversation"]')!.click();
    expect(input.value).toBe('Unsent draft'); expect(document.querySelector<HTMLElement>('.opt-codex-compose')!.hidden).toBe(false);
    expect(document.querySelectorAll('#opt-codex-panel')).toHaveLength(1);
  });

  it('retries failed history discovery and appends cursor pages without duplicates', async () => {
    const list = vi.fn<NonNullable<CodexPanelOptions['onListConversations']>>()
      .mockRejectedValueOnce(new Error('Connection unavailable'))
      .mockResolvedValueOnce({ conversations: [{ id: 'a', title: 'Recent', updatedAt: 300, current: true }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ conversations: [{ id: 'a', title: 'Recent', updatedAt: 300, current: true }, { id: 'b', title: 'Earlier', updatedAt: 100 }] });
    remount({ onListConversations: list, onSelectConversation: vi.fn(async () => {}) });
    nativeRail(); await flush(); panel.open(); document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click(); await flush();
    expect(document.querySelector('.opt-codex-conversation-status')!.textContent).toBe('Connection unavailable');
    document.querySelector<HTMLButtonElement>('.opt-codex-history-retry')!.click(); await flush();
    document.querySelector<HTMLButtonElement>('.opt-codex-conversations > .opt-codex-history-more')!.click(); await flush();
    expect(list.mock.calls).toEqual([[undefined], [undefined], ['page-2']]);
    expect([...document.querySelectorAll<HTMLElement>('.opt-codex-conversation')].map(row => row.dataset.conversationId)).toEqual(['a', 'b']);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-conversations > .opt-codex-history-more')!.hidden).toBe(true);
    document.documentElement.lang = 'zh-CN'; await flush();
    expect(document.querySelector('[aria-label="返回对话"]')).not.toBeNull();
    expect(document.querySelector('.opt-codex-conversation-current')!.textContent).toBe('当前');
  });

  it('keeps chat and draft on failed switching, retries, and returns to the successfully selected conversation', async () => {
    let finish!: () => void;
    const select = vi.fn<NonNullable<CodexPanelOptions['onSelectConversation']>>()
      .mockRejectedValueOnce(new Error('Conversation unavailable'))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => { panel.setMessages([{ role: 'user', text: 'Restored question', selection }, { role: 'assistant', text: 'Restored answer' }]); resolve(); }; }));
    remount({ onListConversations: async () => ({ conversations: [{ id: 'older', title: 'Earlier chat', updatedAt: 100 }] }), onSelectConversation: select });
    nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Current answer'); panel.setSelection(selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Draft';
    document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click(); await flush();
    document.querySelector<HTMLButtonElement>('.opt-codex-conversation-select')!.click(); await flush();
    expect(document.querySelector('.opt-codex-conversation-status')!.textContent).toBe('Conversation unavailable');
    expect(document.querySelector('.opt-codex-message-body')!.textContent).toBe('Current answer'); expect(input.value).toBe('Draft');
    document.querySelector<HTMLButtonElement>('.opt-codex-history-retry')!.click();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Back to conversation"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!.disabled).toBe(true);
    finish(); await flush();
    expect(select.mock.calls).toEqual([['older'], ['older']]);
    expect(document.querySelector<HTMLElement>('.opt-codex-conversations')!.hidden).toBe(true);
    expect(document.querySelector('.opt-codex-quote-full')!.textContent).toBe(selection.text);
    expect(document.querySelector('[data-role=assistant] .opt-codex-message-body')!.textContent).toBe('Restored answer');
    expect(input.value).toBe('Draft'); expect(document.activeElement).toBe(input);
  });

  it('reloads the current conversation for recovery and disallows history operations during generation', async () => {
    const select = vi.fn(async () => {}), open = vi.fn(async () => {}), list = vi.fn(async () => ({ conversations: [{ id: 'current', title: 'Current', updatedAt: 100, current: true }] }));
    remount({ onListConversations: list, onSelectConversation: select, onOpenConversationInCodex: open });
    nativeRail(); await flush(); panel.open(); panel.setBusy(true);
    const historyButton = document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!;
    expect(historyButton.disabled).toBe(true); historyButton.click(); expect(list).not.toHaveBeenCalled();
    panel.setBusy(false); historyButton.click(); await flush();
    const external = document.querySelector<HTMLButtonElement>('[aria-label="Open in Codex"]')!; external.focus();
    expect(document.querySelector('[role=tooltip]')!.textContent).toBe('Open in Codex'); external.click(); await flush();
    expect(open).toHaveBeenCalledExactlyOnceWith('current');
    document.querySelector<HTMLButtonElement>('.opt-codex-conversation-select')!.click(); await flush();
    expect(select).toHaveBeenCalledExactlyOnceWith('current'); expect(document.querySelector<HTMLElement>('.opt-codex-compose')!.hidden).toBe(false);
  });

  it('ignores a late list result after returning to the composer or destroying the panel', async () => {
    let finish!: (page: CodexConversationPage) => void;
    remount({ onListConversations: () => new Promise(resolve => { finish = resolve; }), onSelectConversation: vi.fn(async () => {}) });
    nativeRail(); await flush(); panel.open();
    document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click(); await flush();
    document.querySelector<HTMLButtonElement>('[aria-label="Back to conversation"]')!.click();
    finish({ conversations: [{ id: 'late', title: 'Late', updatedAt: 100 }] }); await flush();
    expect(document.querySelector<HTMLElement>('.opt-codex-conversations')!.hidden).toBe(true);
    expect(document.querySelectorAll('.opt-codex-conversation')).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click(); await flush(); panel.destroy();
    finish({ conversations: [] }); await flush(); expect(document.querySelector('#opt-codex-panel')).toBeNull();
  });

  it('prepends earlier messages without replacing the visible paragraph or moving the reading anchor', async () => {
    const load = vi.fn(async () => { panel.prependMessages([{ role: 'user', text: 'Older question', selection }, { role: 'assistant', text: 'Older answer' }]); panel.setHistoryPaging({ hasOlder: false }); });
    remount({ onLoadOlderMessages: load }); nativeRail(); await flush(); panel.open();
    panel.setMessages([{ role: 'user', text: 'Recent question' }, { role: 'assistant', text: 'Paragraph being read' }]);
    panel.setHistoryPaging({ hasOlder: true });
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!, paragraph = document.querySelector<HTMLElement>('[data-role=assistant] p')!;
    let top = 200;
    const insertedHeight = () => document.querySelectorAll('.opt-codex-message').length > 2 ? 180 : 0;
    Object.defineProperties(transcript, { scrollHeight: { get: () => 1000 + insertedHeight() }, clientHeight: { get: () => 400 }, scrollTop: { get: () => top, set: (value: number) => { top = value; } } });
    vi.spyOn(transcript, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 20 + insertedHeight() - (top - 200), 300, 40));
    document.querySelector<HTMLButtonElement>('.opt-codex-earlier button')!.click(); await flush();
    expect(load).toHaveBeenCalledOnce(); expect(top).toBe(380); expect(paragraph.getBoundingClientRect().top).toBe(20);
    expect(document.querySelectorAll('[data-role=assistant] p')[1]).toBe(paragraph);
    expect([...document.querySelectorAll('.opt-codex-message-body')].map(body => body.textContent)).toEqual(['Older question', 'Older answer', 'Recent question', 'Paragraph being read']);
    expect(document.querySelector('.opt-codex-quote-full')!.textContent).toBe(selection.text);
    expect(document.querySelector<HTMLElement>('.opt-codex-earlier')!.hidden).toBe(true);
  });

  it('keeps earlier-message failures retryable and prevents duplicate loads or sending while loading', async () => {
    let finish!: () => void;
    const load = vi.fn<NonNullable<CodexPanelOptions['onLoadOlderMessages']>>().mockRejectedValueOnce(new Error('Read failed')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    remount({ onLoadOlderMessages: load }); nativeRail(); await flush(); panel.open(); panel.setHistoryPaging({ hasOlder: true });
    const earlier = document.querySelector<HTMLButtonElement>('.opt-codex-earlier button')!;
    earlier.click(); await flush(); expect(earlier.textContent).toBe('Retry'); expect(document.querySelector('.opt-codex-earlier-status')!.textContent).toBe('Read failed');
    earlier.click(); earlier.click();
    expect(load).toHaveBeenCalledTimes(2); expect(earlier.disabled).toBe(true);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'New question'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(send).not.toHaveBeenCalled(); finish(); await flush(); expect(earlier.disabled).toBe(false);
  });

  it('handles disabled settings, native rerenders and context invalidation without duplicates', async () => {
    const layout = nativeRail(); await flush(); panel.open();
    settings.enabled = false; panel.update();
    expect(document.getElementById('opt-codex-tab')!.hidden).toBe(true);
    expect(document.getElementById('opt-codex-panel')!.hidden).toBe(true);
    settings.enabled = true; panel.update();
    layout.querySelector('.ide-rail-tabs-wrapper')!.append(document.createElement('span')); await flush();
    expect(document.querySelectorAll('#opt-codex-tab')).toHaveLength(1);
    vi.stubGlobal('chrome', { runtime: { id: undefined } }); layout.append(document.createElement('span')); await flush();
    expect(document.getElementById('opt-codex-panel')).toBeNull();
    expect(document.querySelector('#ide-redesign-editor-and-pdf-panel')).not.toBeNull();
  });

  it('remounts after the body and head are replaced and follows theme changes on the new body', async () => {
    nativeRail(); await flush(); panel.open(); panel.appendMessage('user', 'Retained question', selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Retained draft';
    document.body.replaceWith(document.createElement('body'));
    document.head.replaceWith(document.createElement('head'));
    const layout = nativeRail();
    layout.querySelector<HTMLElement>('.ide-rail-content')!.style.fontFamily = 'Noto Sans';
    document.body.style.backgroundColor = 'rgb(250, 250, 250)'; await flush();
    const restored = document.querySelector<HTMLElement>('#opt-codex-panel')!;
    expect(document.querySelectorAll('#opt-codex-tab')).toHaveLength(1);
    expect(restored.hidden).toBe(false); expect(restored.parentElement).toBe(layout);
    expect(document.head.querySelector('style[data-opt-codex-style]')).not.toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!.value).toBe('Retained draft');
    expect(document.querySelector('.opt-codex-quote-full')!.textContent).toBe(selection.text);
    expect(restored.style.fontFamily).toBe('Noto Sans');
    expect(restored.style.getPropertyValue('--opt-codex-bg')).toBe('rgb(250, 250, 250)');
    document.body.style.backgroundColor = 'rgb(27, 34, 44)'; await flush();
    expect(restored.style.getPropertyValue('--opt-codex-bg')).toBe('rgb(27, 34, 44)');
  });

  it('places a right panel after the editor while keeping its left rail entry and native file navigation', async () => {
    remount({ position: 'right' }); const layout = nativeRail(); await flush(); panel.open();
    const aside = document.querySelector<HTMLElement>('#opt-codex-panel')!;
    expect(layout.lastElementChild).toBe(aside); expect(aside.dataset.position).toBe('right');
    expect(layout.querySelector('#ide-rail-tabs-tab-workbench')!.nextElementSibling!.id).toBe('opt-codex-tab');
    expect(layout.querySelector('#ide-rail-tabs-tab-workbench')!.classList.contains('open-rail')).toBe(true);
    document.querySelector<HTMLButtonElement>('#ide-rail-tabs-tab-file-tree')!.click(); expect(aside.hidden).toBe(false);
    const input = aside.querySelector<HTMLTextAreaElement>('textarea')!; input.value = 'Draft'; panel.setSelection(selection); panel.appendMessage('assistant', 'Answer');
    panel.setPosition('left'); expect(layout.querySelector('nav')!.nextElementSibling).toBe(aside);
    expect(input.value).toBe('Draft'); expect(aside.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    expect(aside.querySelector('.opt-codex-message-body')!.textContent).toBe('Answer');
    panel.setPosition('right'); panel.close(); expect(aside.hidden).toBe(true); panel.open(); expect(layout.lastElementChild).toBe(aside);
  });

  it('reverses keyboard and pointer resize direction on the right and persists only shortcut changes', async () => {
    const change = vi.fn(async () => {}); remount({ position: 'right', onPositionChange: change }); nativeRail(); await flush(); panel.open();
    const aside = document.querySelector<HTMLElement>('#opt-codex-panel')!, handle = aside.querySelector<HTMLElement>('.opt-codex-resize')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); expect(handle.getAttribute('aria-valuenow')).toBe('360');
    handle.onpointerdown?.(new MouseEvent('pointerdown', { button: 0, clientX: 500 }) as PointerEvent);
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 450 })); document.dispatchEvent(new Event('pointerup'));
    expect(handle.getAttribute('aria-valuenow')).toBe('410');
    panel.setPosition('left'); expect(change).not.toHaveBeenCalled();
    const move = document.querySelector<HTMLButtonElement>('[aria-label="Move panel to the right"]')!; move.focus();
    expect(document.querySelector('[role=tooltip]')!.textContent).toBe('Move panel to the right'); move.click(); await flush();
    expect(change).toHaveBeenCalledExactlyOnceWith('right'); expect(aside.dataset.position).toBe('right');
    expect(document.querySelector('[aria-label="Move panel to the left"]')).not.toBeNull();
  });

  it('restores the old panel side when saving the shortcut position fails', async () => {
    remount({ onPositionChange: async () => { throw new Error('Storage unavailable'); } }); const layout = nativeRail(); await flush(); panel.open();
    document.querySelector<HTMLButtonElement>('[aria-label="Move panel to the right"]')!.click(); await flush();
    expect(document.querySelector<HTMLElement>('#opt-codex-panel')!.dataset.position).toBe('left');
    expect(layout.querySelector('nav')!.nextElementSibling!.id).toBe('opt-codex-panel');
    expect(document.querySelector('.opt-codex-status')!.textContent).toBe('Storage unavailable');
  });

  it('copies the complete original assistant source and the latest streamed text without losing LaTeX', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    nativeRail(); await flush(); panel.open();
    const source = '**Result**\n\nInline \\(x=1\\), display \\[x^2=1\\].\n\n```latex\n\\alpha\n```';
    panel.appendMessage('assistant', source);
    document.querySelector<HTMLButtonElement>('[aria-label="Copy source (Markdown / LaTeX)"]')!.click(); await flush();
    expect(writeText).toHaveBeenLastCalledWith(source); expect(document.querySelector('[role=tooltip]')!.textContent).toBe('Copied');
    panel.setAssistantText(source + '\nMore \\(y\\).');
    document.querySelector<HTMLButtonElement>('.opt-codex-message-copy')!.click(); await flush();
    expect(writeText).toHaveBeenLastCalledWith(source + '\nMore \\(y\\).');
  });

  it('leaves formula hover, focus, context menu and clicks alone by default', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Use \\(\\frac{x}{y}\\).');
    const formula = document.querySelector<HTMLElement>('.opt-codex-math')!;
    vi.useFakeTimers();
    formula.dispatchEvent(new Event('pointerover', { bubbles: true }));
    formula.focus();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); formula.dispatchEvent(menu);
    formula.click(); formula.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); formula.dispatchEvent(enter);
    await vi.advanceTimersByTimeAsync(500);
    expect(menu.defaultPrevented).toBe(false); expect(enter.defaultPrevented).toBe(false);
    expect(document.querySelector('.opt-codex-math-copy')).toBeNull(); expect(document.querySelector('[role=tooltip]')).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    expect(document.querySelector('.opt-codex-math')).toBe(formula);
  });

  it('optionally copies a formula quietly without changing thinking or error status', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    settings.clickToCopy = true; nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Use \\(\\frac{x}{y}\\).');
    panel.setStatus('History unavailable'); const formula = document.querySelector<HTMLElement>('.opt-codex-math')!;
    vi.useFakeTimers(); formula.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); await vi.advanceTimersByTimeAsync(300);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('\\frac{x}{y}');
    expect(formula.dataset.copyFeedback).toBe('copied'); expect(document.querySelector('.opt-codex-copy-notice')!.textContent).toBe('Copied');
    expect(document.querySelector('.opt-codex-status')!.textContent).toBe('History unavailable');
    expect(document.querySelector('.opt-codex-math-copy')).toBeNull(); expect(document.querySelector('[role=tooltip]')).toBeNull();
    panel.setStatus(''); panel.setBusy(true); formula.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.opt-codex-activity')!.textContent).toBe('Thinking…'); expect(writeText).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1200); expect(formula.dataset.copyFeedback).toBeUndefined();
  });

  it('preserves selection and double-click gestures and cancels pending copy when disabled or closed', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    settings.clickToCopy = true; nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Use \\(x+y\\).');
    const formula = document.querySelector<HTMLElement>('.opt-codex-math')!;
    const click = () => formula.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    vi.useFakeTimers(); click(); formula.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); formula.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    formula.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    formula.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })); click(); await vi.advanceTimersByTimeAsync(300);
    const range = document.createRange(); range.selectNodeContents(formula); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    click(); await vi.advanceTimersByTimeAsync(300); expect(document.getSelection()!.isCollapsed).toBe(false);
    document.getSelection()!.removeAllRanges(); click(); settings.clickToCopy = false; panel.update(); await vi.advanceTimersByTimeAsync(300);
    settings.clickToCopy = true; click(); panel.close(); await vi.advanceTimersByTimeAsync(300);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('keeps formula copy failure separate from other conversation status', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    settings.clickToCopy = true; nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Use \\(x\\).'); panel.setStatus('Keep this error');
    vi.useFakeTimers(); document.querySelector<HTMLElement>('.opt-codex-math')!.click(); await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector('.opt-codex-copy-notice')!.textContent).toContain('Unable to copy');
    expect(document.querySelector('.opt-codex-status')!.textContent).toBe('Keep this error');
  });

  it('reports visibility transitions and blocks sending only while remote state is active or unknown', async () => {
    const visibility = vi.fn(), newChat = vi.fn(async () => { panel.setRemoteState('idle'); }); remount({ onVisibilityChange: visibility, onNewChat: newChat });
    nativeRail(); await flush(); expect(panel.isOpen()).toBe(false); panel.open(); panel.open();
    expect(panel.isOpen()).toBe(true); expect(visibility).toHaveBeenCalledExactlyOnceWith(true);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'My draft'; panel.setSelection(selection); panel.setRemoteState('active');
    expect(document.querySelector<HTMLButtonElement>('[aria-label=Send]')!.disabled).toBe(true);
    expect(document.querySelector('[aria-label="Stop generating"]:not([hidden])')).toBeNull(); expect(document.querySelector('.opt-codex-remote-status')!.textContent).toBe('Codex desktop is replying…');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); expect(send).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false); expect(document.querySelector<HTMLButtonElement>('[aria-label="Remove selected passage"]')!.disabled).toBe(false);
    panel.setRemoteState('unknown'); expect(document.querySelector('.opt-codex-remote-status')!.textContent).toContain('Retrying automatically');
    expect(document.querySelector('.opt-codex-remote-status')!.textContent).not.toMatch(/new conversation/i);
    document.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!.click(); await flush(); expect(newChat).toHaveBeenCalledOnce();
    expect(input.value).toBe('My draft'); expect(document.querySelector<HTMLButtonElement>('[aria-label=Send]')!.disabled).toBe(false);
    panel.close(); panel.close(); expect(visibility.mock.calls).toEqual([[true], [false]]); expect(panel.isOpen()).toBe(false);
  });

  it('keeps manual cache-sync guidance separate from transient progress and follows the interface language', async () => {
    nativeRail(); await flush(); panel.open();
    const notice=document.querySelector<HTMLElement>('.opt-codex-cache-notice')!;
    expect(notice.hidden).toBe(true);expect(notice.textContent).toBe('');
    panel.setCacheNotice('stale');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Recent edits may not be in the project cache yet');
    expect(notice.textContent).toContain('Settings → Extension → Codex Assistant → Sync project cache');
    expect(notice.getAttribute('role')).toBe('status');expect(notice.getAttribute('aria-live')).toBe('polite');
    const inputWrap=document.querySelector('.opt-codex-input-wrap')!;
    expect(notice.compareDocumentPosition(inputWrap)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    panel.setBusy(true);panel.setStatus('Thinking…');panel.setBusy(false);panel.setStatus('Complete project synced');
    expect(notice.hidden).toBe(false);expect(notice.textContent).toContain('Recent edits');
    document.documentElement.lang='zh-CN';panel.update();
    expect(notice.textContent).toContain('项目缓存可能尚未同步');
    panel.setCacheNotice('error');
    expect(notice.textContent).toContain('项目缓存读取或恢复失败');
    expect(notice.textContent).toContain('Settings → Extension → Codex Assistant → Sync project cache');
    panel.setCacheNotice(null);expect(notice.hidden).toBe(true);expect(notice.textContent).toBe('');
  });

  it('does not replace or reannounce an unchanged cache notice during streamed and status updates', async () => {
    nativeRail();await flush();panel.open();panel.appendMessage('assistant','A response');panel.setCacheNotice('error');
    const notice=document.querySelector<HTMLElement>('.opt-codex-cache-notice')!, content=notice.firstChild;
    const changed=vi.fn(),observer=new MutationObserver(changed);observer.observe(notice,{childList:true,characterData:true,subtree:true,attributes:true});
    panel.setCacheNotice('error');panel.setStatus('Working');panel.setAssistantText('A longer response');panel.update();await flush();
    expect(notice.firstChild).toBe(content);expect(changed).not.toHaveBeenCalled();observer.disconnect();
  });

  it('dismisses only the current cache notice without suppressing a different or recurring problem', async () => {
    nativeRail();await flush();panel.open();panel.setCacheNotice('saved');
    const notice=document.querySelector<HTMLElement>('.opt-codex-cache-notice')!;
    const dismiss=notice.querySelector<HTMLButtonElement>('button')!;
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!;
    input.value='Keep this draft';
    expect(dismiss.type).toBe('button');expect(dismiss.getAttribute('aria-label')).toBe('Dismiss this notice');
    dismiss.focus();dismiss.click();
    expect(notice.hidden).toBe(true);expect(document.activeElement).toBe(input);
    panel.setCacheNotice('saved');panel.setStatus('Working');panel.setBusy(true);panel.setBusy(false);
    panel.close();panel.open();document.documentElement.lang='zh-CN';panel.update();
    expect(notice.hidden).toBe(true);expect(dismiss.getAttribute('aria-label')).toBe('关闭本次提示');
    expect(input.value).toBe('Keep this draft');expect(send).not.toHaveBeenCalled();
    panel.setCacheNotice('error');expect(notice.hidden).toBe(false);expect(notice.textContent).toContain('项目缓存读取或恢复失败');
    dismiss.click();panel.setCacheNotice(null);panel.setCacheNotice('error');
    expect(notice.hidden).toBe(false);
  });

  it('preserves the reading position, draft focus and quoted source when a cache notice appears or clears', async () => {
    nativeRail();await flush();panel.open();
    const transcript=document.querySelector<HTMLElement>('.opt-codex-messages')!, notice=document.querySelector<HTMLElement>('.opt-codex-cache-notice')!;
    let top=0;const height=()=>notice.hidden?400:320;
    Object.defineProperties(transcript,{scrollHeight:{get:()=>1000},clientHeight:{get:height},scrollTop:{get:()=>top,set:(value:number)=>{top=Math.max(0,Math.min(value,1000-height()));}}});
    vi.spyOn(transcript,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,0,300,height()));
    panel.appendMessage('assistant','Keep reading this paragraph.');
    const paragraph=document.querySelector<HTMLElement>('[data-role=assistant] p')!;
    vi.spyOn(paragraph,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,280-top,300,40));
    top=250;transcript.dispatchEvent(new Event('scroll'));
    panel.setSelection(selection);
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!;
    input.value='Keep the unfinished question';input.focus();input.setSelectionRange(2,8);
    panel.setCacheNotice('stale');
    expect(top).toBe(250);expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Keep the unfinished question');expect(input.selectionStart).toBe(2);expect(input.selectionEnd).toBe(8);
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    notice.querySelector<HTMLButtonElement>('button')!.click();expect(notice.hidden).toBe(true);expect(top).toBe(250);
    expect(input.value).toBe('Keep the unfinished question');expect(document.activeElement).toBe(input);
    panel.setCacheNotice(null);expect(top).toBe(250);expect(document.activeElement).toBe(input);expect(send).not.toHaveBeenCalled();
  });

  it('keeps drafts and source quotations while another page is syncing, then enables sending after recovery', async () => {
    const newChat=vi.fn(async()=>{}), queue=vi.fn(async()=>{});remount({onNewChat:newChat,onQueue:queue});
    nativeRail();await flush();panel.open();
    const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;
    input.value='Continue this argument';input.setSelectionRange(3,7);input.dispatchEvent(new Event('input'));
    panel.setSelection(selection);panel.setRemoteState('unknown',true);
    const status=document.querySelector<HTMLElement>('.opt-codex-remote-status')!;
    expect(status.textContent).toBe('Waiting for the other page. Sync will resume automatically.');
    expect(status.textContent).not.toMatch(/new conversation|reconnect/i);
    expect(status.getAttribute('aria-live')).toBe('off');expect(status.hasAttribute('role')).toBe(false);
    const unchangedText=status.firstChild;panel.setRemoteState('unknown',true);expect(status.firstChild).toBe(unchangedText);
    expect(document.querySelector<HTMLButtonElement>('[aria-label=Send]')!.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    document.querySelector<HTMLButtonElement>('[aria-label=Send]')!.click();
    expect(send).not.toHaveBeenCalled();expect(queue).not.toHaveBeenCalled();expect(newChat).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false);expect(input.value).toBe('Continue this argument');
    expect(input.selectionStart).toBe(3);expect(input.selectionEnd).toBe(7);
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    panel.setRemoteState('idle');
    expect(status.hidden).toBe(true);expect(document.querySelector<HTMLButtonElement>('[aria-label=Send]')!.disabled).toBe(false);
    expect(input.value).toBe('Continue this argument');expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
  });

  it('syncs the same conversation by ID without replacing unchanged content, quotes or drafts', async () => {
    nativeRail(); await flush(); panel.open();
    const values = [{ messageId: 'u1', role: 'user' as const, text: 'Question', selection }, { messageId: 'a1', role: 'assistant' as const, text: 'Read this paragraph.\n\nUse \\(x\\).' }];
    panel.setMessages(values); const original = [...document.querySelectorAll('.opt-codex-message')];
    const formula = document.querySelector('.opt-codex-math')!, quote = document.querySelector<HTMLDetailsElement>('.opt-codex-message-selection')!; quote.open = true;
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Still editing'; input.setSelectionRange(2, 5); panel.setSelection(selection);
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!; let top = 420, height = 1000;
    Object.defineProperties(transcript, { scrollTop: { get: () => top, set: (value: number) => { top = value; } }, scrollHeight: { get: () => height }, clientHeight: { get: () => 400 } });
    transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 })); transcript.dispatchEvent(new Event('scroll'));
    panel.syncMessages(values); expect(document.querySelector('.opt-codex-math')).toBe(formula);
    height = 1400; panel.syncMessages([...values, { messageId: 'u2', role: 'user', text: 'From desktop' }, { messageId: 'a2', role: 'assistant', text: 'New answer' }]);
    expect([...document.querySelectorAll('.opt-codex-message')].slice(0, 2)).toEqual(original); expect(top).toBe(420);
    expect(document.querySelector('.opt-codex-message-selection')).toBe(quote); expect(quote.open).toBe(true);
    expect(input.value).toBe('Still editing'); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(5);
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    panel.syncMessages([...values, { messageId: 'u2', role: 'user', text: 'From desktop' }, { messageId: 'a2', role: 'assistant', text: 'New answer completed' }]);
    expect(document.querySelectorAll('.opt-codex-message')[3].textContent).toContain('completed'); expect(top).toBe(420);
  });

  it('uses message IDs when history shifts and adopts IDs for locally appended messages', async () => {
    nativeRail(); await flush(); panel.appendMessage('user', 'Question', selection); panel.appendMessage('assistant', 'Answer');
    const originals = [...document.querySelectorAll('.opt-codex-message')];
    const values = [{ messageId: 'u', role: 'user' as const, text: 'Question', selection }, { messageId: 'a', role: 'assistant' as const, text: 'Answer' }];
    panel.syncMessages(values); expect([...document.querySelectorAll('.opt-codex-message')]).toEqual(originals);
    panel.syncMessages([{ messageId: 'old', role: 'user', text: 'Earlier question' }, ...values]);
    expect([...document.querySelectorAll('.opt-codex-message')].slice(1)).toEqual(originals);
    panel.syncMessages([values[1]]); expect([...document.querySelectorAll('.opt-codex-message')]).toEqual([originals[1]]);
  });

  it('requests a current editor selection before focusing the composer on open', async () => {
    nativeRail(); await flush();
    let focusedAtRequest: Element | null | undefined;
    const capture = () => { focusedAtRequest = document.activeElement; panel.setSelection(selection); };
    document.addEventListener('opt:request-selection', capture);
    try {
      panel.open(); const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!;
      expect(focusedAtRequest).not.toBe(input); expect(document.activeElement).toBe(input);
      expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    } finally { document.removeEventListener('opt:request-selection', capture); }
  });

  it('quotes only after an explicit action and sends exact selected prose and original LaTeX with a draft', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    nativeRail(); await flush(); panel.open();
    panel.setMessages([{ messageId: 'answer-1', role: 'assistant', text: 'Keep **this** \\(x+y\\). Tail' }]);
    panel.setSelection(selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Why does this hold?'; input.dispatchEvent(new Event('input'));
    const paragraph = document.querySelector('[data-role=assistant] p')!, range = document.createRange();
    range.setStart(paragraph.firstChild!, 5); range.setEnd(paragraph.lastChild!, 1); await selectAnswerRange(range);
    const action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!, card = document.querySelector<HTMLElement>('.opt-codex-answer-quote')!;
    expect(action.hidden).toBe(false); expect(card.hidden).toBe(true); expect(send).not.toHaveBeenCalled(); expect(input.value).toBe('Why does this hold?');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); action.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
    action.click();
    expect(card.hidden).toBe(false); expect(card.querySelector('.opt-codex-selection-source')!.textContent).toBe('this \\(x+y\\).');
    expect(document.querySelector('.opt-codex-selection:not(.opt-codex-answer-quote) .opt-codex-selection-source')!.textContent).toBe(selection.text);
    expect(input.value).toBe('Why does this hold?'); expect(document.activeElement).toBe(input); expect(send).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    expect(send).toHaveBeenCalledExactlyOnceWith('Why does this hold?', selection, { messageId: 'answer-1', text: 'this \\(x+y\\).' });
    expect(input.value).toBe(''); expect(card.hidden).toBe(true);
  });

  it('keeps the quote action usable by keyboard and removes only the chosen answer quote', async () => {
    nativeRail(); await flush(); panel.open(); panel.setSelection(selection); panel.appendMessage('assistant', 'A chosen answer');
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!));
    const action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!; action.focus();
    await selectAnswerRange(); expect(action.hidden).toBe(false); action.click();
    const card = document.querySelector<HTMLElement>('.opt-codex-answer-quote')!, label = card.querySelector<HTMLButtonElement>('.opt-codex-selection-label')!;
    label.click(); expect(label.getAttribute('aria-expanded')).toBe('true'); expect(card.classList.contains('expanded')).toBe(true);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Draft stays';
    document.querySelector<HTMLButtonElement>('[aria-label="Remove quoted answer"]')!.click();
    expect(card.hidden).toBe(true); expect(input.value).toBe('Draft stays'); expect(document.activeElement).toBe(input);
    expect(document.querySelector<HTMLElement>('.opt-codex-selection:not(.opt-codex-answer-quote)')!.hidden).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    expect(send).toHaveBeenCalledExactlyOnceWith('Draft stays', selection);
  });

  it('restores a failed send with both references and preserves text typed while waiting', async () => {
    let reject!: (reason: Error) => void; send.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
    nativeRail(); await flush(); panel.open(); panel.setSelection(selection); panel.appendMessage('assistant', 'Quoted answer');
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!)); document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!.click();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Original question'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const card = document.querySelector<HTMLElement>('.opt-codex-answer-quote')!; expect(card.hidden).toBe(true);
    input.value = 'New draft'; reject(new Error('Connection unavailable')); await flush();
    expect(input.value).toBe('New draft'); expect(card.hidden).toBe(false); expect(card.querySelector('.opt-codex-selection-source')!.textContent).toBe('Quoted answer');
    expect(document.querySelector('.opt-codex-selection:not(.opt-codex-answer-quote) .opt-codex-selection-source')!.textContent).toBe(selection.text);
    expect(document.querySelector('.opt-codex-status')!.textContent).toBe('Connection unavailable');
    send.mockResolvedValue(undefined); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    expect(send).toHaveBeenLastCalledWith('New draft', selection, { text: 'Quoted answer' });
  });

  it('does not overwrite a newer answer quote when an older send fails', async () => {
    let reject!: (reason: Error) => void; send.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
    nativeRail(); await flush(); panel.open(); panel.setMessages([{ messageId: 'a1', role: 'assistant', text: 'First answer' }, { messageId: 'a2', role: 'assistant', text: 'Second answer' }]);
    const paragraphs = document.querySelectorAll('[data-role=assistant] p');
    await selectAnswerRange(contentsRange(paragraphs[0])); document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!.click();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Question'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await selectAnswerRange(contentsRange(paragraphs[1])); document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!.click();
    reject(new Error('Disconnected')); await flush();
    expect(input.value).toBe('Question'); expect(document.querySelector('.opt-codex-answer-quote .opt-codex-selection-source')!.textContent).toBe('Second answer');
  });

  it('renders and syncs history answer cards independently of manuscript references', async () => {
    nativeRail(); await flush(); panel.open();
    const answerQuote = { messageId: 'a1', text: 'Selected \\(\\alpha\\)' }, values = [{ messageId: 'u1', role: 'user' as const, text: 'Explain', selection, answerQuote }];
    panel.setMessages(values);
    const message = document.querySelector('.opt-codex-message')!, card = message.querySelector<HTMLDetailsElement>('.opt-codex-message-answer-quote')!, manuscript = message.querySelector<HTMLDetailsElement>('.opt-codex-message-selection:not(.opt-codex-message-answer-quote)')!, body = message.querySelector('.opt-codex-message-body');
    card.open = true; manuscript.open = true;
    expect(card.querySelector('.opt-codex-quote-full')!.textContent).toBe(answerQuote.text); expect(card.getAttribute('aria-label')).toBe('Codex answer');
    panel.syncMessages(values); expect(message.querySelector('.opt-codex-message-answer-quote')).toBe(card); expect(card.open).toBe(true);
    panel.syncMessages([{ ...values[0], answerQuote: { text: 'Reconciled quote' } }]);
    const updated = message.querySelector<HTMLDetailsElement>('.opt-codex-message-answer-quote')!;
    expect(updated.open).toBe(true); expect(updated.querySelector('.opt-codex-quote-full')!.textContent).toBe('Reconciled quote');
    expect(message.querySelector('.opt-codex-message-body')).toBe(body); expect(message.querySelector('.opt-codex-message-selection:not(.opt-codex-message-answer-quote)')).toBe(manuscript); expect(manuscript.open).toBe(true);
    panel.syncMessages([{ ...values[0], answerQuote: undefined }]); expect(message.querySelector('.opt-codex-message-answer-quote')).toBeNull(); expect(manuscript.isConnected).toBe(true);
  });

  it('rejects user, external, collapsed and cross-answer selections without changing the composer', async () => {
    nativeRail(); await flush(); panel.open(); panel.setMessages([{ role: 'user', text: 'User words' }, { role: 'assistant', text: 'First answer' }, { role: 'assistant', text: 'Second answer' }]);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea')!; input.value = 'Retained draft';
    const paragraphs = document.querySelectorAll('[data-role=assistant] p'), action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!;
    await selectAnswerRange(contentsRange(paragraphs[0])); expect(action.hidden).toBe(false);
    const invalid = [contentsRange(document.querySelector('[data-role=user] .opt-codex-message-body')!), contentsRange(document.querySelector('#ide-redesign-editor-and-pdf-panel')!)];
    const collapsed = document.createRange(); collapsed.setStart(paragraphs[0].firstChild!, 2); collapsed.collapse(true); invalid.push(collapsed);
    const cross = document.createRange(); cross.setStart(paragraphs[0].firstChild!, 1); cross.setEnd(paragraphs[1].firstChild!, 4); invalid.push(cross);
    for (const range of invalid) { await selectAnswerRange(range); expect(action.hidden).toBe(true); action.click(); }
    expect(document.querySelector<HTMLElement>('.opt-codex-answer-quote')!.hidden).toBe(true); expect(input.value).toBe('Retained draft'); expect(send).not.toHaveBeenCalled();
  });

  it('follows Overleaf locale for quote actions and cards without changing quoted text', async () => {
    nativeRail(); await flush(); panel.open(); panel.setMessages([{ role: 'user', text: 'Question', answerQuote: { text: 'Earlier answer' } }, { role: 'assistant', text: 'Untranslated selected text' }]);
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!));
    const action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!; expect(action.textContent).toBe('Quote selected text');
    document.documentElement.lang = 'zh-CN'; await flush(); expect(action.textContent).toBe('引用所选内容'); action.click();
    expect(document.querySelector('[aria-label="移除回答引用"]')).not.toBeNull(); expect(document.querySelector('[aria-label="展开完整回答引用"]')).not.toBeNull();
    expect(document.querySelector('.opt-codex-answer-quote .opt-codex-selection-source')!.textContent).toBe('Untranslated selected text');
    const history = document.querySelector('.opt-codex-message-answer-quote')!; expect(history.getAttribute('aria-label')).toBe('Codex 回答'); expect(history.querySelector('summary > span')!.textContent).toBe('Codex 回答');
    document.documentElement.lang = 'en'; await flush(); expect(document.querySelector('[aria-label="Remove quoted answer"]')).not.toBeNull(); expect(history.getAttribute('aria-label')).toBe('Codex answer');
  });

  it('keeps selected answer text anchored when its quote action reduces transcript height', async () => {
    nativeRail(); await flush(); panel.open();
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!, action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!;
    let top = 0; const viewportHeight = () => action.hidden ? 400 : 368;
    Object.defineProperties(transcript, { scrollHeight: { get: () => 1000 }, clientHeight: { get: viewportHeight }, scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, 1000 - viewportHeight())); } } });
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, viewportHeight()));
    panel.appendMessage('assistant', 'Keep this paragraph still while selecting.'); expect(top).toBe(600);
    const paragraph = document.querySelector<HTMLElement>('[data-role=assistant] p')!;
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 620 - top, 300, 40));
    const range = document.createRange(); range.setStart(paragraph.firstChild!, 5); range.setEnd(paragraph.firstChild!, 19); await selectAnswerRange(range);
    expect(action.hidden).toBe(false); expect(top).toBe(600); expect(paragraph.getBoundingClientRect().top).toBe(20);
    expect(document.getSelection()!.toString()).toBe('this paragraph');
  });

  it('clears a quote action when synced history removes or changes its source answer', async () => {
    nativeRail(); await flush(); panel.open(); panel.setMessages([{ messageId: 'a1', role: 'assistant', text: 'Previous answer' }]);
    const action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!;
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!)); expect(action.hidden).toBe(false);
    panel.syncMessages([{ messageId: 'a1', role: 'assistant', text: 'Updated answer' }]); expect(action.hidden).toBe(true);
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!)); expect(action.hidden).toBe(false);
    panel.syncMessages([]); expect(action.hidden).toBe(true); action.click();
    expect(document.querySelector<HTMLElement>('.opt-codex-answer-quote')!.hidden).toBe(true); expect(send).not.toHaveBeenCalled();
  });

  it('does not redisplay an attached or dismissed selection until the selected range changes', async () => {
    nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'First part and second part');
    const paragraph = document.querySelector('[data-role=assistant] p')!, range = document.createRange(); range.setStart(paragraph.firstChild!, 0); range.setEnd(paragraph.firstChild!, 10);
    const action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!;
    await selectAnswerRange(range); action.click(); await selectAnswerRange(range); expect(action.hidden).toBe(true);
    const next = document.createRange(); next.setStart(paragraph.firstChild!, 15); next.setEnd(paragraph.firstChild!, 26); await selectAnswerRange(next); expect(action.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-latest')!.hidden).toBe(true);
    document.querySelector('#opt-codex-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await selectAnswerRange(next); expect(action.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-latest')!.hidden).toBe(false);
    await selectAnswerRange(); await selectAnswerRange(next); expect(action.hidden).toBe(false);
  });

  it('returns to draft and historical manuscript quotes without changing cards or drafts', async () => {
    const reveal = vi.fn(async () => {}); remount({ onRevealSource: reveal }); nativeRail(); await flush(); panel.open();
    panel.setSelection(selection); panel.appendMessage('user', 'Earlier question', selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!; input.value = 'Unsent question';
    const draft = document.querySelector<HTMLElement>('.opt-codex-selection:not(.opt-codex-answer-quote)')!;
    const card = document.querySelector<HTMLDetailsElement>('.opt-codex-message-selection')!;
    draft.querySelector<HTMLButtonElement>('.opt-codex-source-button')!.click(); await flush();
    expect(reveal).toHaveBeenLastCalledWith(selection); expect(draft.hidden).toBe(false); expect(input.value).toBe('Unsent question');
    card.querySelector<HTMLButtonElement>('.opt-codex-source-button')!.click(); await flush(); expect(card.open).toBe(false);
    card.open = true; card.querySelector<HTMLButtonElement>('.opt-codex-source-button')!.click(); await flush();
    expect(card.open).toBe(true); expect(reveal).toHaveBeenCalledTimes(3); expect(send).not.toHaveBeenCalled();
    document.documentElement.lang = 'zh'; await flush();
    const control = draft.querySelector<HTMLButtonElement>('.opt-codex-source-button')!; expect(control.getAttribute('aria-label')).toBe('回到引用位置'); control.focus();
    expect(document.querySelector('.opt-codex-tooltip')!.textContent).toBe('回到引用位置');
  });

  it('reports source navigation failures without removing the manuscript citation', async () => {
    remount({ onRevealSource: async () => { throw new Error('The original file was removed.'); } }); nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    document.querySelector<HTMLButtonElement>('.opt-codex-selection .opt-codex-source-button')!.click(); await flush();
    expect(document.querySelector('.opt-codex-source-notice')!.textContent).toBe('The original file was removed.');
    expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
  });

  it('serializes manuscript navigation and re-enables actions after completion', async () => {
    let finish!: () => void; const reveal = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    remount({ onRevealSource: reveal }); nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    const button = document.querySelector<HTMLButtonElement>('.opt-codex-selection .opt-codex-source-button')!; button.click(); button.click();
    expect(reveal).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true); finish(); await flush(); expect(button.disabled).toBe(false);
  });

  it('keeps the panel and draft during source navigation rail clicks but honors real user navigation', async () => {
    let finish!: () => void;
    const addListener = vi.spyOn(document, 'addEventListener');
    remount({ onRevealSource: () => new Promise<void>(resolve => { finish = resolve; document.querySelector<HTMLButtonElement>('#ide-rail-tabs-tab-file-tree')!.click(); }) });
    const nativeNavigation = addListener.mock.calls.find(([name, , capture]) => name === 'click' && capture === true)![1] as EventListener;
    nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!; input.value = 'Keep this draft';
    document.querySelector<HTMLButtonElement>('.opt-codex-selection .opt-codex-source-button')!.click();
    expect(panel.isOpen()).toBe(true); expect(input.value).toBe('Keep this draft'); expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
    const fileTab = document.querySelector<HTMLButtonElement>('#ide-rail-tabs-tab-file-tree')!;
    // jsdom's dispatchEvent cannot create trusted events; exercise the same
    // captured rail listener with browser-supplied trust metadata.
    nativeNavigation({ target: fileTab, isTrusted: true } as unknown as Event); expect(panel.isOpen()).toBe(false);
    finish(); await flush(); panel.open(); fileTab.click(); expect(panel.isOpen()).toBe(false);
  });

  it('keeps native rail restoration protected if chat history changes during a source reveal', async () => {
    let finish!: () => void;
    remount({ onRevealSource: async () => { await new Promise<void>(resolve => { finish = resolve; }); document.querySelector<HTMLButtonElement>('#ide-rail-tabs-tab-file-tree')!.click(); } });
    nativeRail(); await flush(); panel.open(); panel.setSelection(selection);
    document.querySelector<HTMLButtonElement>('.opt-codex-selection .opt-codex-source-button')!.click();
    panel.setMessages([{ role: 'assistant', text: 'Newly loaded conversation' }]);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-selection .opt-codex-source-button')!.disabled).toBe(true);
    finish(); await flush(); expect(panel.isOpen()).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.opt-codex-selection .opt-codex-source-button')!.disabled).toBe(false);
  });

  it('highlights a multi-paragraph quote at its starting paragraph after scrolling completes', async () => {
    nativeRail(); await flush(); panel.open(); panel.setMessages([{ messageId: 'source', role: 'assistant', text: 'Introduction.\n\nFirst selected paragraph.\n\nSecond selected paragraph.' }, { role: 'user', text: 'Question', answerQuote: { messageId: 'source', text: 'selected paragraph.\nSecond selected paragraph.' } }]);
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!, paragraphs = document.querySelectorAll<HTMLElement>('[data-role=assistant] p');
    Object.defineProperty(transcript, 'scrollTo', { value: vi.fn(() => undefined) });
    document.querySelector<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button')!.click(); await flush();
    expect(document.querySelector('.opt-codex-source-highlight')).toBeNull(); transcript.dispatchEvent(new Event('scrollend')); await flush();
    expect(paragraphs[1].classList.contains('opt-codex-source-highlight')).toBe(true); expect(paragraphs[0].classList.contains('opt-codex-source-highlight')).toBe(false);
  });

  it('uses an answer id among duplicate text and keeps bottom-follow paused after returning', async () => {
    nativeRail(); await flush(); panel.open();
    panel.setMessages([{ messageId: 'a1', role: 'assistant', text: 'Same quoted text' }, { messageId: 'a2', role: 'assistant', text: 'Same quoted text' }, { role: 'user', text: 'Explain', answerQuote: { messageId: 'a1', text: 'Same quoted text' } }]);
    const paragraphs = document.querySelectorAll<HTMLElement>('[data-role=assistant] p'), transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!;
    let top = 20; Object.defineProperties(transcript, { scrollHeight: { get: () => 1000 }, clientHeight: { get: () => 500 }, scrollTop: { get: () => top, set: value => { top = value; } } });
    const scroll = vi.fn(({ top: next }: ScrollToOptions) => { top = next!; return Promise.resolve(); }); Object.defineProperty(transcript, 'scrollTo', { value: scroll });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.spyOn(paragraphs[0], 'getBoundingClientRect').mockReturnValue({ top: 200 } as DOMRect);
    const card = document.querySelector<HTMLDetailsElement>('.opt-codex-message-answer-quote')!;
    card.querySelector<HTMLButtonElement>('.opt-codex-source-button')!.click(); await flush();
    expect(scroll).toHaveBeenCalledWith({ top: 196, behavior: 'instant' }); expect(paragraphs[0].classList.contains('opt-codex-source-highlight')).toBe(true); expect(paragraphs[1].classList.contains('opt-codex-source-highlight')).toBe(false); expect(card.open).toBe(false);
    // A late programmatic scroll event at the bottom must not resume following.
    top = 500; transcript.dispatchEvent(new Event('scroll')); panel.appendMessage('assistant', 'Another streamed chunk');
    expect(top).toBe(500); expect(document.querySelector<HTMLButtonElement>('.opt-codex-latest')!.hidden).toBe(false);
  });

  it('does not cancel a source scroll when streamed layout updates preserve the viewport', async () => {
    nativeRail(); await flush(); panel.open();
    panel.setMessages([{ messageId: 'original', role: 'assistant', text: 'Quoted origin' }, { role: 'user', text: 'Explain', answerQuote: { messageId: 'original', text: 'Quoted origin' } }]);
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!, paragraph = document.querySelector<HTMLElement>('[data-role=assistant] p')!;
    let top = 900, sourceOffset = 100, writes = 0, destination = 0, finish!: () => void;
    Object.defineProperties(transcript, { scrollHeight: { get: () => 1200 }, clientHeight: { get: () => 300 }, scrollTop: { get: () => top, set: value => { writes++; top = value; } } });
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => ({ top: sourceOffset - top, bottom: sourceOffset - top + 30, height: 30 }) as DOMRect);
    Object.defineProperty(transcript, 'scrollTo', { value: vi.fn(({ top: next }: ScrollToOptions) => { destination = next!; return new Promise<void>(resolve => { finish = resolve; }); }) });
    document.querySelector<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button')!.click();
    panel.setStatus('Streaming status update'); panel.setHistoryPaging({ hasOlder: false });
    expect(writes).toBe(0); expect(top).toBe(900); expect(document.querySelector('.opt-codex-source-highlight')).toBeNull();
    // A formula above the source grows while the native animation is in flight.
    sourceOffset = 240; top = destination; finish(); await flush();
    expect(top).toBe(216); expect(paragraph.getBoundingClientRect().top).toBe(24); expect(paragraph.classList.contains('opt-codex-source-highlight')).toBe(true);
    panel.setStatus('Another update'); expect(top).toBe(216);
  });

  it('does not pull the user back if they manually scroll while a source jump is in flight', async () => {
    nativeRail(); await flush(); panel.open(); panel.setMessages([{ messageId: 'a1', role: 'assistant', text: 'Quoted source' }, { role: 'user', text: 'Question', answerQuote: { messageId: 'a1', text: 'Quoted source' } }]);
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!; let finish!: () => void;
    Object.defineProperty(transcript, 'scrollTo', { value: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
    document.querySelector<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button')!.click();
    transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); transcript.scrollTop = 200; finish(); await flush();
    expect(transcript.scrollTop).toBe(200); expect(document.querySelector('.opt-codex-source-highlight')).toBeNull();
  });

  it('finds the live paragraph if streaming rerenders the source during a jump', async () => {
    nativeRail(); await flush(); panel.open();
    panel.setMessages([{ messageId: 'source', role: 'assistant', text: 'Quoted source' }]);
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!)); document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!.click();
    const transcript = document.querySelector<HTMLElement>('.opt-codex-messages')!; let finish!: () => void;
    Object.defineProperty(transcript, 'scrollTo', { value: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
    document.querySelector<HTMLButtonElement>('.opt-codex-answer-quote .opt-codex-source-button')!.click();
    panel.setAssistantText('Quoted source continues streaming.'); finish(); await flush();
    expect(document.querySelector('.opt-codex-source-highlight')!.textContent).toBe('Quoted source continues streaming.');
  });

  it('returns to the exact draft answer even before it receives a persistent id', async () => {
    nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Repeated answer'); panel.appendMessage('assistant', 'Repeated answer');
    const paragraphs = document.querySelectorAll<HTMLElement>('[data-role=assistant] p');
    await selectAnswerRange(contentsRange(paragraphs[1])); document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!.click();
    const input = document.querySelector<HTMLTextAreaElement>('#opt-codex-input')!; input.value = 'Follow-up draft'; panel.setSelection(selection); panel.setBusy(true);
    document.querySelector<HTMLButtonElement>('.opt-codex-answer-quote .opt-codex-source-button')!.click(); await flush();
    expect(paragraphs[1].classList.contains('opt-codex-source-highlight')).toBe(true); expect(paragraphs[0].classList.contains('opt-codex-source-highlight')).toBe(false);
    expect(input.value).toBe('Follow-up draft'); expect(document.querySelector<HTMLElement>('.opt-codex-answer-quote')!.hidden).toBe(false); expect(document.querySelector('.opt-codex-selection-source')!.textContent).toBe(selection.text);
  });

  it('loads older pages until the identified answer is available and preserves the quoted card', async () => {
    let count = 0; const load = vi.fn(async () => { count++; panel.prependMessages([{ messageId: count === 2 ? 'original' : 'older', role: 'assistant', text: count === 2 ? 'Original answer' : 'Unrelated page' }]); panel.setHistoryPaging({ hasOlder: count < 2 }); });
    remount({ onLoadOlderMessages: load }); nativeRail(); await flush(); panel.open(); panel.setMessages([{ role: 'user', text: 'Question', answerQuote: { messageId: 'original', text: 'Original answer' } }]); panel.setHistoryPaging({ hasOlder: true });
    const card = document.querySelector<HTMLDetailsElement>('.opt-codex-message-answer-quote')!;
    card.querySelector<HTMLButtonElement>('.opt-codex-source-button')!.click(); await flush();
    expect(load).toHaveBeenCalledTimes(2); expect(document.querySelector('.opt-codex-source-highlight')!.textContent).toBe('Original answer'); expect(card.isConnected).toBe(true); expect(card.open).toBe(false);
    expect(document.querySelector<HTMLElement>('.opt-codex-source-notice')!.hidden).toBe(true);
  });

  it('does not jump to ambiguous or missing legacy quotes and normalizes rendered math delimiters', async () => {
    nativeRail(); await flush(); panel.open();
    const click = async () => { document.querySelector<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button')!.click(); await flush(); };
    panel.setMessages([{ role: 'assistant', text: 'Duplicate' }, { role: 'assistant', text: 'Duplicate' }, { role: 'user', text: 'Question', answerQuote: { text: 'Duplicate' } }]);
    await click(); expect(document.querySelector('.opt-codex-source-highlight')).toBeNull(); expect(document.querySelector('.opt-codex-source-notice')!.textContent).toContain('Several messages');
    panel.setMessages([{ role: 'assistant', text: 'Different' }, { role: 'user', text: 'Question', answerQuote: { text: 'Removed text' } }]);
    await click(); expect(document.querySelector('.opt-codex-source-highlight')).toBeNull(); expect(document.querySelector('.opt-codex-source-notice')!.textContent).toContain('no longer available');
    panel.setMessages([{ role: 'assistant', text: 'A **selected** \\(x+y\\) result.' }, { role: 'user', text: 'Question', answerQuote: { text: 'selected $x+y$ result.' } }]);
    await click(); expect(document.querySelector('.opt-codex-source-highlight')!.textContent).toContain('selected');
  });

  it('bounds source lookup and stops before guessing when history remains unloaded', async () => {
    let count = 0; const load = vi.fn(async () => { panel.prependMessages([{ messageId: `page-${++count}`, role: 'assistant', text: 'Not the source' }]); });
    remount({ onLoadOlderMessages: load }); nativeRail(); await flush(); panel.open(); panel.setMessages([{ role: 'user', text: 'Question', answerQuote: { text: 'Missing source' } }]); panel.setHistoryPaging({ hasOlder: true });
    document.querySelector<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button')!.click(); await flush();
    expect(load).toHaveBeenCalledTimes(8); expect(document.querySelector('.opt-codex-source-highlight')).toBeNull(); expect(document.querySelector('.opt-codex-source-notice')!.textContent).toContain('further back');
  });

  it('refuses older-page reads during generation but still allows loaded answer returns', async () => {
    const load = vi.fn(async () => {}); remount({ onLoadOlderMessages: load }); nativeRail(); await flush(); panel.open();
    panel.setMessages([{ messageId: 'loaded', role: 'assistant', text: 'Known source' }, { role: 'user', text: 'First', answerQuote: { messageId: 'unloaded', text: 'Earlier source' } }, { role: 'user', text: 'Second', answerQuote: { messageId: 'loaded', text: 'Known source' } }]); panel.setHistoryPaging({ hasOlder: true }); panel.setBusy(true);
    const buttons = document.querySelectorAll<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button'); buttons[0].click(); await flush();
    expect(load).not.toHaveBeenCalled(); expect(document.querySelector('.opt-codex-source-notice')!.textContent).toContain('current reply finishes');
    buttons[1].click(); await flush(); expect(document.querySelector('.opt-codex-source-highlight')!.textContent).toBe('Known source');
  });

  it('cancels an obsolete source lookup when the conversation changes', async () => {
    let finish!: () => void; const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    remount({ onLoadOlderMessages: load }); nativeRail(); await flush(); panel.open(); panel.setMessages([{ role: 'user', text: 'Question', answerQuote: { messageId: 'old', text: 'Original' } }]); panel.setHistoryPaging({ hasOlder: true });
    const button = document.querySelector<HTMLButtonElement>('.opt-codex-message-answer-quote .opt-codex-source-button')!; button.click(); button.click(); expect(load).toHaveBeenCalledTimes(1);
    panel.setMessages([{ messageId: 'old', role: 'assistant', text: 'Original' }]); panel.setHistoryPaging({ hasOlder: false }); finish(); await flush();
    expect(document.querySelector('.opt-codex-source-highlight')).toBeNull(); expect(document.querySelector<HTMLElement>('.opt-codex-source-notice')!.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!.disabled).toBe(false);
  });

  it('clears transient quote candidates on Escape, close, history replacement and destroy', async () => {
    nativeRail(); await flush(); panel.open(); panel.appendMessage('assistant', 'Temporary selection');
    const action = document.querySelector<HTMLButtonElement>('.opt-codex-quote-selected')!, paragraph = document.querySelector('[data-role=assistant] p')!;
    await selectAnswerRange(contentsRange(paragraph)); document.querySelector('#opt-codex-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(action.hidden).toBe(true);
    await selectAnswerRange(contentsRange(paragraph)); panel.close(); expect(action.hidden).toBe(true); panel.open(); expect(action.hidden).toBe(true);
    await selectAnswerRange(contentsRange(paragraph)); panel.setMessages([{ role: 'assistant', text: 'Replacement answer' }]); expect(action.hidden).toBe(true); action.click(); expect(document.querySelector<HTMLElement>('.opt-codex-answer-quote')!.hidden).toBe(true);
    await selectAnswerRange(contentsRange(document.querySelector('[data-role=assistant] p')!)); action.click(); panel.clearAnswerQuote(); expect(document.querySelector<HTMLElement>('.opt-codex-answer-quote')!.hidden).toBe(true);
    const remove = vi.spyOn(document, 'removeEventListener');
    document.dispatchEvent(new Event('selectionchange')); panel.destroy();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await flush();
    expect(remove).toHaveBeenCalledWith('selectionchange', expect.any(Function)); expect(document.querySelector('#opt-codex-panel')).toBeNull(); expect(send).not.toHaveBeenCalled();
  });
});

describe('safe assistant Markdown and formulas', () => {
  it('renders structure and safe links while keeping HTML and unsafe links inert', () => {
    const element = document.createElement('div');
    renderAssistantMessage(element, '## Result\n\n**Bold** and `code` and [source](https://example.com/p).\n\n<script>alert(1)</script> [bad](javascript:alert)\n\n- First\n- Second\n\n```latex\n\\phi = 0\n```');
    expect(element.querySelector('strong')!.textContent).toBe('Bold');
    expect(element.querySelectorAll('li')).toHaveLength(2);
    expect(element.querySelector('pre code')!.textContent).toBe('\\phi = 0');
    expect(element.querySelectorAll('a')).toHaveLength(1);
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('<script>alert(1)</script>');
    expect(element.querySelector('a')!.rel).toBe('noopener noreferrer');
  });

  it('renders inline/display math and cancels stale asynchronous updates', async () => {
    const element = document.createElement('div');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const renderMath = vi.fn(async () => svg);
    renderAssistantMessage(element, 'Let \\(x=1\\).\n\n\\[\nx^2=1\n\\]', { renderMath }); await flush();
    expect(renderMath).toHaveBeenCalledWith('x=1', false);
    expect(renderMath).toHaveBeenCalledWith('x^2=1', true);
    expect(element.querySelectorAll('svg')).toHaveLength(2);
    let finish!: (result: string) => void;
    const dispose = renderAssistantMessage(element, '\\(y\\)', { renderMath: () => new Promise(resolve => { finish = resolve; }) });
    const old = element.querySelector('.opt-codex-math')!; dispose(); renderAssistantMessage(element, 'New message'); finish(svg); await flush();
    expect(element.textContent).toBe('New message'); expect(old.querySelector('svg')).toBeNull();
  });

  it('rejects active SVG while preserving valid MathJax shapes', () => {
    expect(safeMathSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', document)).toBeUndefined();
    expect(safeMathSvg('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://bad.test"/></svg>', document)).toBeUndefined();
    expect(safeMathSvg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#glyph"/></svg>', document)).toBeDefined();
  });
});
