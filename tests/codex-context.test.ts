import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { syncCodexProjectSource } from '../src/codex/context';
import { validCodexRequest, type CodexEvent, type CodexRequest } from '../src/codex/types';

const uploadId = '12345678-1234-4234-8234-123456789abc', snapshotId = 'ab'.repeat(32);
const project = (texts: Record<string, string>, rootPath = 'main.tex') => ({ rootPath, files: Object.entries(texts).map(([path, content]) => ({ path, content })) });
function receiver(reused?: Record<string, string>) {
  const contents = new Map<string, string>();
  let manifest: NonNullable<CodexRequest['sourceManifest']> = [];
  const request = vi.fn(async (op: CodexRequest['op'], data: Partial<CodexRequest>): Promise<CodexEvent> => {
    expect(validCodexRequest({ ...data, version: 1, id: 'request', op, projectId: '0123456789abcdef01234567' })).toBe(true);
    if (op === 'source-begin') {
      manifest = data.sourceManifest!;
      for (const file of manifest) contents.set(file.path, reused?.[file.path] ?? '');
      return { id: 'r', type: 'source', uploadId, ...(reused === undefined ? {} : { missingPaths: manifest.filter(file => !(file.path in reused)).map(file => file.path) }) };
    }
    if (op === 'source-chunk') {
      const previous = contents.get(data.path!)!; expect(data.offset).toBe(Buffer.byteLength(previous));
      expect(data.content!.length).toBeLessThanOrEqual(100_000); expect(data.content).not.toMatch(/[\uD800-\uDFFF]/u);
      contents.set(data.path!, previous + data.content!); return { id: 'r', type: 'source', uploadId };
    }
    for (const file of manifest) { const text = contents.get(file.path)!; expect(Buffer.byteLength(text)).toBe(file.bytes); expect(createHash('sha256').update(text).digest('hex')).toBe(file.sha256); }
    return { id: 'r', type: 'source', snapshotId, fileCount: manifest.length, totalBytes: manifest.reduce((sum, file) => sum + file.bytes, 0) };
  });
  return { contents, request };
}
describe('complete project source snapshots', () => {
  it('uploads every byte after the old 80k and 230k cutoffs and preserves more than 64 files', async () => {
    const texts = { 'main.tex': 'Opening\n' + 'background line\n'.repeat(9000) + '\\section{Required derivation}\nESSENTIAL_ANSWER_BODY\n', ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`chapter-${i}.tex`, `File ${i}\n` + 'entire source\n'.repeat(300)])) };
    const host = receiver(), result = await syncCodexProjectSource(project(texts), host.request);
    expect(result).toEqual({ snapshotId, fileCount: 81, totalBytes: Object.values(texts).reduce((sum, value) => sum + Buffer.byteLength(value), 0), uploadedFileCount: 81 });
    for (const [path, content] of Object.entries(texts)) expect(host.contents.get(path)).toBe(content);
    expect(host.contents.get('main.tex')).toContain('ESSENTIAL_ANSWER_BODY'); expect(host.request.mock.calls.at(-1)![0]).toBe('source-commit');
  });

  it('uses UTF-8 byte offsets and never splits a surrogate pair at a chunk boundary', async () => {
    const text = '中'.repeat(99_999) + '😀' + '量子'.repeat(100_000) + '末尾', host = receiver();
    await syncCodexProjectSource(project({ 'main.tex': text, 'empty.txt': '' }), host.request);
    expect(host.contents.get('main.tex')).toBe(text); expect(host.contents.get('empty.txt')).toBe('');
    const chunks = host.request.mock.calls.filter(([op]) => op === 'source-chunk');
    expect(chunks[0][1].content).toBe('中'.repeat(99_999)); expect(chunks[1][1].offset).toBe(299_997); expect(chunks[1][1].content!.startsWith('😀')).toBe(true);
  });

  it('uploads only requested changed and added files while committing the complete current manifest', async () => {
    const texts = { 'main.tex': 'Unchanged root', 'changed.tex': 'New version', 'added.tex': 'Added source', 'renamed.tex': 'Same source under a new name' };
    const host = receiver({ 'main.tex': texts['main.tex'], 'renamed.tex': texts['renamed.tex'], 'deleted.tex': 'Removed source' });
    const result = await syncCodexProjectSource(project(texts), host.request);
    expect(host.request.mock.calls.filter(([op]) => op === 'source-chunk').map(([,data]) => data.path)).toEqual(['added.tex', 'changed.tex']);
    expect(host.request.mock.calls[0][1].sourceManifest!.map(file => file.path)).toEqual(['added.tex', 'changed.tex', 'main.tex', 'renamed.tex']);
    expect(host.contents.has('deleted.tex')).toBe(false);
    expect(result).toMatchObject({ snapshotId, fileCount: 4, uploadedFileCount: 2 });
    for (const [path, content] of Object.entries(texts)) expect(host.contents.get(path)).toBe(content);
  });

  it('commits a fully reusable project without sending source chunks', async () => {
    const texts = { 'main.tex': 'Unchanged text', 'empty.txt': '' }, host = receiver(texts);
    const result = await syncCodexProjectSource(project(texts), host.request);
    expect(host.request.mock.calls.map(([op]) => op)).toEqual(['source-begin', 'source-commit']);
    expect(result).toMatchObject({ snapshotId, fileCount: 2, uploadedFileCount: 0 });
  });

  it('rejects invalid incremental file requests before sending any source chunk or commit', async () => {
    for (const missingPaths of [['other.tex'], ['main.tex', 'main.tex'], ['../secret'], [''], null, 'main.tex']) {
      const request = vi.fn(async () => ({ id: 'r', type: 'source', uploadId, missingPaths } as unknown as CodexEvent));
      await expect(syncCodexProjectSource(project({ 'main.tex': 'Text' }), request)).rejects.toThrow('invalid source file');
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it('rejects unsafe or oversized projects before opening any upload', async () => {
    const host = receiver();
    for (const input of [project({ '../escape.tex': 'x' }, ''), project({ 'main.tex': 'x\0y' }), project({ 'main.tex': '\uD800' }), project({ 'main.tex': '中'.repeat(700_000) }), project(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i}.tex`, 'x'.repeat(2 * 1024 * 1024)])), ''), project({ 'main.tex': 'x' }, 'missing.tex')]) {
      await expect(syncCodexProjectSource(input, host.request)).rejects.toThrow();
    }
    expect(host.request).not.toHaveBeenCalled();
  });

  it('does not commit incomplete uploads or silently accept a mismatched receipt', async () => {
    const host = receiver(); host.request.mockImplementationOnce(async () => ({ id: 'r', type: 'source', uploadId })).mockImplementationOnce(async () => { throw new Error('Connection lost'); });
    await expect(syncCodexProjectSource(project({ 'main.tex': 'full text' }), host.request)).rejects.toThrow('Connection lost');
    expect(host.request.mock.calls.map(([op]) => op)).toEqual(['source-begin', 'source-chunk']);
    const wrong = vi.fn(async (op: string): Promise<CodexEvent> => op === 'source-commit' ? { id: 'r', type: 'source', snapshotId, fileCount: 9 } : { id: 'r', type: 'source', uploadId });
    await expect(syncCodexProjectSource(project({ 'main.tex': 'text' }), wrong)).rejects.toThrow('could not be verified');
  });

  it('stops a canceled capture before any later chunk or commit', async () => {
    let current = true;
    const request = vi.fn(async (): Promise<CodexEvent> => { current = false; return { id: 'r', type: 'source', uploadId }; });
    await expect(syncCodexProjectSource(project({ 'main.tex': 'a'.repeat(200_000) }), request, () => current)).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not proceed without a compatible helper acknowledgment', async () => {
    const request = vi.fn(async (): Promise<CodexEvent> => ({ id: 'r', type: 'done' }));
    await expect(syncCodexProjectSource(project({ 'main.tex': 'text' }), request)).rejects.toThrow('Update the local connection');
  });
});
