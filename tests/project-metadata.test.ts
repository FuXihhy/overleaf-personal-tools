import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProjectRoot, readProjectRoot, type MetadataSocket } from '../src/overleaf/project-metadata';

const PROJECT = '0123456789abcdef01234567';
const ROOT = '1123456789abcdef01234567';
const OTHER = '2123456789abcdef01234567';
afterEach(() => vi.unstubAllGlobals());
const folder = (name: string, docs: unknown[] = [], folders: unknown[] = [], fileRefs: unknown[] = []): object => ({ name, docs, folders, fileRefs });
const payload = (root = ROOT, roots = [folder('root', [{ _id: OTHER, name: 'main.tex' }], [folder('paper', [{ _id: root, name: 'main.tex' }])])]) => ({ project: { _id: PROJECT, rootDoc_id: root, rootFolder: roots } });
function fakeSocket(value?: unknown, event = 'joinProjectResponse') {
  const handlers = new Map<string, (data?: unknown) => void>();
  const socket: MetadataSocket & { emit: ReturnType<typeof vi.fn> } = {
    on: vi.fn((name, handler) => { handlers.set(name, handler); if (name === event && value !== undefined) queueMicrotask(() => handler(value)); }),
    disconnect: vi.fn(), emit: vi.fn(),
  };
  return { socket, handlers, connect: vi.fn(() => socket) };
}

describe('read-only Overleaf project metadata', () => {
  it('retains the exact compiler image identifier without guessing unavailable settings', () => {
    const data=payload();
    expect(parseProjectRoot(PROJECT,{project:{...data.project,compiler:'xelatex',imageName:'texlive-2026.1'}}))
      .toMatchObject({compiler:'xelatex',texLiveVersion:'texlive-2026.1'});
    expect(parseProjectRoot(PROJECT,{project:{...data.project,compiler:'custom',imageName:'bad\nimage'}}))
      .toEqual({rootDocId:ROOT,rootPath:'paper/main.tex'});
  });
  it('accepts the Chinese editor origin and rejects cross-language connections', async () => {
    const { socket, connect } = fakeSocket(payload());
    vi.stubGlobal('location', { origin: 'https://cn.overleaf.com' });
    expect((await readProjectRoot(PROJECT, { connectSocket: connect })).rootPath).toBe('paper/main.tex');
    expect(connect).toHaveBeenCalledWith('https://cn.overleaf.com', expect.objectContaining({ query: `projectId=${PROJECT}` }));
    expect(socket.disconnect).toHaveBeenCalledOnce();
    for (const [current, requested] of [['https://www.overleaf.com', 'https://cn.overleaf.com'], ['https://cn.overleaf.com', 'https://www.overleaf.com']]) {
      vi.stubGlobal('location', { origin: current });
      await expect(readProjectRoot(PROJECT, { origin: requested, connectSocket: connect })).rejects.toThrow('同源');
    }
    for (const origin of ['https://fr.overleaf.com', 'https://cn.overleaf.com:8443', 'http://cn.overleaf.com', 'https://cn.overleaf.com.attacker.test']) {
      await expect(readProjectRoot(PROJECT, { origin, connectSocket: connect })).rejects.toThrow('Overleaf');
    }
    expect(connect).toHaveBeenCalledOnce();
  });
  it('maps rootDoc_id to a full nested path, without guessing among identical basenames', () => {
    expect(parseProjectRoot(PROJECT, payload())).toEqual({ rootDocId: ROOT, rootPath: 'paper/main.tex' });
    expect(parseProjectRoot(PROJECT, payload(ROOT, [folder('root', [], [], [{ _id: ROOT, name: 'uploaded.tex' }])]))).toEqual({ rootDocId: ROOT, rootPath: 'uploaded.tex' });
    expect(parseProjectRoot(PROJECT, { project: { _id: PROJECT, rootDoc_id: null } })).toEqual({});
  });
  it('rejects mismatched identities, traversal, duplicate root IDs, cycles, and oversized trees', () => {
    expect(() => parseProjectRoot(OTHER, payload())).toThrow('不匹配');
    expect(() => parseProjectRoot(PROJECT, payload(ROOT, [folder('root', [], [folder('..', [{ _id: ROOT, name: 'x.tex' }])])]))).toThrow('路径');
    expect(() => parseProjectRoot(PROJECT, payload(ROOT, [folder('root', [{ _id: ROOT, name: 'a.tex' }, { _id: ROOT, name: 'b.tex' }])]))).toThrow('多个路径');
    const circular = folder('root') as { folders: unknown[] }; circular.folders.push(circular);
    expect(() => parseProjectRoot(PROJECT, payload(ROOT, [circular]))).toThrow('限额');
    expect(() => parseProjectRoot(PROJECT, payload(ROOT, [folder('root', Array(6001).fill({ _id: ROOT, name: 'a.tex' }))]))).toThrow('限额');
  });
  it('joins only the current project, emits no application event, and immediately disconnects', async () => {
    const { socket, connect } = fakeSocket(payload());
    expect(await readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', connectSocket: connect })).toEqual({ rootDocId: ROOT, rootPath: 'paper/main.tex' });
    expect(connect).toHaveBeenCalledWith('https://www.overleaf.com', expect.objectContaining({ 'force new connection': true, reconnect: false, transports: ['websocket'], query: `projectId=${PROJECT}` }));
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });
  it('disconnects on rejection, invalid payload, timeout, and cancellation', async () => {
    const rejected = fakeSocket({ message: 'permission denied' }, 'connectionRejected');
    await expect(readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', connectSocket: rejected.connect })).rejects.toThrow('暂时无法');
    expect(rejected.socket.disconnect).toHaveBeenCalledOnce();
    const invalid = fakeSocket({ project: { _id: OTHER } });
    await expect(readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', connectSocket: invalid.connect })).rejects.toThrow('不匹配');
    expect(invalid.socket.disconnect).toHaveBeenCalledOnce();
    const timed = fakeSocket();
    await expect(readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', connectSocket: timed.connect, timeoutMs: 5 })).rejects.toThrow('超时');
    expect(timed.socket.disconnect).toHaveBeenCalledOnce();
    const aborted = fakeSocket();
    const controller = new AbortController();
    const promise = readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', connectSocket: aborted.connect, signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(aborted.socket.on).toHaveBeenCalled());
    controller.abort();
    expect(await promise).toEqual(expect.objectContaining({ name: 'AbortError' }));
    expect(aborted.socket.disconnect).toHaveBeenCalledOnce();
  });
  it('cleans up a connector that resolves only after the request times out', async () => {
    const { socket } = fakeSocket();
    let resolve!: (socket: MetadataSocket) => void;
    await expect(readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', timeoutMs: 5, connectSocket: () => new Promise(done => { resolve = done; }) })).rejects.toThrow('超时');
    resolve(socket);
    await vi.waitFor(() => expect(socket.disconnect).toHaveBeenCalledOnce());
    expect(socket.on).not.toHaveBeenCalled();
  });
  it('rejects unrelated origins and malformed project IDs before connecting', async () => {
    const { connect } = fakeSocket(payload());
    await expect(readProjectRoot(PROJECT, { origin: 'https://example.com', connectSocket: connect })).rejects.toThrow('Overleaf');
    await expect(readProjectRoot('../project', { origin: 'https://www.overleaf.com', connectSocket: connect })).rejects.toThrow('ID');
    expect(connect).not.toHaveBeenCalled();
  });
  it('does not open a connection if cancelled before the connector starts', async () => {
    const { connect } = fakeSocket(payload());
    const controller = new AbortController();
    const promise = readProjectRoot(PROJECT, { origin: 'https://www.overleaf.com', connectSocket: connect, signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await promise).toEqual(expect.objectContaining({ name: 'AbortError' }));
    expect(connect).not.toHaveBeenCalled();
  });
});
