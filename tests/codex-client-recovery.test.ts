import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexClient } from '../src/codex/client';
import { createExtensionContext } from '../src/extension-context';

const PROJECT = '0123456789abcdef01234567';
const CONVERSATION = '12345678-1234-1234-1234-123456789abc';
class Port {
  private messages: Array<(message: unknown) => void> = [];
  private disconnections: Array<() => void> = [];
  onMessage = { addListener: (fn: (message: unknown) => void) => this.messages.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => this.disconnections.push(fn) };
  postMessage = vi.fn();
  disconnect = vi.fn(() => this.drop());
  receive(message: unknown) { this.messages.forEach(fn => fn(message)); }
  drop() { this.disconnections.forEach(fn => fn()); }
  get id(): string { return this.postMessage.mock.calls.at(-1)![0].id; }
}
function setup(onContextInvalidated?: () => void) {
  const ports: Port[] = [];
  const runtime = { id: 'synthetic', lastError: undefined as { message: string } | undefined, connect: vi.fn(() => {
    const port = new Port(); ports.push(port); return port;
  }) };
  vi.stubGlobal('chrome', { runtime });
  return { ports, runtime, client: new CodexClient(PROJECT, undefined, onContextInvalidated) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('recoverable Codex connections', () => {
  it('settles source receipts beside a live answer and never retries an uncertain upload mutation', async () => {
    const h=setup(),answer=h.client.request('ask',{question:'Why?'}),answerId=h.ports[0].id;
    const uploadId='12345678-1234-4234-8234-123456789abc';
    const chunk=h.client.request('source-chunk',{uploadId,path:'main.tex',offset:0,content:'source'}),chunkId=h.ports[0].id;
    h.ports[0].receive({id:chunkId,type:'source',uploadId});expect(await chunk).toMatchObject({type:'source',uploadId});expect(vi.getTimerCount()).toBe(1);
    h.ports[0].receive({id:answerId,type:'done',text:'Answer'});await answer;expect(vi.getTimerCount()).toBe(0);
    const commit=h.client.request('source-commit',{uploadId}).catch(error=>error);h.ports[0].drop();await vi.advanceTimersByTimeAsync(1000);
    expect(await commit).toMatchObject({kind:'disconnected'});expect(h.ports).toHaveLength(1);h.client.close();
  });
  it('retries a disconnected read with a fresh request ID and ignores old replies', async () => {
    const h = setup(), receive = vi.fn();
    const result = h.client.request('history-read', {conversationId:CONVERSATION}, receive);
    const first = h.ports[0], oldID = first.id;
    first.drop();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.ports).toHaveLength(2);
    expect(h.ports[1].id).not.toBe(oldID);
    first.receive({ id: oldID, type: 'history', messages: [] });
    first.drop();
    expect(receive).not.toHaveBeenCalled();
    h.ports[1].receive({ id: h.ports[1].id, type: 'history', conversationId:CONVERSATION, messages: [] });
    expect(await result).toMatchObject({ type:'history', conversationId:CONVERSATION, messages: [] });
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });

  it('bounds repeated connection loss without any heartbeat or endless recovery', async () => {
    const h = setup(), result = h.client.request('history-read', {conversationId:CONVERSATION}).catch(error => error);
    h.ports[0].drop(); await vi.advanceTimersByTimeAsync(150);
    h.ports[1].drop(); await vi.advanceTimersByTimeAsync(500);
    h.ports[2].drop();
    expect(await result).toMatchObject({ kind: 'disconnected' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.runtime.connect).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });

  it.each(['ask', 'new-chat', 'history-select', 'cancel'] as const)('never automatically replays %s after an uncertain result', async op => {
    const data = op === 'ask' ? { question: 'Why?' } : op === 'history-select' ? { conversationId: CONVERSATION } : {};
    const h = setup(), result = h.client.request(op, data).catch(error => error);
    h.ports[0].drop();
    expect(await result).toMatchObject({ kind: 'disconnected' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runtime.connect).toHaveBeenCalledOnce();
    expect(h.ports[0].postMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });

  it.each(['history-list', 'history-read'] as const)('reconnects %s with its pagination scope and settles its history event', async op => {
    const h = setup();
    const data = { cursor: 'opaque-next-page', limit: 20, ...(op === 'history-read' ? { conversationId: CONVERSATION } : {}) };
    const result = h.client.request(op, data);
    h.ports[0].drop(); await vi.advanceTimersByTimeAsync(150);
    expect(h.ports[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({ op, ...data }));
    const reply = op === 'history-list'
      ? { conversations: [{ id: CONVERSATION, title: 'Previous conversation', updatedAt: 1 }], nextCursor: 'next' }
      : { conversationId: CONVERSATION, messages: [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }], nextCursor: 'older' };
    h.ports[1].receive({ id: h.ports[1].id, type: 'history', ...reply });
    expect(await result).toMatchObject({ type: 'history', ...reply });
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });

  it('settles a history-select response without leaving a timeout behind', async () => {
    const h = setup(), result = h.client.request('history-select', { conversationId: CONVERSATION });
    h.ports[0].receive({ id: h.ports[0].id, type: 'history', activeConversationId: CONVERSATION, messages: [] });
    expect(await result).toMatchObject({ activeConversationId: CONVERSATION, messages: [] });
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });

  it('cancels queued reconnects on explicit close but permits a later user request', async () => {
    const h = setup(), old = h.client.request('history-read', {conversationId:CONVERSATION}).catch(error => error);
    h.ports[0].drop(); await vi.advanceTimersByTimeAsync(50);
    h.client.close(); expect(await old).toMatchObject({ kind: 'closed' });
    await vi.advanceTimersByTimeAsync(1000); expect(h.ports).toHaveLength(1);
    const next = h.client.request('status');
    h.ports[1].receive({ id: h.ports[1].id, type: 'status', available: true });
    expect(await next).toMatchObject({ available: true }); h.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry genuine context invalidation or installation failures', async () => {
    const h = setup();
    h.runtime.connect.mockImplementationOnce(() => { throw new Error('Extension context invalidated.'); });
    await expect(h.client.request('status')).rejects.toMatchObject({ kind: 'context-invalidated', message: expect.stringContaining('Refresh the Overleaf page') });
    expect(h.runtime.connect).toHaveBeenCalledOnce();
    const other = setup(), missing = other.client.request('status').catch(error => error);
    other.runtime.lastError = { message: 'Specified native messaging host not found.' }; other.ports[0].drop();
    expect(await missing).toMatchObject({ kind: 'unavailable' });
    expect(vi.getTimerCount()).toBe(0); h.client.close(); other.client.close();
  });

  it('retires the shared context once even when Chrome retains runtime.id after invalidation', async () => {
    let context: ReturnType<typeof createExtensionContext>;
    const retired = vi.fn(() => context.invalidate('extension-updated'));
    const h = setup(retired); context = createExtensionContext();
    context.signal.addEventListener('abort', () => h.client.close());
    h.runtime.connect.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
    expect(context.alive()).toBe(true);
    await expect(h.client.request('status')).rejects.toMatchObject({ kind: 'context-invalidated' });
    expect(h.runtime.id).toBe('synthetic');
    expect(context.reason).toBe('extension-updated'); expect(context.signal.aborted).toBe(true);
    await expect(h.client.request('status')).rejects.toMatchObject({ kind: 'context-invalidated' });
    expect(retired).toHaveBeenCalledOnce(); expect(h.runtime.connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports context invalidation from an idle port but not ordinary connection loss', async () => {
    const retired = vi.fn(), h = setup(retired), first = h.client.request('status');
    h.ports[0].receive({ id: h.ports[0].id, type: 'status', available: true }); await first;
    h.ports[0].drop(); expect(retired).not.toHaveBeenCalled();
    const second = h.client.request('status');
    h.ports[1].receive({ id: h.ports[1].id, type: 'status', available: true }); await second;
    Object.defineProperty(h.runtime, 'lastError', { get() { throw new Error('Extension context invalidated.'); } });
    h.ports[1].drop(); expect(retired).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });

  it('leaves status reconnects to its caller without a second transport retry loop', async () => {
    const h = setup(), status = h.client.request('status').catch(error => error);
    h.ports[0].drop();
    expect(await status).toMatchObject({ kind:'disconnected' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.ports).toHaveLength(1);
    expect(h.ports[0].postMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retried = h.client.request('status');
    h.ports[1].receive({ id:h.ports[1].id, type:'status', available:true });
    expect(await retried).toMatchObject({available:true});h.client.close();
  });

  it('keeps an active answer alive while a status timeout is returned without replay', async () => {
    const h = setup(), answer = h.client.request('ask', { question: 'Why?' });
    const answerID = h.ports[0].id, status = h.client.request('status').catch(error => error);
    await vi.advanceTimersByTimeAsync(60_150);
    expect(await status).toMatchObject({kind:'timeout'});
    expect(h.ports).toHaveLength(1);
    expect(h.ports[0].disconnect).not.toHaveBeenCalled();
    expect(h.ports[0].postMessage.mock.calls.map(call => call[0].op)).toEqual(['ask', 'status']);
    h.ports[0].receive({ id: answerID, type: 'done', text: 'Complete answer' });
    expect(await answer).toMatchObject({ text: 'Complete answer' }); h.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
