/**
 * 데모와 e2e 용 가상 Office 문서 생성기 (설계서 §3.5)
 *
 * 전부 이 코드가 만드는 가상기관 문서다(실물 지침서 아님, 무저작권). 바이너리를 저장소에 두지 않고
 * 시드 때 만든다. 새 의존성 없음: docx 는 jobs/zip.ts 의 ZIP 작성기, xlsx 는 기존 ExcelJS.
 *
 * - buildDemoDocx: 번호 문단(1. / 1.1 / 가.), 표지 표, 개정 이력 표, 쪽 나누기, Word 쪽 나눔 표지
 *   (w:lastRenderedPageBreak, 표 안 포함), 머리말/꼬리말(PAGE 필드)
 * - buildDemoXlsx: 시트 2장(병합 제목, 굵은 머리글과 채우기, 틀 고정, 날짜, 백분율)
 * - buildDemoCsv: 접근권한 검토 기록
 */
import ExcelJS from 'exceljs';
import { zipEntries } from '../server/src/jobs/zip.js';

const FIXED_DATE = new Date(2026, 0, 1);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** 글자 조각 하나 */
function run(text: string, opts: { b?: boolean; sz?: number; lrpb?: boolean } = {}): string {
  const rPr =
    opts.b || opts.sz
      ? `<w:rPr>${opts.b ? '<w:b/><w:bCs/>' : ''}${opts.sz ? `<w:sz w:val="${opts.sz}"/><w:szCs w:val="${opts.sz}"/>` : ''}</w:rPr>`
      : '';
  return `<w:r>${rPr}${opts.lrpb ? '<w:lastRenderedPageBreak/>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(
  text: string,
  opts: { style?: string; num?: { id: number; lvl: number }; jc?: string; b?: boolean; sz?: number; lrpb?: boolean } = {},
): string {
  const pPr: string[] = [];
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.num) pPr.push(`<w:numPr><w:ilvl w:val="${opts.num.lvl}"/><w:numId w:val="${opts.num.id}"/></w:numPr>`);
  if (opts.jc) pPr.push(`<w:jc w:val="${opts.jc}"/>`);
  const body = text === '' ? '' : run(text, { b: opts.b, sz: opts.sz, lrpb: opts.lrpb });
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${body}</w:p>`;
}

function cell(text: string, w: number, opts: { b?: boolean; fill?: string; span?: number; lrpb?: boolean; jc?: string } = {}): string {
  const tcPr =
    `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>` +
    (opts.span ? `<w:gridSpan w:val="${opts.span}"/>` : '') +
    (opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : '') +
    `<w:vAlign w:val="center"/></w:tcPr>`;
  const pPr = opts.jc ? `<w:pPr><w:jc w:val="${opts.jc}"/></w:pPr>` : '';
  return `<w:tc>${tcPr}<w:p>${pPr}${run(text, { b: opts.b, lrpb: opts.lrpb })}</w:p></w:tc>`;
}

function table(grid: number[], rows: string[], opts: { header?: boolean } = {}): string {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${grid.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:jc w:val="center"/>` +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>` +
    rows
      .map((r, i) => (i === 0 && opts.header ? r.replace('<w:tr>', '<w:tr><w:trPr><w:tblHeader/></w:trPr>') : r))
      .join('') +
    `</w:tbl>`
  );
}

const tr = (...cells: string[]): string => `<w:tr>${cells.join('')}</w:tr>`;

/** 가상기관 정보보안 점검 절차서 (docx) */
export function buildDemoDocx(): Buffer {
  const H = { id: 1 }; // 번호 매기기 numId 1: 1. / 1.1 / 가.
  const body: string[] = [];
  // 표지 표
  body.push(
    table([2400, 6600], [
      tr(cell('가상기관', 2400, { b: true, jc: 'center', fill: 'DCE6F2' }), cell('정보보안 점검 절차서', 6600, { b: true, jc: 'center' })),
    ]),
  );
  body.push(para(''));
  body.push(
    table([1800, 2700, 1800, 2700], [
      tr(cell('문서번호', 1800, { b: true, fill: 'F2F2F2' }), cell('VIRT-SEC-001', 2700), cell('판', 1800, { b: true, fill: 'F2F2F2' }), cell('2.1', 2700)),
      tr(cell('작성 부서', 1800, { b: true, fill: 'F2F2F2' }), cell('가상기관 정보보안팀', 2700), cell('시행일', 1800, { b: true, fill: 'F2F2F2' }), cell('2026-01-02', 2700)),
    ]),
  );
  body.push(para(''));
  body.push(para('개정 이력', { b: true }));
  body.push(
    table([1500, 1000, 6500], [
      tr(cell('개정일', 1500, { b: true, fill: 'F2F2F2', jc: 'center' }), cell('판', 1000, { b: true, fill: 'F2F2F2', jc: 'center' }), cell('개정 내용', 6500, { b: true, fill: 'F2F2F2', jc: 'center' })),
      tr(cell('2024-03-01', 1500), cell('1.0', 1000), cell('제정', 6500)),
      tr(cell('2025-05-12', 1500), cell('2.0', 1000), cell('백업 점검 주기를 분기에서 월로 변경', 6500)),
      tr(cell('2026-01-02', 1500), cell('2.1', 1000), cell('접근권한 정기 검토 절차 추가', 6500)),
    ], { header: true }),
  );
  body.push(para('목적', { style: 'Heading1', num: { id: H.id, lvl: 0 } }));
  body.push(para('이 절차서는 가상기관의 정보시스템 점검 방법과 기록 관리 기준을 정한다.'));
  body.push(para('적용 범위', { style: 'Heading1', num: { id: H.id, lvl: 0 } }));
  body.push(para('검사 정보시스템, 업무용 개인 컴퓨터, 백업 장치에 적용한다.'));
  // 명시적 쪽 나누기 + Word 쪽 나눔 표지
  body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
  body.push(para('백업 및 복구 점검', { style: 'Heading1', num: { id: H.id, lvl: 0 }, lrpb: true }));
  body.push(para('백업 주기', { style: 'Heading2', num: { id: H.id, lvl: 1 } }));
  body.push(para('주요 데이터는 매일 자동 백업하고, 백업 매체는 월 1회 복구 시험으로 확인한다.'));
  body.push(para('복구 시험 기록', { style: 'Heading2', num: { id: H.id, lvl: 1 } }));
  body.push(para('복구 시험 결과는 점검 기록표에 남기고 담당자와 책임자가 확인 서명한다.', { num: { id: H.id, lvl: 2 } }));
  body.push(para('실패한 시험은 원인과 조치를 적고 7일 안에 다시 시험한다.', { num: { id: H.id, lvl: 2 } }));
  // 쪽을 넘어가는 긴 표: 머리글 행 반복 + 표 안 쪽 나눔 표지
  const rows = [
    tr(cell('점검 항목', 3000, { b: true, fill: 'F2F2F2' }), cell('주기', 1500, { b: true, fill: 'F2F2F2' }), cell('확인 방법', 4500, { b: true, fill: 'F2F2F2' })),
  ];
  const items = [
    ['백업 성공 여부', '매일', '백업 프로그램 결과 화면 확인'],
    ['백업 매체 상태', '주 1회', '매체 오류 표시 확인'],
    ['복구 시험', '월 1회', '임의 파일 복구 후 내용 대조'],
    ['접근권한 검토', '분기 1회', '퇴직자, 부서 이동자 계정 정리'],
    ['백신 갱신', '매일', '자동 갱신 기록 확인'],
    ['보안 패치', '월 1회', '운영체제 업데이트 이력 확인'],
  ];
  items.forEach(([a, b, c], i) => {
    // 네 번째 행이 다음 쪽에서 시작했다고 Word 가 기록한 상태를 흉내 낸다
    rows.push(tr(cell(a!, 3000, { lrpb: i === 3 }), cell(b!, 1500, { lrpb: i === 3 }), cell(c!, 4500, { lrpb: i === 3 })));
  });
  body.push(para('정기 점검표', { style: 'Heading1', num: { id: H.id, lvl: 0 } }));
  body.push(table([3000, 1500, 4500], rows, { header: true }));
  body.push(para('기록 보존', { style: 'Heading1', num: { id: H.id, lvl: 0 } }));
  body.push(para('점검 기록은 3년간 보존하고, 보존 기간이 지난 기록은 정보보안팀 확인 후 파기한다.'));

  const sectPr =
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:footerReference w:type="default" r:id="rIdFooter1"/>` +
    `<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<w:document ${W_NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:eastAsia="맑은 고딕" w:hAnsi="Malgun Gothic"/>` +
    `<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>` +
    `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `</w:styles>`;

  const lvl = (ilvl: number, fmt: string, text: string, left: number, hanging: number): string =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr></w:lvl>`;
  const numberingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>` +
    lvl(0, 'decimal', '%1.', 400, 400) +
    lvl(1, 'decimal', '%1.%2', 800, 400) +
    lvl(2, 'ganada', '%3.', 1200, 400) +
    `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  const headerXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:hdr ${W_NS}>` +
    `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run('VIRT-SEC-001 정보보안 점검 절차서')}</w:p></w:hdr>`;
  const footerXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:ftr ${W_NS}>` +
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `${run(' / ')}` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p></w:ftr>`;

  const settingsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:settings ${W_NS}><w:defaultTabStop w:val="800"/></w:settings>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
    `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
    `<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
    `<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>` +
    `</Relationships>`;
  return zipEntries(
    [
      ['[Content_Types].xml', contentTypes],
      ['_rels/.rels', rootRels],
      ['word/document.xml', documentXml],
      ['word/styles.xml', stylesXml],
      ['word/numbering.xml', numberingXml],
      ['word/settings.xml', settingsXml],
      ['word/header1.xml', headerXml],
      ['word/footer1.xml', footerXml],
      ['word/_rels/document.xml.rels', docRels],
    ].map(([name, body]) => ({ name: name!, data: Buffer.from(body!, 'utf8'), date: FIXED_DATE })),
  );
}

/** 가상기관 정보자산 목록 (xlsx) */
export async function buildDemoXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '가상기관';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;
  const ws = wb.addWorksheet('자산목록', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = [
    { key: 'no', width: 6 },
    { key: 'name', width: 24 },
    { key: 'place', width: 14 },
    { key: 'owner', width: 14 },
    { key: 'backup', width: 12 },
    { key: 'checked', width: 14 },
  ];
  ws.mergeCells('A1:F1');
  ws.getCell('A1').value = '가상기관 정보자산 목록 (2026년)';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  const header = ['번호', '자산명', '위치', '관리자', '백업', '최근 점검일'];
  const headRow = ws.getRow(2);
  header.forEach((h, i) => {
    const c = headRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  const assets: [string, string, string, string, Date][] = [
    ['검사정보시스템 서버', '전산실', '김가상', '매일', new Date(Date.UTC(2026, 0, 5))],
    ['백업 저장장치', '전산실', '김가상', '해당없음', new Date(Date.UTC(2026, 0, 5))],
    ['분자검사실 업무용 PC 1', '분자검사실', '이가상', '주 1회', new Date(Date.UTC(2026, 0, 12))],
    ['분자검사실 업무용 PC 2', '분자검사실', '이가상', '주 1회', new Date(Date.UTC(2026, 0, 12))],
    ['검체 바코드 프린터', '검체접수실', '박가상', '해당없음', new Date(Date.UTC(2026, 1, 2))],
  ];
  assets.forEach((a, i) => {
    const row = ws.getRow(3 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = a[0];
    row.getCell(3).value = a[1];
    row.getCell(4).value = a[2];
    row.getCell(5).value = a[3];
    row.getCell(6).value = a[4];
    row.getCell(6).numFmt = 'yyyy-mm-dd';
    for (let c = 1; c <= 6; c += 1) {
      row.getCell(c).border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    }
  });
  const hist = wb.addWorksheet('점검이력');
  hist.columns = [{ width: 14 }, { width: 20 }, { width: 12 }, { width: 30 }];
  hist.addRow(['점검월', '항목', '이행률', '비고']);
  hist.getRow(1).font = { bold: true };
  const h: [string, string, number, string][] = [
    ['2026-01', '백업 복구 시험', 1, '전 항목 이행'],
    ['2026-01', '접근권한 검토', 0.875, '퇴직자 1명 계정 정리 지연'],
    ['2026-02', '백업 복구 시험', 1, '전 항목 이행'],
  ];
  for (const r of h) {
    const row = hist.addRow(r);
    row.getCell(3).numFmt = '0.0%';
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** 가상기관 접근권한 검토 기록 (csv, UTF-8 BOM) */
export function buildDemoCsv(): Buffer {
  const rows = [
    '검토일,대상 시스템,검토 계정 수,조치,확인자',
    '2026-01-15,검사정보시스템,42,퇴직자 계정 2건 잠금,정보보안팀',
    '2026-04-15,검사정보시스템,44,부서 이동자 권한 1건 변경,정보보안팀',
  ];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rows.join('\r\n') + '\r\n', 'utf8')]);
}
