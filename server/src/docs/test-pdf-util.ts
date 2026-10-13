/**
 * 테스트 전용 초소형 PDF 생성기 (ASCII 전용, Helvetica Tj)
 * 재앵커링 테스트가 "문구 1건만 바꾼 v2"를 결정론적으로 만들 수 있게 한다.
 * 각 줄은 별도 Tj + Td(-20) — extract.ts의 Y 변화 줄바꿈 규칙으로 줄당 1행이 복원된다.
 * (데모/시드 용도가 아니라 vitest 픽스처 빌더 — 런타임 코드에서 임포트 금지)
 */

function escapePdfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** pages[i] = i+1 페이지의 줄 목록 (ASCII만) */
export function buildTestPdf(pages: string[][]): Uint8Array {
  const n = pages.length;
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`); // 2
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  for (let i = 0; i < n; i++) {
    const contentNum = 5 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    const lines = pages[i] ?? [];
    let stream = 'BT /F1 12 Tf 72 720 Td';
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) stream += ' 0 -20 Td';
      stream += ` (${escapePdfString(lines[li] ?? '')}) Tj`;
    }
    stream += ' ET';
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length); // ASCII 전용이라 문자 수 == 바이트 수
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += off.toString().padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
