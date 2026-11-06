export interface ProjectFile { id: string; path: string; kind: 'doc' | 'file' }
export interface Diagnostic { level: 'info' | 'warning' | 'error'; message: string; source?: string }
export interface MacroDefinition {
  name: string;
  body: string;
  args: number;
  optionalDefault?: string;
  raw: string;
  kind: string;
  source: string;
  offset: number;
  supported: boolean;
  signature?: string;
}
export interface PackageDeclaration { name: string; options: string[]; source: string }
export interface PreviewSource {
  /** Stable within a project: file:<full relative path> or package:<package name>. */
  id: string;
  kind: 'file' | 'package';
  name: string;
  path?: string;
  /** A local .sty has one file identity, even when loaded as a package. */
  packageName?: string;
  options?: string[];
}
export interface PreviewSourceSetting { id: string; enabled: boolean }
export type PreviewSourceEvent =
  | { sourceId: string; type: 'macro'; macro: MacroDefinition }
  | { sourceId: string; type: 'package'; package: PackageDeclaration };
export interface CommandEntry {
  name: string;
  signature?: string;
  snippet?: string;
  source: string;
  description?: string;
  preview: 'supported' | 'unsupported' | 'unknown';
}
export interface ProjectIndex {
  macros: MacroDefinition[];
  packages: PackageDeclaration[];
  commands: CommandEntry[];
  files: string[];
  diagnostics: Diagnostic[];
  previewSources?: PreviewSource[];
  /** Original declarations, including definitions shadowed in the completion index. */
  previewEvents?: PreviewSourceEvent[];
  /** Present only for an explicitly configured preview load order (low to high). */
  previewSourceOrder?: string[];
}
export interface Settings {
  rootFile?: string;
  extraFilesMode: 'auto' | 'manual' | 'none';
  extraFiles: string[];
  autoFileName: string;
  completion: boolean;
  preview: boolean;
  /** Project-local source choices. Omitted preserves the original dependency order. */
  previewSources?: PreviewSourceSetting[];
  previewEngine: 'mathjax' | 'tex';
  texBackend: 'local' | 'overleaf';
  texCompiler: 'pdflatex' | 'xelatex' | 'lualatex';
  cloudProjectId?: string;
  cloudProjectName?: string;
  cloudCompiler?: 'pdflatex' | 'xelatex' | 'lualatex';
  cloudTexLiveVersion?: string;
}
export const DEFAULT_SETTINGS: Settings = {
  extraFilesMode: 'auto', extraFiles: [], autoFileName: 'macros.sty', completion: true, preview: true,
  previewEngine: 'mathjax', texBackend: 'overleaf', texCompiler: 'pdflatex',
};
export const emptyIndex = (): ProjectIndex => ({ macros: [], packages: [], commands: [], files: [], diagnostics: [] });
