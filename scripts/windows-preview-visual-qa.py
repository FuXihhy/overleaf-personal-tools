"""Generate three synthetic preview PDFs using the real sandboxed host."""
import base64
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'native'))
import host

output = root / 'artifacts/windows-preview'
output.mkdir(parents=True, exist_ok=True)
source = r'''\documentclass[border=5pt]{standalone}
\usepackage{amsmath,amssymb,physics,xparse}
\newcommand{\cN}{\mathcal{N}}
\begin{document}
$\displaystyle \cN=\frac{1}{\sqrt{2\pi}}\int_{-\infty}^{\infty}e^{-x^2/2}\,dx
\qquad \ket{\psi}=\frac{\ket{0}+\ket{1}}{\sqrt{2}}
\qquad \pdv{f}{x}=2x$
\end{document}
'''
(output / 'synthetic-preview.tex').write_text(source, encoding='utf-8')
evidence = {}
for compiler in ('pdflatex', 'xelatex', 'lualatex'):
    result = host.render({'id': 'visual-qa-' + compiler, 'version': 1, 'op': 'render',
                          'compiler': compiler, 'document': {'entryPath': 'main.tex',
                          'files': [{'path': 'main.tex', 'content': source}]}})
    pdf = base64.b64decode(result['pdfBase64'])
    (output / (compiler + '.pdf')).write_bytes(pdf)
    evidence[compiler] = {'bytes': len(pdf), 'elapsedMs': result['elapsedMs'],
                          'diagnostics': result['diagnostics']}
(output / 'evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
print(json.dumps(evidence, indent=2))
