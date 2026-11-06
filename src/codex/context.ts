import {
  CODEX_SOURCE_CHUNK_CHARS, CODEX_SOURCE_MAX_FILE_BYTES, CODEX_SOURCE_MAX_FILES, CODEX_SOURCE_MAX_TOTAL_BYTES,
  isCodexSnapshotId, sourcePath, type CodexEvent, type CodexRequest, type CodexSourceManifestEntry,
} from './types';

export interface CodexProjectSource { rootPath: string; files: Array<{ path: string; content: string }> }
export interface CodexProjectSnapshot { snapshotId: string; fileCount: number; totalBytes: number; uploadedFileCount?: number }
type SourceRequest = (op: 'source-begin' | 'source-chunk' | 'source-commit', data: Partial<CodexRequest>) => Promise<CodexEvent>;
const encoder = new TextEncoder();

/** Synchronize a complete source manifest, uploading only files the helper
 * cannot reuse. A committed snapshot is immutable and can outlive the tab. */
export async function syncCodexProjectSource(source: CodexProjectSource, request: SourceRequest, current: () => boolean = () => true): Promise<CodexProjectSnapshot> {
  const check = () => { if (!current()) throw new Error('Project synchronization was cancelled because the conversation changed.'); };
  check();
  if (!sourcePath(source.rootPath, true) || !source.files.length || source.files.length > CODEX_SOURCE_MAX_FILES) throw new Error('The project does not contain a supported number of readable source files.');
  const sourceManifest: CodexSourceManifestEntry[] = [], paths = new Set<string>();
  let totalBytes = 0;
  // Freeze text references before async hashing. No file is excerpted or omitted.
  const files = source.files.map(file => ({ ...file })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of files) {
    check();
    if (!sourcePath(file.path) || paths.has(file.path) || typeof file.content !== 'string' || /[\0\uD800-\uDFFF]/u.test(file.content)) throw new Error('The project contains an invalid source path or text file.');
    paths.add(file.path);
    const bytes = encoder.encode(file.content); totalBytes += bytes.byteLength;
    if (bytes.byteLength > CODEX_SOURCE_MAX_FILE_BYTES || totalBytes > CODEX_SOURCE_MAX_TOTAL_BYTES) throw new Error('The complete project exceeds the local source snapshot limit. Nothing was sent to the model.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    sourceManifest.push({ path: file.path, bytes: bytes.byteLength, sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join('') });
  }
  if (source.rootPath && !paths.has(source.rootPath)) throw new Error('The main source file is missing from the project export.');
  check();
  const begin = await request('source-begin', { sourceManifest, rootPath: source.rootPath });
  if (begin.type !== 'source' || !begin.uploadId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(begin.uploadId)) throw new Error('The local helper cannot receive complete project sources. Update the local connection and try again.');
  const uploadId = begin.uploadId;
  // Check again at this boundary: synthetic/alternate callers can bypass the
  // transport parser, and the helper may only request files in this manifest.
  if (begin.missingPaths !== undefined && (!Array.isArray(begin.missingPaths) || begin.missingPaths.length > files.length
    || begin.missingPaths.some(path => !sourcePath(path) || !paths.has(path)) || new Set(begin.missingPaths).size !== begin.missingPaths.length)) {
    throw new Error('The local helper requested an invalid source file. The project cache was not updated.');
  }
  const missing = begin.missingPaths === undefined ? paths : new Set(begin.missingPaths);
  for (const file of files) {
    if (!missing.has(file.path)) continue;
    let offset = 0;
    for (let from = 0; from < file.content.length;) {
      check();
      let to = Math.min(file.content.length, from + CODEX_SOURCE_CHUNK_CHARS);
      // Offsets are UTF-8 bytes; slice boundaries are UTF-16 code units. Never
      // send half of a supplementary Unicode character in either message.
      if (to < file.content.length && /[\uD800-\uDBFF]/.test(file.content[to - 1])) to--;
      const content = file.content.slice(from, to);
      const response = await request('source-chunk', { uploadId, path: file.path, offset, content });
      if (response.type !== 'source' || response.uploadId !== undefined && response.uploadId !== uploadId) throw new Error('The local helper did not confirm a complete source chunk.');
      offset += encoder.encode(content).byteLength; from = to;
    }
  }
  check();
  const committed = await request('source-commit', { uploadId });
  check();
  if (committed.type !== 'source' || !isCodexSnapshotId(committed.snapshotId)
    || committed.fileCount !== undefined && committed.fileCount !== files.length
    || committed.totalBytes !== undefined && committed.totalBytes !== totalBytes) throw new Error('The complete project snapshot could not be verified. Nothing was sent to the model.');
  return { snapshotId: committed.snapshotId, fileCount: files.length, totalBytes, uploadedFileCount: missing.size };
}
