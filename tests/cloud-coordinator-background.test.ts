import { describe, expect, it, vi } from 'vitest';
import { allowedNativeSender } from '../src/background';
import { registerCloudCoordinator, validSharedCloudState, type CoordinatorStorage, type CoordinatorRuntime } from '../src/cloud-coordinator-background';

const ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const SOURCE = '111111111111111111111111';
const PROJECT = '222222222222222222222222';
const EXTENSION = 'synthetic-extension';
const sender = (tabId = 1, language = 'www'): chrome.runtime.MessageSender => ({ id: EXTENSION, tab: { id: tabId } as chrome.tabs.Tab, frameId: 0, documentId: 'document-' + tabId, url: `https://${language}.overleaf.com/project/${SOURCE}` });
const binding = { kind: 'shared-v1', accountId: ACCOUNT, projectId: PROJECT, name: 'Shared preview' };
const state = () => ({ binding, workspace: { sourceProjectId: SOURCE, files: [{ path: 'macros.sty', id: '333333333333333333333333', type: 'doc', digest: 'a'.repeat(64) }], dirty: true, pendingPaths: ['main.tex'] }, nextCompileAt: 3000 });
function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])]))),
    set: vi.fn(async (updates: Record<string, unknown>) => { for (const [key, value] of Object.entries(updates)) values[key] = structuredClone(value); }),
  };
}
function harness(storage: CoordinatorStorage = { local: area(), session: area() }) {
  let listener!: Parameters<CoordinatorRuntime['onMessage']['addListener']>[0];
  let time = 1000, count = 0;
  const runtime: CoordinatorRuntime = { id: EXTENSION, onMessage: { addListener: fn => { listener = fn; }, removeListener: vi.fn() } };
  const stop = registerCloudCoordinator(runtime, storage, allowedNativeSender, { now: () => time, token: () => 'token-' + (++count) });
  const dispatch = (op: string, requestId = 'a', from = sender(), extra: Record<string, unknown> = {}, accountId = ACCOUNT): Promise<any> => new Promise(resolve => {
    listener({ type: 'opt:shared-cloud', op, requestId, accountId, ...extra }, from, resolve);
  });
  return { dispatch, storage, stop, setTime: (value: number) => { time = value; } };
}

describe('shared cloud coordinator persistence', () => {
  it('serializes simultaneous English and Chinese tabs for the same account', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.dispatch('acquire'), h.dispatch('acquire', 'b', sender(2, 'cn'))]);
    expect(a).toMatchObject({ ok: true, granted: true });
    expect(b).toMatchObject({ ok: true, granted: false });
    await h.dispatch('release', 'a', sender(), { token: a.token });
    expect(await h.dispatch('acquire', 'b', sender(2, 'cn'))).toMatchObject({ granted: true });
    h.stop();
  });

  it('gives independent accounts independent locks and states', async () => {
    const h = harness();
    const a = await h.dispatch('acquire');
    const b = await h.dispatch('acquire', 'b', sender(2), {}, ACCOUNT_B);
    expect(a.granted).toBe(true); expect(b.granted).toBe(true);
    expect(await h.dispatch('save', 'a', sender(), { token: a.token, state: state() })).toMatchObject({ ok: true });
    expect(await h.dispatch('read')).toMatchObject({ state: state() });
    expect(await h.dispatch('read', 'b', sender(2), {}, ACCOUNT_B)).toMatchObject({ state: {} });
    h.stop();
  });

  it('retains FIFO order and allows a canceled waiting formula to leave the queue', async () => {
    const h = harness(), a = await h.dispatch('acquire');
    await h.dispatch('acquire', 'b', sender(2));
    await h.dispatch('acquire', 'c', sender(3));
    await h.dispatch('release', 'a', sender(), { token: a.token });
    expect(await h.dispatch('acquire', 'c', sender(3))).toMatchObject({ granted: false });
    await h.dispatch('cancel', 'b', sender(2));
    expect(await h.dispatch('acquire', 'c', sender(3))).toMatchObject({ granted: true });
    h.stop();
  });

  it('rejects a forged token, another tab, and a reloaded document', async () => {
    const h = harness(), a = await h.dispatch('acquire');
    expect(await h.dispatch('release', 'a', sender(), { token: 'wrong' })).toMatchObject({ ok: false });
    expect(await h.dispatch('save', 'a', sender(2), { token: a.token, state: state() })).toMatchObject({ ok: false });
    expect(await h.dispatch('renew', 'a', { ...sender(), documentId: 'new-document' }, { token: a.token })).toMatchObject({ ok: false });
    expect(await h.dispatch('renew', 'a', sender(), { token: a.token })).toMatchObject({ ok: true, activeUntil: 31_000 });
    h.stop();
  });

  it('cannot resume an expired owner and quarantines the workspace for a full compile deadline', async () => {
    const h = harness(), a = await h.dispatch('acquire');
    h.setTime(31_001);
    expect(await h.dispatch('renew', 'a', sender(), { token: a.token })).toMatchObject({ ok: false });
    expect(await h.dispatch('release', 'a', sender(), { token: a.token })).toMatchObject({ ok: false });
    expect(await h.dispatch('acquire', 'b', sender(2))).toMatchObject({ granted: false });
    h.setTime(330_999);
    expect(await h.dispatch('acquire', 'b', sender(2))).toMatchObject({ granted: false });
    h.setTime(331_001);
    expect(await h.dispatch('acquire', 'b', sender(2))).toMatchObject({ granted: true });
    h.stop();
  });

  it('retains active and quarantined leases across service worker and full browser restarts', async () => {
    const local = area(), first = harness({ local, session: area() });
    const a = await first.dispatch('acquire'); first.stop();
    // Replacing the entire session area simulates browser restart, not only SW idle.
    const next = harness({ local, session: area() }); next.setTime(32_000);
    expect(await next.dispatch('acquire', 'b', sender(2))).toMatchObject({ granted: false });
    expect(await next.dispatch('renew', 'a', sender(), { token: a.token })).toMatchObject({ ok: false });
    next.setTime(331_001);
    expect(await next.dispatch('acquire', 'b', sender(2))).toMatchObject({ granted: true });
    next.stop();
  });

  it('keeps quarantine on uncertain release but releases definite completion immediately', async () => {
    const h = harness(), a = await h.dispatch('acquire');
    expect(await h.dispatch('release', 'a', sender(), { token: a.token, uncertain: true })).toMatchObject({ ok: true });
    expect(await h.dispatch('renew', 'a', sender(), { token: a.token })).toMatchObject({ ok: false });
    expect(await h.dispatch('acquire', 'b', sender(2))).toMatchObject({ granted: false });
    h.setTime(332_000);
    const b = await h.dispatch('acquire', 'b', sender(2));
    await h.dispatch('release', 'b', sender(2), { token: b.token });
    expect(await h.dispatch('acquire', 'c', sender(3))).toMatchObject({ granted: true });
    h.stop();
  });

  it('persists creation and upload journals without accepting document text or arbitrary metadata', async () => {
    const h = harness(), a = await h.dispatch('acquire');
    const pending = { creationPending: { name: 'Shared preview', startedAt: 1000 } };
    expect(await h.dispatch('save', 'a', sender(), { token: a.token, state: pending })).toMatchObject({ state: pending });
    const next = state(); next.workspace.files[0].digest = '';
    expect(await h.dispatch('save', 'a', sender(), { token: a.token, state: next })).toMatchObject({ state: next });
    expect(await h.dispatch('save', 'a', sender(), { token: a.token, state: { ...next, formula: 'private formula' } })).toMatchObject({ ok: false });
    expect(await h.dispatch('read')).toMatchObject({ state: next });
    h.stop();
  });

  it('denies cross-account bindings, malformed paths and non-editor senders', async () => {
    expect(validSharedCloudState({ binding: { ...binding, accountId: ACCOUNT_B } }, ACCOUNT)).toBe(false);
    expect(validSharedCloudState({ ...state(), workspace: { ...state().workspace, pendingPaths: ['../private'] } }, ACCOUNT)).toBe(false);
    expect(validSharedCloudState({ ...state(), workspace: { ...state().workspace, files: [{ ...state().workspace.files[0], content: 'private' }] } }, ACCOUNT)).toBe(false);
    const h = harness();
    for (const from of [{ ...sender(), id: 'another-extension' }, { ...sender(), frameId: 1 }, { ...sender(), url: 'https://attacker.test/project/' + SOURCE }]) {
      expect(await h.dispatch('acquire', 'a', from)).toMatchObject({ ok: false });
    }
    h.stop();
  });
});
