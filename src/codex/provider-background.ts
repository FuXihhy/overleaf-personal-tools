import { CODEX_NATIVE_HOST, parseCodexEvent, record } from './types';

const uuid = (value: unknown) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
export function allowedAPISettingsSender(sender: chrome.runtime.MessageSender | undefined, extensionId: string): boolean {
  if (!sender || sender.id !== extensionId || !sender.url || sender.frameId !== undefined && sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId && url.pathname === '/api-settings.html'
      && !url.username && !url.password;
  } catch { return false; }
}

export function validProviderManagement(value: unknown): boolean {
  const r = record(value);
  if (!r || r.version !== 1 || typeof r.id !== 'string' || !/^[\w-]{1,100}$/.test(r.id)
    || Object.keys(r).some(key => !['version','id','op','profile','providerId'].includes(key))) return false;
  if (r.op === 'provider-list') return r.profile === undefined && r.providerId === undefined;
  if (r.op === 'provider-test' || r.op === 'provider-delete') return uuid(r.providerId) && r.profile === undefined;
  if (r.op !== 'provider-save' || r.providerId !== undefined) return false;
  const p = record(r.profile);
  return !!p && Object.keys(p).every(key => ['id','name','baseUrl','model','apiKey'].includes(key))
    && (p.id === undefined || uuid(p.id))
    && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 80
    && typeof p.baseUrl === 'string' && p.baseUrl.length <= 2000
    && typeof p.model === 'string' && p.model.length > 0 && p.model.length <= 128
    && (p.apiKey === undefined || typeof p.apiKey === 'string' && p.apiKey.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(p.apiKey));
}

/** Credentials are admitted only from the extension-owned top-level page. */
export function registerAPISettingsTransport(runtime: typeof chrome.runtime): void {
  runtime.onConnect.addListener(port => {
    if (port.name !== 'opt:api-settings') return;
    if (!allowedAPISettingsSender(port.sender, runtime.id)) { port.disconnect(); return; }
    let native: chrome.runtime.Port | undefined, closed = false;
    let pending: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const send = (event: unknown) => { if (!closed) try { port.postMessage(event); } catch { stop(); } };
    const stop = () => { if (closed) return; closed = true; clearTimeout(timer); native?.disconnect(); port.disconnect(); };
    port.onDisconnect.addListener(() => { void runtime.lastError; stop(); });
    port.onMessage.addListener(raw => {
      if (!validProviderManagement(raw)) {
        const id = record(raw)?.id;
        if (typeof id === 'string' && /^[\w-]{1,100}$/.test(id)) send({id,type:'error',message:'Invalid API connection request.'});
        return;
      }
      const id = String(record(raw)!.id);
      if (pending) { send({id,type:'error',message:'Wait for the current connection operation to finish.'}); return; }
      try {
        if (!native) {
          native = runtime.connectNative(CODEX_NATIVE_HOST);
          native.onMessage.addListener(rawEvent => {
            const event = parseCodexEvent(rawEvent);
            if (!event || event.id !== pending || !['profiles','error'].includes(event.type)) return;
            clearTimeout(timer); pending = undefined; send(event);
          });
          native.onDisconnect.addListener(() => {
            void runtime.lastError;
            if (pending) send({id:pending,type:'error',message:'The local assistant helper disconnected. Reconnect and check whether your changes were saved.'});
            stop();
          });
        }
        pending = id;
        timer = setTimeout(() => { send({id,type:'error',message:'The connection operation timed out. Its outcome may be unknown; reload the connection list before trying again.'}); stop(); }, 55_000);
        native.postMessage(raw);
      } catch {
        send({id,type:'error',message:'The local assistant helper is unavailable. Install or update the companion helper.'}); stop();
      }
    });
  });
}
