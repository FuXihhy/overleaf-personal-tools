import {renderCloudPdf} from '/dist/cloud-pdf.js';
try {
  const bytes=new Uint8Array(await (await fetch('/dev/generated/formula.pdf')).arrayBuffer());
  const result=await renderCloudPdf(bytes);
  const image=document.createElement('img');image.src=result.dataUrl;image.width=result.width;image.height=result.height;image.alt='Synthetic formula: Spec(R), partial derivative, z squared';
  document.getElementById('result').append(image);
  document.getElementById('status').textContent='PASS — single-page PDF rendered. '+result.diagnostics.join('\n');
} catch(error) {document.getElementById('status').textContent='FAIL — '+error.message;}
