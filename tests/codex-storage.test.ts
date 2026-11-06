import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveCodexMessages, loadCodexClickToCopy, saveCodexClickToCopy, loadCodexCopyToast, saveCodexCopyToast, loadCodexBusyMessageBehavior, saveCodexBusyMessageBehavior, codexStorageKey, loadCodexSettings, saveCodexSettings, loadCodexPanelPosition, saveCodexPanelPosition, saveCodexDefaults, type CodexDefaults } from '../src/codex/storage';
import { DEFAULT_CODEX_SETTINGS, type CodexMessage, type CodexSelection } from '../src/codex/types';

const projectId = '0123456789abcdef01234567', accountId = '123456789abcdef012345678';
const selection: CodexSelection = { path: 'notes.tex', text: 'x=0', from: 12, to: 15, startLine: 2, endLine: 2, before: 'Assume ', after: '.' };
const pair = (label: string, text: string): CodexMessage[] => [{ role: 'user', text: label, selection }, { role: 'assistant', text }];
const cost = (messages: CodexMessage[]) => messages.reduce((total, message) => total + message.text.length + (message.selection ? JSON.stringify(message.selection).length : 0) + (message.answerQuote ? JSON.stringify(message.answerQuote).length : 0), 0);

describe('browser-only formula click preference', () => {
  let stored: Record<string, unknown>;
  beforeEach(() => {
    stored={};vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(key:string)=>({[key]:stored[key]})),set:vi.fn(async(values:Record<string,unknown>)=>{Object.assign(stored,values);})}}});
  });
  afterEach(() => vi.unstubAllGlobals());
  it('defaults to off and only accepts explicitly saved true', async () => {
    const key=codexStorageKey(projectId,accountId)+':click-to-copy';
    for(const value of [undefined,false,'true',1,null]){stored[key]=value;expect(await loadCodexClickToCopy(projectId,accountId)).toBe(false);}
    stored[key]=true;expect(await loadCodexClickToCopy(projectId,accountId)).toBe(true);
  });
  it('persists independently per account and project without changing native model settings', async () => {
    const settingsKey=codexStorageKey(projectId,accountId)+':settings';stored[settingsKey]={model:'existing'};
    await saveCodexClickToCopy(projectId,accountId,true);
    expect(await loadCodexClickToCopy(projectId,accountId)).toBe(true);
    expect(await loadCodexClickToCopy('different-project',accountId)).toBe(false);
    expect(await loadCodexClickToCopy(projectId,'different-account')).toBe(false);
    expect(stored[settingsKey]).toEqual({model:'existing'});
    await saveCodexClickToCopy(projectId,accountId,false);expect(await loadCodexClickToCopy(projectId,accountId)).toBe(false);
  });
  it('keeps copied-formula notices separately opt-in per account and project', async () => {
    const key=codexStorageKey(projectId,accountId)+':copy-toast';
    for(const value of [undefined,false,'true',1,null]){stored[key]=value;expect(await loadCodexCopyToast(projectId,accountId)).toBe(false);}
    await saveCodexClickToCopy(projectId,accountId,true);
    expect(await loadCodexCopyToast(projectId,accountId)).toBe(false);
    await saveCodexCopyToast(projectId,accountId,true);expect(await loadCodexCopyToast(projectId,accountId)).toBe(true);
    expect(await loadCodexCopyToast('different-project',accountId)).toBe(false);
    expect(await loadCodexCopyToast(projectId,'different-account')).toBe(false);
    await saveCodexCopyToast(projectId,accountId,false);expect(await loadCodexCopyToast(projectId,accountId)).toBe(false);
    expect(await loadCodexClickToCopy(projectId,accountId)).toBe(true);
  });
  it('defaults new-message behavior to queue, isolating it from model settings and saved prompts', async () => {
    const scope=codexStorageKey(projectId,accountId),key=scope+':busy-message-behavior';
    for(const value of [undefined,'queue','invalid',true,1,null]){stored[key]=value;expect(await loadCodexBusyMessageBehavior(projectId,accountId)).toBe('queue');}
    stored[scope+':settings']={model:'existing',instructions:'Keep notation'};
    stored[scope+':queue']=[{prompt:{question:'Original question',settings:{model:'existing'}}}];
    await saveCodexBusyMessageBehavior(projectId,accountId,'steer');
    expect(await loadCodexBusyMessageBehavior(projectId,accountId)).toBe('steer');
    expect(await loadCodexBusyMessageBehavior('different-project',accountId)).toBe('queue');
    expect(await loadCodexBusyMessageBehavior(projectId,'different-account')).toBe('queue');
    expect(stored[scope+':settings']).toEqual({model:'existing',instructions:'Keep notation'});
    expect(stored[scope+':queue']).toEqual([{prompt:{question:'Original question',settings:{model:'existing'}}}]);
    await saveCodexBusyMessageBehavior(projectId,accountId,'queue');expect(await loadCodexBusyMessageBehavior(projectId,accountId)).toBe('queue');
  });
});

describe('account-scoped assistant defaults', () => {
  let stored: Record<string, unknown>;
  const providerId = '12345678-1234-1234-1234-123456789abc';
  const defaults: CodexDefaults = {
    settings: { ...DEFAULT_CODEX_SETTINGS, enabled: false, model: 'gpt-6-astra', effort: 'ultra', contextMode: 'selection', providerId },
    panelPosition: 'right', busyMessageBehavior: 'steer', clickToCopy: true, copyToast: true,
  };
  beforeEach(() => {
    stored = {};
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
    } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('inherits saved defaults for another project without writing project overrides', async () => {
    await saveCodexDefaults(accountId, defaults);
    const before = structuredClone(stored);
    expect(await loadCodexSettings(projectId, accountId)).toEqual({ ...defaults.settings, instructions: '' });
    expect(await loadCodexPanelPosition(projectId, accountId)).toBe('right');
    expect(await loadCodexBusyMessageBehavior(projectId, accountId)).toBe('steer');
    expect(await loadCodexClickToCopy(projectId, accountId)).toBe(true);
    expect(await loadCodexCopyToast(projectId, accountId)).toBe(true);
    expect(stored).toEqual(before);
  });

  it('preserves explicit project values including false, left, queue and Follow Codex', async () => {
    const settings = { ...DEFAULT_CODEX_SETTINGS, instructions: 'Preserve the notation in this paper.' };
    await saveCodexSettings(projectId, accountId, settings);
    await saveCodexPanelPosition(projectId, accountId, 'left');
    await saveCodexBusyMessageBehavior(projectId, accountId, 'queue');
    await saveCodexClickToCopy(projectId, accountId, false);
    await saveCodexCopyToast(projectId, accountId, false);
    await saveCodexDefaults(accountId, defaults);
    expect(await loadCodexSettings(projectId, accountId)).toEqual(settings);
    expect(await loadCodexPanelPosition(projectId, accountId)).toBe('left');
    expect(await loadCodexBusyMessageBehavior(projectId, accountId)).toBe('queue');
    expect(await loadCodexClickToCopy(projectId, accountId)).toBe(false);
    expect(await loadCodexCopyToast(projectId, accountId)).toBe(false);
    expect(await loadCodexSettings('another-project', accountId)).toEqual({ ...defaults.settings, instructions: '' });
  });

  it('inherits each preference independently and isolates accounts', async () => {
    await saveCodexDefaults(accountId, defaults);
    await saveCodexPanelPosition(projectId, accountId, 'left');
    expect(await loadCodexPanelPosition(projectId, accountId)).toBe('left');
    expect(await loadCodexClickToCopy(projectId, accountId)).toBe(true);
    for (const otherAccount of ['other-account', undefined]) {
      expect(await loadCodexSettings(projectId, otherAccount)).toEqual(DEFAULT_CODEX_SETTINGS);
      expect(await loadCodexPanelPosition(projectId, otherAccount)).toBe('left');
      expect(await loadCodexBusyMessageBehavior(projectId, otherAccount)).toBe('queue');
      expect(await loadCodexClickToCopy(projectId, otherAccount)).toBe(false);
      expect(await loadCodexCopyToast(projectId, otherAccount)).toBe(false);
    }
    await expect(saveCodexDefaults(undefined, defaults)).rejects.toThrow('Overleaf account');
    expect(Object.keys(stored)).toHaveLength(2);
  });

  it('excludes project instructions and unrelated private data from defaults', async () => {
    const supplied = {
      ...defaults, settings: { ...defaults.settings, instructions: 'Private manuscript convention', apiKey: 'private-key', conversationId: 'private-chat' },
      messages: [{ text: 'private question' }],
    };
    const scope = codexStorageKey(projectId, accountId);
    stored[scope + ':messages'] = [{ text: 'Existing history' }];
    await saveCodexDefaults(accountId, supplied);
    expect(stored[`codex-defaults:${accountId}`]).toEqual({
      ...defaults, settings: { enabled: false, model: 'gpt-6-astra', effort: 'ultra', contextMode: 'selection', providerId },
    });
    expect(stored[scope + ':messages']).toEqual([{ text: 'Existing history' }]);
    const saved = stored[`codex-defaults:${accountId}`] as { settings: Record<string, unknown> };
    saved.settings.instructions = 'Legacy or manually edited instructions';
    expect((await loadCodexSettings('new-project', accountId)).instructions).toBe('');
  });

  it('validates malformed defaults without enabling formula copying from truthy values', async () => {
    stored[`codex-defaults:${accountId}`] = {
      settings: { enabled: 'false', model: 'invalid model', effort: 'impossible', providerId: 'invalid', instructions: 'ignore' },
      panelPosition: 'somewhere', busyMessageBehavior: 'replace', clickToCopy: 'true', copyToast: 1,
    };
    expect(await loadCodexSettings(projectId, accountId)).toEqual(DEFAULT_CODEX_SETTINGS);
    expect(await loadCodexPanelPosition(projectId, accountId)).toBe('left');
    expect(await loadCodexBusyMessageBehavior(projectId, accountId)).toBe('queue');
    expect(await loadCodexClickToCopy(projectId, accountId)).toBe(false);
    expect(await loadCodexCopyToast(projectId, accountId)).toBe(false);
  });
});

describe('bounded display history retention', () => {
  const sendMessage = vi.fn(async (_request: { messages: CodexMessage[] }) => ({ ok: true }));
  beforeEach(() => { sendMessage.mockClear(); vi.stubGlobal('chrome', { runtime: { sendMessage } }); });
  afterEach(() => vi.unstubAllGlobals());
  const saved = () => sendMessage.mock.calls.at(-1)![0].messages;

  it('retains the latest question and exact quote with a marked excerpt of a maximum native answer', async () => {
    const messages = [...pair('Old question', 'Old answer'), ...pair('Newest question', 'A'.repeat(450_000))];
    await saveCodexMessages(projectId, accountId, messages);
    expect(saved()).toHaveLength(2);
    expect(saved()[0]).toEqual(messages[2]);
    expect(saved()[0].selection).toEqual(selection);
    expect(saved()[1].text).toMatch(/^A+/);
    expect(saved()[1].text).toContain('Display history excerpt');
    expect(saved()[1].text).toContain('后续内容未保存');
    expect(cost(saved())).toBeLessThanOrEqual(350_000);
    expect(messages[3].text).toHaveLength(450_000);
  });

  it('keeps older turns whole instead of retaining an answer without its question', async () => {
    const messages = [...pair('Older', 'A'.repeat(180_000)), ...pair('Newest', 'B'.repeat(180_000))];
    await saveCodexMessages(projectId, accountId, messages);
    expect(saved()).toEqual(messages.slice(2));
    expect(saved()[1].text).not.toContain('Display history excerpt');
  });

  it('preserves recent pairs within the 60-message limit, with their selection snapshots', async () => {
    const messages = Array.from({ length: 31 }, (_, i) => pair(`Question ${i}`, `Answer ${i}`)).flat();
    await saveCodexMessages(projectId, accountId, messages);
    expect(saved()).toEqual(messages.slice(2));
    expect(saved()).toHaveLength(60);
  });

  it('counts a large quoted selection in the budget and never cuts a surrogate pair', async () => {
    const quote = { ...selection, text: 'x'.repeat(64_000), from: 0, to: 64_000, before: 'b'.repeat(16_000), after: 'a'.repeat(16_000) };
    await saveCodexMessages(projectId, accountId, [{ role: 'user', text: 'Explain.', selection: quote }, { role: 'assistant', text: '😀'.repeat(225_000) }]);
    expect(saved()[0].selection).toEqual(quote);
    expect(cost(saved())).toBeLessThanOrEqual(350_000);
    const prefix = saved()[1].text.split('\n\n[Display history excerpt')[0];
    expect(prefix).toMatch(/^(?:😀)+$/u);
  });

  it('counts both quote types and retains their exact text when excerpting a long answer', async () => {
    const answerQuote={text:'quoted answer '.repeat(4000),messageId:'native-answer'};
    const question:CodexMessage={role:'user',text:'Explain both.',selection,answerQuote};
    await saveCodexMessages(projectId,accountId,[question,{role:'assistant',text:'A'.repeat(350_000)}]);
    expect(saved()[0]).toEqual(question);
    expect(saved()[1].text).toContain('Display history excerpt');
    expect(cost(saved())).toBeLessThanOrEqual(350_000);
  });

  it('keeps New chat clearing explicit and does not persist an unidentified account', async () => {
    await saveCodexMessages(projectId, undefined, pair('Question', 'Answer'));
    expect(sendMessage).not.toHaveBeenCalled();
    await saveCodexMessages(projectId, accountId, [{ role: 'assistant', text: 'Orphan legacy answer' }]);
    expect(sendMessage).not.toHaveBeenCalled();
    await saveCodexMessages(projectId, accountId, []);
    expect(saved()).toEqual([]);
  });
});
