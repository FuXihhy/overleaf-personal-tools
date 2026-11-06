// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyIndex } from '../src/core/types';
import { mountNativeSettings, type PanelActions, type PanelModel } from '../src/settings/native-panel';

const nativeDialog = () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `<div class="ide-settings-modal-body">
    <nav class="ide-settings-tab-nav" role="tablist">
      <button id="editor-tab" role="tab" aria-selected="true" tabindex="0">Editor</button>
      <button id="project-tab" role="tab" aria-selected="false" tabindex="-1">Project</button>
      <a href="#help">Help</a>
    </nav>
    <div class="ide-settings-tab-content">
      <div id="editor-panel" role="tabpanel">Native editor settings</div>
      <div id="project-panel" role="tabpanel" hidden>Native project settings</div>
    </div>
  </div>`;
  for (const target of ['editor', 'project']) dialog.querySelector<HTMLButtonElement>('#' + target + '-tab')!.onclick = () => {
    for (const name of ['editor', 'project']) {
      const button = dialog.querySelector<HTMLButtonElement>('#' + name + '-tab')!;
      button.setAttribute('aria-selected', String(name === target));
      button.tabIndex = name === target ? 0 : -1;
      dialog.querySelector<HTMLElement>('#' + name + '-panel')!.hidden = name !== target;
    }
  };
  document.body.append(dialog);
  return dialog;
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const openPreview = () => {
  const parent=document.getElementById('opt-settings-tab')!;
  if(parent.getAttribute('aria-expanded')!=='true')parent.click();
  document.getElementById('opt-settings-preview-tab')!.click();
};
const openCodex = () => {
  const parent=document.getElementById('opt-settings-tab')!;
  if(parent.getAttribute('aria-expanded')!=='true')parent.click();
  document.getElementById('opt-settings-codex-tab')!.click();
};

describe('native settings integration', () => {
  let panel: ReturnType<typeof mountNativeSettings>;
  let model: PanelModel;
  let actions: PanelActions;
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.lang='zh';
    vi.stubGlobal('chrome', { runtime: { id: 'test', getURL: (path: string) => 'chrome-extension://test/'+path } });
    model = { settings: { ...DEFAULT_SETTINGS, extraFiles: [] }, files: [
      { id: '1', path: 'main.tex', kind: 'doc' },
      { id: '2', path: 'config/notation.sty', kind: 'doc' },
    ], index: emptyIndex(), status: 'Ready', busy: false, editorReady: true };
    actions = { save: vi.fn(async next => { model.settings=structuredClone(next); }), defaults: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
    panel = mountNativeSettings(() => model, actions);
  });
  afterEach(() => { panel.destroy(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

  it('creates no persistent buttons or sidebars outside the existing dialog', () => {
    expect(document.querySelector('button')).toBeNull();
    expect(document.querySelector('#opt-settings-panel')).toBeNull();
  });

  it('shows the three retention modes, defaults to on-demand, and persists explicit local retention',async()=>{
    document.documentElement.lang='en';model.codex={enabled:true,model:'',effort:'',instructions:'',contextMode:'project'};
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});nativeDialog();await flush();openCodex();
    const select=document.getElementById('opt-codex-context') as HTMLSelectElement;
    expect(select.options).toHaveLength(3);expect(select.value).toBe('project');
    expect(select.options[0].text).toContain('Normal context');expect(select.options[1].text).toContain('default');expect(select.options[2].text).toContain('Keep');
    select.value='persistent';select.dispatchEvent(new Event('change'));await flush();
    expect(actions.saveCodex).toHaveBeenLastCalledWith(expect.objectContaining({contextMode:'project',cacheMode:'persistent'}));
    select.value='selection';select.dispatchEvent(new Event('change'));await flush();
    expect(actions.saveCodex).toHaveBeenLastCalledWith(expect.objectContaining({contextMode:'selection',cacheMode:'normal'}));
  });

  it('shows exact local-copy information and a separate confirmation before cleanup, preserving failures for review',async()=>{
    document.documentElement.lang='en';model.codex={enabled:true,model:'',effort:'',instructions:'',contextMode:'project',cacheMode:'persistent'};
    actions.inspectProjectCache=vi.fn(async()=>'2 retained versions; 400 bytes; C:\\Synthetic\\mirror');
    actions.clearProjectCache=vi.fn(async()=>'0 versions');actions.openProjectCache=vi.fn(async()=>'Folder opened');
    nativeDialog();await flush();openCodex();
    const button=(name:string)=>document.querySelector<HTMLButtonElement>(`[data-opt-action="codex-cache-${name}"]`)!;
    expect(button('confirm').hidden).toBe(true);button('clear').click();await flush();
    expect(actions.inspectProjectCache).toHaveBeenCalledOnce();expect(actions.clearProjectCache).not.toHaveBeenCalled();
    expect(document.getElementById('opt-settings-panel')!.textContent).toContain('2 retained versions; 400 bytes');expect(document.getElementById('opt-settings-panel')!.textContent).toContain('Chat history');
    expect(button('confirm').hidden).toBe(false);
    vi.mocked(actions.clearProjectCache).mockRejectedValueOnce(new Error('Cache changed; inspect again'));
    button('confirm').click();await flush();expect(document.getElementById('opt-codex-status')!.textContent).toContain('Cache changed');
    button('inspect').click();await flush();expect(button('confirm').hidden).toBe(true);
    button('clear').click();await flush();button('confirm').click();await flush();
    expect(button('confirm').hidden).toBe(true);expect(document.getElementById('opt-settings-panel')!.textContent).toContain('0 versions');
  });

  it('remounts Extension after the entire body and head are replaced', async () => {
    nativeDialog();await flush();expect(document.getElementById('opt-settings-tab')).not.toBeNull();
    const oldHead=document.head,oldBody=document.body;
    const head=document.createElement('head'),body=document.createElement('body');
    oldHead.replaceWith(head);oldBody.replaceWith(body);nativeDialog();await flush();
    expect(document.getElementById('opt-settings-tab')).not.toBeNull();
    expect(document.head.querySelector('style')?.textContent).toContain('opt-settings-panel');
    openCodex();expect(document.getElementById('opt-codex-position')).not.toBeNull();
  });

  it('saves panel side immediately and restores the selected value on failure', async () => {
    actions.setCodexPosition=vi.fn(async position=>{model.codexPanelPosition=position;});
    nativeDialog();await flush();openCodex();
    const select=document.getElementById('opt-codex-position') as HTMLSelectElement;
    select.value='right';select.dispatchEvent(new Event('change'));await flush();
    expect(actions.setCodexPosition).toHaveBeenCalledWith('right');expect(model.codexPanelPosition).toBe('right');
    actions.setCodexPosition=vi.fn(async()=>{throw new Error('Storage unavailable');});
    select.value='left';select.dispatchEvent(new Event('change'));await flush();
    expect(select.value).toBe('right');expect(select.disabled).toBe(false);
  });

  it('saves the busy-message preference independently and follows the native select style', async () => {
    actions.setCodexBusyMessageBehavior=vi.fn(async behavior=>{model.codexBusyMessageBehavior=behavior;});
    nativeDialog();await flush();openCodex();
    const select=document.getElementById('opt-codex-busy-message-behavior') as HTMLSelectElement;
    expect(select.value).toBe('queue');expect(select.className).toBe('ide-dropdown-setting form-select form-select-sm');
    expect(select.labels?.[0].textContent).toBe('处理期间的新消息');
    expect([...select.options].map(option=>[option.value,option.textContent])).toEqual([['queue','排队'],['steer','立即引导']]);
    expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toContain('不支持引导时会加入队列');
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Keep this draft';instructions.dispatchEvent(new Event('input'));
    select.value='steer';select.dispatchEvent(new Event('change'));await flush();panel.update();
    expect(actions.setCodexBusyMessageBehavior).toHaveBeenCalledExactlyOnceWith('steer');expect(select.value).toBe('steer');
    expect(document.getElementById('opt-codex-instructions')).toBe(instructions);expect(instructions.value).toBe('Keep this draft');
    expect(model.codex).toBeUndefined();
    model.codexBusyMessageBehavior='queue';panel.update();expect(select.value).toBe('queue');
    document.documentElement.lang='en';await flush();
    const translated=document.getElementById('opt-codex-busy-message-behavior') as HTMLSelectElement;
    expect(translated.labels?.[0].textContent).toBe('Messages while working');
    expect([...translated.options].map(option=>option.textContent)).toEqual(['Queue','Steer']);
    expect((document.getElementById('opt-codex-instructions') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });

  it('preserves an in-flight busy-message choice and restores the saved value on failure', async () => {
    let reject!: (reason: Error)=>void;
    actions.setCodexBusyMessageBehavior=vi.fn(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
    nativeDialog();await flush();openCodex();
    const select=document.getElementById('opt-codex-busy-message-behavior') as HTMLSelectElement;
    select.value='steer';select.dispatchEvent(new Event('change'));panel.update();
    expect(select.disabled).toBe(true);expect(select.value).toBe('steer');
    reject(new Error('Storage unavailable'));await flush();
    expect(select.disabled).toBe(false);expect(select.value).toBe('queue');expect(model.codexBusyMessageBehavior).toBeUndefined();
    expect(document.getElementById('opt-settings-panel')!.textContent).toContain('Storage unavailable');
  });

  it('keeps formula click-copy opt-in and saves it without resetting model or instruction drafts', async () => {
    actions.setCodexClickToCopy=vi.fn(async enabled=>{model.codexClickToCopy=enabled;});
    nativeDialog();await flush();openCodex();
    const toggle=document.getElementById('opt-codex-click-to-copy') as HTMLInputElement;
    expect(toggle.checked).toBe(false);expect(toggle.className).toBe('form-check-input');expect(toggle.parentElement!.className).toBe('form-switch');
    expect(toggle.getAttribute('aria-label')).toBe('单击公式复制 LaTeX');
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Unsaved instructions';instructions.dispatchEvent(new Event('input'));
    toggle.checked=true;toggle.dispatchEvent(new Event('change'));await flush();panel.update();
    expect(actions.setCodexClickToCopy).toHaveBeenCalledExactlyOnceWith(true);expect(toggle.checked).toBe(true);
    expect(document.getElementById('opt-codex-instructions')).toBe(instructions);expect(instructions.value).toBe('Unsaved instructions');
    expect(model.codex).toBeUndefined();
    model.codexClickToCopy=false;panel.update();expect(toggle.checked).toBe(false);
  });

  it('does not reset a pending formula preference and restores its saved value after failure', async () => {
    let reject!: (reason: Error)=>void;
    model.codexClickToCopy=true;actions.setCodexClickToCopy=vi.fn(()=>new Promise<void>((_resolve, fail)=>{reject=fail;}));
    nativeDialog();await flush();openCodex();
    const toggle=document.getElementById('opt-codex-click-to-copy') as HTMLInputElement;
    toggle.checked=false;toggle.dispatchEvent(new Event('change'));panel.update();
    expect(toggle.disabled).toBe(true);expect(toggle.checked).toBe(false);
    reject(new Error('Storage unavailable'));await flush();expect(toggle.checked).toBe(true);expect(toggle.disabled).toBe(false);
    expect(document.getElementById('opt-settings-panel')!.textContent).toContain('Storage unavailable');
  });

  it('offers a separately opt-in formula copied notice without replacing unsaved instructions', async () => {
    actions.setCodexCopyToast=vi.fn(async enabled=>{model.codexCopyToast=enabled;});
    model.codexClickToCopy=true;nativeDialog();await flush();openCodex();
    const toggle=document.getElementById('opt-codex-copy-toast') as HTMLInputElement;
    expect(toggle.checked).toBe(false);expect(toggle.getAttribute('aria-label')).toBe('显示公式复制提示');
    expect(toggle.className).toBe('form-check-input');expect(toggle.parentElement!.className).toBe('form-switch');
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Keep this draft';instructions.dispatchEvent(new Event('input'));
    toggle.checked=true;toggle.dispatchEvent(new Event('change'));await flush();panel.update();
    expect(actions.setCodexCopyToast).toHaveBeenCalledExactlyOnceWith(true);expect(toggle.checked).toBe(true);
    expect(instructions.value).toBe('Keep this draft');expect(model.codexClickToCopy).toBe(true);
    actions.setCodexCopyToast=vi.fn(async()=>{throw new Error('Storage unavailable');});
    toggle.checked=false;toggle.dispatchEvent(new Event('change'));await flush();expect(toggle.checked).toBe(true);
  });

  it('can initialize against an already invalid runtime without leaving observers or UI', async () => {
    panel.destroy();
    vi.stubGlobal('chrome',{get runtime(){throw new Error('Extension context invalidated.');}});
    nativeDialog();
    expect(()=>{panel=mountNativeSettings(()=>model,actions);}).not.toThrow();
    await flush();
    expect(document.getElementById('opt-settings-tab')).toBeNull();
    document.body.append(document.createElement('div'));await flush();
    panel.update();panel.refreshForm();panel.destroy();
    expect(document.getElementById('opt-settings-panel')).toBeNull();
  });

  it('retires before opening settings when a reload removes the runtime identity', async () => {
    const getURL=vi.fn(()=>{throw new Error('Extension context invalidated.');});
    vi.stubGlobal('chrome',{runtime:{id:undefined,getURL}});
    const dialog=nativeDialog();await flush();
    expect(document.getElementById('opt-settings-tab')).toBeNull();
    expect(getURL).not.toHaveBeenCalled();
    for(let i=0;i<3;i++){dialog.append(document.createElement('p'));await flush();}
    panel.update();panel.refreshForm();
    expect(document.getElementById('opt-settings-tab')).toBeNull();
    expect(getURL).not.toHaveBeenCalled();
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
  });

  it('contains getURL failure from a queued mount and never retries it on later DOM mutations', async () => {
    const getURL=vi.fn(()=>{throw new Error('Extension context invalidated.');});
    vi.stubGlobal('chrome',{runtime:{id:'test',getURL}});
    let dialog=nativeDialog();await flush();
    expect(getURL).toHaveBeenCalledTimes(1);
    expect(document.getElementById('opt-settings-tab')).toBeNull();
    dialog.remove();await flush();dialog=nativeDialog();await flush();
    document.documentElement.lang='en';await flush();
    panel.update();panel.refreshForm();
    expect(getURL).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector('#opt-settings-panel')).toBeNull();
  });

  it('restores the native settings after context loss while Extension is selected', async () => {
    const dialog=nativeDialog();await flush();openPreview();
    expect(dialog.querySelector('.opt-settings-active')).not.toBeNull();
    vi.stubGlobal('chrome',{runtime:{id:undefined}});
    dialog.append(document.createElement('p'));await flush();
    expect(document.getElementById('opt-settings-tab')).toBeNull();
    expect(document.getElementById('opt-settings-panel')).toBeNull();
    expect(dialog.querySelector('.opt-settings-active')).toBeNull();
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('editor-tab')?.getAttribute('tabindex')).toBe('0');
    expect((document.getElementById('editor-panel') as HTMLElement).hidden).toBe(false);
    panel.destroy();panel.destroy();
  });

  it('ignores completion and stale change events from an autosave after context loss', async () => {
    let reject!: (error:Error)=>void;
    actions.save=vi.fn(()=>new Promise<void>((_resolve,no)=>{reject=no;}));
    const dialog=nativeDialog();await flush();openPreview();
    const completion=document.getElementById('opt-completion') as HTMLInputElement;
    completion.checked=false;completion.dispatchEvent(new Event('change'));await flush();
    expect(actions.save).toHaveBeenCalledTimes(1);
    vi.stubGlobal('chrome',{runtime:{id:undefined}});
    reject(new Error('Extension context invalidated.'));await flush();
    expect(document.getElementById('opt-settings-panel')).toBeNull();
    expect(dialog.querySelector('.opt-settings-active')).toBeNull();
    completion.checked=true;completion.dispatchEvent(new Event('change'));await flush();
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(document.getElementById('opt-settings-panel')).toBeNull();
  });
  it('mounts exactly one extra tab inside the native tablist after opening', async () => {
    const dialog = nativeDialog(); await flush();
    expect(document.querySelectorAll('#opt-settings-tab')).toHaveLength(1);
    expect(dialog.querySelector('.ide-settings-tab-nav #opt-settings-tab')).not.toBeNull();
    expect(document.getElementById('opt-settings-tab')?.textContent).toBe('Extension');
    expect(document.querySelector('#opt-settings-tab .material-symbols')).toBeNull();
    expect(document.querySelector<HTMLImageElement>('#opt-settings-tab img')?.src).toBe('chrome-extension://test/assets/zero-two-avatar.png');
    const avatar=document.querySelector<HTMLElement>('#opt-settings-tab .opt-tab-avatar')!;
    expect(getComputedStyle(avatar).width).toBe('20px');
    expect(getComputedStyle(avatar).overflow).toBe('hidden');
    expect(getComputedStyle(avatar.querySelector('img')!).width).toBe('36px');
    dialog.append(document.createElement('p')); await flush();
    expect(document.querySelectorAll('#opt-settings-tab')).toHaveLength(1);
  });
  it('returns control to a native tab without resetting its selected state', async () => {
    const dialog = nativeDialog(); await flush();
    openPreview();
    expect(dialog.querySelector('.opt-settings-active')).not.toBeNull();
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('false');
    (document.getElementById('project-tab') as HTMLButtonElement).click();
    expect(dialog.querySelector('.opt-settings-active')).toBeNull();
    expect(document.getElementById('project-tab')?.getAttribute('aria-selected')).toBe('true');
    expect((document.getElementById('project-panel') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('opt-settings-panel') as HTMLElement).hidden).toBe(true);
  });
  it('supports close/reopen without leaving duplicate UI or modified native tabs', async () => {
    let dialog = nativeDialog(); await flush();
    openPreview();
    dialog.remove(); await flush();
    dialog = nativeDialog(); await flush();
    expect(document.querySelectorAll('#opt-settings-tab')).toHaveLength(1);
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
    expect((document.getElementById('opt-settings-panel') as HTMLElement).hidden).toBe(true);
    openPreview();
    expect(document.querySelectorAll('#opt-extra-mode')).toHaveLength(1);
  });

  it('opens preview settings without writing and keeps reload available beside collapsed support details', async () => {
    document.documentElement.lang='en';nativeDialog();await flush();openPreview();await flush();
    expect(actions.save).not.toHaveBeenCalled();
    expect(document.querySelector('[data-opt-action="save"]')).toBeNull();
    const defaults=document.querySelector<HTMLButtonElement>('[data-opt-action="defaults"]')!;
    expect(defaults.textContent).toBe('Set as defaults');
    expect(document.getElementById(defaults.getAttribute('aria-describedby')!)?.textContent).toContain('projects without their own settings');
    const details=document.getElementById('opt-support-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const reload=details.parentElement!.querySelector<HTMLButtonElement>('[data-opt-action="refresh"]')!;
    expect(details.contains(reload)).toBe(false);
    expect(reload.textContent).toBe('Reload commands and packages');
    expect(document.getElementById(reload.getAttribute('aria-describedby')!)?.textContent).toBeTruthy();
    panel.update();panel.update();
    expect(details.parentElement!.querySelector('[data-opt-action="refresh"]')).toBe(reload);
    reload.click();await flush();expect(actions.refresh).toHaveBeenCalledOnce();expect(details.open).toBe(false);
    expect(document.querySelectorAll('[data-opt-action="refresh"]')).toHaveLength(1);
  });

  it.each([
    ['en','Reconnect editor','Reconnecting editor…','Editor reconnected. Click a formula to preview it.'],
    ['zh','重新连接编辑器','正在重新连接编辑器…','编辑器已重新连接，点击公式即可预览。'],
  ])('reconnects independently of indexing, preserves focus and waits for acknowledgement in %s', async (language,label,pending,success) => {
    let finish!:()=>void;
    actions.reconnectEditor=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    model.busy=true;document.documentElement.lang=language;
    nativeDialog();await flush();openPreview();
    const details=document.getElementById('opt-support-details') as HTMLDetailsElement;
    const button=document.querySelector<HTMLButtonElement>('[data-opt-action="reconnect-editor"]')!;
    const note=document.getElementById('opt-editor-connection-status')!;
    expect(button.textContent).toBe(label);expect(button.classList.contains('btn-primary')).toBe(true);
    expect(details.contains(button)).toBe(false);expect(details.open).toBe(false);expect(button.disabled).toBe(false);
    expect(note.getAttribute('role')).toBe('status');expect(note.getAttribute('aria-live')).toBe('polite');expect(note.textContent).toBe('');
    button.focus();button.click();button.click();await flush();
    expect(actions.reconnectEditor).toHaveBeenCalledOnce();expect(actions.refresh).not.toHaveBeenCalled();expect(actions.save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');expect(button.getAttribute('aria-busy')).toBe('true');
    expect(note.textContent).toBe(pending);expect(note.textContent).not.toBe(success);
    model.status='An unrelated index update';panel.update();expect(note.textContent).toBe(pending);
    finish();await flush();
    expect(note.textContent).toBe(success);expect(button.getAttribute('aria-disabled')).toBe('false');expect(button.getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(button);expect(details.open).toBe(false);
    panel.update();expect(note.textContent).toBe(success);
  });

  it.each([
    ['en','editor-reconnect-timeout','Could not reconnect. Refresh this page and try again.'],
    ['zh','editor-reconnect-timeout','未能重新连接，请刷新页面后重试。'],
    ['en','editor-unavailable','Open a project file, then try again.'],
    ['zh','editor-unavailable','请先打开一个项目文件，再重试。'],
  ])('shows a localized reconnect failure in %s for %s and allows retry', async (language,reason,message) => {
    actions.reconnectEditor=vi.fn().mockRejectedValueOnce(new Error(reason)).mockResolvedValue(undefined);
    document.documentElement.lang=language;nativeDialog();await flush();openPreview();
    const button=document.querySelector<HTMLButtonElement>('[data-opt-action="reconnect-editor"]')!;
    const note=document.getElementById('opt-editor-connection-status')!;
    button.click();await flush();
    expect(note.textContent).toBe(message);expect(note.textContent).not.toContain(reason);
    expect(button.getAttribute('aria-disabled')).toBe('false');expect(button.getAttribute('aria-busy')).toBe('false');
    model.status='Compilation finished';panel.update();expect(note.textContent).toBe(message);
    button.click();await flush();expect(actions.reconnectEditor).toHaveBeenCalledTimes(2);
    expect(note.textContent).toBe(language==='en'?'Editor reconnected. Click a formula to preview it.':'编辑器已重新连接，点击公式即可预览。');
    document.documentElement.lang=language==='en'?'zh':'en';await flush();
    expect(document.getElementById('opt-editor-connection-status')!.textContent).toBe(language==='en'?'编辑器已重新连接，点击公式即可预览。':'Editor reconnected. Click a formula to preview it.');
  });

  it('serializes preview changes with immutable snapshots and retains the latest choices', async () => {
    let finish!:()=>void;
    actions.save=vi.fn(async next=>{
      if(vi.mocked(actions.save).mock.calls.length===1)await new Promise<void>(resolve=>{finish=resolve;});
      model.settings=structuredClone(next);
    });
    nativeDialog();await flush();openPreview();
    const completion=document.getElementById('opt-completion') as HTMLInputElement;
    completion.checked=false;completion.dispatchEvent(new Event('change'));await flush();
    const preview=document.getElementById('opt-preview') as HTMLInputElement;
    preview.checked=false;preview.dispatchEvent(new Event('change'));
    completion.checked=true;completion.dispatchEvent(new Event('change'));await flush();
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(actions.save).mock.calls[0][0]).toMatchObject({completion:false,preview:true});
    finish();await flush();
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(model.settings).toMatchObject({completion:true,preview:false});
    expect(document.getElementById('opt-completion')).toBe(completion);
    expect(document.getElementById('opt-preview')).toBe(preview);
  });

  it('debounces the filename while preserving focus and flushes it on blur', async () => {
    nativeDialog();await flush();openPreview();
    const filename=document.getElementById('opt-auto-name') as HTMLInputElement;
    filename.focus();
    vi.useFakeTimers();
    try {
      filename.value='defs';filename.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(200);
      filename.value='defs.sty';filename.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(349);
      expect(actions.save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(actions.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({autoFileName:'defs.sty'}));
      expect(document.activeElement).toBe(filename);
      filename.value='macros.tex';filename.dispatchEvent(new Event('input'));filename.blur();
      await vi.advanceTimersByTimeAsync(0);
      expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({autoFileName:'macros.tex'}));
    } finally {vi.useRealTimers();}
  });

  it.each(['native tab','Codex tab','close dialog'] as const)('flushes a pending filename before leaving via %s', async destination=>{
    const dialog=nativeDialog();await flush();openPreview();
    const filename=document.getElementById('opt-auto-name') as HTMLInputElement;
    filename.value='definitions.sty';filename.dispatchEvent(new Event('input'));
    expect(actions.save).not.toHaveBeenCalled();
    if(destination==='native tab')document.getElementById('editor-tab')!.click();
    else if(destination==='Codex tab')openCodex();
    else dialog.remove();
    await flush();
    expect(actions.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({autoFileName:'definitions.sty'}));
  });

  it('preserves the latest filename when the dialog reopens before its save completes', async () => {
    let finish!:()=>void;
    actions.save=vi.fn(async next=>{await new Promise<void>(resolve=>{finish=resolve;});model.settings=structuredClone(next);});
    const dialog=nativeDialog();await flush();openPreview();
    const filename=document.getElementById('opt-auto-name') as HTMLInputElement;
    filename.value='pending.sty';filename.dispatchEvent(new Event('input'));
    dialog.remove();await flush();expect(actions.save).toHaveBeenCalledTimes(1);
    nativeDialog();await flush();openPreview();
    expect((document.getElementById('opt-auto-name') as HTMLInputElement).value).toBe('pending.sty');
    finish();await flush();
    expect(model.settings.autoFileName).toBe('pending.sty');
  });

  it.each(['defaults','refresh'] as const)('flushes a pending filename before %s', async action=>{
    const order:string[]=[];
    actions.save=vi.fn(async next=>{model.settings=structuredClone(next);order.push('save');});
    actions[action]=vi.fn(async()=>{order.push(action);expect(model.settings.autoFileName).toBe('shared.sty');});
    nativeDialog();await flush();openPreview();
    const filename=document.getElementById('opt-auto-name') as HTMLInputElement;
    filename.value='shared.sty';filename.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>(`[data-opt-action="${action}"]`)!.click();await flush();
    expect(order).toEqual(['save',action]);
    if(action==='defaults')expect(actions.defaults).toHaveBeenCalledWith(expect.objectContaining({autoFileName:'shared.sty'}));
  });

  it('keeps failed changes visible, blocks defaults and retries the latest draft on the next edit', async () => {
    document.documentElement.lang='en';actions.save=vi.fn(async()=>{throw new Error('Storage unavailable');});
    const dialog=nativeDialog();await flush();openPreview();
    const completion=document.getElementById('opt-completion') as HTMLInputElement;
    completion.checked=false;completion.dispatchEvent(new Event('change'));await flush();panel.update();
    expect(completion.checked).toBe(false);expect(model.settings.completion).toBe(true);
    expect(document.getElementById('opt-settings-panel')?.textContent).toContain('Could not save changes: Storage unavailable');
    dialog.remove();await flush();nativeDialog();await flush();openPreview();await flush();
    expect((document.getElementById('opt-completion') as HTMLInputElement).checked).toBe(false);
    expect(document.getElementById('opt-settings-panel')?.textContent).toContain('Could not save changes: Storage unavailable');
    document.querySelector<HTMLButtonElement>('[data-opt-action="defaults"]')!.click();await flush();
    expect(actions.defaults).not.toHaveBeenCalled();
    actions.save=vi.fn(async next=>{model.settings=structuredClone(next);});
    const preview=document.getElementById('opt-preview') as HTMLInputElement;
    preview.checked=false;preview.dispatchEvent(new Event('change'));await flush();
    expect(model.settings).toMatchObject({completion:false,preview:false});
    expect(document.getElementById('opt-settings-panel')?.textContent).not.toContain('Storage unavailable');
  });

  it('shows retry only after a failed autosave and hides it after recovery', async () => {
    actions.save=vi.fn(async()=>{throw new Error('Storage unavailable');});
    nativeDialog();await flush();openPreview();
    const retry=()=>document.querySelector<HTMLButtonElement>('[data-opt-action="retry-save"]')!;
    expect(retry().hidden).toBe(true);
    const preview=document.getElementById('opt-preview') as HTMLInputElement;
    preview.checked=false;preview.dispatchEvent(new Event('change'));await flush();
    expect(retry().hidden).toBe(false);
    actions.save=vi.fn(async next=>{model.settings=structuredClone(next);});
    retry().click();await flush();
    expect(actions.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({preview:false}));
    expect(retry().hidden).toBe(true);expect(model.settings.preview).toBe(false);
  });

  it('saves configurable discovery mode and a user-selected project file', async () => {
    nativeDialog(); await flush();
    openPreview();
    const mode = document.getElementById('opt-extra-mode') as HTMLSelectElement;
    expect(mode.value).toBe('auto');
    expect((document.getElementById('opt-auto-name') as HTMLInputElement).value).toBe('macros.sty');
    mode.value = 'manual'; mode.dispatchEvent(new Event('change'));
    const picker = document.getElementById('opt-file-picker-menu') as HTMLDetailsElement;
    expect(picker.open).toBe(false);
    picker.open = true;
    const search = document.getElementById('opt-file-search') as HTMLInputElement;
    search.value = 'notation'; search.dispatchEvent(new Event('input'));
    expect(document.querySelector('#opt-file-options input[value="main.tex"]')).toBeNull();
    const checkbox = document.querySelector<HTMLInputElement>('input[value="config/notation.sty"]')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    expect(document.getElementById('opt-selected-files')?.textContent).toContain('config/notation.sty');
    await flush();
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ extraFilesMode: 'manual', extraFiles: ['config/notation.sty'] }));
    document.querySelector<HTMLButtonElement>('[aria-label="移除 config/notation.sty"]')!.click();
    await flush();
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({ extraFiles: [] }));
  });

  it('uses native switch and select structure without repeating the known main file setting', async () => {
    model.rootPath = 'main.tex';model.rootCandidates=['main.tex','other.tex'];
    nativeDialog(); await flush();
    openPreview();
    expect(document.querySelector('.ide-setting-input > .form-switch > #opt-completion')).not.toBeNull();
    expect(document.querySelector('label.ide-setting-title[for="opt-completion"]')).not.toBeNull();
    expect(document.querySelector('#opt-preview-engine.ide-dropdown-setting.form-select.form-select-sm')).not.toBeNull();
    expect(document.getElementById('opt-root')).toBeNull();
    expect(document.getElementById('opt-root-advanced')).toBeNull();
    expect(document.getElementById('opt-root-status')?.textContent).toBe('主文件：main.tex');
  });

  it('asks for a main file only when native detection is ambiguous and keeps an override cancellable', async () => {
    model.rootCandidates=['main.tex','other.tex'];
    nativeDialog(); await flush();
    openPreview();
    const root=document.getElementById('opt-root') as HTMLSelectElement;
    expect([...root.options].map(option=>option.value)).toEqual(['','main.tex','other.tex']);
    root.value='other.tex';root.dispatchEvent(new Event('change'));
    await flush();
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({rootFile:'other.tex'}));
    model.settings.rootFile='other.tex';model.rootPath='other.tex';panel.refreshForm();
    expect(document.getElementById('opt-root')).toBeNull();
    expect((document.getElementById('opt-root-advanced') as HTMLDetailsElement).open).toBe(false);
    document.getElementById('opt-root-reset')!.click();
    await flush();
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({rootFile:undefined}));
  });
  it('restores native aria state and removes its own nodes on teardown', async () => {
    const dialog = nativeDialog(); await flush();
    openPreview();
    panel.destroy();
    expect(document.getElementById('opt-settings-tab')).toBeNull();
    expect(document.getElementById('opt-settings-panel')).toBeNull();
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('editor-tab')?.getAttribute('tabindex')).toBe('0');
    expect(dialog.querySelector('.opt-settings-active')).toBeNull();
  });

  it('keeps refresh disabled while busy or pending and retains an action failure message', async () => {
    let reject!: (error: Error) => void;
    actions.refresh=vi.fn(()=>new Promise<void>((_resolve,rejectPromise)=>{reject=rejectPromise;}));
    model.busy=true;
    nativeDialog();await flush();
    openPreview();
    const refresh=document.querySelector<HTMLButtonElement>('[data-opt-action="refresh"]')!;
    expect(refresh.disabled).toBe(true);
    model.busy=false;panel.update();refresh.click();panel.update();refresh.click();await flush();
    expect(refresh.disabled).toBe(true);
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    reject(new Error('读取失败，请重试'));await flush();
    expect(refresh.disabled).toBe(false);
    expect(document.querySelector('#opt-settings-panel > .ide-settings-section > .opt-status')?.textContent).toBe('读取失败，请重试');
  });

  it('uses a two-level engine/backend choice and keeps TeX controls hidden for MathJax', async () => {
    nativeDialog(); await flush();
    openPreview();
    const engine = document.getElementById('opt-preview-engine') as HTMLSelectElement;
    expect([...engine.options].map(option => option.value)).toEqual(['mathjax', 'tex']);
    expect(engine.value).toBe('mathjax');
    expect((document.getElementById('opt-tex-settings') as HTMLElement).hidden).toBe(true);
    expect(getComputedStyle(document.getElementById('opt-tex-settings')!).display).toBe('none');
    expect((document.getElementById('opt-mathjax-note') as HTMLElement).hidden).toBe(false);
    engine.value = 'tex'; engine.dispatchEvent(new Event('change'));
    expect((document.getElementById('opt-tex-settings') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('opt-mathjax-note') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('opt-cloud-settings') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('opt-local-settings') as HTMLElement).hidden).toBe(true);
    expect(getComputedStyle(document.getElementById('opt-local-settings')!).display).toBe('none');
  });

  it('saves the local backend and chosen compiler without invoking either backend on selection', async () => {
    actions.checkLocal = vi.fn(async () => {});
    actions.createCloudProject = vi.fn(async () => {});
    nativeDialog(); await flush();
    openPreview();
    const engine = document.getElementById('opt-preview-engine') as HTMLSelectElement;
    engine.value = 'tex'; engine.dispatchEvent(new Event('change'));
    const backend = document.getElementById('opt-tex-backend') as HTMLSelectElement;
    backend.value = 'local'; backend.dispatchEvent(new Event('change'));
    const compiler = document.getElementById('opt-tex-compiler') as HTMLSelectElement;
    expect([...compiler.options].map(option => option.value)).toEqual(['pdflatex', 'xelatex', 'lualatex']);
    compiler.value = 'xelatex'; compiler.dispatchEvent(new Event('change'));
    expect((document.getElementById('opt-local-settings') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('opt-cloud-settings') as HTMLElement).hidden).toBe(true);
    expect(getComputedStyle(document.getElementById('opt-cloud-settings')!).display).toBe('none');
    expect(actions.checkLocal).not.toHaveBeenCalled();
    expect(actions.createCloudProject).not.toHaveBeenCalled();
    await flush();
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex' }));
  });

  it('checks the local connection on demand and updates its status without losing form edits', async () => {
    actions.checkLocal = vi.fn(async () => { model.localStatus = '已连接：pdfLaTeX、XeLaTeX 可用'; });
    model.settings.previewEngine = 'tex'; model.settings.texBackend = 'local';
    nativeDialog(); await flush();
    openPreview();
    const compiler = document.getElementById('opt-tex-compiler') as HTMLSelectElement;
    compiler.value = 'lualatex'; compiler.dispatchEvent(new Event('change'));
    expect(document.getElementById('opt-local-status')?.textContent).toContain('尚未检查');
    (document.getElementById('opt-check-local') as HTMLButtonElement).click(); await flush();
    expect(actions.checkLocal).toHaveBeenCalledTimes(1);
    expect(document.getElementById('opt-local-status')?.textContent).toBe(model.localStatus);
    expect((document.getElementById('opt-tex-compiler') as HTMLSelectElement).value).toBe('lualatex');
  });

  it('preserves saved preview choices and adopts the new cloud identity for subsequent edits', async () => {
    actions.createCloudProject = vi.fn(async () => {
      model.settings.cloudProjectId = 'abcdef0123456789abcdef01';
      model.settings.cloudProjectName = 'Formula preview clone';
      model.settings.cloudCompiler = 'xelatex';
    });
    nativeDialog(); await flush();
    openPreview();
    const engine = document.getElementById('opt-preview-engine') as HTMLSelectElement;
    engine.value = 'tex'; engine.dispatchEvent(new Event('change'));
    const mode = document.getElementById('opt-extra-mode') as HTMLSelectElement;
    mode.value = 'none'; mode.dispatchEvent(new Event('change'));
    (document.getElementById('opt-create-cloud') as HTMLButtonElement).click(); await flush();
    expect((document.getElementById('opt-preview-engine') as HTMLSelectElement).value).toBe('tex');
    expect((document.getElementById('opt-extra-mode') as HTMLSelectElement).value).toBe('none');
    const link = document.querySelector<HTMLAnchorElement>('#opt-cloud-settings a')!;
    expect(link.href).toBe('https://www.overleaf.com/project/abcdef0123456789abcdef01');
    expect(link.rel).toBe('noopener');
    const completion=document.getElementById('opt-completion') as HTMLInputElement;
    completion.checked=false;completion.dispatchEvent(new Event('change'));await flush();
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ previewEngine: 'tex', texBackend: 'overleaf', extraFilesMode: 'none', cloudProjectId: model.settings.cloudProjectId, cloudCompiler: 'xelatex' }));
  });

  it('explains each engine boundary and the retained cloud scratch files inside the native panel', async () => {
    nativeDialog(); await flush();
    openPreview();
    expect(document.getElementById('opt-mathjax-note')?.textContent).toContain('已适配');
    expect(document.getElementById('opt-mathjax-note')?.parentElement?.classList.contains('ide-setting-description')).toBe(true);
    expect(document.getElementById('opt-tex-settings')?.textContent).toContain('引用与编号');
    expect(document.getElementById('opt-local-settings')?.textContent).toContain('不启动本机网络服务');
    expect(document.getElementById('opt-cloud-settings')?.textContent).toContain('临时 .tex 文件');
    expect(document.getElementById('opt-cloud-settings')?.textContent).toContain('不写入原项目');
    for(const help of document.querySelectorAll<HTMLDetailsElement>('#opt-tex-settings .opt-usage')) {
      expect(help.open).toBe(false);
      expect(help.querySelector('summary')?.textContent).toBe('使用说明');
    }
    expect(document.querySelector('#opt-cloud-settings .opt-usage')?.textContent).toContain('TeX Live');
    expect((document.getElementById('opt-check-local') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('opt-create-cloud') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a retained clone after metadata failure without discarding the unsaved engine choice', async () => {
    actions.createCloudProject = vi.fn(async () => {
      model.settings.cloudProjectId = 'abcdef0123456789abcdef01';
      model.settings.cloudProjectName = 'Retained preview';
      throw new Error('副本已保留，暂时无法读取目录');
    });
    nativeDialog(); await flush();
    openPreview();
    const engine = document.getElementById('opt-preview-engine') as HTMLSelectElement;
    engine.value = 'tex'; engine.dispatchEvent(new Event('change'));
    (document.getElementById('opt-create-cloud') as HTMLButtonElement).click(); await flush();
    expect((document.getElementById('opt-preview-engine') as HTMLSelectElement).value).toBe('tex');
    expect(document.querySelector<HTMLAnchorElement>('#opt-cloud-settings a')?.href).toContain('abcdef0123456789abcdef01');
    expect(document.getElementById('opt-create-cloud')?.textContent).toBe('检查共享项目连接');
    expect(document.querySelector('#opt-settings-panel > .ide-settings-section > .opt-status')?.textContent).toContain('副本已保留');
  });

  it('renders English controls, accessible labels and support details for an English site', async () => {
    document.documentElement.lang='en';
    model.settings.extraFilesMode='manual';model.settings.extraFiles=['config/notation.sty'];
    model.settings.previewEngine='tex';model.rootPath='main.tex';model.editorReady=false;
    nativeDialog();await flush();openPreview();
    const content=document.getElementById('opt-settings-panel')!;
    expect(content.textContent).not.toMatch(/[\p{Script=Han}]/u);
    expect(content.querySelector('label[for="opt-completion"]')?.textContent).toBe('Project command completion');
    expect(content.querySelector('[data-opt-action="save"]')).toBeNull();
    expect(content.querySelector('[data-opt-action="defaults"]')?.textContent).toBe('Set as defaults');
    expect(content.querySelector('.opt-support > .opt-actions [data-opt-action="refresh"]')?.textContent).toBe('Reload commands and packages');
    expect((document.getElementById('opt-file-search') as HTMLInputElement).placeholder).toBe('Search file names or paths');
    expect(document.querySelector('[aria-label="Remove config/notation.sty"]')).not.toBeNull();
    expect(document.getElementById('opt-root-status')?.textContent).toBe('Main file: main.tex');
    expect(content.textContent).toContain('0 completions · 0 packages · 0 files');
    expect(content.textContent).toContain('Waiting for the editor connection…');
    expect(document.getElementById('opt-settings-tab')?.textContent).toBe('Extension');
  });

  it('preserves settings, search, expanded details, focus and scroll when the site language changes', async () => {
    const dialog=nativeDialog();await flush();openPreview();
    const engine=document.getElementById('opt-preview-engine') as HTMLSelectElement;
    engine.value='tex';engine.dispatchEvent(new Event('change'));
    const mode=document.getElementById('opt-extra-mode') as HTMLSelectElement;
    mode.value='manual';mode.dispatchEvent(new Event('change'));
    (document.getElementById('opt-file-picker-menu') as HTMLDetailsElement).open=true;
    (document.getElementById('opt-cloud-help') as HTMLDetailsElement).open=true;
    (document.getElementById('opt-support-details') as HTMLDetailsElement).open=true;
    const search=document.getElementById('opt-file-search') as HTMLInputElement;
    search.value='notation';search.dispatchEvent(new Event('input'));
    const selected=document.querySelector<HTMLInputElement>('#opt-file-options input')!;
    selected.checked=true;selected.dispatchEvent(new Event('change'));
    search.focus();search.setSelectionRange(1,4);
    const scrollContainer=dialog.querySelector<HTMLElement>('.ide-settings-tab-content')!;
    scrollContainer.scrollTop=120;document.getElementById('opt-file-options')!.scrollTop=36;
    document.documentElement.lang='en';await flush();
    expect((document.getElementById('opt-preview-engine') as HTMLSelectElement).value).toBe('tex');
    expect((document.getElementById('opt-extra-mode') as HTMLSelectElement).value).toBe('manual');
    for(const id of ['opt-file-picker-menu','opt-cloud-help','opt-support-details'])expect((document.getElementById(id) as HTMLDetailsElement).open).toBe(true);
    const restoredSearch=document.getElementById('opt-file-search') as HTMLInputElement;
    expect(restoredSearch.value).toBe('notation');expect(document.activeElement).toBe(restoredSearch);
    expect([restoredSearch.selectionStart,restoredSearch.selectionEnd]).toEqual([1,4]);
    expect(scrollContainer.scrollTop).toBe(120);expect(document.getElementById('opt-file-options')!.scrollTop).toBe(36);
    expect(document.querySelector('#opt-file-options input[value="main.tex"]')).toBeNull();
    expect(document.querySelector('[aria-label="Remove config/notation.sty"]')).not.toBeNull();
    expect(model.settings.previewEngine).toBe('tex');
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({previewEngine:'tex',extraFilesMode:'manual',extraFiles:['config/notation.sty']}));
  });

  it('lists detected preview sources in natural order and changes only their preview selection and priority', async () => {
    model.index.previewSources=[
      {id:'package:physics',kind:'package',name:'physics',packageName:'physics'},
      {id:'file:config/notation.sty',kind:'file',name:'config/notation.sty',path:'config/notation.sty',packageName:'config/notation'},
    ];
    nativeDialog();await flush();openPreview();
    const details=document.getElementById('opt-preview-sources') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.previousElementSibling?.querySelector('#opt-preview-engine')).not.toBeNull();
    details.open=true;
    const rows=()=>[...details.querySelectorAll<HTMLElement>('[data-preview-source]')];
    expect(rows().map(row=>row.dataset.previewSource)).toEqual(['package:physics','file:config/notation.sty']);
    expect(rows().every(row=>row.querySelector<HTMLInputElement>('input')!.checked)).toBe(true);
    expect(rows()[0].querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    expect(rows()[1].querySelectorAll<HTMLButtonElement>('button')[1].disabled).toBe(true);
    expect(actions.save).not.toHaveBeenCalled();
    const checkbox=rows()[0].querySelector<HTMLInputElement>('input')!;
    checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));
    const up=rows()[1].querySelector<HTMLButtonElement>('button')!;
    expect(up.getAttribute('aria-label')).toContain('降低优先级');up.focus();up.click();
    expect(rows().map(row=>row.dataset.previewSource)).toEqual(['file:config/notation.sty','package:physics']);
    expect(document.activeElement).toBe(rows()[0].querySelector('input'));
    await flush();
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({
      completion:true,extraFiles:[],previewSources:[
        {id:'file:config/notation.sty',enabled:true},{id:'package:physics',enabled:false},
      ],
    }));
    expect(model.settings.previewSources).toEqual([{id:'file:config/notation.sty',enabled:true},{id:'package:physics',enabled:false}]);
    expect(document.getElementById('opt-preview-sources-description')?.textContent).toContain('不影响命令补全');
  });

  it('preserves preview source drafts through language and catalog updates while enabling new sources in natural order', async () => {
    model.index.previewSources=[
      {id:'package:physics',kind:'package',name:'physics'},
      {id:'file:macros.sty',kind:'file',name:'macros.sty',path:'macros.sty'},
    ];
    model.settings.previewSources=[{id:'package:physics',enabled:true},{id:'file:macros.sty',enabled:true}];
    nativeDialog();await flush();openPreview();
    (document.getElementById('opt-preview-sources') as HTMLDetailsElement).open=true;
    const rows=()=>[...document.querySelectorAll<HTMLElement>('#opt-preview-source-list [data-preview-source]')];
    const checkbox=rows()[0].querySelector<HTMLInputElement>('input')!;
    checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));
    rows()[1].querySelector<HTMLButtonElement>('button')!.click();
    model.index.previewSources=[model.index.previewSources[0],
      {id:'package:amsmath',kind:'package',name:'amsmath'},model.index.previewSources[1],
      {id:'file:defs/extra.tex',kind:'file',name:'defs/extra.tex',path:'defs/extra.tex'},
    ];
    panel.update();
    expect(rows().map(row=>row.dataset.previewSource)).toEqual(['file:macros.sty','package:physics','package:amsmath','file:defs/extra.tex']);
    expect(rows().map(row=>row.querySelector<HTMLInputElement>('input')!.checked)).toEqual([true,false,true,true]);
    const focused=rows()[1].querySelector<HTMLInputElement>('input')!;focused.focus();
    document.getElementById('opt-preview-source-list')!.scrollTop=24;
    document.documentElement.lang='en';await flush();
    expect((document.getElementById('opt-preview-sources') as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById('opt-preview-source-list')!.scrollTop).toBe(24);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Use physics in formula previews');
    expect(rows()[0].querySelector('button')?.getAttribute('aria-label')).toBe('Move macros.sty up · lower priority');
    expect(document.getElementById('opt-preview-sources')?.textContent).not.toMatch(/[\p{Script=Han}]/u);
    document.querySelector<HTMLButtonElement>('[data-opt-action="defaults"]')!.click();await flush();
    expect(actions.defaults).toHaveBeenCalledWith(expect.objectContaining({previewSources:[
      {id:'file:macros.sty',enabled:true},{id:'package:physics',enabled:false},
    ]}));
    expect(model.settings.previewSources).toEqual([{id:'file:macros.sty',enabled:true},{id:'package:physics',enabled:false}]);
  });

  it('automatically saves reset preview sources without changing file discovery',async()=>{
    model.index.previewSources=[{id:'package:physics',kind:'package',name:'physics'}];
    model.settings.previewSources=[{id:'file:removed.sty',enabled:false},{id:'package:physics',enabled:false}];
    model.settings.extraFilesMode='manual';model.settings.extraFiles=['config/notation.sty'];
    nativeDialog();await flush();openPreview();
    const reset=document.getElementById('opt-reset-preview-sources') as HTMLButtonElement;
    expect(reset.textContent).toBe('恢复默认来源');reset.click();
    expect(document.querySelector<HTMLInputElement>('#opt-preview-source-list input')!.checked).toBe(true);
    document.documentElement.lang='en';await flush();
    expect(document.getElementById('opt-reset-preview-sources')?.textContent).toBe('Reset preview sources');
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({previewSources:undefined,extraFilesMode:'manual',extraFiles:['config/notation.sty']}));
  });

  it('expands two child rows without changing the active native settings page',async()=>{
    nativeDialog();await flush();
    const parent=document.getElementById('opt-settings-tab')!;
    const children=document.getElementById('opt-settings-children')!;
    expect(parent.getAttribute('role')).not.toBe('tab');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    expect(children.hidden).toBe(true);
    parent.click();
    expect(parent.getAttribute('aria-expanded')).toBe('true');expect(children.hidden).toBe(false);
    expect([...children.querySelectorAll('[role=tab]')].map(node=>node.textContent)).toEqual(['LaTeX 预览','Codex Assistant']);
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('opt-settings-panel')!.hidden).toBe(true);
    expect(document.getElementById('opt-preview-engine')).toBeNull();
    openCodex();
    expect(document.getElementById('opt-settings-codex-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('opt-settings-panel')?.getAttribute('aria-labelledby')).toBe('opt-settings-codex-tab');
    parent.click();
    expect(children.hidden).toBe(true);expect(document.getElementById('opt-settings-panel')!.hidden).toBe(true);
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
  });

  it('automatically saves project Codex preferences independently from Preview settings',async()=>{
    model.codex={enabled:true,model:'',effort:'',contextMode:'project',instructions:''};
    model.codexModels=[{id:'model-one',displayName:'First model'}];
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    nativeDialog();await flush();openCodex();
    expect(document.getElementById('opt-preview-engine')).toBeNull();
    expect(document.querySelector('[data-opt-action=codex-save]')).toBeNull();
    const enabled=document.getElementById('opt-codex-enabled') as HTMLInputElement;
    const modelSelect=document.getElementById('opt-codex-model') as HTMLSelectElement;
    const effort=document.getElementById('opt-codex-effort') as HTMLSelectElement;
    const scope=document.getElementById('opt-codex-context') as HTMLSelectElement;
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    expect(modelSelect.options[0].textContent).toBe('跟随 Codex');
    enabled.checked=false;enabled.dispatchEvent(new Event('change'));
    modelSelect.value='model-one';modelSelect.dispatchEvent(new Event('change'));
    effort.value='high';effort.dispatchEvent(new Event('change'));
    scope.value='selection';scope.dispatchEvent(new Event('change'));
    instructions.value='保留符号约定';instructions.dispatchEvent(new Event('input'));
    instructions.dispatchEvent(new Event('blur'));await flush();
    expect(actions.saveCodex).toHaveBeenLastCalledWith({enabled:false,model:'model-one',effort:'high',contextMode:'selection',cacheMode:'normal',instructions:'保留符号约定'});
    expect(actions.save).not.toHaveBeenCalled();expect(actions.defaults).not.toHaveBeenCalled();
    expect(model.codex.enabled).toBe(false);
    expect(document.getElementById('opt-settings-panel')?.textContent).not.toMatch(/API key|localhost|端口/);
  });

  it('flushes Codex instructions when switching tabs while preserving the Preview draft',async()=>{
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    nativeDialog();await flush();openPreview();
    const engine=document.getElementById('opt-preview-engine') as HTMLSelectElement;
    engine.value='tex';engine.dispatchEvent(new Event('change'));
    openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Use the definitions from section 1.';instructions.dispatchEvent(new Event('input'));
    openPreview();
    expect((document.getElementById('opt-preview-engine') as HTMLSelectElement).value).toBe('tex');
    await flush();
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({previewEngine:'tex'}));
    expect(actions.saveCodex).toHaveBeenCalledWith(expect.objectContaining({instructions:'Use the definitions from section 1.'}));
    openCodex();
    expect((document.getElementById('opt-codex-instructions') as HTMLTextAreaElement).value).toBe('Use the definitions from section 1.');
    expect(model.settings.previewEngine).toBe('tex');
  });

  it('serializes rapid changes and persists the latest model and effort after an earlier write',async()=>{
    model.codex={enabled:true,model:'',effort:'',contextMode:'project',instructions:''};
    model.codexModels=[{id:'one',displayName:'One'},{id:'two',displayName:'Two'}];
    let finish!:()=>void;
    actions.saveCodex=vi.fn(async next=>{
      if(next.model==='one')await new Promise<void>(resolve=>{finish=resolve;});
      model.codex={...next};
    });
    nativeDialog();await flush();openCodex();
    const selected=document.getElementById('opt-codex-model') as HTMLSelectElement;
    const effort=document.getElementById('opt-codex-effort') as HTMLSelectElement;
    selected.value='one';selected.dispatchEvent(new Event('change'));await flush();
    expect(actions.saveCodex).toHaveBeenCalledTimes(1);
    selected.value='two';selected.dispatchEvent(new Event('change'));
    effort.value='high';effort.dispatchEvent(new Event('change'));panel.update();await flush();
    expect(actions.saveCodex).toHaveBeenCalledTimes(1);
    expect(selected.value).toBe('two');expect(effort.value).toBe('high');
    finish();await flush();
    expect(actions.saveCodex).toHaveBeenLastCalledWith(expect.objectContaining({model:'two',effort:'high'}));
    expect(model.codex).toMatchObject({model:'two',effort:'high'});
  });

  it('retains the latest draft and a visible save error until another change succeeds',async()=>{
    model.codex={enabled:true,model:'',effort:'',contextMode:'project',instructions:''};
    actions.saveCodex=vi.fn(async()=>{throw new Error('Storage unavailable');});
    nativeDialog();await flush();openCodex();
    const scope=document.getElementById('opt-codex-context') as HTMLSelectElement;
    scope.value='selection';scope.dispatchEvent(new Event('change'));await flush();panel.update();
    expect(scope.value).toBe('selection');expect(model.codex.contextMode).toBe('project');
    expect(document.getElementById('opt-codex-status')!.textContent).toContain('Storage unavailable');
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    const effort=document.getElementById('opt-codex-effort') as HTMLSelectElement;
    effort.value='high';effort.dispatchEvent(new Event('change'));await flush();panel.update();
    expect(model.codex).toMatchObject({contextMode:'selection',effort:'high'});
    expect(document.getElementById('opt-codex-status')!.textContent).not.toContain('Storage unavailable');
  });

  it('shows accessible API reading limits after Context and explains the extra cost before editing',async()=>{
    document.documentElement.lang='en';
    model.codex={enabled:true,providerId:'11111111-2222-3333-4444-555555555555',model:'',effort:'',contextMode:'project',instructions:''};
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    nativeDialog();await flush();openCodex();
    const budget=document.getElementById('opt-codex-api-budget')!;
    expect(budget.hidden).toBe(false);expect(budget.getAttribute('role')).toBe('group');
    const retention=document.getElementById('opt-codex-context')!.closest('.ide-setting')!.nextElementSibling!;
    expect(retention.textContent).toContain('On-demand');expect(retention.nextElementSibling).toBe(budget);
    expect(budget.textContent).toContain('may increase API requests, token usage, costs and waiting time');
    expect(budget.textContent).toContain('upper limits, not a fixed number of calls');
    expect(budget.textContent).toContain('future messages');expect(budget.textContent).toContain('partial answer');
    for(const [id,label,value,min,max] of [
      ['opt-codex-api-read-rounds','Read rounds','64','1','256'],
      ['opt-codex-api-tool-calls','Tool calls','128','1','512'],
      ['opt-codex-api-timeout','Total time (seconds)','580','90','580'],
    ]){
      const field=document.getElementById(id) as HTMLInputElement;
      expect(field.labels?.[0]?.textContent).toBe(label);expect(field.type).toBe('number');
      expect(field.value).toBe(value);expect(field.min).toBe(min);expect(field.max).toBe(max);
      expect(field.required).toBe(true);expect(field.step).toBe('1');expect(field.classList.contains('form-control-sm')).toBe(true);
      expect(field.getAttribute('aria-describedby')).toContain('opt-codex-api-budget-description');
    }
    expect(actions.saveCodex).not.toHaveBeenCalled();
  });

  it.each([
    ['apiMaxReadRounds','opt-codex-api-read-rounds',1,256],
    ['apiMaxToolCalls','opt-codex-api-tool-calls',1,512],
    ['apiTimeoutSeconds','opt-codex-api-timeout',90,580],
  ] as const)('saves %s only on blur and restores both allowed endpoints after reopening',async(key,id,min,max)=>{
    model.codex={enabled:true,providerId:'11111111-2222-3333-4444-555555555555',model:'',effort:'',contextMode:'project',instructions:''};
    const save=vi.fn(async next=>{model.codex={...next};});actions.saveCodex=save;
    let dialog=nativeDialog();await flush();openCodex();
    for(const value of [min,max]){
      const field=document.getElementById(id) as HTMLInputElement;
      const previousCalls=save.mock.calls.length;
      field.value=String(value);field.dispatchEvent(new Event('input'));await flush();
      expect(save).toHaveBeenCalledTimes(previousCalls);
      field.dispatchEvent(new Event('blur'));await flush();
      expect(save).toHaveBeenCalledTimes(previousCalls+1);
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({[key]:value}));
      expect(field.getAttribute('aria-invalid')).toBe('false');
      dialog.remove();await flush();dialog=nativeDialog();await flush();openCodex();
      expect((document.getElementById(id) as HTMLInputElement).value).toBe(String(value));
    }
  });

  it.each([
    ['apiMaxReadRounds','opt-codex-api-read-rounds',64,1,256],
    ['apiMaxToolCalls','opt-codex-api-tool-calls',128,1,512],
    ['apiTimeoutSeconds','opt-codex-api-timeout',580,90,580],
  ] as const)('keeps invalid %s drafts out of autosave and defaults while allowing correction',async(key,id,original,min,max)=>{
    model.codex={enabled:true,providerId:'11111111-2222-3333-4444-555555555555',model:'',effort:'',contextMode:'project',instructions:'',[key]:original};
    const save=vi.fn(async next=>{model.codex={...next};});actions.saveCodex=save;
    actions.defaultsCodex=vi.fn(async()=>{expect(model.codex?.[key]).toBe(original);});
    nativeDialog();await flush();openCodex();
    const field=document.getElementById(id) as HTMLInputElement;
    for(const value of ['',String(min-1),String(max+1),String(min+0.5)]){
      field.value=value;field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('blur'));await flush();
      expect(save).not.toHaveBeenCalled();expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById(id+'-error')!.hidden).toBe(false);
      model.codexStatus='Connected';panel.update();expect(field.value).toBe(value);
    }
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Use the paper notation';instructions.dispatchEvent(new Event('input'));instructions.dispatchEvent(new Event('blur'));await flush();
    expect(save).toHaveBeenCalledTimes(1);expect(save).toHaveBeenLastCalledWith(expect.objectContaining({[key]:original,instructions:'Use the paper notation'}));
    document.querySelector<HTMLButtonElement>('[data-opt-action=codex-defaults]')!.click();await flush();
    expect(actions.defaultsCodex).toHaveBeenCalledTimes(1);expect(field.getAttribute('aria-invalid')).toBe('true');
    field.value=String(min+1);field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('blur'));await flush();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({[key]:min+1}));
    expect(field.getAttribute('aria-invalid')).toBe('false');expect(document.getElementById(id+'-error')!.hidden).toBe(true);
  });

  it('allows API budget preferences for future messages to change during an active reply',async()=>{
    model.codex={enabled:true,providerId:'11111111-2222-3333-4444-555555555555',model:'',effort:'',contextMode:'project',instructions:''};
    model.codexBusy=true;
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    nativeDialog();await flush();openCodex();
    const field=document.getElementById('opt-codex-api-read-rounds') as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(document.getElementById('opt-codex-api-budget')!.textContent).toContain('可能增加 API 请求次数');
    expect(document.getElementById('opt-codex-api-budget')!.textContent).toContain('用于之后发送的消息');
    field.value='96';field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('blur'));await flush();
    expect(actions.saveCodex).toHaveBeenLastCalledWith(expect.objectContaining({apiMaxReadRounds:96}));
    expect(model.codexBusy).toBe(true);expect(field.disabled).toBe(false);
  });

  it('preserves invalid and uncommitted API budget drafts when the website language changes',async()=>{
    model.codex={enabled:true,providerId:'11111111-2222-3333-4444-555555555555',model:'',effort:'',contextMode:'project',instructions:''};
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    nativeDialog();await flush();openCodex();
    let field=document.getElementById('opt-codex-api-read-rounds') as HTMLInputElement;
    field.value='0';field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('blur'));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    document.documentElement.lang='en';await flush();
    field=document.getElementById('opt-codex-api-read-rounds') as HTMLInputElement;
    let error=document.getElementById('opt-codex-api-read-rounds-error')!;
    expect(field.value).toBe('0');expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(error.hidden).toBe(false);expect(error.textContent).toContain('whole number from 1 to 256');
    expect(field.getAttribute('aria-describedby')).toContain(error.id);expect(actions.saveCodex).not.toHaveBeenCalled();
    field.value='96';field.dispatchEvent(new Event('input'));
    document.documentElement.lang='zh';await flush();
    field=document.getElementById('opt-codex-api-read-rounds') as HTMLInputElement;
    error=document.getElementById('opt-codex-api-read-rounds-error')!;
    expect(field.value).toBe('96');expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(error.hidden).toBe(true);expect(error.textContent).toContain('1 到 256 之间的整数');
    expect(actions.saveCodex).not.toHaveBeenCalled();expect(model.codex?.apiMaxReadRounds).toBeUndefined();
    field.dispatchEvent(new Event('blur'));await flush();
    expect(actions.saveCodex).toHaveBeenCalledTimes(1);expect(model.codex?.apiMaxReadRounds).toBe(96);
  });

  it('debounces instructions while typing and flushes them when the native dialog closes',async()=>{
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    const dialog=nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='A';instructions.dispatchEvent(new Event('input'));
    instructions.value='A complete preference';instructions.dispatchEvent(new Event('input'));
    expect(actions.saveCodex).not.toHaveBeenCalled();
    dialog.remove();await flush();
    expect(actions.saveCodex).toHaveBeenCalledTimes(1);
    expect(model.codex?.instructions).toBe('A complete preference');
    nativeDialog();await flush();openCodex();
    expect((document.getElementById('opt-codex-instructions') as HTMLTextAreaElement).value).toBe('A complete preference');
  });

  it('keeps the latest instructions when settings reopen before the closing save completes',async()=>{
    let finish!:()=>void;
    actions.saveCodex=vi.fn(async next=>{await new Promise<void>(resolve=>{finish=resolve;});model.codex={...next};});
    const dialog=nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Latest instruction';instructions.dispatchEvent(new Event('input'));
    dialog.remove();await flush();expect(actions.saveCodex).toHaveBeenCalledTimes(1);
    nativeDialog();await flush();openCodex();
    const restored=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    expect(restored.value).toBe('Latest instruction');
    finish();await flush();expect(model.codex?.instructions).toBe('Latest instruction');expect(restored.value).toBe('Latest instruction');
  });

  it('saves instructions after typing pauses without requiring blur or a confirmation',async()=>{
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};});
    nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.focus();instructions.value='Use the paper notation';instructions.dispatchEvent(new Event('input'));
    expect(actions.saveCodex).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(model.codex?.instructions).toBe('Use the paper notation'));
    expect(document.activeElement).toBe(instructions);expect(actions.saveCodex).toHaveBeenCalledTimes(1);
  });

  it('keeps defaults unavailable while an independent interaction preference is being saved',async()=>{
    let finish!:()=>void;
    actions.setCodexPosition=vi.fn(async position=>{await new Promise<void>(resolve=>{finish=resolve;});model.codexPanelPosition=position;});
    actions.defaultsCodex=vi.fn(async()=>{});
    nativeDialog();await flush();openCodex();
    const position=document.getElementById('opt-codex-position') as HTMLSelectElement;
    const defaults=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-defaults]')!;
    position.value='right';position.dispatchEvent(new Event('change'));
    expect(defaults.disabled).toBe(true);defaults.click();expect(actions.defaultsCodex).not.toHaveBeenCalled();
    finish();await flush();expect(defaults.disabled).toBe(false);
    defaults.click();await flush();expect(actions.defaultsCodex).toHaveBeenCalledTimes(1);
    expect(model.codexPanelPosition).toBe('right');
  });

  it('does not set defaults when the pending project save fails',async()=>{
    actions.saveCodex=vi.fn(async()=>{throw new Error('Storage unavailable');});
    actions.defaultsCodex=vi.fn(async()=>{});
    nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Keep the draft';instructions.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('[data-opt-action=codex-defaults]')!.click();await flush();
    expect(actions.defaultsCodex).not.toHaveBeenCalled();expect(instructions.value).toBe('Keep the draft');
    expect(document.getElementById('opt-codex-status')!.textContent).toContain('Storage unavailable');
  });

  it('sets defaults separately after flushing pending project instructions',async()=>{
    document.documentElement.lang='en';
    const order:string[]=[];
    actions.saveCodex=vi.fn(async next=>{model.codex={...next};order.push('save');});
    actions.defaultsCodex=vi.fn(async()=>{order.push('defaults');expect(model.codex?.instructions).toBe('Project-only notation');});
    nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Project-only notation';instructions.dispatchEvent(new Event('input'));
    expect(actions.defaultsCodex).not.toHaveBeenCalled();
    const defaults=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-defaults]')!;
    expect(defaults.textContent).toBe('Set as default');defaults.click();await flush();
    expect(order).toEqual(['save','defaults']);
    expect(actions.save).not.toHaveBeenCalled();expect(actions.defaults).not.toHaveBeenCalled();
  });

  it('updates available models and connection status without overwriting unsaved Codex controls',async()=>{
    model.codex={enabled:true,model:'saved-unlisted-model',effort:'high',instructions:'',contextMode:'project'};
    actions.checkCodex=vi.fn(async()=>{
      model.codexStatus='Connected';model.codexModels=[{id:'available-model',displayName:'Available model'}];
    });
    nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Draft preference';instructions.dispatchEvent(new Event('input'));
    const selected=document.getElementById('opt-codex-model') as HTMLSelectElement;
    expect(selected.value).toBe('saved-unlisted-model');
    document.querySelector<HTMLButtonElement>('[data-opt-action=codex-check]')!.click();await flush();
    expect(actions.checkCodex).toHaveBeenCalledTimes(1);expect(document.getElementById('opt-codex-status')?.textContent).toBe('Connected');
    expect(selected.value).toBe('saved-unlisted-model');
    expect([...selected.options].map(option=>option.value)).toEqual(['','available-model','saved-unlisted-model']);
    expect(instructions.value).toBe('Draft preference');
    expect((document.getElementById('opt-codex-effort') as HTMLSelectElement).value).toBe('high');
  });

  it('preserves the Codex textarea caret and draft through a website language change',async()=>{
    nativeDialog();await flush();openCodex();
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Use local notation';instructions.dispatchEvent(new Event('input'));instructions.focus();instructions.setSelectionRange(4,9);
    document.documentElement.lang='en';await flush();
    expect(document.getElementById('opt-settings-preview-tab')?.textContent).toBe('LaTeX Preview');
    const restored=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    expect(restored.value).toBe('Use local notation');expect(document.activeElement).toBe(restored);
    expect([restored.selectionStart,restored.selectionEnd]).toEqual([4,9]);
    expect(document.getElementById('opt-settings-panel')?.textContent).not.toMatch(/[\p{Script=Han}]/u);
    expect(document.getElementById('opt-settings-codex-tab')?.getAttribute('aria-selected')).toBe('true');
  });

  it('uses independent busy state, prevents duplicate Codex actions and retains errors',async()=>{
    let reject!: (error:Error)=>void;
    actions.checkCodex=vi.fn(()=>new Promise<void>((_resolve,no)=>{reject=no;}));
    model.busy=true;
    nativeDialog();await flush();openCodex();
    const check=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-check]')!;
    expect(check.disabled).toBe(false);check.click();check.click();
    expect(actions.checkCodex).toHaveBeenCalledTimes(1);expect(check.disabled).toBe(true);
    reject(new Error('Connection unavailable'));await flush();
    expect(document.getElementById('opt-codex-status')?.textContent).toBe('Connection unavailable');
    expect(check.disabled).toBe(false);model.codexBusy=true;panel.update();expect(check.disabled).toBe(true);
  });

  it('syncs project cache with a native secondary action, preserves settings and reports the result',async()=>{
    document.documentElement.lang='en';
    model.codex={enabled:true,model:'',effort:'',instructions:'Keep notation',contextMode:'project'};
    let finish!:(message:string)=>void;
    actions.onSyncProjectCache=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
    actions.saveCodex=vi.fn(async()=>{});actions.checkCodex=vi.fn(async()=>{});actions.defaultsCodex=vi.fn(async()=>{});
    nativeDialog();await flush();openCodex();
    const sync=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-sync-project]')!;
    expect([...sync.parentElement!.querySelectorAll<HTMLButtonElement>('button')].map(button=>button.textContent))
      .toEqual(['Check connection','Set as default','Sync project cache']);
    expect(sync.className).toBe('btn btn-sm btn-secondary');expect(sync.type).toBe('button');
    expect(sync.disabled).toBe(false);sync.click();sync.click();panel.update();
    expect(actions.onSyncProjectCache).toHaveBeenCalledTimes(1);expect(sync.disabled).toBe(true);expect(sync.getAttribute('aria-busy')).toBe('true');
    finish('Project cache synchronized: 4 source files.');await flush();panel.update();
    expect(sync.disabled).toBe(false);expect(sync.getAttribute('aria-busy')).toBe('false');
    expect(document.getElementById('opt-codex-status')?.textContent).toBe('Project cache synchronized: 4 source files.');
    expect(actions.saveCodex).not.toHaveBeenCalled();expect(actions.checkCodex).not.toHaveBeenCalled();expect(actions.defaultsCodex).not.toHaveBeenCalled();
    expect(model.codex.instructions).toBe('Keep notation');
  });

  it('keeps project cache sync errors visible and restores the action for an explicit retry',async()=>{
    model.codex={enabled:true,model:'',effort:'',instructions:'',contextMode:'project'};
    actions.onSyncProjectCache=vi.fn(async()=>{throw new Error('Project export unavailable');});
    nativeDialog();await flush();openCodex();
    const sync=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-sync-project]')!;
    expect(sync.textContent).toBe('同步项目缓存');sync.click();await flush();panel.update();
    expect(document.getElementById('opt-codex-status')?.textContent).toBe('Project export unavailable');
    expect(sync.disabled).toBe(false);expect(sync.getAttribute('aria-busy')).toBe('false');
    actions.onSyncProjectCache=vi.fn(async()=>'项目缓存已同步。');sync.click();await flush();
    expect(document.getElementById('opt-codex-status')?.textContent).toBe('项目缓存已同步。');
  });

  it('updates project cache sync availability from external settings and never reenables a disabled context after completion',async()=>{
    model.codex={enabled:true,model:'',effort:'',instructions:'',contextMode:'project'};
    nativeDialog();await flush();openCodex();
    const sync=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-sync-project]')!;
    expect(sync.disabled).toBe(true);
    let finish!:(message:string)=>void;
    actions.onSyncProjectCache=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));panel.update();
    expect(sync.disabled).toBe(false);
    model.codex.enabled=false;panel.update();expect(sync.disabled).toBe(true);sync.click();expect(actions.onSyncProjectCache).not.toHaveBeenCalled();
    model.codex.enabled=true;model.codex.contextMode='selection';panel.update();expect(sync.disabled).toBe(true);
    model.codex.contextMode='project';panel.update();expect(sync.disabled).toBe(false);sync.click();
    model.codex.contextMode='selection';panel.update();finish('Cache synchronized');await flush();
    expect(sync.disabled).toBe(true);expect(sync.getAttribute('aria-busy')).toBe('false');
    model.codex.contextMode='project';panel.update();expect(sync.disabled).toBe(false);
    delete actions.onSyncProjectCache;panel.update();expect(sync.disabled).toBe(true);
  });

  it('blocks project cache sync while a context change is saving and after it saves selection-only mode',async()=>{
    model.codex={enabled:true,model:'',effort:'',instructions:'',contextMode:'project'};
    let finish!:()=>void;
    actions.saveCodex=vi.fn(async next=>{await new Promise<void>(resolve=>{finish=resolve;});model.codex={...next};});
    actions.onSyncProjectCache=vi.fn(async()=>'Cache synchronized');
    nativeDialog();await flush();openCodex();
    const sync=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-sync-project]')!;
    const scope=document.getElementById('opt-codex-context') as HTMLSelectElement;
    scope.value='selection';scope.dispatchEvent(new Event('change'));await flush();
    expect(sync.disabled).toBe(true);sync.click();expect(actions.onSyncProjectCache).not.toHaveBeenCalled();
    finish();await flush();expect(sync.disabled).toBe(true);
  });

  it('uses native compact typography instead of inheriting the larger dialog parent size',async()=>{
    const nativeStyle=document.createElement('style');
    nativeStyle.textContent=`
      .ide-settings-modal-body{font-family:"Noto Sans",sans-serif;font-size:16px;line-height:24px}
      .ide-settings-tab-link{font-size:14px;line-height:20px;font-weight:400}
      .ide-setting-title,.ide-setting-description,.form-select-sm,.form-control-sm{font-family:"Noto Sans",sans-serif;font-size:14px;line-height:21px}
    `;
    document.head.append(nativeStyle);
    try{
      nativeDialog();await flush();openCodex();
      for(const id of ['opt-settings-tab','opt-settings-preview-tab','opt-settings-codex-tab']){
        expect(getComputedStyle(document.getElementById(id)!).fontSize).toBe('14px');
        expect(getComputedStyle(document.getElementById(id)!).lineHeight).toBe('20px');
      }
      for(const id of ['opt-codex-model','opt-codex-effort','opt-codex-context','opt-codex-instructions']){
        const computed=getComputedStyle(document.getElementById(id)!);
        expect(computed.fontSize).toBe('14px');expect(computed.lineHeight).toBe('21px');
        expect(computed.fontFamily).toContain('Noto Sans');
      }
    }finally{nativeStyle.remove();}
  });

  it('loads models on Codex activation once without update or locale loops and preserves drafts',async()=>{
    let finish!:()=>void;
    actions.openCodex=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    nativeDialog();await flush();openCodex();
    const modelSelect=document.getElementById('opt-codex-model') as HTMLSelectElement;
    expect(actions.openCodex).toHaveBeenCalledTimes(1);
    expect(modelSelect.disabled).toBe(true);expect(modelSelect.getAttribute('aria-busy')).toBe('true');
    expect(modelSelect.closest('.ide-setting')?.textContent).toContain('正在加载可用模型');
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    instructions.value='Keep this unsaved preference';instructions.dispatchEvent(new Event('input'));
    panel.update();panel.refreshForm();openCodex();
    document.documentElement.lang='en';await flush();
    expect(actions.openCodex).toHaveBeenCalledTimes(1);
    // Explicit refreshForm intentionally reloads saved controls; type a new draft
    // before the asynchronous catalogue completes to check update preservation.
    const current=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    current.value='Preserve after load';current.dispatchEvent(new Event('input'));
    model.codexModels=[{id:'model-one',displayName:'Model one',efforts:['low','high','max']}];
    finish();await flush();
    const loaded=document.getElementById('opt-codex-model') as HTMLSelectElement;
    expect(loaded.disabled).toBe(false);expect([...loaded.options].map(o=>o.value)).toEqual(['','model-one']);
    expect(current.value).toBe('Preserve after load');
    openPreview();openCodex();expect(actions.openCodex).toHaveBeenCalledTimes(2);
    finish();await flush();
  });

  it('shows model load errors with a retry and recovers without replacing the form',async()=>{
    actions.openCodex=vi.fn(async()=>{throw new Error('Local Codex unavailable');});
    actions.checkCodex=vi.fn(async()=>{model.codexModels=[{id:'ready',displayName:'Ready model'}];model.codexStatus='Connected';});
    nativeDialog();await flush();openCodex();await flush();
    const selected=document.getElementById('opt-codex-model') as HTMLSelectElement;
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;
    expect(selected.closest('.ide-setting')?.textContent).toContain('Local Codex unavailable');
    const retry=document.querySelector<HTMLButtonElement>('[data-opt-action=codex-check]')!;
    expect(retry.textContent).toBe('重试连接');expect(retry.disabled).toBe(false);
    instructions.value='Do not lose this';instructions.dispatchEvent(new Event('input'));
    retry.click();await flush();
    expect(document.getElementById('opt-codex-model')).toBe(selected);
    expect(instructions.value).toBe('Do not lose this');
    expect(selected.closest('.ide-setting')?.textContent).not.toContain('Local Codex unavailable');
    expect(retry.textContent).toBe('检查连接');
  });

  it('uses supported reasoning efforts while preserving a saved unavailable effort explicitly',async()=>{
    model.codex={enabled:true,model:'model-one',effort:'xhigh',instructions:'',contextMode:'project'};
    model.codexModels=[{id:'model-one',displayName:'One',efforts:['low','high','max']},{id:'model-two',displayName:'Two',efforts:['minimal','medium']}];
    nativeDialog();await flush();openCodex();
    const effort=document.getElementById('opt-codex-effort') as HTMLSelectElement;
    expect([...effort.options].map(o=>o.value)).toEqual(['','low','high','max','xhigh']);
    expect(effort.selectedOptions[0].textContent).toContain('此模型不支持');
    const selected=document.getElementById('opt-codex-model') as HTMLSelectElement;
    selected.value='model-two';selected.dispatchEvent(new Event('change'));
    expect([...effort.options].map(o=>o.value)).toEqual(['','minimal','medium','xhigh']);
    expect(effort.value).toBe('xhigh');
  });

  it('supports keyboard navigation in the disclosure and returns to native tabs',async()=>{
    nativeDialog();await flush();
    const parent=document.getElementById('opt-settings-tab')!;parent.focus();
    parent.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    parent.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    const preview=document.getElementById('opt-settings-preview-tab')!;
    expect(document.activeElement).toBe(preview);expect(preview.getAttribute('aria-selected')).toBe('true');
    preview.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    const codex=document.getElementById('opt-settings-codex-tab')!;
    expect(document.activeElement).toBe(codex);expect(codex.getAttribute('aria-selected')).toBe('true');
    codex.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    expect(document.activeElement).toBe(document.getElementById('editor-tab'));
    expect(document.getElementById('editor-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('opt-settings-panel')!.hidden).toBe(true);
    panel.destroy();expect(document.getElementById('opt-settings-children')).toBeNull();
  });
});
