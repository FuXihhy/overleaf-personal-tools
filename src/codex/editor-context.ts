import { sourcePath } from './types';

/** A live buffer is optional: never label an unverified buffer as a project file.
 * An unavailable bridge falls back to a fresh server export at the caller. */
export function captureEditorContext(options: {
  path: string; selectedPath(): string; current(): boolean; signal: AbortSignal;
}): Promise<{ path: string; content: string } | undefined> {
  return new Promise((resolve, reject) => {
    const id = `context-${crypto.randomUUID()}`;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(deadline); clearTimeout(retry); window.removeEventListener('opt:document-context-result', receive); options.signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(new Error('Project synchronization was cancelled.')); };
    const finish = (value?: {path:string;content:string}) => { cleanup(); if (!options.current()) reject(new Error('Project synchronization was cancelled.')); else resolve(value); };
    const request = () => {
      if (!options.current() || options.signal.aborted) { cancel(); return; }
      if (options.selectedPath() !== options.path) { finish(); return; }
      window.dispatchEvent(new CustomEvent('opt:request-document-context', {detail:JSON.stringify({id})}));
    };
    const receive = (event: Event) => {
      try {
        const raw = (event as CustomEvent<unknown>).detail;
        if (typeof raw !== 'string' || raw.length > 16_000_000) return;
        const message = JSON.parse(raw);
        if (message?.id !== id) return;
        if (message.ok === true && sourcePath(message.name) && typeof message.text === 'string'
          && message.text.length <= 2_000_000 && (!options.path || message.name === options.path)
          && options.selectedPath() === options.path) { finish({path:message.name,content:message.text}); return; }
        // Native editor transitions can return pending immediately; allow them
        // to settle, but keep the whole attempt bounded even if no reply arrives.
        if (!retry) retry = setTimeout(() => { retry = undefined; request(); }, 200);
      } catch { /* Unrelated malformed replies cannot supply editor content. */ }
    };
    const deadline = setTimeout(() => finish(), 1500);
    window.addEventListener('opt:document-context-result', receive);
    options.signal.addEventListener('abort', cancel, {once:true});
    request();
  });
}
