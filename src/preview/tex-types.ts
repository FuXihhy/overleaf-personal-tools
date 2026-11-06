export interface TexSourceFile { path: string; content: string }
export interface TexDocument { files: TexSourceFile[]; entryPath: string; diagnostics: string[] }
export interface TexRenderRequest {
  version: 1;
  op: 'render';
  id: string;
  compiler: 'pdflatex' | 'xelatex' | 'lualatex';
  document: TexDocument;
}
export interface TexRenderResult { id?: string; pdfBase64?: string; diagnostics: string[]; elapsedMs?: number }
export interface TexHostStatus { available: boolean; version?: string; compilers?: string[]; sandbox?: boolean; message: string }
