/** Construct a valid ten-page PDF with a configurable byte-range surface. */
export function makePdf(fillerLines = 1400): Buffer {
  const pageCount = 10;
  const fontId = pageCount * 2 + 3;
  const kids = Array.from({ length: pageCount }, (_, i) => (3 + i * 2) + ' 0 R');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pageCount + ' >>',
  ];
  for (let i = 0; i < pageCount; i++) {
    const contentId = 4 + i * 2;
    const stream = 'BT /F1 26 Tf 72 690 Td (FlashView page ' + (i + 1) + ') Tj ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
    objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  // Force noncontiguous PDF.js range requests for structure near the file tail.
  pdf += ('% ' + 'PDF DATA '.repeat(15) + '\n').repeat(fillerLines);
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
  pdf += 'startxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}
