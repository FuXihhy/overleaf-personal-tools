import type { CommandEntry, Diagnostic, ProjectIndex } from '../core/types';

/** A deliberately finite catalog: these are editor hints, not a TeX package loader. */
interface PackageCommand {
  name: string;
  args?: string[];
  optional?: string;
  description: string;
}

const command = (name: string, args: string[] = [], description = '', optional?: string): PackageCommand =>
  ({ name, args, description, optional });

const physics: PackageCommand[] = [
  command('dv', ['f', 'x'], '普通导数；可用 * 输出行内分式', 'order'),
  command('pdv', ['f', 'x'], '偏导数；支持高阶及混合偏导', 'order'),
  command('fdv', ['F', 'f'], '泛函导数', 'order'),
  command('dd', ['x'], '微分', 'order'),
  command('var', ['x'], '变分', 'order'),
  command('qty', ['expression'], '自动调整大小的括号；也接受 (...)、[...]、|...|'),
  ...['pqty', 'bqty', 'Bqty', 'vqty', 'abs', 'norm', 'order'].map(name => command(name, ['expression'], '自动调整大小的定界符')),
  ...['vb', 'va', 'vu'].map(name => command(name, ['v'], '向量记号；可用 * 处理希腊字母')),
  ...['grad', 'div', 'curl', 'laplacian'].map(name => command(name, [], '向量微分算符')),
  command('vnabla', [], '向量 nabla'),
  command('vdot', [], '向量点积'),
  command('cp', [], '向量叉积'),
  command('bra', ['psi'], 'Dirac bra'),
  command('ket', ['psi'], 'Dirac ket'),
  command('braket', ['phi', 'psi'], '内积；单参数形式用于范数'),
  command('ketbra', ['psi', 'phi'], '外积'),
  command('expval', ['A'], '期望值；可追加态参数'),
  command('mel', ['phi', 'A', 'psi'], '矩阵元'),
  ...['comm', 'acomm', 'pb'].map(name => command(name, ['A', 'B'], '对易子、反对易子或 Poisson 括号')),
  command('eval', ['expression'], '求值记号；之后可接上下标'),
  ...['mqty', 'pmqty', 'bmqty', 'vmqty', 'smqty'].map(name => command(name, ['a & b \\\\ c & d'], '矩阵')),
  command('imat', ['n'], '单位矩阵（预览最多 32 行）'),
  command('zmat', ['rows', 'columns'], '零矩阵（预览每维最多 32）'),
  command('xmat', ['x', 'rows', 'columns'], '重复元素矩阵（预览每维最多 32）'),
  command('pmat', ['0'], 'Pauli 矩阵，参数 0、1、2、3'),
  command('dmat', ['a,b,c'], '对角矩阵'),
  command('admat', ['a,b,c'], '反对角矩阵'),
  command('flatfrac', ['a', 'b'], '行内斜线分式'),
  command('qq', ['text'], '带间距的公式内文本'),
  ...['tr', 'Tr', 'rank', 'Res', 'pv', 'PV', 'Re', 'Im'].map(name => command(name, [], 'physics 运算符')),
  ...['qif', 'qthen', 'qelse', 'qotherwise', 'qgiven', 'qsince', 'qfor', 'qall', 'qand', 'qor', 'qc', 'qcc'].map(name => command(name, [], 'physics 公式内文本')),
];

const aliases: Record<string, string[]> = {
  dv: ['derivative'], pdv: ['partialderivative', 'pderivative'], fdv: ['functionalderivative', 'fderivative'],
  dd: ['differential'], var: ['variation'], qty: ['quantity'], abs: ['absolutevalue'],
  vb: ['vectorbold'], va: ['vectorarrow'], vu: ['vectorunit'], grad: ['gradient'],
  div: ['divergence'], vdot: ['dotproduct'], cp: ['cross', 'crossproduct'],
  braket: ['innerproduct', 'ip'], ketbra: ['outerproduct', 'dyad', 'op'],
  expval: ['expectationvalue', 'ev'], mel: ['matrixelement', 'matrixel'],
  comm: ['commutator'], acomm: ['anticommutator'], pb: ['poissonbracket'], eval: ['evaluated'],
  mqty: ['matrixquantity'], smqty: ['smallmatrixquantity'], imat: ['identitymatrix'],
  zmat: ['zeromatrix'], xmat: ['xmatrix'], pmat: ['paulimatrix'], dmat: ['diagonalmatrix'],
  admat: ['antidiagonalmatrix'], qq: ['qqtext'],
};
for (const entry of [...physics]) {
  for (const name of aliases[entry.name] ?? []) physics.push({ ...entry, name });
}

const ams: PackageCommand[] = [
  ...['dfrac', 'tfrac', 'binom', 'dbinom', 'tbinom'].map(name => command(name, ['a', 'b'], 'AMS 分式或二项式')),
  command('operatorname', ['name'], '正体数学算符'),
  command('DeclareMathOperator', ['\\Op', 'Op'], '定义数学算符'),
  command('overset', ['above', 'base'], '上方标注'),
  command('underset', ['below', 'base'], '下方标注'),
  command('substack', ['a \\\\ b'], '多行上下标'),
  command('boxed', ['expression'], '公式方框'),
  command('boldsymbol', ['symbol'], '加粗数学符号'),
];

const mathtools: PackageCommand[] = [
  ...ams,
  command('coloneqq', [], '定义等号'), command('eqqcolon', [], '反向定义等号'),
  ...['mathclap', 'mathllap', 'mathrlap'].map(name => command(name, ['expression'], '零宽数学盒')),
  command('prescript', ['sup', 'sub', 'symbol'], '左侧上下标'),
  command('xrightarrow', ['label'], '带文字的右箭头'),
  command('xleftarrow', ['label'], '带文字的左箭头'),
  command('underbracket', ['expression'], '下方方括号'),
  command('overbracket', ['expression'], '上方方括号'),
  command('DeclarePairedDelimiter', ['\\delim', '\\langle', '\\rangle'], '定义成对定界符'),
];

const fontCommands = [command('mathbb', ['R'], 'AMS 黑板粗体'), command('mathfrak', ['g'], 'Fraktur 字体')];

export const PACKAGE_CATALOG: Readonly<Record<string, readonly PackageCommand[]>> = {
  physics, amsmath: ams, amssymb: fontCommands, amsfonts: fontCommands, mathtools,
  bm: [command('bm', ['symbol'], '预览按 boldsymbol 渲染；复杂字体细节以 PDF 为准')],
  cancel: ['cancel', 'bcancel', 'xcancel'].map(name => command(name, ['expression'], '删除线')),
  braket: ['bra', 'ket', 'braket', 'Bra', 'Ket', 'Braket', 'set', 'Set'].map(name => command(name, ['expression'], 'braket 宏包定界符')),
};

const NON_MATH_PACKAGES = new Set([
  'geometry', 'graphicx', 'graphics', 'hyperref', 'cleveref', 'url', 'xurl', 'bookmark', 'fontenc', 'inputenc',
  'babel', 'polyglossia', 'microtype', 'setspace', 'parskip', 'fancyhdr', 'fancyvrb', 'titlesec', 'titling',
  'tocloft', 'caption', 'subcaption', 'subfig', 'float', 'placeins', 'booktabs', 'longtable', 'tabularx', 'array',
  'multirow', 'multicol', 'enumitem', 'listings', 'minted', 'verbatim', 'csquotes', 'natbib', 'biblatex',
  'amsthm', 'ntheorem', 'thmtools', 'thm-restate', 'etoolbox', 'xparse', 'expl3', 'xifthen', 'ifthen', 'xspace',
  'import', 'subfiles', 'standalone', 'abstract', 'appendix', 'authblk', 'datetime', 'ulem', 'todonotes',
]);
const UNSUPPORTED_MATH_PACKAGES = new Set([
  'bbm', 'bbold', 'dsfont', 'slashed', 'siunitx', 'physics2', 'unicode-math', 'mathspec', 'fontspec',
  'tensor', 'stackengine', 'scalerel', 'mathrsfs', 'euscript', 'mathabx', 'tikz', 'tikz-cd', 'pgfplots', 'feynmp', 'feynmp-auto',
]);
const DIAGNOSTIC_SOURCE = 'preview-packages';

export function packageNames(index: ProjectIndex): Set<string> {
  return new Set(index.packages.map(pkg => pkg.name.replace(/\.sty$/i, '').trim()));
}

export function hasQtyConflict(index: ProjectIndex): boolean {
  const names = packageNames(index);
  return names.has('physics') && names.has('siunitx') && !index.macros.some(macro => macro.name.replace(/^\\/, '') === 'qty');
}

function asCompletion(entry: PackageCommand, name: string): CommandEntry {
  const args = entry.args ?? [];
  const placeholder = (arg: string, index: number) => (/[{}$]/.test(arg) ? `arg${index + 1}` : arg)
    .replace(/\\/g, character => character + character);
  return {
    name: entry.name,
    signature: `\\${entry.name}${entry.optional ? `[${entry.optional}]` : ''}${args.map(arg => `{${arg}}`).join('')}`,
    // Optional arguments stay optional: suggestions insert the common form.
    snippet: `\\${entry.name}${args.map((arg, i) => `{\${${i + 1}:${placeholder(arg, i)}}}`).join('')}`,
    source: `package:${name}`,
    description: entry.description,
    preview: 'supported',
  };
}

/** Merge package completions without replacing the user's own definitions. Pure and idempotent. */
export function enrichIndex(index: ProjectIndex): ProjectIndex {
  const names = packageNames(index);
  const diagnostics: Diagnostic[] = index.diagnostics.filter(item => item.source !== DIAGNOSTIC_SOURCE);
  const commands = new Map<string, CommandEntry>();
  for (const name of names) {
    for (const entry of PACKAGE_CATALOG[name] ?? []) commands.set(entry.name, asCompletion(entry, name));
  }
  const localPackages = new Set(index.files.filter(path => /\.sty$/i.test(path)).flatMap(path => [
    path.replace(/\.sty$/i, ''), path.split('/').pop()!.replace(/\.sty$/i, ''),
  ]));
  const unknown: string[] = [];
  for (const name of names) {
    if (PACKAGE_CATALOG[name] || NON_MATH_PACKAGES.has(name) || localPackages.has(name)) continue;
    if (UNSUPPORTED_MATH_PACKAGES.has(name)) {
      diagnostics.push({ level: 'warning', source: DIAGNOSTIC_SOURCE,
        message: `${name} 尚无完整公式预览适配；其中专用命令或字体以编译后的 PDF 为准。` });
    } else unknown.push(name);
  }
  if (unknown.length) diagnostics.push({ level: 'info', source: DIAGNOSTIC_SOURCE,
    message: `未内置这些宏包的补全/预览目录：${unknown.join('、')}。可继续读取它们在项目中的宏定义。` });
  const physicsDeclaration = index.packages.filter(pkg => pkg.name === 'physics');
  const unsupportedPhysicsOptions = [...new Set(physicsDeclaration.flatMap(pkg => pkg.options))]
    .filter(option => !['italicdiff', 'arrowdel'].includes(option));
  if (unsupportedPhysicsOptions.length) diagnostics.push({ level: 'warning', source: DIAGNOSTIC_SOURCE,
    message: `physics 预览不支持选项 ${unsupportedPhysicsOptions.join('、')}；相关公式不会伪装成已正确适配。` });
  if (hasQtyConflict(index)) {
    diagnostics.push({ level: 'warning', source: DIAGNOSTIC_SOURCE,
      message: 'physics 与 siunitx 都使用 \\qty；需明确命令归属后才能预览使用它的公式。' });
    const qty = commands.get('qty');
    if (qty) commands.set('qty', { ...qty, preview: 'unsupported' });
  }
  for (const entry of index.commands) {
    if (!entry.source.startsWith('package:')) commands.set(entry.name.replace(/^\\/, ''), entry);
  }
  // If the caller only supplied macros, they still override the package hints.
  for (const macro of index.macros) {
    const name = macro.name.replace(/^\\/, '');
    if (!commands.has(name) || commands.get(name)!.source.startsWith('package:')) {
      commands.set(name, {
        name, source: macro.source, signature: macro.signature,
        snippet: `\\${name}${Array.from({ length: Math.max(0, Math.min(9, macro.args - (macro.optionalDefault !== undefined ? 1 : 0))) }, (_, i) => `{\${${i + 1}:arg${i + 1}}}`).join('')}`,
        description: '项目自定义命令', preview: macro.supported ? 'supported' : 'unsupported',
      });
    }
  }
  return { ...index, commands: [...commands.values()], diagnostics };
}
