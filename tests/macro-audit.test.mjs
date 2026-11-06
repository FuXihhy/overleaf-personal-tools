import { describe, expect, it } from 'vitest';
import { inventoryDeclarations, representativeCase } from '../scripts/audit-macros.mjs';
import { parseTex, maskComments } from '../src/core/parser';

const inventory = text => inventoryDeclarations(text, parseTex(text, 'synthetic.sty'), maskComments(text));
const cases = text => {
  const rows = inventory(text);
  return Object.fromEntries(rows.map(row => [row.name, representativeCase(row, rows)]));
};

describe('local macro audit representative cases', () => {
  it('inventories unsupported symbol, environment and resource declarations without counting nested bodies', () => {
    const text = String.raw`% \def\commented{X}
\DeclareSymbolFont{customfont}{U}{custom}{m}{n}
\DeclareMathSymbol{\symbolX}{\mathord}{customfont}{"00}
\newtheorem{lemma}{Lemma}
\newcommand\outer{\def\nested{X}}`;
    const rows = inventory(text);
    expect(rows.map(row => [row.name, row.declarationType])).toEqual([
      ['customfont', 'resource'], ['symbolX', 'command'], ['lemma', 'environment'], ['outer', 'command'],
    ]);
    expect(rows[1].parserRecognized).toBe(false);
    expect(rows[1].raw).toBe(String.raw`\DeclareMathSymbol{\symbolX}{\mathord}{customfont}{"00}`);
    expect(rows[1].line).toBe(3);
  });

  it('delimits control words in color switches and paired environment aliases', () => {
    const result = cases(String.raw`\def\beginEq{\begin{equation}\begin{aligned}}
\def\endEq{\end{aligned}\end{equation}}
\def\ink{\color[rgb]{1,0,0}}`);
    expect(result.beginEq.texBody).toBe(String.raw`\beginEq x&=x\endEq`);
    expect(result.endEq.texBody).toBe(result.beginEq.texBody);
    expect(result.ink.formula).toBe(String.raw`{\ink x}`);
  });

  it('provides operands for aliases and omits optional xparse arguments', () => {
    const result = cases(String.raw`\def\accentAlias{\widetilde}
\NewDocumentCommand\conditional{s o m}{#3}
\newcommand\diagramAlias{\tiny\yng}
\def\scriptAlias{\mathscr{P}}
\def\indirectScript{\scriptAlias}`);
    expect(result.accentAlias.formula).toBe(String.raw`\accentAlias{x}`);
    expect(result.conditional.formula).toBe(String.raw`\conditional{x}`);
    expect(result.diagramAlias.formula).toBe(String.raw`\diagramAlias(2,1)`);
    expect(result.diagramAlias.context).toBe('text');
    expect(result.diagramAlias.texBody).toBe(String.raw`{\diagramAlias(2,1)}`);
    expect(result.indirectScript.usesScriptAlphabet).toBe(true);
  });

  it('places standalone drawing commands in a picture without adding a stray semicolon', () => {
    const result = cases(String.raw`\newcommand\lineSegment[2]{\draw (#1,0)--(#2,1);}
\newcommand\pictureWrapper[2][]{\ensuremath{\vcenter{\hbox{\begin{tikzpicture}[#1]#2\end{tikzpicture}}}}}`);
    expect(result.lineSegment.context).toBe('tikz');
    expect(result.lineSegment.texBody).toBe(String.raw`\begin{tikzpicture}\lineSegment{0}{0}\end{tikzpicture}`);
    expect(result.pictureWrapper.texBody).toBe(String.raw`\(\pictureWrapper{\draw (0,0)--(1,0);}\)`);
  });
});
