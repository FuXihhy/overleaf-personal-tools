export const PROJECT_ID = '0123456789abcdef01234567';
export const sources = {
  'main.tex': String.raw`\documentclass{article}
\usepackage{physics,amsmath}
\input{defs/extra}
\begin{document}
An ordinary formula: $x^2 + y^2$.
A package command: $\pdv{f}{x} + \qty(\frac{a}{b})$.
A custom definition: $\RR^n \quad \vect{x}$.
Unclicked custom formula: $\cN=(1,0)$.
A standard wrapper: $\ensuremath{\operatorname{Spec}(R)} + \bR$.
A source-order check: $\choice$.
Competing native output probe: $\fixtureNativeOnly$.
Unknown input probe: $\fixtureBothFail$.
\end{document}`,
  'macros.sty': String.raw`\newcommand{\RR}{\ensuremath{\mathbb{R}}}
\newcommand{\cN}{\mathcal{N}}
\newcommand{\vect}[1]{\mathbf{#1}}
\newcommand{\bR}{\ensuremath{\mathbb{R}}}
\newcommand{\bfR}{\ensuremath{\mathbf{R}}}
\newcommand{\biR}{\ensuremath{\mathit{R}}}
\newcommand{\brD}{\mathrm{D}}
\newcommand{\brF}{\mathrm{F}}
\def\choice{B}`,
  'defs/extra.tex': String.raw`\DeclareMathOperator{\Spec}{Spec}\def\choice{A}`,
  'notes/unloaded.tex': String.raw`\newcommand{\UNLOADED}{\mathbb{Q}}`,
};
