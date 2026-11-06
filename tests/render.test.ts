import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, emptyIndex, type MacroDefinition, type ProjectIndex } from '../src/core/types';
import { buildProjectIndex } from '../src/core/project-index';
import { renderFormula, RENDER_LIMITS } from '../src/preview/render';

function macro(name: string, body: string, args = 0, extra: Partial<MacroDefinition> = {}): MacroDefinition {
  return { name, body, args, raw: '', kind: 'newcommand', source: 'macros.sty', offset: 0, supported: true, ...extra };
}
function project(macros: MacroDefinition[] = [], packages: string[] = []): ProjectIndex {
  return { ...emptyIndex(), macros, packages: packages.map(name => ({ name, options: [], source: 'main.tex' })) };
}
function glyphs(svg: string): string[] {
  return [...svg.matchAll(/data-c="([0-9A-F]+)"/g)].map(match => match[1]);
}

describe('isolated formula renderer', () => {
  it.each(['\\missing+x', 'x+\\missing+y', 'x+\\missing'])('marks an unknown command red without discarding the surrounding formula: %s', async expression => {
    const result = await renderFormula(expression, project(), false, { tolerant: true });
    expect(result.svg).toContain('data-mml-node="mtext"');
    expect(result.svg).toContain('#c62828');
    expect(glyphs(result.svg)).toContain('1D465'); // x remains an ordinary math glyph.
    expect(result.unresolvedCommands).toEqual(['missing']);
    expect(result.fallbackText).toBeUndefined();
    expect(result.svg).not.toContain('merror');
    expect(result.svg).not.toContain('Undefined');
    expect((await renderFormula(expression, project(), false)).svg).toBe('');
  });

  it('retains fractions, known macro expansions and multiple unknown commands in tolerant mode', async () => {
    const index = project([macro('Wrapped', '\\frac{#1+\\innerMissing}{2}', 1)]);
    const result = await renderFormula('\\outerMissing+\\Wrapped{x}+\\outerMissing+\\otherMissing', index, false, { tolerant: true });
    expect(result.svg).toContain('data-mml-node="mfrac"');
    expect(result.unresolvedCommands).toEqual(['outerMissing', 'innerMissing', 'otherMissing']);
    expect(result.diagnostics).toHaveLength(3);
    expect([...result.svg.matchAll(/data-mml-node="mtext"/g)]).toHaveLength(4);
  });

  it('locally marks unsupported definitions and qty conflicts without consuming their arguments', async () => {
    const index = project([macro('bad', '\\iftrue #1\\fi', 1, { supported: false })], ['physics', 'siunitx']);
    const result = await renderFormula('\\bad{x}+\\qty{y}+\\frac{a}{b}', index, false, { tolerant: true });
    expect(result.unresolvedCommands).toEqual(['bad', 'qty']);
    expect(result.svg).toContain('data-mml-node="mfrac"');
    expect(glyphs(result.svg)).toEqual(expect.arrayContaining(['1D465', '1D466']));
    // An unsupported replacement of a built-in must not quietly regain the
    // built-in meaning, and a fresh instance must not inherit that placeholder.
    const blockedFraction = project([macro('frac', '\\iftrue x\\fi', 0, { supported: false })]);
    const blocked = await renderFormula('\\frac{x}{y}', blockedFraction, false, { tolerant: true });
    expect(blocked.unresolvedCommands).toEqual(['frac']);
    expect(blocked.svg).not.toContain('data-mml-node="mfrac"');
    expect((await renderFormula('\\frac{x}{y}', project(), false)).svg).toContain('data-mml-node="mfrac"');
  });

  it.each(['\\frac{x}', '\\sqrt{', '\\left(x'])('returns bounded original text for syntax without a safe local recovery: %s', async expression => {
    const result = await renderFormula(expression, project(), false, { tolerant: true });
    expect(result.svg).toBe('');
    expect(result.fallbackText).toBe(expression);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect((await renderFormula(expression, project(), false)).fallbackText).toBeUndefined();
  });

  it('keeps tolerant markup inert and exposes incomplete source only as plain-text metadata', async () => {
    const result = await renderFormula('\\unknown{<script>alert(1)</script>}+\\frac{x}{y}', project(), false, { tolerant: true });
    expect(result.svg).toContain('data-mml-node="mfrac"');
    expect(result.svg).not.toMatch(/<script|<img|onerror=|href=/i);
    const raw = '\\frac{<img src=x onerror=alert(1)>';
    const draft = await renderFormula(raw, project(), false, { tolerant: true });
    expect(draft.svg).toBe('');
    expect(draft.fallbackText).toBe(raw);
  });

  it('preserves hard resource and recursion limits in tolerant mode', async () => {
    for (const [expression, index] of [
      ['x'.repeat(RENDER_LIMITS.formula + 1), project()],
      ['\\loop', project([macro('loop', '\\loop')])],
      ['\\imat{100000}', project([], ['physics'])],
      ['\\' + 'a'.repeat(RENDER_LIMITS.placeholderCharacters), project()],
    ] as const) {
      const result = await renderFormula(expression, index, false, { tolerant: true });
      expect(result.svg).toBe('');
      expect(result.fallbackText).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['\\ensuremath{\\mathbb{R}}', '\\mathbb{R}'],
    ['\\ensuremath\\alpha+b', '\\alpha+b'],
    ['\\frac{\\ensuremath{x+y}}{z}', '\\frac{x+y}{z}'],
    ['\\ensuremath{\\ensuremath{\\mathbf{x}}}', '\\mathbf{x}'],
    ['a\\ensuremath{=}b', 'a=b'],
    ['\\ensuremath{ab}^2', 'ab^2'],
    ['\\ensuremath{{\\bf x}}y', '{\\bf x}y'],
  ])('supports ensuremath with LaTeX math-mode grouping and spacing: %s', async (expression, expanded) => {
    const result = await renderFormula(expression, project(), false);
    const expected = await renderFormula(expanded, project(), false);
    expect(result.diagnostics).toEqual([]);
    expect(expected.diagnostics).toEqual([]);
    // Compare layout too: glyph-only checks miss changed atom spacing, font
    // scope and the difference between ab^2 and {ab}^2.
    expect(result.svg).toBe(expected.svg);
  });

  it('supports ensuremath through nested project macros and preserves custom overrides', async () => {
    const index = project([
      macro('RR', '\\ensuremath{\\mathbb{R}}'),
      macro('Space', '\\ensuremath{\\RR^{#1}}', 1),
      macro('Form', '\\frac{\\Space{#1}}{\\ensuremath{1+\\alpha}}', 1),
    ]);
    const result = await renderFormula('\\Form{n}', index, true);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toBe((await renderFormula('\\frac{\\mathbb{R}^{n}}{1+\\alpha}', project(), true)).svg);
    const overridden = await renderFormula('\\ensuremath{x}', project([macro('ensuremath', '\\mathbf{#1}', 1)]), false);
    expect(overridden.diagnostics).toEqual([]);
    expect(overridden.svg).toBe((await renderFormula('\\mathbf{x}', project(), false)).svg);
    // A custom override must not replace the built-in fallback in later renders.
    expect((await renderFormula('\\ensuremath{x}', project(), false)).svg)
      .toBe((await renderFormula('x', project(), false)).svg);
  });

  it('keeps ensuremath argument errors, undefined commands and expansion bounds visible', async () => {
    const missing = await renderFormula('\\ensuremath', project(), false);
    expect(missing.svg).toBe('');
    expect(missing.diagnostics.join(' ')).toMatch(/argument/i);
    const unknown = await renderFormula('\\ensuremath{\\missingInside}', project(), false);
    expect(unknown.svg).toBe('');
    expect(unknown.diagnostics.join(' ')).toContain('Undefined control sequence \\missingInside');
    const recursion = await renderFormula('\\Loop', project([macro('Loop', '\\ensuremath{\\Loop}')]), false);
    expect(recursion.svg).toBe('');
    expect(recursion.diagnostics.join(' ')).toMatch(/maximum macro substitution count/i);
  });

  it.each([
    '\\mathrm{d}x+\\mathit{ab}+\\mathnormal{x}+\\mathbf{v}+\\mathsf{T}+\\mathtt{M}',
    '\\mathbb{R}\\oplus\\mathcal{H}\\otimes\\mathfrak{g}',
    '\\boldsymbol{\\alpha}+\\pmb{\\beta}+\\vec{v}+\\hat{A}',
    '\\text{for }x\\textnormal{ fixed}+\\textbf{bold}+\\textit{italic}+\\textrm{unit}',
    '\\operatorname{tr}(A)+\\operatorname*{arg\\,max}_{x}f(x)+\\sum_{i=1}^n i',
  ])('retains common built-in font, text, bold and operator commands inside custom wrappers: %s', async expression => {
    const direct = await renderFormula(expression, project(), true);
    const wrapped = await renderFormula('\\Common', project([macro('Common', `\\ensuremath{${expression}}`)]), true);
    expect(direct.diagnostics).toEqual([]);
    expect(direct.svg).toMatch(/^<svg\b/);
    expect(wrapped.diagnostics).toEqual([]);
    expect(wrapped.svg).toBe(direct.svg);
  });

  it('renders ordinary and starred custom math operators with AMS spacing and limits', async () => {
    const result=await renderFormula('\\operatorname{Spec}(R)+\\operatorname*{arg\\,max}_{x}f(x)',project(),true);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toContain('data-mml-node="munder"');
  });
  it('renders supported arguments, optional defaults, and nested custom definitions', async () => {
    const index = project([
      macro('pair', '\\langle #1,#2\\rangle', 2),
      macro('power', '#2^{#1}', 2, { optionalDefault: '2' }),
      macro('Norm', '\\pair{#1}{#1}', 1),
    ]);
    const result = await renderFormula('\\Norm{x}+\\power{y}+\\power[3]{z}', index, false);
    const expanded = await renderFormula('\\langle x,x\\rangle+y^{2}+z^{3}', project(), false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toMatch(/^<svg\b/);
    expect(glyphs(result.svg)).toEqual(glyphs(expanded.svg));
  });

  it('uses normalized operator, def and resolved let bodies without executing raw definitions', async () => {
    const index = project([
      macro('Fun', '\\operatorname{Fun}', 0, { kind: 'DeclareMathOperator', raw: 'NOT EXECUTED' }),
      macro('twice', '#1+#1', 1, { kind: 'def' }),
      macro('saved', '\\alpha', 0, { kind: 'let' }),
    ]);
    const result = await renderFormula('\\Fun(\\twice{x})+\\saved', index, true);
    expect(result.diagnostics).toEqual([]);
    expect(glyphs(result.svg)).toEqual(glyphs((await renderFormula('\\operatorname{Fun}(x+x)+\\alpha', project(), true)).svg));
  });

  it('does not leak custom definitions between renders or change the host MathJax global', async () => {
    const original = (globalThis as { MathJax?: unknown }).MathJax;
    const sentinel = { hostRenderer: true };
    (globalThis as { MathJax?: unknown }).MathJax = sentinel;
    try {
      const first = await renderFormula('\\onlyHere', project([macro('onlyHere', 'x')]), false);
      const second = await renderFormula('\\onlyHere', project(), false);
      expect(first.diagnostics).toEqual([]);
      expect(second.svg).toBe('');
      expect(second.diagnostics.join(' ')).toContain('onlyHere');
      expect((await renderFormula('\\newcommand{\\createdHere}{x}\\createdHere', project(), false)).diagnostics).toEqual([]);
      expect((await renderFormula('\\createdHere', project(), false)).svg).toBe('');
      expect((globalThis as { MathJax?: unknown }).MathJax).toBe(sentinel);
    } finally {
      if (original === undefined) delete (globalThis as { MathJax?: unknown }).MathJax;
      else (globalThis as { MathJax?: unknown }).MathJax = original;
    }
  });

  it('reports undefined commands rather than returning a misleading error rendering', async () => {
    const result = await renderFormula('x+\\nonexistentCommand{a}', project(), false);
    expect(result.svg).toBe('');
    expect(result.diagnostics.join(' ')).toContain('Undefined control sequence \\nonexistentCommand');
  });

  it('follows custom macro dependencies before falling back to package definitions', async () => {
    const result = await renderFormula('\\outer{x}', project([
      macro('outer', '\\qty{#1}', 1),
      macro('qty', '#1', 1, { kind: 'NewDocumentCommand', signature: 's m', supported: false }),
    ], ['physics']), false);
    expect(result.svg).toBe('');
    expect(result.diagnostics.join(' ')).toContain('\\qty');
    expect(result.diagnostics.join(' ')).toContain('NewDocumentCommand');
  });

  it('supports the parser-verified simple xparse subset', async () => {
    const result = await renderFormula('\\pow{x}', project([
      macro('pow', '#2^{#1}', 2, { optionalDefault: '2', kind: 'NewDocumentCommand', signature: 'O{2} m' }),
    ]), false);
    expect(result.diagnostics).toEqual([]);
    expect(glyphs(result.svg)).toEqual(glyphs((await renderFormula('x^2', project(), false)).svg));
  });

  it('bounds expansion recursion and initial input length', async () => {
    const recursion = await renderFormula('\\Loop', project([macro('Loop', '\\Loop')]), false);
    expect(recursion.svg).toBe('');
    expect(recursion.diagnostics.join(' ')).toMatch(/maximum macro substitution count/i);
    const long = await renderFormula('x'.repeat(RENDER_LIMITS.formula + 1), project(), false);
    expect(long.svg).toBe('');
    expect(long.diagnostics.join(' ')).toContain('长度限制');
  });

  it('does not let unrelated macros block an otherwise supported formula', async () => {
    const unrelated = Array.from({ length: RENDER_LIMITS.macros + 1 }, (_, i) =>
      macro(`unused${i}`, 'x'.repeat(120), 0, { supported: false }));
    const result = await renderFormula('\\local{x}', project([...unrelated, macro('local', '#1^2', 1)]), false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toMatch(/^<svg/);
  });

  it('ignores commands in comments when resolving macro dependencies', async () => {
    const result = await renderFormula('x % \\unsupported\n + y', project([
      macro('unsupported', '', 0, { supported: false }),
    ]), false);
    expect(result.diagnostics).toEqual([]);
  });

  it('escapes text and does not permit links or external resource commands', async () => {
    const literal = await renderFormula('\\text{<script>alert(1)</script>}', project(), false);
    expect(literal.diagnostics).toEqual([]);
    expect(literal.svg).not.toMatch(/<script\b|<foreignObject\b|onerror=/i);
    const link = await renderFormula('\\href{javascript:alert(1)}{x}', project(), false);
    expect(link.svg).toBe('');
    expect(link.diagnostics.length).toBeGreaterThan(0);
    const remote = await renderFormula('\\require{html}', project(), false);
    expect(remote.svg).toBe('');
    expect(remote.diagnostics.join(' ')).toContain('require');
  });
});

describe('package-aware formula rendering', () => {
  it('respects explicit file/package preview precedence without changing the default policy', async () => {
    const index = project([macro('qty', '#1^2', 1)], ['physics']);
    index.previewSources = [
      { id: 'file:macros.sty', kind: 'file', name: 'macros.sty', path: 'macros.sty' },
      { id: 'package:physics', kind: 'package', name: 'physics', packageName: 'physics' },
    ];
    const custom = await renderFormula('x^2', project(), false);
    const physics = await renderFormula('\\qty{x}', project([], ['physics']), false);
    expect((await renderFormula('\\qty{x}', index, false)).svg).toBe(custom.svg);
    index.previewSourceOrder = ['file:macros.sty', 'package:physics'];
    expect((await renderFormula('\\qty{x}', index, false)).svg).toBe(physics.svg);
    index.previewSourceOrder.reverse();
    expect((await renderFormula('\\qty{x}', index, false)).svg).toBe(custom.svg);
    expect(index.macros[0].body).toBe('#1^2');
  });

  it('checks source precedence before reporting an unsupported shadowed definition', async () => {
    const index = project([macro('qty', '', 1, { supported: false, kind: 'NewDocumentCommand' })], ['physics']);
    index.previewSourceOrder = ['file:macros.sty', 'package:physics'];
    expect((await renderFormula('\\qty{x}', index, false)).diagnostics).toEqual([]);
    index.previewSourceOrder.reverse();
    expect((await renderFormula('\\qty{x}', index, false)).diagnostics.join(' ')).toContain('NewDocumentCommand');
    // Selecting an unknown package never silently erases a custom macro.
    const unknown = project([macro('Local', 'x')], ['unknown-package']);
    unknown.previewSourceOrder = ['file:macros.sty', 'package:unknown-package'];
    expect((await renderFormula('\\Local', unknown, false)).diagnostics).toEqual([]);
  });

  it('preserves optional defaults for the winning macro while retaining the shared math baseline', async () => {
    const index = project([macro('qty', '#2^{#1}', 2, { optionalDefault: '2' })], ['physics']);
    index.previewSourceOrder = ['package:physics', 'file:macros.sty'];
    const custom = await renderFormula('\\qty{x}+\\qty[3]{y}', index, false);
    expect(custom.diagnostics).toEqual([]);
    expect(custom.svg).toBe((await renderFormula('x^{2}+y^{3}', project(), false)).svg);
    index.previewSourceOrder.reverse();
    expect((await renderFormula('\\qty{x}', index, false)).svg)
      .toBe((await renderFormula('\\qty{x}', project([], ['physics']), false)).svg);
    const baseline = project(); baseline.previewSourceOrder = [];
    const expression = '\\operatorname{Spec}(\\mathbb{R})+\\boldsymbol{\\alpha}+\\ensuremath{x}';
    const result = await renderFormula(expression, baseline, false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toBe((await renderFormula(expression, project(), false)).svg);
  });

  it('treats providecommand as a fallback for baseline and enabled package commands', async () => {
    const index = project([
      macro('qty', '\\invalidFallback', 1, { kind: 'providecommand', supported: false }),
      macro('sin', 'x', 0, { kind: 'providecommand' }),
      macro('ensuremath', '\\mathbf{#1}', 1, { kind: 'providecommand' }),
      macro('Local', 'z', 0, { kind: 'providecommand' }),
    ], ['physics']);
    const expression = '\\qty{x}+\\sin x+\\ensuremath{y}+\\Local';
    const expected = await renderFormula('\\qty{x}+\\sin x+y+z', project([], ['physics']), false);
    expect((await renderFormula(expression, index, false)).svg).toBe(expected.svg);
    index.previewSourceOrder = ['package:physics', 'file:macros.sty'];
    const reordered = await renderFormula(expression, index, false);
    expect(reordered.diagnostics).toEqual([]);
    expect(reordered.svg).toBe(expected.svg);
    const withoutPhysics = project([macro('qty', '#1^2', 1, { kind: 'providecommand' })]);
    expect((await renderFormula('\\qty{x}', withoutPhysics, false)).svg)
      .toBe((await renderFormula('x^2', project(), false)).svg);
  });

  it('rechecks parsed wrapper dependencies after an unsupported fallback is shadowed', async () => {
    const text = String.raw`\usepackage{physics}
\providecommand{\qty}[1]{\iftrue #1\fi}
\newcommand{\Wrapped}[1]{\ensuremath{\qty{#1}}}
\newcommand{\StillUnsupported}{\iftrue x\fi}`;
    const index = await buildProjectIndex({
      files: [{ id: 'main', path: 'main.tex', kind: 'doc' }], rootPath: 'main.tex',
      settings: { ...DEFAULT_SETTINGS, extraFilesMode: 'none' }, readFile: async () => text,
    });
    expect(index.macros.find(macro => macro.name === 'Wrapped')?.supported).toBe(false);
    const result = await renderFormula('\\Wrapped{x}', index, false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toBe((await renderFormula('\\qty{x}', project([], ['physics']), false)).svg);
    expect((await renderFormula('\\StillUnsupported', index, false)).svg).toBe('');
    // Rendering cannot mutate the shared completion index's diagnostics/flags.
    expect(index.macros.find(macro => macro.name === 'Wrapped')?.supported).toBe(false);
  });

  it('renders a declared bold italic math alphabet and rejects unadapted font families', async () => {
    const text = String.raw`\DeclareMathAlphabet{\customBI}{OML}{cmm}{b}{it}
\newcommand{\boldItalicA}{\customBI{A}}
\DeclareMathAlphabet{\unknownFont}{U}{another}{m}{n}`;
    const index = await buildProjectIndex({
      files: [{ id: 'main', path: 'main.tex', kind: 'doc' }], rootPath: 'main.tex',
      settings: { ...DEFAULT_SETTINGS, extraFilesMode: 'none' }, readFile: async () => text,
    });
    const result = await renderFormula('\\boldItalicA+\\customBI{\\alpha}', index, false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toBe((await renderFormula('\\mathbfit{A}+\\mathbfit{\\alpha}', project(), false)).svg);
    expect(result.svg).not.toBe((await renderFormula('\\mathbf{A}+\\mathbf{\\alpha}', project(), false)).svg);
    expect((await renderFormula('\\unknownFont{A}', index, false)).svg).toBe('');
  });

  it('applies package/package source order and local package file identities', async () => {
    const index = project([], ['physics', 'braket']);
    index.previewSourceOrder = ['package:braket', 'package:physics'];
    const physics = await renderFormula('\\braket{x}{y}', project([], ['physics']), false);
    const braket = await renderFormula('\\braket{x}{y}', project([], ['braket']), false);
    expect(physics.svg).not.toBe(braket.svg);
    expect((await renderFormula('\\braket{x}{y}', index, false)).svg).toBe(physics.svg);
    index.previewSourceOrder.reverse();
    expect((await renderFormula('\\braket{x}{y}', index, false)).svg).toBe(braket.svg);
    const local = project([macro('bm', '#1^2', 1)], ['bm']);
    local.previewSources = [{ id: 'file:vendor/bm.sty', kind: 'file', name: 'bm.sty', packageName: 'bm', path: 'vendor/bm.sty' }];
    local.previewSourceOrder = ['file:macros.sty', 'file:vendor/bm.sty'];
    expect((await renderFormula('\\bm{x}', local, false)).svg).toBe((await renderFormula('\\boldsymbol{x}', project(), false)).svg);
  });

  it('only enables physics when the project declares it', async () => {
    const disabled = await renderFormula('\\dv{f}{x}', project(), false);
    const enabled = await renderFormula('\\dv{f}{x}', project([], ['physics']), false);
    expect(disabled.svg).toBe('');
    expect(disabled.diagnostics.join(' ')).toContain('dv');
    expect(enabled.diagnostics).toEqual([]);
    expect(enabled.svg).toMatch(/^<svg/);
    expect((await renderFormula('\\dv{f}{x}', project(), false)).svg).toBe('');
  });

  it.each([
    '\\dv[2]{f}{x}', '\\dv*{f}{x}', '\\pdv{f}{x}{y}', '\\qty(\\frac{a}{b})',
    '\\bra{\\psi}\\ket{\\phi}', '\\braket{\\psi}{\\phi}', '\\mel{\\phi}{A}{\\psi}',
    '\\vb*{\\alpha}+\\dd{x}', '\\mqty(a&b\\\\c&d)', '\\mqty(\\imat{3})',
  ])('renders physics argument forms: %s', async expression => {
    const result = await renderFormula(expression, project([], ['physics']), false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toMatch(/^<svg/);
  });

  it('uses project custom commands in preference to physics commands', async () => {
    const result = await renderFormula('\\qty{x}', project([macro('qty', '#1^2', 1)], ['physics']), false);
    const expected = await renderFormula('x^2', project(), false);
    expect(result.diagnostics).toEqual([]);
    expect(glyphs(result.svg)).toEqual(glyphs(expected.svg));
    const redefinedMatrix = await renderFormula('\\imat{x}', project([macro('imat', '#1^2', 1)], ['physics']), false);
    expect(redefinedMatrix.diagnostics).toEqual([]);
    expect(glyphs(redefinedMatrix.svg)).toEqual(glyphs(expected.svg));
  });

  it('honors physics italicdiff and reports unsupported options or qty ambiguity', async () => {
    const upright = project([], ['physics']);
    const italic = project([], ['physics']);
    italic.packages[0].options = ['italicdiff'];
    const a = await renderFormula('\\dd{x}', upright, false);
    const b = await renderFormula('\\dd{x}', italic, false);
    expect(a.diagnostics).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    expect(a.svg).not.toBe(b.svg);
    const invalid = project([], ['physics']);
    invalid.packages[0].options = ['notrig'];
    const rejected = await renderFormula('\\sin(x)', invalid, false);
    expect(rejected.svg).toBe('');
    expect(rejected.diagnostics.join(' ')).toContain('notrig');
    expect((await renderFormula('\\qty{x}', project([], ['physics', 'siunitx']), false)).svg).toBe('');
  });

  it.each(['\\imat{100000}', '\\xmat{x}{100000}{2}', '\\zmat{2}{100000}'])('bounds generated matrices: %s', async expression => {
    const result = await renderFormula(expression, project([], ['physics']), false);
    expect(result.svg).toBe('');
    expect(result.diagnostics.join(' ')).toContain('32');
  });

  it('renders explicitly adapted mathtools and bm commands', async () => {
    const result = await renderFormula('\\prescript{a}{b}{X}\\coloneqq\\bm{\\alpha}', project([], ['mathtools', 'bm']), false);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toMatch(/^<svg/);
  });

  it('does not fake bbm and slashed by replacing them with different notation', async () => {
    const result = await renderFormula('\\mathbbm{1}+\\slashed{p}', project([], ['bbm', 'slashed']), false);
    expect(result.svg).toBe('');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
