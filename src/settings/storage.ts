import { DEFAULT_SETTINGS, type Settings } from '../core/types';
import { validatePreviewSourceSettings } from '../core/preview-sources';

export function validateSettings(value: unknown): Settings {
  const s = (value && typeof value === 'object' ? value : {}) as Partial<Settings>;
  const path = (v: unknown): v is string => typeof v === 'string' && v.length <= 512 && !v.includes('..') && !v.startsWith('/') && !/[\0\r\n]/.test(v);
  return {
    ...DEFAULT_SETTINGS,
    rootFile: path(s.rootFile) ? s.rootFile : undefined,
    extraFilesMode: ['auto','manual','none'].includes(s.extraFilesMode || '') ? s.extraFilesMode! : 'auto',
    extraFiles: Array.isArray(s.extraFiles) ? [...new Set(s.extraFiles.filter(path))].slice(0,100) : [],
    autoFileName: typeof s.autoFileName === 'string' && /^[^/\\\0\r\n]{1,128}$/.test(s.autoFileName) ? s.autoFileName : 'macros.sty',
    completion: typeof s.completion === 'boolean' ? s.completion : true,
    preview: typeof s.preview === 'boolean' ? s.preview : true,
    previewSources: validatePreviewSourceSettings(s.previewSources),
    previewEngine: s.previewEngine === 'tex' ? 'tex' : 'mathjax',
    texBackend: s.texBackend === 'local' ? 'local' : 'overleaf',
    texCompiler: ['pdflatex','xelatex','lualatex'].includes(s.texCompiler||'') ? s.texCompiler! : 'pdflatex',
    cloudProjectId: typeof s.cloudProjectId==='string' && /^[a-f0-9]{24}$/.test(s.cloudProjectId) ? s.cloudProjectId : undefined,
    cloudProjectName: typeof s.cloudProjectName==='string' ? s.cloudProjectName.slice(0,200) : undefined,
    cloudCompiler: ['pdflatex','xelatex','lualatex'].includes(s.cloudCompiler||'') ? s.cloudCompiler : undefined,
    cloudTexLiveVersion: typeof s.cloudTexLiveVersion==='string' && /^\d{4}$/.test(s.cloudTexLiveVersion) ? s.cloudTexLiveVersion : undefined,
  };
}
export async function loadSettings(projectId: string): Promise<Settings> {
  const key = 'project:' + projectId;
  const data = await chrome.storage.local.get(['defaults',key]);
  if (data[key]) return validateSettings(data[key]);
  // Source IDs contain project paths and must never leak through old saved defaults.
  return validateSettings({ ...(data.defaults ?? {}), previewSources: undefined });
}
export async function saveSettings(projectId: string, settings: Settings): Promise<void> {
  await chrome.storage.local.set({ ['project:' + projectId]: validateSettings(settings) });
}
export async function saveDefaults(settings: Settings): Promise<void> {
  const { rootFile: _, previewSources: _sources, cloudProjectId: _id, cloudProjectName: _name, cloudCompiler: _compiler, cloudTexLiveVersion: _version, ...defaults } = validateSettings(settings);
  await chrome.storage.local.set({ defaults });
}
