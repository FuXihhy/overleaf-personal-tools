import { describe, expect, it } from 'vitest';
import { translateRuntimeText } from '../src/i18n-runtime';

it.each([
  ['未完成的下标：_', 'Incomplete subscript: _'],
  ['未完成的上标：^', 'Incomplete superscript: ^'],
  ['未完成的分组：缺少右花括号', 'Incomplete group: missing closing brace.'],
  ['未完成的公式结构超过预览限制', 'Incomplete formula structures exceed the preview limit.'],
])('translates partial syntax diagnostics: %s', (source, expected) => {
  expect(translateRuntimeText(source, 'en')).toBe(expected);
  expect(translateRuntimeText(source, 'zh')).toBe(source);
});

describe('runtime presentation translations', () => {
  it.each([
    ['正在连接账号共享预览项目…', 'Connecting the account’s shared preview project…'],
    ['共享预览项目已连接；本账号的其他项目会自动复用。', 'Shared preview project connected. Other projects for this account will reuse it automatically.'],
    ['请先在 Extension 设置中启用共享云端预览项目。', 'Enable the shared cloud preview project in Extension settings first.'],
    ['云端预览锁已失效；旧请求不能继续写入共享项目。', 'The cloud preview lock has expired. Old requests cannot continue writing to the shared project.'],
    ['上次创建共享预览项目的结果尚未确认；请先检查 Overleaf 项目列表，扩展不会自动重复创建。', 'The previous shared preview project creation has an unknown outcome. Check your Overleaf project list first; the extension will not create another project automatically.'],
    ['共享预览项目的所有者与当前账号不匹配；已拒绝写入。', 'The shared preview project owner does not match the current account. The write was rejected.'],
  ])('translates shared cloud state and failure messages: %s', (source, expected) => {
    expect(translateRuntimeText(source, 'en')).toBe(expected);
    expect(translateRuntimeText(source, 'zh')).toBe(source);
    expect(translateRuntimeText('公式预览失败：' + source, 'en')).toBe('Formula preview failed: ' + expected);
  });

  it('preserves Chinese paths in shared workspace conflicts and raw compiler logs', () => {
    const path = '研究/共享预览项目正在编译，请稍后重试。/macros（旧版）.sty';
    const failure = '共享预览项目中的文件未经扩展登记或已被替换，已停止同步：' + path;
    expect(translateRuntimeText(failure, 'en')).toBe('The shared preview project contains an unregistered or replaced file. Synchronization stopped: ' + path);
    expect(translateRuntimeText('预览文件已被替换，已停止清理：' + path, 'en')).toBe('The preview file has been replaced. Cleanup stopped: ' + path);
    const log = '! Custom error\n' + failure + '\n\\text{共享预览项目目录不可用。}\n';
    expect(translateRuntimeText('云端 TeX 编译失败。\n' + log, 'en')).toBe('Cloud TeX compilation failed.\n' + log);
    expect(translateRuntimeText(log, 'en')).toBe(log);
  });

  it('translates lightweight dependency warnings without interpreting file or command arguments', () => {
    const path = '研究/公式预览失败：主文档.tex';
    const reference = String.raw`\目录{共享预览项目目录不可用。}/macros.sty`;
    const source = `无法静态跟踪动态文件引用：${reference}（${path}）；请将其项目文本依赖明确加入额外定义文件。`;
    expect(translateRuntimeText(source, 'en')).toBe(`Could not statically follow the dynamic file reference: ${reference} (${path}). Explicitly add its project text dependencies to Additional definition files.`);
    expect(translateRuntimeText(source, 'zh')).toBe(source);
    expect(translateRuntimeText(`无法静态跟踪文件导入（${path}）：\\subimport；请将依赖加入额外定义文件。`, 'en')).toBe(`Could not statically follow the file import (${path}): \\subimport. Add its dependencies to Additional definition files.`);
    expect(translateRuntimeText('TeX 预览最多同步 200 个依赖文本文件；当前公式依赖超出限制。', 'en')).toBe('TeX previews can synchronize up to 200 dependency text files. The current formula exceeds that limit.');
    const formula = String.raw`\text{正在连接账号共享预览项目…}+V_`;
    expect(translateRuntimeText(formula, 'en')).toBe(formula);
  });

  it('translates the complete binary-resource warning but preserves the resource path', () => {
    const path = '字体/共享预览项目目录不可用。（草稿）.otf（研究/main.tex）';
    expect(translateRuntimeText('轻量 TeX 预览尚不支持同步图片或字体等二进制资源：' + path + '。请使用系统字体或移除公式预览对该资源的依赖。', 'en'))
      .toBe('Lightweight TeX previews do not yet synchronize binary resources such as images or fonts: ' + path + '. Use system fonts or remove this resource dependency from the formula preview.');
    expect(translateRuntimeText('导言区或公式不能再次引用完整主文档：' + path, 'en')).toBe('The preamble or formula cannot include the complete main document again: ' + path);
  });

  it('keeps the original Chinese status and translates the main operation states', () => {
    const status = '正在分析项目宏包与命令…';
    expect(translateRuntimeText(status, 'zh')).toBe(status);
    expect(translateRuntimeText(status, 'en')).toBe('Analyzing project packages and commands…');
    expect(translateRuntimeText('本机 TeX 沙盒可用。', 'en')).toBe('The local TeX sandbox is available.');
    expect(translateRuntimeText('Overleaf 正在编译当前公式…', 'en')).toBe('Overleaf is compiling the current formula…');
    expect(translateRuntimeText('云端 TeX 编译超时。', 'en')).toBe('Cloud TeX compilation timed out.');
  });

  it('preserves interpolated counts and wraps project read failures without altering paths', () => {
    expect(translateRuntimeText('已更新：123 个命令，17 个宏包。', 'en')).toBe('Updated: 123 commands, 17 packages.');
    const path = '研究/公式预览失败：\\alpha {draft}.sty';
    expect(translateRuntimeText('项目读取失败：无法读取项目文件：' + path, 'en'))
      .toBe('Could not read the project: Could not read the project file: ' + path);
    expect(translateRuntimeText('项目读取失败：无法读取项目源码（HTTP 403）。请确认已登录并具有项目读取权限。', 'en'))
      .toContain('(HTTP 403)');
  });

  it('keeps custom commands, package options and source details opaque', () => {
    const details = 'NewDocumentCommand，研究/macros（旧版）.sty';
    expect(translateRuntimeText(`暂不支持预览自定义命令 \\myPair（${details}）；请查看编译后的 PDF。`, 'en'))
      .toBe(`Previewing custom command \\myPair is not supported yet (${details}). See the compiled PDF.`);
    expect(translateRuntimeText('physics 的预览尚不支持选项 a、b=\\alpha；请查看 PDF。', 'en'))
      .toBe('The physics preview does not support these options yet: a、b=\\alpha. See the PDF.');
  });

  it('translates local connection wrappers while preserving browser error details', () => {
    const reason = 'Specified native messaging host not found. /Users/名字/host.py';
    expect(translateRuntimeText(`无法连接本机 TeX 辅助程序：${reason}`, 'en'))
      .toBe(`Could not connect to the local TeX helper: ${reason}`);
    expect(translateRuntimeText('无法连接扩展的本机 TeX 服务。请重新加载扩展与 Overleaf 页面（本机 TeX 服务响应超时）', 'en'))
      .toContain('(The local TeX service timed out)');
  });

  it('translates only the owned compiler failure heading and preserves the raw log exactly', () => {
    const log = '! Undefined control sequence.\r\nl.12 \\我的命令{正在读取项目文件…}\n公式预览失败：用户正文\n';
    const failure = 'TeX 编译失败（退出码 1）：\n' + log;
    expect(translateRuntimeText(failure, 'en')).toBe('TeX compilation failed (exit code 1):\n' + log);
    expect(translateRuntimeText('所选预览引擎未能生成结果：' + failure, 'en'))
      .toBe('The selected preview engine could not produce a result: TeX compilation failed (exit code 1):\n' + log);
    expect(translateRuntimeText('Overleaf 没有生成预览 PDF。\n' + log, 'en'))
      .toBe('Overleaf did not generate a preview PDF.\n' + log);
    expect(translateRuntimeText(log, 'en')).toBe(log);
  });

  it('leaves unknown messages, project names, formulas and partial matches unchanged', () => {
    for (const text of ['新版本增加的状态。', 'My project: 研究与几何', '\\text{正在读取项目文件…}+\\alpha',
      'prefix 正在读取项目文件…', '已更新：12 个命令，3 个宏包。 extra', '已更新：12 个命令，3 个宏包。\n', '__proto__', 'constructor', '']) {
      expect(translateRuntimeText(text, 'en')).toBe(text);
      expect(translateRuntimeText(text, 'zh')).toBe(text);
    }
  });

  it('translates preview source indexing and command diagnostics without rewriting command names', () => {
    const duplicate=String.raw`预览来源重复声明 \my@command；MathJax 使用后面的定义，TeX 保留原声明并可能报告重复定义错误。`;
    expect(translateRuntimeText(duplicate,'en')).toBe(String.raw`Preview sources declare \my@command more than once. MathJax uses the later definition; TeX preserves the original declarations and may report a duplicate definition error.`);
    expect(translateRuntimeText(duplicate,'zh')).toBe(duplicate);
    const dependency=String.raw`预览命令 \show 引用了未启用来源中的 \alpha；将由渲染器检查是否存在同名内置或宏包命令。`;
    expect(translateRuntimeText(dependency,'en')).toBe(String.raw`Preview command \show references \alpha from a disabled source. The renderer will check for an available built-in or package command with that name.`);
    expect(translateRuntimeText(String.raw`预览宏存在循环依赖或超过依赖深度上限：\cycle@name`,'en')).toBe(String.raw`The preview macro has a circular dependency or exceeds the dependency depth limit: \cycle@name`);
    expect(translateRuntimeText('当前索引缺少预览来源信息；请刷新项目后再调整预览来源。','en')).toBe('The index has no preview source information. Refresh the project before changing preview sources.');
    expect(translateRuntimeText('预览来源按指定顺序各加载一次；TeX 保留原始声明语义，重复 newcommand 或依赖顺序冲突会报告编译错误。','en')).toBe('Preview sources are loaded once in the selected order. TeX preserves the original declarations; duplicate newcommand definitions or dependency order conflicts may cause compilation errors.');
  });

  it.each([
    ['存在循环文件引用或依赖深度超过上限','a circular file reference or excessive dependency depth was found'],
    ['找不到来源文本','the source text is unavailable'],
    ['来源包含完整文档或条件文档边界','the source contains a complete document or a conditional document boundary'],
    ['宏定义内部动态加载了文件或宏包','a macro definition dynamically loads files or packages'],
    ['宏包声明无法静态解析','a package declaration cannot be resolved statically'],
    ['宏包名称包含动态内容','a package name contains dynamic content'],
    ['文件引用无法静态解析','a file reference cannot be resolved statically'],
    ['含有条件、动态或未解析的加载/定义','the source contains conditional, dynamic or unresolved loading commands or definitions'],
  ])('translates the owned source control reason %s while preserving its path', (reason,englishReason) => {
    const path='研究/公式预览失败：（旧版）：notation.sty';
    const source=`无法安全应用自定义预览来源（${path}）：${reason}。请恢复默认来源顺序，或把相关加载/定义改为明确的顶层声明。`;
    const expected=`Custom preview sources cannot be applied safely (${path}): ${englishReason}. Restore the default source order, or use explicit top-level loading commands and definitions.`;
    expect(translateRuntimeText(source,'en')).toBe(expected);
    expect(translateRuntimeText('所选预览引擎未能生成结果：'+source,'en')).toBe('The selected preview engine could not produce a result: '+expected);
    expect(translateRuntimeText(source,'zh')).toBe(source);
  });

  it('preserves dynamic source references, unknown reasons and compiler logs containing source diagnostics', () => {
    const path='研究/main.tex';
    const reference=String.raw`\动态目录{公式预览失败：用户内容}/macros.sty`;
    const suffix='。请恢复默认来源顺序，或把相关加载/定义改为明确的顶层声明。';
    const prefix=`无法安全应用自定义预览来源（${path}）：`;
    expect(translateRuntimeText(prefix+'文件引用不在项目文本中或包含动态内容：'+reference+suffix,'en')).toBe(`Custom preview sources cannot be applied safely (${path}): the file reference is missing from the project text or contains dynamic content: ${reference}. Restore the default source order, or use explicit top-level loading commands and definitions.`);
    expect(translateRuntimeText(prefix+'宏包名称不能静态表示：'+reference+suffix,'en')).toBe(`Custom preview sources cannot be applied safely (${path}): the package name cannot be represented statically: ${reference}. Restore the default source order, or use explicit top-level loading commands and definitions.`);
    const unknown=prefix+'用户自己的未识别说明'+suffix;
    expect(translateRuntimeText(unknown,'en')).toBe(unknown);
    const diagnostic=prefix+'找不到来源文本'+suffix;
    const log='! Custom compiler message\r\n'+diagnostic+'\n预览宏存在循环依赖或超过依赖深度上限：\\foo\n';
    expect(translateRuntimeText('TeX 编译失败（退出码 1）：\n'+log,'en')).toBe('TeX compilation failed (exit code 1):\n'+log);
  });

  it('translates math font diagnostics while preserving control sequences and font identifiers',()=>{
    expect(translateRuntimeText('无法解析数学字体声明的命令名。','en')).toBe('Could not parse the command name in the math font declaration.');
    expect(translateRuntimeText(String.raw`无法完整解析数学字体声明：\mathCustom`,'en')).toBe(String.raw`Could not fully parse the math font declaration: \mathCustom`);
    const source=String.raw`数学字体声明 \mathCustom（U/研究字体/b/n）尚无可靠的 MathJax 适配，请使用 TeX 预览。`;
    expect(translateRuntimeText(source,'en')).toBe(String.raw`Math font declaration \mathCustom (U/研究字体/b/n) does not yet have reliable MathJax support. Use a TeX preview.`);
    expect(translateRuntimeText(source,'zh')).toBe(source);
  });
});
