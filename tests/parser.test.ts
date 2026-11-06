import { describe, expect, it } from 'vitest';
import { macroToCommand, maskComments, parseTex } from '../src/core/parser';

const macros = (text: string) => parseTex(text, 'synthetic.sty').events.flatMap(event => event.type === 'macro' ? [event.macro] : []);

describe('TeX declaration scanner', () => {
  it('ignores comments while retaining escaped percent and source positions', () => {
    const text = String.raw`% \newcommand{\hidden}{H}
\newcommand{\percent}{\%} % \def\hiddenTwo{X}
\newcommand{\nested}[1]{\frac{{#1}+1}{2}}`;
    expect(maskComments(text).length).toBe(text.length);
    expect(macros(text).map(macro => macro.name)).toEqual(['percent', 'nested']);
    expect(macros(text)[0].offset).toBe(text.indexOf('\\newcommand{\\percent}'));
    expect(macros(text)[1].body).toBe('\\frac{{#1}+1}{2}');
    expect(macros(String.raw`\def\joined{\text{a% comment
b}}`)[0].body).toBe('\\text{ab}');
  });

  it('handles starred definitions, optional defaults containing brackets, and unbraced names', () => {
    const result = macros(String.raw`\newcommand*\sample[2][{[x]}]{#1+#2}`)[0];
    expect(result).toMatchObject({ name: 'sample', args: 2, optionalDefault: '{[x]}', body: '#1+#2', supported: true });
    expect(macroToCommand(result).snippet).toContain('${2:arg}');
  });

  it('normalizes math operators while preserving starred limits', () => {
    const result = macros(String.raw`\DeclareMathOperator{\Hom}{Hom}\DeclareMathOperator*{\limCustom}{lim}`);
    expect(result.map(macro => macro.body)).toEqual(['\\operatorname{Hom}', '\\operatorname*{lim}']);
  });

  it('adapts only the declared Computer Modern bold italic alphabet regardless of its command name', () => {
    const result = macros(String.raw`\DeclareMathAlphabet{\customBI}{OML}{cmm}{b}{it}
\DeclareMathAlphabet{\otherFamily}{U}{unknown}{m}{n}`);
    expect(result[0]).toMatchObject({ name: 'customBI', kind: 'DeclareMathAlphabet', args: 1, body: '\\mathbfit{#1}', supported: true });
    expect(macroToCommand(result[0]).snippet).toBe('\\customBI{${1:arg}}');
    expect(result[1]).toMatchObject({ name: 'otherFamily', args: 1, supported: false });
    expect(result[1].signature).toContain('U/unknown/m/n');
    expect(macroToCommand(result[1]).preview).toBe('unsupported');
  });

  it('recognizes simple def parameters and flags delimited TeX definitions', () => {
    const result = macros(String.raw`\def\pair#1#2{(#1,#2)}\def\until#1;{#1}`);
    expect(result[0]).toMatchObject({ args: 2, supported: true });
    expect(result[1]).toMatchObject({ args: 1, supported: false });
  });

  it('records let without pretending it has expanded the target', () => {
    const result = macros(String.raw`\let\alias = \original`)[0];
    expect(result).toMatchObject({ name: 'alias', kind: 'let', body: '\\original' });
  });

  it('supports representable xparse signatures and preserves unsupported signatures for completion', () => {
    const result = macros(String.raw`\NewDocumentCommand\simple{O{z} m}{#1+#2}
\NewDocumentCommand\complex{s o m}{#3}`);
    expect(result[0]).toMatchObject({ args: 2, optionalDefault: 'z', supported: true });
    expect(result[1]).toMatchObject({ args: 3, supported: false });
    expect(macroToCommand(result[0]).snippet).toBe('\\simple[${1:z}]{${2:arg}}');
    expect(macroToCommand(result[1]).snippet).toBe('\\complex[${1:optional}]{${2:arg}}');
    const unknown = macros(String.raw`\NewDocumentCommand\unknown{m >{\Processor}m}{#1#2}`)[0];
    expect(unknown.supported).toBe(false);
    expect(macroToCommand(unknown).snippet).toBe('\\unknown');
    expect(unknown.signature).toContain('…');
  });

  it('preserves package and file order, including option lists and bare input', () => {
    const events = parseTex(String.raw`\usepackage[a,b]{physics,amsmath}\input{sections/a}\RequirePackage{local}\input bare.tex
\include{sections/b}`, 'main.tex').events;
    expect(events.map(event => event.type)).toEqual(['package', 'package', 'include', 'package', 'include', 'include']);
    expect(events[0]).toMatchObject({ package: { name: 'physics', options: ['a', 'b'], source: 'main.tex' } });
    expect(events[4]).toMatchObject({ path: 'bare.tex' });
  });

  it('does not interpret declarations nested in replacement text or local groups', () => {
    const result = macros(String.raw`\newcommand\outer{\newcommand\inner{X}} {\def\local{L}} \def\global{G}`);
    expect(result.map(macro => macro.name)).toEqual(['outer', 'global']);
    expect(result[0].supported).toBe(false);
  });

  it('does not index either branch of a TeX conditional as certain definitions', () => {
    expect(macros(String.raw`\ifdefined\test\def\uncertain{A}\else\def\uncertain{B}\fi\def\certain{C}`).map(macro => macro.name)).toEqual(['certain']);
  });

  it('reports malformed input without throwing or fabricating a body', () => {
    const result = parseTex(String.raw`\newcommand\broken[1]{\frac{#1}{2}`);
    expect(result.events).toHaveLength(0);
    expect(result.diagnostics.some(item => item.level === 'warning')).toBe(true);
  });

  it('ignores literal code environments and inline verbatim command examples', () => {
    const source = String.raw`\verb|\def\inlineExample{X}|
\begin{verbatim}
\newcommand\codeExample{Y}
\end{verbatim}
\begin{minted}{latex}
\def\mintedExample{Z}
\end{minted}
\def\real{R}`;
    expect(macros(source).map(macro => macro.name)).toEqual(['real']);
  });

  it('does not mistake a newif declaration for an opened conditional', () => {
    const source = String.raw`\newif\ifdraft\def\outside{O}\ifdraft\def\inside{I}\fi`;
    expect(macros(source).map(macro => macro.name)).toEqual(['outside']);
  });

  it('marks structural and drawing macros unsupported for math preview', () => {
    const result = macros(String.raw`\newcommand\plot{\tikz{\draw (0,0)--(1,1);}}\newcommand\equationStart{\begin{equation}}`);
    expect(result.every(macro => !macro.supported)).toBe(true);
    expect(result.every(macro => macroToCommand(macro).preview === 'unsupported')).toBe(true);
  });
});
