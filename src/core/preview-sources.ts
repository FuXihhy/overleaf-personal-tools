import type { MacroDefinition, PreviewSource, PreviewSourceSetting, ProjectIndex, Settings } from './types';

export type ConfiguredPreviewSource = PreviewSource & { enabled: boolean };

export function validPreviewSourceId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 520) return false;
  if (value.startsWith('package:')) return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value.slice(8)) && !value.includes('..');
  if (!value.startsWith('file:')) return false;
  const path = value.slice(5);
  return !!path && !path.startsWith('/') && !/[\\\u0000-\u001f\u007f:]/u.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}

export function validatePreviewSourceSettings(value: unknown): PreviewSourceSetting[] | undefined {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  const result: PreviewSourceSetting[] = [];
  for (const item of value.slice(0, 500)) {
    if (!item || typeof item !== 'object' || !validPreviewSourceId(item.id) || typeof item.enabled !== 'boolean' || seen.has(item.id)) continue;
    seen.add(item.id); result.push({ id: item.id, enabled: item.enabled });
  }
  return result.length ? result : undefined;
}

/** Saved order first; newly discovered sources append enabled in discovery order. */
export function getPreviewSources(index: ProjectIndex, settings: Pick<Settings, 'previewSources'>): ConfiguredPreviewSource[] {
  const catalog = new Map((index.previewSources ?? []).map(source => [source.id, source]));
  const result: ConfiguredPreviewSource[] = [];
  for (const setting of settings.previewSources ?? []) {
    const source = catalog.get(setting.id);
    if (!source) continue;
    result.push({ ...source, enabled: setting.enabled }); catalog.delete(setting.id);
  }
  for (const source of catalog.values()) result.push({ ...source, enabled: true });
  return result;
}

/** Disabling a source alone must not regroup interleaved main/include declarations. */
export function previewSourcesReordered(index: ProjectIndex, settings: Pick<Settings, 'previewSources'>): boolean {
  const selected = getPreviewSources(index, settings).filter(source => source.enabled).map(source => source.id);
  const enabled = new Set(selected);
  const natural = (index.previewSources ?? []).filter(source => enabled.has(source.id)).map(source => source.id);
  return selected.some((id, position) => id !== natural[position]);
}

/** Replay source definitions for preview only. Completion remains the original index. */
export function applyPreviewSources(index: ProjectIndex, settings: Pick<Settings, 'previewSources'>): ProjectIndex {
  if (!settings.previewSources?.length) return index;
  const sources = getPreviewSources(index, settings).filter(source => source.enabled);
  const reordered = previewSourcesReordered(index, settings);
  const diagnostics = [...index.diagnostics];
  const warn = (message: string, source?: string) => diagnostics.push({ level: 'warning' as const, message, ...(source ? { source } : {}) });
  if (!index.previewEvents) {
    warn('当前索引缺少预览来源信息；请刷新项目后再调整预览来源。');
    return { ...index, macros: [], packages: [], diagnostics, previewSourceOrder: [] };
  }
  const macros = new Map<string, MacroDefinition>();
  const packages: ProjectIndex['packages'] = [];
  const packageNames = new Set<string>();
  const knownMacros = new Set(index.previewEvents.filter(event => event.type === 'macro').map(event => event.macro.name));
  const enabled = new Set(sources.map(source => source.id));
  const events = reordered ? sources.flatMap(source => index.previewEvents!.filter(event => event.sourceId === source.id))
    : index.previewEvents.filter(event => enabled.has(event.sourceId));
  const seenDefinitions = new Set<string>();
  for (const event of events) {
      if (event.type === 'package') {
        if (!packageNames.has(event.package.name)) {
          packages.push({ ...event.package, options: [...event.package.options] }); packageNames.add(event.package.name);
        }
        continue;
      }
      // A custom source order loads a file once, even if the original used repeated input.
      const definitionKey = event.sourceId + ':' + event.macro.offset;
      if (reordered && seenDefinitions.has(definitionKey)) continue;
      seenDefinitions.add(definitionKey);
      let macro = { ...event.macro };
      if ((macro.kind === 'providecommand' || macro.kind === 'ProvideDocumentCommand') && macros.has(macro.name)) continue;
      if (macro.kind === 'let') {
        const target = /^\\([A-Za-z@]+|.)$/.exec(macro.body)?.[1];
        const captured = target && macros.get(target);
        if (captured) macro = { ...macro, body: captured.body, args: captured.args, optionalDefault: captured.optionalDefault, supported: captured.supported,
          signature: captured.signature?.replace('\\' + captured.name, '\\' + macro.name) };
        else macro.supported = false;
      }
      if ((macro.kind === 'newcommand' || macro.kind === 'NewDocumentCommand') && macros.has(macro.name)) {
        warn('预览来源重复声明 \\' + macro.name + '；MathJax 使用后面的定义，TeX 保留原声明并可能报告重复定义错误。', macro.source);
      }
      macros.delete(macro.name); macros.set(macro.name, macro);
  }
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const reported = new Set<string>();
  const check = (name: string): boolean => {
    const macro = macros.get(name)!;
    if (resolved.has(name)) return macro.supported;
    if (visiting.has(name) || visiting.size >= 64) {
      if (!reported.has(name)) { warn('预览宏存在循环依赖或超过依赖深度上限：\\' + name, macro.source); reported.add(name); }
      macro.supported = false; return false;
    }
    visiting.add(name);
    for (const match of (macro.body + ' ' + (macro.optionalDefault ?? '')).matchAll(/\\([A-Za-z@]+)/g)) {
      const dependency = match[1];
      if (macros.has(dependency)) { if (!check(dependency)) macro.supported = false; }
      else if (knownMacros.has(dependency)) {
        if (!reported.has(dependency)) { warn('预览命令 \\' + macro.name + ' 引用了未启用来源中的 \\' + dependency + '；将由渲染器检查是否存在同名内置或宏包命令。', macro.source); reported.add(dependency); }
      }
    }
    visiting.delete(name); resolved.add(name);
    return macro.supported;
  };
  for (const name of macros.keys()) check(name);
  return { ...index, macros: [...macros.values()], packages, diagnostics, previewSources: sources.map(({ enabled: _, ...source }) => source), previewSourceOrder: reordered ? sources.map(source => source.id) : undefined };
}
