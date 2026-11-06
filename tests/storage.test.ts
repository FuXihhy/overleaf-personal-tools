import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { loadSettings, saveDefaults, saveSettings, validateSettings } from '../src/settings/storage';

afterEach(() => vi.unstubAllGlobals());

describe('settings validation and persistence', () => {
  it('validates bounded per-project preview source settings and migrates missing choices to defaults', () => {
    expect(validateSettings({}).previewSources).toBeUndefined();
    expect(validateSettings({ previewSources: [] }).previewSources).toBeUndefined();
    const raw = { previewSources: [
      { id: 'file:config/macros.sty', enabled: false }, { id: 'package:physics', enabled: true },
      { id: 'file:config/macros.sty', enabled: true }, { id: 'file:../private.sty', enabled: false },
      { id: 'file:/absolute.sty', enabled: false }, { id: 'package:physics', enabled: 'yes' },
      { id: 'file:bad\\path.sty', enabled: true },
    ] };
    expect(validateSettings(raw).previewSources).toEqual([{ id: 'file:config/macros.sty', enabled: false }, { id: 'package:physics', enabled: true }]);
  });
  it('validates the two independent engine/backend choices and compiler allowlist', () => {
    expect(validateSettings({ previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex' })).toMatchObject({ previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex' });
    expect(validateSettings({ previewEngine: 'tex', texBackend: 'overleaf', texCompiler: 'lualatex' })).toMatchObject({ previewEngine: 'tex', texBackend: 'overleaf', texCompiler: 'lualatex' });
    expect(validateSettings({ previewEngine: 'unknown', texBackend: 'remote-host', texCompiler: 'sh -c something' })).toMatchObject({ previewEngine: 'mathjax', texBackend: 'overleaf', texCompiler: 'pdflatex' });
  });

  it('rejects invalid cloud identities and versions, and bounds display names', () => {
    expect(validateSettings({ cloudProjectId: '../../another-project', cloudCompiler: 'custom', cloudTexLiveVersion: 'latest' })).toMatchObject({ cloudProjectId: undefined, cloudCompiler: undefined, cloudTexLiveVersion: undefined });
    const valid = validateSettings({ cloudProjectId: 'abcdef0123456789abcdef01', cloudProjectName: 'x'.repeat(500), cloudCompiler: 'xelatex', cloudTexLiveVersion: '2026' });
    expect(valid.cloudProjectId).toBe('abcdef0123456789abcdef01');
    expect(valid.cloudProjectName).toHaveLength(200);
    expect(valid.cloudCompiler).toBe('xelatex');
    expect(valid.cloudTexLiveVersion).toBe('2026');
  });

  it('keeps project-relative file choices bounded and rejects traversal/control paths', () => {
    const settings = validateSettings({ rootFile: '/tmp/main.tex', extraFilesMode: 'manual', extraFiles: ['config/macros.sty', 'config/macros.sty', '../private.sty', 'bad\nname.sty'], autoFileName: 'folder/macros.sty' });
    expect(settings.rootFile).toBeUndefined();
    expect(settings.extraFiles).toEqual(['config/macros.sty']);
    expect(settings.autoFileName).toBe('macros.sty');
    expect(validateSettings({ extraFiles: Array.from({ length: 150 }, (_, i) => 'file' + i + '.sty') }).extraFiles).toHaveLength(100);
  });

  it('prefers a project override and otherwise uses the global defaults', async () => {
    const get = vi.fn(async () => ({ defaults: { ...DEFAULT_SETTINGS, texCompiler: 'lualatex' }, 'project:first': { ...DEFAULT_SETTINGS, previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex' } }));
    vi.stubGlobal('chrome', { storage: { local: { get } } });
    expect(await loadSettings('first')).toMatchObject({ previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex' });
    expect(await loadSettings('second')).toMatchObject({ texCompiler: 'lualatex' });
  });

  it('persists validated settings under only the requested project key', async () => {
    const set = vi.fn(async (_value: unknown) => {});
    vi.stubGlobal('chrome', { storage: { local: { set } } });
    await saveSettings('one', { ...DEFAULT_SETTINGS, previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex', cloudProjectId: 'invalid' });
    expect(set).toHaveBeenCalledWith({ 'project:one': expect.objectContaining({ previewEngine: 'tex', texBackend: 'local', texCompiler: 'xelatex', cloudProjectId: undefined }) });
  });

  it('does not copy a project root or cloud clone identity into global defaults', async () => {
    const set = vi.fn(async (_value: unknown) => {});
    vi.stubGlobal('chrome', { storage: { local: { set } } });
    await saveDefaults({ ...DEFAULT_SETTINGS, rootFile: 'sub/main.tex', previewSources: [{ id: 'file:private-macros.sty', enabled: false }], previewEngine: 'tex', texBackend: 'local', texCompiler: 'lualatex', cloudProjectId: 'abcdef0123456789abcdef01', cloudProjectName: 'Private clone', cloudCompiler: 'xelatex', cloudTexLiveVersion: '2026' });
    const saved = set.mock.calls[0][0] as { defaults: Record<string, unknown> };
    expect(saved.defaults).toMatchObject({ previewEngine: 'tex', texBackend: 'local', texCompiler: 'lualatex' });
    for (const key of ['rootFile', 'previewSources', 'cloudProjectId', 'cloudProjectName', 'cloudCompiler', 'cloudTexLiveVersion']) expect(saved.defaults).not.toHaveProperty(key);
  });

  it('ignores preview source paths found in legacy global defaults', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({ defaults: { previewSources: [{ id: 'file:other-project.sty', enabled: false }] } })) } } });
    expect((await loadSettings('new-project')).previewSources).toBeUndefined();
  });

  it('persists resetting preview sources without retaining stale preferences or changing discovery choices',async()=>{
    const data:Record<string,unknown>={};
    vi.stubGlobal('chrome',{storage:{local:{
      get:vi.fn(async()=>data),
      set:vi.fn(async(values:Record<string,unknown>)=>{Object.assign(data,JSON.parse(JSON.stringify(values)));}),
    }}});
    await saveSettings('reset',{...DEFAULT_SETTINGS,extraFilesMode:'manual',extraFiles:['config/macros.sty'],previewSources:[{id:'file:removed.sty',enabled:false}]});
    const draft=await loadSettings('reset');draft.previewSources=undefined;
    await saveSettings('reset',draft);
    expect(await loadSettings('reset')).toMatchObject({previewSources:undefined,extraFilesMode:'manual',extraFiles:['config/macros.sty']});
    expect(data['project:reset']).not.toHaveProperty('previewSources');
  });
});
