import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverleafCloudClient, type CloudProjectBinding, type CloudSocket } from '../src/overleaf/cloud-client';

const SOURCE = '0123456789abcdef01234567';
const ACCOUNT = '4123456789abcdef01234567';
const COPY = '1123456789abcdef01234567';
const FOLDER = '2123456789abcdef01234567';
const DOC = '3123456789abcdef01234567';
afterEach(() => vi.unstubAllGlobals());
const binding: CloudProjectBinding = { kind: 'shared-v1', accountId: ACCOUNT, projectId: COPY, rootFolderId: FOLDER, name: 'Preview copy' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const pdf = () => new Response('%PDF-1.7\npreview', { headers: { 'content-type': 'application/pdf' } });
const upload = () => json({ success: true, entity_id: DOC, entity_type: 'doc' });
const output = (status = 'success', extra: Record<string, unknown>[] = []) => json({ status, clsiServerId: 'clsi-2', outputFiles: [{ path: 'output.pdf', build: 'build-1', url: 'https://attacker.invalid/not-used.pdf' }, ...extra] });
function client(fetcher: typeof fetch, isActive?: () => boolean) {
  const c = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher, csrfToken: 'token', origin: 'https://www.overleaf.com', connectSocket: socketFactory({project:metadata()}).connect, isActive });
  c.restorePreviewProject(binding);
  return c;
}
function metadata(extra: Record<string,unknown> = {}) { return { _id: COPY, owner: {_id:ACCOUNT}, rootFolder:[{_id:FOLDER}], ...extra }; }
async function flush() { for(let i=0;i<24;i++) await Promise.resolve(); }
function socketFactory(data: unknown) {
  const handlers = new Map<string, (data?: unknown) => void>();
  const socket: CloudSocket = {
    on: vi.fn((event: string, handler: (data?: unknown) => void) => {
      handlers.set(event, handler);
      if (event === 'joinProjectResponse') queueMicrotask(() => handler(data));
    }),
    disconnect: vi.fn(),
  };
  return { socket, connect: vi.fn(async () => socket), handlers };
}

describe('Overleaf cloud preview client', () => {
  it('distinguishes unsent creation from definite refusal so a safe retry can clear its journal', async () => {
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:429}));
    const noToken=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:''});
    await expect(noToken.createPreviewProject()).rejects.toThrow('登录令牌');
    expect(noToken.creationOutcome).toBe('not-started');expect(fetcher).not.toHaveBeenCalled();
    const noLease=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',beforeRequest:async()=>{throw new DOMException('Lost lease','AbortError');}});
    await expect(noLease.createPreviewProject()).rejects.toThrow('Lost lease');
    expect(noLease.creationOutcome).toBe('not-started');expect(fetcher).not.toHaveBeenCalled();
    const refused=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token'});
    await expect(refused.createPreviewProject()).rejects.toThrow('频繁');
    expect(refused.creationOutcome).toBe('rejected');
  });

  it.each(['network','server','invalid-success'])('keeps creation outcome uncertain for %s failures', async failure => {
    const uncertain=vi.fn();
    const fetcher=vi.fn<typeof fetch>(async()=>{
      if(failure==='network')throw new TypeError('lost');
      if(failure==='server')return new Response(null,{status:503});
      return json({project_id:'invalid'});
    });
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',onUncertain:uncertain});
    await expect(c.createPreviewProject()).rejects.toThrow();
    expect(c.creationOutcome).toBe('uncertain');expect(uncertain).toHaveBeenCalledOnce();
  });

  it('reuses a shared binding across source projects but rejects legacy clone bindings', () => {
    const other = new OverleafCloudClient('5123456789abcdef01234567', { accountId: ACCOUNT, fetch: vi.fn() });
    other.restorePreviewProject(binding);
    expect(other.getPreviewProject()?.projectId).toBe(COPY);
    expect(() => other.restorePreviewProject({ sourceProjectId: SOURCE, projectId: COPY } as unknown as CloudProjectBinding)).toThrow();
  });

  it('rejects an unexpected owner in creation and in restored-project metadata before any writes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ project_id: COPY, owner_ref: SOURCE }));
    const created = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher, csrfToken: 'token' });
    await expect(created.createPreviewProject()).rejects.toThrow('所属账号');
    expect(created.getPreviewProject()).toBeUndefined();
    const restoredFetch = vi.fn<typeof fetch>();
    const restored = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: restoredFetch, csrfToken: 'token',
      connectSocket: socketFactory({project:metadata({owner:{_id:SOURCE}})}).connect });
    restored.restorePreviewProject(binding);
    await expect(restored.uploadText('preview.tex', 'x')).rejects.toThrow('所有者');
    expect(restoredFetch).not.toHaveBeenCalled();
  });

  it('does not create a second project after a known creation whose metadata failed', async () => {
    const fetcher=vi.fn<typeof fetch>(async()=>json({project_id:COPY,owner_ref:ACCOUNT}));
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',connectSocket:socketFactory({project:metadata({rootFolder:[]})}).connect});
    await expect(c.createPreviewProject()).rejects.toThrow('目录');
    expect(c.creationOutcome).toBe('created');
    await expect(c.createPreviewProject()).rejects.toThrow('复用');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads nested file identities and removes only exact managed matches', async () => {
    const nested='6123456789abcdef01234567', unknown='7123456789abcdef01234567';
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:204}));
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',connectSocket:socketFactory({project:metadata({rootFolder:[{
      _id:FOLDER,docs:[{_id:unknown,name:'user.tex'}],folders:[{_id:nested,name:'defs',docs:[{_id:DOC,name:'macros.sty'}]}],
    }]})}).connect});
    c.restorePreviewProject(binding);
    await c.refreshMetadata();
    expect(c.getFiles()).toEqual([{path:'user.tex',id:unknown,type:'doc'},{path:'defs/macros.sty',id:DOC,type:'doc'}]);
    const snapshot=c.getFiles();snapshot[0].path='modified';
    expect(c.getFiles()[0].path).toBe('user.tex');
    await c.removeManagedFiles([{path:'defs/macros.sty',id:DOC,type:'doc'},{path:'already-gone.tex',id:'8123456789abcdef01234567',type:'doc'}]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`/project/${COPY}/doc/${DOC}`,expect.objectContaining({method:'DELETE',headers:{'X-CSRF-TOKEN':'token'}}));
    expect(c.getFiles()).toEqual([{path:'user.tex',id:unknown,type:'doc'}]);
  });

  it('refuses the entire cleanup when a managed path now has a different identity', async () => {
    const fetcher=vi.fn<typeof fetch>();
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',connectSocket:socketFactory({project:metadata({rootFolder:[{
      _id:FOLDER,docs:[{_id:DOC,name:'preview.tex'},{_id:'7123456789abcdef01234567',name:'macros.sty'}],
    }]})}).connect});
    c.restorePreviewProject(binding);
    await expect(c.removeManagedFiles([{path:'preview.tex',id:DOC,type:'doc'},{path:'macros.sty',id:'8123456789abcdef01234567',type:'doc'}])).rejects.toThrow('已被替换');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks the asynchronous lease fence at the actual HTTP boundary', async () => {
    let allowed=true;
    const fetcher=vi.fn<typeof fetch>(), uncertain=vi.fn();
    const fence=vi.fn(async()=>{if(!allowed)throw new DOMException('Lease expired','AbortError');});
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',beforeRequest:fence,onUncertain:uncertain,connectSocket:socketFactory({project:metadata()}).connect});
    c.restorePreviewProject(binding);await c.refreshMetadata();allowed=false;
    await expect(c.uploadText('preview.tex','x')).rejects.toMatchObject({name:'AbortError'});
    expect(fetcher).not.toHaveBeenCalled();expect(uncertain).not.toHaveBeenCalled();
  });

  it('marks lost responses as uncertain without retrying a mutation', async () => {
    const fetcher=vi.fn<typeof fetch>(async()=>{throw new TypeError('Network lost');}), uncertain=vi.fn();
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',onUncertain:uncertain,connectSocket:socketFactory({project:metadata()}).connect});
    c.restorePreviewProject(binding);
    await expect(c.uploadText('preview.tex','x')).rejects.toThrow('Network lost');
    expect(fetcher).toHaveBeenCalledOnce();expect(uncertain).toHaveBeenCalledOnce();
  });

  it('installs join listeners before the next asynchronous lease round trip', async () => {
    const events:string[]=[];
    const beforeRequest=vi.fn(async()=>{events.push('fence');});
    const socket:CloudSocket={on(event,handler){
      if(event==='joinProjectResponse') { events.push('listen');queueMicrotask(()=>handler({project:metadata()})); }
    },disconnect:vi.fn()};
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,beforeRequest,connectSocket:async()=>{events.push('connect');return socket;}});
    c.restorePreviewProject(binding);await c.refreshMetadata();
    expect(events).toEqual(['fence','connect','listen','fence']);
  });

  it.each([503,408,423])('quarantines ambiguous mutation HTTP %s responses', async status => {
    const uncertain=vi.fn();
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,onUncertain:uncertain,csrfToken:'token',fetch:async()=>new Response(null,{status}),connectSocket:socketFactory({project:metadata()}).connect});
    c.restorePreviewProject(binding);
    await expect(c.uploadText('preview.tex','x')).rejects.toThrow();
    expect(uncertain).toHaveBeenCalledOnce();
  });

  it('quarantines an already-running server compilation before another tab can upload', async () => {
    const uncertain=vi.fn();
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,onUncertain:uncertain,csrfToken:'token',fetch:async()=>json({status:'compile-in-progress'}),connectSocket:socketFactory({project:metadata()}).connect});
    c.restorePreviewProject(binding);
    await expect(c.compile(DOC,'preview.tex')).rejects.toThrow('正在编译');
    expect(uncertain).toHaveBeenCalledOnce();
  });

  it('does not start uploads after context loss while waiting for metadata', async () => {
    let active=true;
    const handlers = new Map<string, (data?: unknown) => void>();
    const socket:CloudSocket={on:vi.fn((event:string,handler:(data?:unknown)=>void)=>{handlers.set(event,handler);}),disconnect:vi.fn()};
    const connect=vi.fn(async()=>socket), fetcher=vi.fn<typeof fetch>();
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',connectSocket:connect,isActive:()=>active});
    c.restorePreviewProject({...binding,rootFolderId:undefined});
    const uploading=c.uploadText('preview.tex','x');
    const rejected=expect(uploading).rejects.toMatchObject({name:'AbortError'});
    await flush();
    expect(handlers.has('joinProjectResponse')).toBe(true);
    active=false;
    handlers.get('joinProjectResponse')!({project:{_id:COPY,rootFolder:[{_id:FOLDER}]}});
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects a delayed socket without installing handshake listeners after context loss', async () => {
    let active=true, finish!:(socket:CloudSocket)=>void;
    const socket:CloudSocket={on:vi.fn(),disconnect:vi.fn()}, fetcher=vi.fn<typeof fetch>();
    const connect=vi.fn(()=>new Promise<CloudSocket>(resolve=>{finish=resolve;}));
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',connectSocket:connect,isActive:()=>active});
    c.restorePreviewProject({...binding,rootFolderId:undefined});
    const uploading=c.uploadText('preview.tex','x');
    const rejected=expect(uploading).rejects.toMatchObject({name:'AbortError'});
    await flush();
    expect(connect).toHaveBeenCalledOnce();
    active=false;finish(socket);await rejected;
    expect(socket.on).not.toHaveBeenCalled();expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('lets an in-flight upload finish but refuses a queued compile after context loss', async () => {
    let active=true, finish!:(response:Response)=>void;
    const fetcher=vi.fn<typeof fetch>(()=>new Promise(resolve=>{finish=resolve;}));
    const c=client(fetcher,()=>active);
    const uploading=c.uploadText('preview.tex','x');
    const compiling=c.compile(DOC,'preview.tex');
    const rejected=expect(compiling).rejects.toMatchObject({name:'AbortError'});
    await flush();expect(fetcher).toHaveBeenCalledOnce();
    active=false;finish(upload());await uploading;await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not fetch output logs or PDFs when a compile finishes after context loss', async () => {
    let active=true, finish!:(response:Response)=>void;
    const fetcher=vi.fn<typeof fetch>(()=>new Promise(resolve=>{finish=resolve;}));
    const c=client(fetcher,()=>active);
    const compiling=c.compile(DOC,'preview.tex');
    const rejected=expect(compiling).rejects.toMatchObject({name:'AbortError'});
    await flush();expect(fetcher).toHaveBeenCalledOnce();
    active=false;finish(output('success',[{path:'output.log',build:'build-1'}]));await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects initial network work when the owner is already invalid', async () => {
    const fetcher=vi.fn<typeof fetch>(), connect=vi.fn();
    const c=new OverleafCloudClient(SOURCE,{accountId:ACCOUNT,fetch:fetcher,csrfToken:'token',connectSocket:connect,isActive:()=>false});
    await expect(c.createPreviewProject('copy')).rejects.toMatchObject({name:'AbortError'});
    expect(fetcher).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
  });

  it('uses the Chinese page origin for its shared-project metadata while retaining same-origin HTTP requests', async () => {
    vi.stubGlobal('location', { origin: 'https://cn.overleaf.com' });
    const fetcher = vi.fn<typeof fetch>(async () => json({ project_id: COPY, owner_ref: ACCOUNT, name: 'Preview copy' }));
    const { socket, connect } = socketFactory({ project: { _id: COPY, owner: {_id:ACCOUNT}, rootFolder: [{ _id: FOLDER }] } });
    const c = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher, csrfToken: 'token', connectSocket: connect });
    await c.createPreviewProject('Preview copy');
    expect(connect).toHaveBeenCalledWith('https://cn.overleaf.com', expect.objectContaining({ query: `projectId=${COPY}` }));
    expect(fetcher).toHaveBeenCalledWith('/project/new', expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }));
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects other sites, ports, and crossing between the allowed language sessions', () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const origin of ['https://fr.overleaf.com', 'https://overleaf.com', 'https://cn.overleaf.com:8443', 'https://cn.overleaf.com.attacker.test', 'http://cn.overleaf.com']) {
      expect(() => new OverleafCloudClient(SOURCE, { origin, fetch: fetcher })).toThrow('Overleaf');
    }
    for (const [current, requested] of [['https://www.overleaf.com', 'https://cn.overleaf.com'], ['https://cn.overleaf.com', 'https://www.overleaf.com']]) {
      vi.stubGlobal('location', { origin: current });
      expect(() => new OverleafCloudClient(SOURCE, { origin: requested, fetch: fetcher })).toThrow('同源');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses unbound writes and bindings to the original / another account', async () => {
    const fetcher = vi.fn();
    const c = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher });
    expect(() => c.uploadText('main.tex', 'x')).toThrow('创建');
    expect(() => c.restorePreviewProject({ ...binding, projectId: SOURCE })).toThrow('绑定');
    expect(() => c.restorePreviewProject({ ...binding, projectId: SOURCE.toUpperCase() })).toThrow('绑定');
    expect(() => c.restorePreviewProject({ ...binding, accountId: COPY })).toThrow('绑定');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates one basic project then independently reads and disconnects the new project socket', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ project_id: COPY, owner_ref: ACCOUNT, name: 'Cloud preview' }));
    const { socket, connect } = socketFactory({ project: { _id: COPY, owner: {_id:ACCOUNT}, rootFolder: [{ _id: FOLDER }], compiler: 'xelatex', imageName: 'texlive-2025.1' } });
    const c = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher, csrfToken: 'token', connectSocket: connect });
    expect(await c.createPreviewProject('Cloud preview')).toEqual({ ...binding, name: 'Cloud preview', compiler: 'xelatex', texLiveVersion: 'texlive-2025.1' });
    expect(fetcher.mock.calls[0][0]).toBe('/project/new');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ projectName: 'Cloud preview', template: 'none' });
    expect(connect).toHaveBeenCalledWith('https://www.overleaf.com', expect.objectContaining({ 'force new connection': true, reconnect: false, query: `projectId=${COPY}` }));
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains a successfully created project if metadata is incompatible, without retrying creation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ project_id: COPY, owner_ref: ACCOUNT }));
    const { socket, connect } = socketFactory({ project: { _id: SOURCE, owner: {_id:ACCOUNT}, rootFolder: [{ _id: FOLDER }] } });
    const c = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher, csrfToken: 'token', connectSocket: connect });
    await expect(c.createPreviewProject('copy')).rejects.toThrow('不匹配');
    expect(c.getPreviewProject()).toEqual({ kind: 'shared-v1', accountId: ACCOUNT, projectId: COPY, name: 'copy' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it('uploads UTF-8 text to the bound copy with CSRF and nested relative paths', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => upload());
    const c = client(fetcher);
    expect(await c.uploadText('config/macros.sty', '\\newcommand{\\R}{数学}')).toEqual({ id: DOC, type: 'doc' });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`/project/${COPY}/upload?folder_id=${FOLDER}`);
    expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error', headers: { 'X-CSRF-TOKEN': 'token' } });
    const form = init!.body as FormData;
    expect(form.get('name')).toBe('macros.sty');
    expect(form.get('relativePath')).toBe('config/macros.sty');
    expect(await (form.get('qqfile') as Blob).text()).toContain('数学');
  });

  it('rejects traversal, binary content, excess size, and a false upload success', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ success: false, entity_id: DOC, entity_type: 'doc' }));
    const c = client(fetcher);
    expect(() => c.uploadText('../main.tex', 'x')).toThrow();
    expect(() => c.uploadText('file.png', 'x')).toThrow('文本');
    expect(() => c.uploadText('file.tex', '\0')).toThrow('无效');
    expect(() => c.uploadText('file.tex', 'a'.repeat(2 * 1024 * 1024 + 1))).toThrow('上限');
    await expect(c.uploadText('file.tex', 'x')).rejects.toThrow('未确认');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sets compiler only on the copy and never changes a rootDoc project setting', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const c = client(fetcher);
    await c.setCompiler('lualatex', 'texlive-2025.1');
    expect(fetcher.mock.calls[0][0]).toBe(`/project/${COPY}/settings`);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ compiler: 'lualatex', imageName: 'texlive-2025.1' });
    expect(c.getPreviewProject()?.compiler).toBe('lualatex');
  });

  it('sends both per-compile root fields and downloads only its same-origin build PDF', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(output()).mockResolvedValueOnce(pdf());
    const c = client(fetcher);
    const result = await c.compile(DOC, 'opt-preview.tex');
    expect(new TextDecoder().decode(result.pdf)).toContain('%PDF-');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ rootDoc_id: DOC, rootResourcePath: 'opt-preview.tex', stopOnFirstError: true, incrementalCompilesEnabled: false });
    expect(fetcher.mock.calls[1][0]).toMatch(new RegExp(`^/download/project/${COPY}/build/build-1/output/output.pdf\\?`));
    expect(String(fetcher.mock.calls[1][0])).toContain('clsiserverid=clsi-2');
    expect(fetcher.mock.calls.every(([path]) => !String(path).includes('attacker.invalid'))).toBe(true);
  });

  it('reports a failed TeX log rather than returning a partial PDF', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(output('stopped-on-first-error', [{ path: 'output.log', build: 'build-1' }]))
      .mockResolvedValueOnce(new Response('log\n! Undefined control sequence.\nl.2 \\bad'));
    await expect(client(fetcher).compile(DOC, 'preview.tex')).rejects.toThrow('Undefined control sequence');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toContain('/output/output.log?');
  });

  it.each(['too-recently-compiled', 'compile-in-progress', 'autocompile-backoff'])('surfaces %s without retrying mutation', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ status, outputFiles: [] }));
    await expect(client(fetcher).compile(DOC, 'preview.tex')).rejects.toThrow(/稍后|等待/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serializes uploads ahead of compilation and refuses duplicate pending compiles / rebinds', async () => {
    let finishUpload!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finishUpload = resolve; }))
      .mockResolvedValueOnce(output()).mockResolvedValueOnce(pdf());
    const c = client(fetcher);
    const first = c.uploadText('preview.tex', 'x');
    const compiling = c.compile(DOC, 'preview.tex');
    await expect(c.compile(DOC, 'preview.tex')).rejects.toThrow('排队');
    expect(() => c.restorePreviewProject(binding)).toThrow('正在');
    await flush();expect(fetcher).toHaveBeenCalledTimes(1);
    finishUpload(upload());
    await first;
    await compiling;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects HTML PDF responses and excessive PDF sizes', async () => {
    const html = vi.fn<typeof fetch>().mockResolvedValueOnce(output()).mockResolvedValueOnce(new Response('<html>login</html>'));
    await expect(client(html).compile(DOC, 'preview.tex')).rejects.toThrow('不是 PDF');
    const huge = vi.fn<typeof fetch>().mockResolvedValueOnce(output()).mockResolvedValueOnce(new Response('%PDF-', { headers: { 'content-length': String(17 * 1024 * 1024) } }));
    await expect(client(huge).compile(DOC, 'preview.tex')).rejects.toThrow('上限');
  });

  it('requires a CSRF token before writes and explains authentication / rate limits', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const c = new OverleafCloudClient(SOURCE, { accountId: ACCOUNT, fetch: fetcher, connectSocket:socketFactory({project:metadata()}).connect, csrfToken: '' });
    c.restorePreviewProject(binding);
    await expect(c.uploadText('preview.tex', 'x')).rejects.toThrow('登录令牌');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(new Response('', { status: 429 }));
    const authenticated = client(fetcher);
    await expect(authenticated.compile(DOC, 'preview.tex')).rejects.toThrow('登录');
    await expect(authenticated.compile(DOC, 'preview.tex')).rejects.toThrow('频繁');
  });
});
