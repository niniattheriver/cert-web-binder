import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readZipDirectory, readZipEntry } from '../files/unzip.js';
import { zipEntries } from '../jobs/zip.js';
import { OfficeParseError } from './errors.js';
import type { CellStyle, OfficeExtractResult, SheetModel, SheetPage } from './model.js';
import { applyTint, formatCellValue, formatNumber, isoToSerial, processXlsx, XLSX_EXTRACTOR } from './xlsx.js';

/** 엑셀 일련번호(1900 체계) */
const serial = (y: number, m: number, d: number, frac = 0): number =>
  Date.UTC(y, m - 1, d) / 86_400_000 + 25_569 + frac;

const thin = { style: 'thin' as const };

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function modelOf(r: OfficeExtractResult): SheetModel {
  return JSON.parse(r.render.toString('utf8')) as SheetModel;
}

/** 쪽의 (행, 열) 셀 */
function cellAt(pg: SheetPage, r: number, c: number): { t?: string; o?: number; s?: number } | undefined {
  return pg.rows.find((row) => row.r === r)?.cells.find((cell) => cell.c === c);
}

function styleAt(m: SheetModel, pg: SheetPage, r: number, c: number): CellStyle | undefined {
  const s = cellAt(pg, r, c)?.s;
  return s === undefined ? undefined : m.styles[s];
}

/** 정합 불변식 1~4 를 모든 쪽에 대해 확인하고 모델을 돌려준다 */
function expectInvariants(r: OfficeExtractResult): SheetModel {
  const m = modelOf(r);
  expect(r.fileKind).toBe('xlsx');
  expect(r.extractor).toBe(XLSX_EXTRACTOR);
  expect(r.renderMime).toBe('application/json');
  expect(m.kind).toBe('sheet');
  expect(m.media).toEqual([]);
  // 1) 쪽 번호 1..N 연속, 모델과 1:1
  expect(r.pages.map((p) => p.pageNo)).toEqual(r.pages.map((_, i) => i + 1));
  expect(m.pages.map((p) => p.pageNo)).toEqual(r.pages.map((p) => p.pageNo));
  m.pages.forEach((pg, i) => {
    const text = r.pages[i]!.text;
    expect(r.pages[i]!.label).toBe(pg.name);
    const pieces: { o: number; t: string }[] = [];
    let lastRow = 0;
    for (const row of pg.rows) {
      expect(row.r).toBeGreaterThan(lastRow); // 행 번호 오름차순
      lastRow = row.r;
      expect(row.r).toBeLessThanOrEqual(pg.maxRow);
      let lastCol = 0;
      for (const cell of row.cells) {
        expect(cell.c).toBeGreaterThan(lastCol);
        lastCol = cell.c;
        expect(cell.c).toBeLessThanOrEqual(pg.maxCol);
        if (cell.s !== undefined) expect(m.styles[cell.s]).toBeDefined();
        if (cell.t === undefined) {
          expect(cell.o).toBeUndefined();
          expect(cell.s).toBeDefined(); // 글자 없는 셀은 보이는 서식이 있어야 한다
          continue;
        }
        // 2) 조각 글자 = 쪽 글자의 o 위치
        expect(text.slice(cell.o!, cell.o! + cell.t.length)).toBe(cell.t);
        pieces.push({ o: cell.o!, t: cell.t });
      }
    }
    // 3) 조각 사이에는 구분자 하나('\t' 또는 '\n')만, 앞뒤에는 아무것도 없다
    pieces.sort((a, b) => a.o - b.o);
    let pos = 0;
    pieces.forEach((p, k) => {
      const gap = text.slice(pos, p.o);
      if (k === 0) expect(gap).toBe('');
      else expect(gap === '\t' || gap === '\n').toBe(true);
      pos = p.o + p.t.length;
    });
    expect(pos).toBe(text.length);
    expect(pg.colWidths).toHaveLength(pg.maxCol);
    for (const [r1, c1, r2, c2] of pg.merges) {
      expect(r1).toBeLessThanOrEqual(r2);
      expect(c1).toBeLessThanOrEqual(c2);
      expect(r2).toBeLessThanOrEqual(pg.maxRow);
      expect(c2).toBeLessThanOrEqual(pg.maxCol);
    }
  });
  // 4) 상한 안내가 색인 결과와 모델에 똑같이
  expect(m.truncated).toBe(r.truncated);
  return m;
}

/** ZIP 안 파일을 고치거나 이름을 바꿔 다시 묶는다 */
function patchZip(
  buf: Buffer,
  patches: Record<string, (s: string) => string>,
  renames: Record<string, string> = {},
): Buffer {
  const dir = readZipDirectory(buf);
  if (!dir) throw new Error('zip 아님');
  return zipEntries(
    dir.map((e) => {
      const data = readZipEntry(buf, e, 64 * 1024 * 1024);
      if (!data) throw new Error(`읽기 실패: ${e.name}`);
      const fix = patches[e.name];
      return {
        name: renames[e.name] ?? e.name,
        data: fix ? Buffer.from(fix(data.toString('utf8')), 'utf8') : data,
        date: new Date(1980, 0, 1),
      };
    }),
  );
}

/** ZIP 목차(중앙 디렉토리)에 적힌, 압축을 푼 크기를 바꾼다 (실제 내용은 그대로) */
function withDeclaredSize(zip: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zip);
  for (let p = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); p > 0; p -= 1) {
    if (out.readUInt32LE(p) !== 0x02014b50) continue;
    const nameLen = out.readUInt16LE(p + 28);
    if (out.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      out.writeUInt32LE(size, p + 24);
      return out;
    }
  }
  throw new Error(`항목 없음: ${name}`);
}

/** SheetView 가 그리는 행 번호(h <= 0 행은 숨김, 1..maxRow): web/src/office/SheetView.tsx SheetGeom 과 같은 규칙 */
function drawnRows(pg: SheetPage): number[] {
  const hidden = new Set(pg.rows.filter((row) => typeof row.h === 'number' && row.h <= 0).map((row) => row.r));
  const out: number[] = [];
  for (let r = 1; r <= pg.maxRow; r += 1) if (!hidden.has(r)) out.push(r);
  return out;
}

/** 1x1 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('formatNumber: 일반, 숫자 서식', () => {
  it('일반(General): 정수는 그대로, 소수는 유효숫자 10자리, 아주 크거나 작으면 지수', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(42, 'General')).toBe('42');
    expect(formatNumber(-7)).toBe('-7');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(Math.PI)).toBe('3.141592654');
    expect(formatNumber(-0.5)).toBe('-0.5');
    expect(formatNumber(123456.789)).toBe('123456.789');
    expect(formatNumber(1234567890123)).toBe('1234567890123');
    expect(formatNumber(12345678901.5)).toBe('12345678902');
    expect(formatNumber(1e20)).toBe('1E+20');
    expect(formatNumber(1.5e-10)).toBe('1.5E-10');
    expect(formatNumber(0.000123)).toBe('0.000123');
  });

  it('정수, 소수 자리: 0.5 는 0 에서 먼 쪽으로, 이진 오차 없이 반올림', () => {
    expect(formatNumber(2.5, '0')).toBe('3');
    expect(formatNumber(-2.5, '0')).toBe('-3');
    expect(formatNumber(1.005, '0.00')).toBe('1.01');
    expect(formatNumber(3.14159, '0.000')).toBe('3.142');
    expect(formatNumber(0.004, '0.00')).toBe('0.00');
    expect(formatNumber(7, '000')).toBe('007');
    expect(formatNumber(5, '#.##')).toBe('5.');
    expect(formatNumber(0.5, '#.00')).toBe('.50');
    expect(formatNumber(1.5, '0.0#')).toBe('1.5');
    expect(formatNumber(1.25, '0.0#')).toBe('1.25');
    expect(formatNumber(1.5, '0.0?')).toBe('1.5 ');
  });

  it('천 단위 쉼표, 끝 쉼표(1,000 으로 나누기)', () => {
    expect(formatNumber(1234567.8, '#,##0')).toBe('1,234,568');
    expect(formatNumber(-1234.5, '#,##0.00')).toBe('-1,234.50');
    expect(formatNumber(0, '#,##0')).toBe('0');
    expect(formatNumber(999, '#,##0')).toBe('999');
    expect(formatNumber(5, '0,000')).toBe('0,005');
    expect(formatNumber(1234567, '#,##0,')).toBe('1,235');
    expect(formatNumber(12345678, '0.0,,')).toBe('12.3');
  });

  it('백분율', () => {
    expect(formatNumber(0.256, '0%')).toBe('26%');
    expect(formatNumber(0.1234, '0.0%')).toBe('12.3%');
    expect(formatNumber(1, '0.00%')).toBe('100.00%');
    expect(formatNumber(-0.05, '0%')).toBe('-5%');
    expect(formatNumber(0.07, '0%')).toBe('7%');
  });

  it('지수 표기', () => {
    expect(formatNumber(12345, '0.00E+00')).toBe('1.23E+04');
    expect(formatNumber(0.000123, '0.00E+00')).toBe('1.23E-04');
    expect(formatNumber(0, '0.00E+00')).toBe('0.00E+00');
    expect(formatNumber(-12345, '0.00E+00')).toBe('-1.23E+04');
    expect(formatNumber(9.999, '0.00E+00')).toBe('1.00E+01');
    expect(formatNumber(12345, '##0.0E+0')).toBe('12.3E+3');
    expect(formatNumber(1500, '0.0E-0')).toBe('1.5E3');
  });

  it('따옴표 글자, 역슬래시 글자, 통화 기호 [$₩-412]', () => {
    expect(formatNumber(1234, '"₩"#,##0')).toBe('₩1,234');
    expect(formatNumber(5000, '#,##0"원"')).toBe('5,000원');
    expect(formatNumber(1234, '[$₩-412]#,##0')).toBe('₩1,234');
    expect(formatNumber(5.25, '0.0 "mg/dL"')).toBe('5.3 mg/dL');
    expect(formatNumber(2.5, '0.0\\m')).toBe('2.5m');
    expect(formatNumber(5, '0.0\\%')).toBe('5.0%');
    expect(formatNumber(5551234567, '(###) ###-####')).toBe('(555) 123-4567');
  });

  it('구역(양수;음수;0;글자), 색, 조건, 너비 맞춤', () => {
    expect(formatNumber(-1234, '#,##0;(#,##0)')).toBe('(1,234)');
    expect(formatNumber(1234, '#,##0;(#,##0)')).toBe('1,234');
    expect(formatNumber(0, '0;-0;"영"')).toBe('영');
    expect(formatNumber(0, '0;-0;;@')).toBe('');
    expect(formatNumber(-1.5, '[Red]0.00;[Blue]-0.00')).toBe('-1.50');
    expect(formatNumber(3, '0.00_);(0.00)')).toBe('3.00');
    const acct = '_-* #,##0_-;\\-* #,##0_-;_-* "-"_-;_-@_-';
    expect(formatNumber(1234, acct)).toBe('1,234');
    expect(formatNumber(-1234, acct)).toBe('-1,234');
    expect(formatNumber(0, acct)).toBe('-');
    const cond = '[>=100]"높음";[<0]"음수";0';
    expect(formatNumber(150, cond)).toBe('높음');
    expect(formatNumber(-1, cond)).toBe('음수');
    expect(formatNumber(50, cond)).toBe('50');
  });

  it('모르는 서식(분수 등)과 글자 서식(@)은 일반 서식으로', () => {
    expect(formatNumber(1.25, '# ?/?')).toBe('1.25');
    expect(formatNumber(12.5, '@')).toBe('12.5');
    expect(formatNumber(Number.NaN, '0')).toBe('#NUM!');
  });
});

describe('formatNumber: 날짜로 나타낼 수 없는 일련번호', () => {
  it('JS 날짜 범위를 넘는 일련번호는 숫자로 둔다 (NaN, undefined, 예외 없음)', () => {
    const fmts = ['yyyy', 'YYYY', 'mmm', 'mmmm', 'mmmmm', 'dddd', 'DD"일"', 'yyyy-mm-dd hh:mm:ss', '[h]:mm', 'aaa'];
    for (const n of [1e9, 123456789012, 8.64e15, 1e300]) {
      for (const fmt of fmts) {
        const out = formatNumber(n, fmt);
        expect(out, `${n} ${fmt}`).not.toMatch(/NaN|undefined/);
        expect(out, `${n} ${fmt}`).toBe(formatNumber(n));
      }
    }
    expect(formatNumber(1e9, 'yyyy')).toBe('1000000000');
    expect(formatNumber(123456789012, 'DD"일"')).toBe('123456789012');
    // 9999년까지는 날짜, 그 뒤는 숫자 (엑셀은 ##### 로 보인다)
    expect(formatNumber(2_958_465, 'yyyy-mm-dd')).toBe('9999-12-31');
    expect(formatNumber(2_958_466, 'yyyy-mm-dd')).toBe('2958466');
  });
});

describe('formatNumber: 날짜, 시각', () => {
  const d = serial(2026, 1, 2); // 2026-01-02 금요일

  it('연, 월, 일과 한국어 글자', () => {
    expect(formatNumber(d, 'yyyy-mm-dd')).toBe('2026-01-02');
    expect(formatNumber(d, 'yyyy"년" m"월" d"일"')).toBe('2026년 1월 2일');
    expect(formatNumber(d, 'yy/mm/dd')).toBe('26/01/02');
    expect(formatNumber(d, 'YYYY.MM.DD')).toBe('2026.01.02');
    expect(formatNumber(d, 'mmm d, yyyy')).toBe('Jan 2, 2026');
    expect(formatNumber(d, 'mmmm')).toBe('January');
    expect(formatNumber(d, 'mmmmm')).toBe('J');
    expect(formatNumber(d, 'dddd')).toBe('Friday');
    expect(formatNumber(d, 'ddd')).toBe('Fri');
  });

  it('로캘: [$-412] 요일, aaa/aaaa, 시스템 긴 날짜, 기본 서식 14', () => {
    expect(formatNumber(d, '[$-412]yyyy-mm-dd ddd')).toBe('2026-01-02 금');
    expect(formatNumber(d, '[$-412]dddd')).toBe('금요일');
    expect(formatNumber(d, 'yyyy-mm-dd (aaa)')).toBe('2026-01-02 (금)');
    expect(formatNumber(d, 'aaaa')).toBe('금요일');
    expect(formatNumber(d, '[$-x-sysdate]dddd, mmmm dd, yyyy')).toBe('2026년 1월 2일 금요일');
    expect(formatNumber(d, 'mm-dd-yy')).toBe('2026-01-02');
    expect(formatNumber(d + 0.5, 'm/d/yy "h":mm')).toBe('2026-01-02 12:00');
  });

  it('시각: 분/월 구분, 12시간제, 경과 시간, 소수 초, 초 단위 반올림', () => {
    expect(formatNumber(0.5, 'h:mm')).toBe('12:00');
    expect(formatNumber(0.75 + 1 / 86_400, 'hh:mm:ss')).toBe('18:00:01');
    expect(formatNumber(0.75, 'h:mm AM/PM')).toBe('6:00 PM');
    expect(formatNumber(0.25, 'h:mm am/pm')).toBe('6:00 am');
    expect(formatNumber(0.25, '[$-412]AM/PM h:mm')).toBe('오전 6:00');
    expect(formatNumber(0.75, '[$-412]AM/PM h:mm')).toBe('오후 6:00');
    expect(formatNumber(30 / 1440, 'mm:ss')).toBe('30:00');
    expect(formatNumber(1.5, '[h]:mm')).toBe('36:00');
    expect(formatNumber(1.5, '[mm]:ss')).toBe('2160:00');
    expect(formatNumber(d + 0.5, 'yyyy-mm-dd hh:mm')).toBe('2026-01-02 12:00');
    expect(formatNumber((10 * 3600 + 29 * 60 + 59.6) / 86_400, 'h:mm')).toBe('10:30');
    expect(formatNumber((10 * 3600 + 29 * 60 + 40) / 86_400, 'h:mm')).toBe('10:29');
    expect(formatNumber(1.25 / 86_400, 'ss.00')).toBe('01.25');
    expect(formatNumber(0.999_999_99, 'yyyy-mm-dd hh:mm:ss')).toBe('1900-01-01 00:00:00');
  });

  it('1900 체계의 가짜 윤일, 0일과 1904 체계', () => {
    expect(formatNumber(1, 'yyyy-mm-dd')).toBe('1900-01-01');
    expect(formatNumber(59, 'yyyy-mm-dd')).toBe('1900-02-28');
    expect(formatNumber(60, 'yyyy-mm-dd')).toBe('1900-02-29');
    expect(formatNumber(61, 'yyyy-mm-dd')).toBe('1900-03-01');
    expect(formatNumber(0, 'yyyy-mm-dd')).toBe('1900-01-00');
    expect(formatNumber(d - 1462, 'yyyy-mm-dd', true)).toBe('2026-01-02');
    expect(formatNumber(d - 1462, 'dddd', true)).toBe('Friday');
    expect(formatNumber(-1, 'yyyy-mm-dd')).toBe('-1'); // 음수 날짜는 엑셀이 #### 로 보인다: 숫자로 둔다
  });
});

describe('formatCellValue: ExcelJS 값 종류', () => {
  it('값 종류별 화면 글자', () => {
    expect(formatCellValue({ value: null })).toBe('');
    expect(formatCellValue({ value: true })).toBe('TRUE');
    expect(formatCellValue({ value: false })).toBe('FALSE');
    expect(formatCellValue({ value: '검체' })).toBe('검체');
    expect(formatCellValue({ value: 'A1', numFmt: '"품번: "@' })).toBe('품번: A1');
    expect(formatCellValue({ value: '숨김', numFmt: ';;;' })).toBe('');
    expect(formatCellValue({ value: 3, numFmt: ';;;' })).toBe('');
    expect(formatCellValue({ value: { richText: [{ text: '굵은' }, { text: ' 글자' }] } })).toBe('굵은 글자');
    expect(formatCellValue({ value: { text: '사이트', hyperlink: 'https://example.com' } })).toBe('사이트');
    expect(
      formatCellValue({ value: { text: { richText: [{ text: '링크' }] }, hyperlink: 'https://example.com' } }),
    ).toBe('링크');
    expect(formatCellValue({ value: { formula: 'A1*2', result: 0.5 }, numFmt: '0%' })).toBe('50%');
    expect(formatCellValue({ value: { sharedFormula: 'B2', result: 3 } })).toBe('3');
    expect(formatCellValue({ value: { formula: 'A1' } })).toBe('');
    expect(formatCellValue({ value: { formula: '1/0', result: { error: '#DIV/0!' } } })).toBe('#DIV/0!');
    expect(formatCellValue({ value: { error: '#N/A' } })).toBe('#N/A');
  });

  it('Date: UTC 날짜를 일련번호로 되돌려 서식 적용 (1904 체계 포함)', () => {
    const dt = new Date(Date.UTC(2026, 0, 2, 13, 30));
    expect(formatCellValue({ value: dt, numFmt: 'yyyy-mm-dd hh:mm' })).toBe('2026-01-02 13:30');
    expect(formatCellValue({ value: dt, numFmt: 'yyyy-mm-dd hh:mm' }, true)).toBe('2026-01-02 13:30');
    expect(formatCellValue({ value: new Date(Date.UTC(2026, 0, 2)) })).toBe('2026-01-02');
    expect(formatCellValue({ value: dt })).toBe('2026-01-02 13:30:00');
    // 날짜로 잘못 바뀐 숫자(서식에 \m): 숫자로 되돌려 보인다
    expect(formatCellValue({ value: new Date(Date.UTC(1900, 0, 1, 12)), numFmt: '0.0\\m' })).toBe('2.5m');
  });
});

describe('applyTint: 테마 색 밝기', () => {
  const close = (got: string, want: string): void => {
    for (let i = 0; i < 6; i += 2) {
      expect(Math.abs(parseInt(got.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16))).toBeLessThanOrEqual(2);
    }
  };

  it('엑셀 팔레트의 회색 단계와 같다', () => {
    expect(applyTint('FFFFFF', -0.0499893185216834)).toBe('F2F2F2');
    expect(applyTint('FFFFFF', -0.149998474074526)).toBe('D9D9D9');
    expect(applyTint('FFFFFF', -0.249977111117893)).toBe('BFBFBF');
    expect(applyTint('000000', 0.499984740745262)).toBe('7F7F7F');
    expect(applyTint('000000', 0.349986266670736)).toBe('595959');
  });

  it('유채색은 엑셀 값과 채널마다 2 이내', () => {
    close(applyTint('4472C4', 0.7999816888943144), 'D9E1F2');
    close(applyTint('4472C4', -0.249977111117893), '305496');
    expect(applyTint('4472C4', 0)).toBe('4472C4');
  });
});

/** 시트 둘(보임) + 하나(숨김), 병합, 서식, 숨긴 행/열, 틀 고정, 여러 값 종류 */
async function sampleWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('장비 목록', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  ws.getColumn(1).width = 20;
  ws.getColumn(4).hidden = true;

  ws.getCell('A1').value = '장비 점검표';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells('A1:C1');

  ['장비', '점검일', '결과'].forEach((t, i) => {
    const cell = ws.getRow(2).getCell(i + 1);
    cell.value = t;
    cell.font = { bold: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });
  ws.getRow(2).height = 30;

  ws.getCell('A3').value = 'PCR';
  ws.getCell('B3').value = new Date(Date.UTC(2026, 0, 2));
  ws.getCell('B3').numFmt = 'yyyy"년" m"월" d"일"';
  ws.getCell('C3').value = 0.987;
  ws.getCell('C3').numFmt = '0.0%';
  ws.getCell('D3').value = '숨긴 열 글자';

  ws.getCell('A4').value = '숨긴 행 글자';
  ws.getRow(4).hidden = true;

  ws.getCell('A5').value = { formula: 'B3+1', result: serial(2026, 1, 3) };
  ws.getCell('A5').numFmt = 'yyyy-mm-dd';
  ws.getCell('B5').value = { richText: [{ text: '굵은', font: { bold: true } }, { text: ' 글자' }] };
  ws.getCell('C5').value = { text: '사이트', hyperlink: 'https://example.com' };

  ws.getCell('A6').value = 1234567.891;
  ws.getCell('A6').numFmt = '#,##0.00';
  ws.getCell('B6').value = 5000;
  ws.getCell('B6').numFmt = '"₩"#,##0';
  ws.getCell('C6').value = { error: '#N/A' };
  ws.getCell('E6').value = true;

  ws.getCell('A7').value = '테마 색';
  ws.getCell('A7').font = { color: { theme: 4 } };
  ws.getCell('B7').value = '어둡게';
  ws.getCell('B7').font = { color: { theme: 4, tint: -0.25 } as Partial<ExcelJS.Color> };
  ws.getCell('C7').value = '기본 글자색';
  ws.getCell('C7').font = { color: { theme: 1 } };

  for (const ref of ['A8', 'B8', 'C8']) ws.getCell(ref).border = { top: thin, left: thin, bottom: thin, right: thin };

  const memo = wb.addWorksheet('메모');
  memo.getCell('A1').value = 'second sheet';
  memo.getCell('A2').value = '두 번째 시트';

  const secret = wb.addWorksheet('비밀', { state: 'hidden' });
  secret.getCell('A1').value = '숨긴 시트 글자';
  return toBuffer(wb);
}

describe('processXlsx', () => {
  it('보이는 시트마다 한 쪽, 화면 글자와 오프셋, 숨긴 시트/행/열 제외', async () => {
    const r = await processXlsx(await sampleWorkbook(), '장비.xlsx');
    const m = expectInvariants(r);
    expect(r.pages.map((p) => p.label)).toEqual(['장비 목록', '메모']);
    expect(r.truncated).toBeNull();
    expect(r.pages[0]!.text).toBe(
      [
        '장비 점검표',
        '장비\t점검일\t결과',
        'PCR\t2026년 1월 2일\t98.7%',
        '2026-01-03\t굵은 글자\t사이트',
        '1,234,567.89\t₩5,000\t#N/A\tTRUE',
        '테마 색\t어둡게\t기본 글자색',
      ].join('\n'),
    );
    expect(r.pages[1]!.text).toBe('second sheet\n두 번째 시트');
    const all = r.pages.map((p) => p.text).join('\n') + r.render.toString('utf8');
    for (const hidden of ['숨긴 시트 글자', '숨긴 행 글자', '숨긴 열 글자']) expect(all).not.toContain(hidden);

    const pg = m.pages[0]!;
    expect(pg.merges).toEqual([[1, 1, 1, 3]]);
    expect(cellAt(pg, 1, 2)).toBeUndefined(); // 병합에 가려진 칸
    expect(pg.rows.map((row) => row.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 숨긴 행은 글자 없이 높이 0 으로 낸다 (SheetView 는 h <= 0 행을 숨긴다)
    expect(pg.rows.find((row) => row.r === 4)).toEqual({ r: 4, h: 0, cells: [] });
    expect(pg.maxRow).toBe(8);
    expect(pg.maxCol).toBe(5);
    // 파일 너비 20 → ECMA-376 식으로 140px, 너비 없는 열은 엑셀 기본 64px
    expect(pg.colWidths).toEqual([140, 64, 64, 0, 64]);
    expect(pg.defaultRowHeight).toBe(20);
    expect(pg.rows.find((row) => row.r === 2)!.h).toBe(40);
    expect(pg.rows.find((row) => row.r === 3)!.h).toBeUndefined();
    expect(pg.frozen).toEqual({ rows: 2, cols: 1 });
    expect(m.pages[1]!.frozen).toBeUndefined();
  });

  it('셀 서식: 굵게, 채우기, 테두리, 정렬, 테마 색, 숫자 표시', async () => {
    const r = await processXlsx(await sampleWorkbook(), '장비.xlsx');
    const m = modelOf(r);
    const pg = m.pages[0]!;
    expect(styleAt(m, pg, 1, 1)).toEqual({ b: true, sz: 14, bg: '#ffff00', ha: 'center', va: 'middle' });
    const line = { w: 1, style: 'solid', color: '#000000' };
    expect(styleAt(m, pg, 2, 2)).toEqual({ b: true, bt: line, br: line, bb: line, bl: line });
    expect(styleAt(m, pg, 3, 2)?.num).toBe(true);
    expect(styleAt(m, pg, 3, 3)?.num).toBe(true);
    expect(styleAt(m, pg, 6, 1)?.num).toBe(true);
    expect(styleAt(m, pg, 5, 1)?.num).toBe(true); // 수식 결과가 날짜
    expect(styleAt(m, pg, 3, 1)).toBeUndefined(); // 글자 + 기본 서식
    // ExcelJS 기본 테마 accent1 = 4F81BD
    expect(styleAt(m, pg, 7, 1)).toEqual({ color: '#4f81bd' });
    expect(styleAt(m, pg, 7, 2)).toEqual({ color: `#${applyTint('4F81BD', -0.25).toLowerCase()}` });
    expect(styleAt(m, pg, 7, 3)).toBeUndefined(); // 기본 검정 글자색은 뺀다
    // 글자 없이 테두리만 있는 칸도 격자를 그리도록 넣는다
    expect(cellAt(pg, 8, 1)).toEqual({ c: 1, s: expect.any(Number) });
    expect(styleAt(m, pg, 8, 1)).toEqual({ bt: line, br: line, bb: line, bl: line });
    // 같은 서식은 한 번만
    const keys = m.styles.map((s) => JSON.stringify(s));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('소수 글꼴 크기(10.5pt)를 지킨다 (ExcelJS 는 정수로 읽는다)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '작은 글자';
    ws.getCell('A1').font = { size: 10.5, name: '맑은 고딕' };
    const r = await processXlsx(await toBuffer(wb), 'f.xlsx');
    const m = expectInvariants(r);
    expect(styleAt(m, m.pages[0]!, 1, 1)).toEqual({ sz: 10.5, font: '맑은 고딕' });
  });

  it('CSS 로 갈 수 없는 글꼴 이름은 모델에 넣지 않는다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '글자';
    ws.getCell('A1').font = { name: 'x;} body{background:url(a)', bold: true };
    const r = await processXlsx(await toBuffer(wb), 'f.xlsx');
    const m = expectInvariants(r);
    expect(styleAt(m, m.pages[0]!, 1, 1)).toEqual({ b: true });
  });

  it('모든 시트가 숨겨져 있으면 전부 넣는다', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('가', { state: 'hidden' }).getCell('A1').value = '하나';
    wb.addWorksheet('나', { state: 'veryHidden' }).getCell('A1').value = '둘';
    const r = await processXlsx(await toBuffer(wb), 'h.xlsx');
    expectInvariants(r);
    expect(r.pages.map((p) => [p.label, p.text])).toEqual([
      ['가', '하나'],
      ['나', '둘'],
    ]);
  });

  it('병합 기준 칸의 오른쪽, 아래 테두리는 범위 끝 칸에서 가져온다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('B2').value = '병합';
    ws.getCell('B2').border = { top: thin, left: thin };
    ws.getCell('C2').border = { top: thin, right: thin };
    ws.getCell('B3').border = { left: thin, bottom: { style: 'medium', color: { argb: 'FFFF0000' } } };
    ws.mergeCellsWithoutStyle('B2:C3');
    const r = await processXlsx(await toBuffer(wb), 'm.xlsx');
    const m = expectInvariants(r);
    const pg = m.pages[0]!;
    expect(pg.merges).toEqual([[2, 2, 3, 3]]);
    const line = { w: 1, style: 'solid', color: '#000000' };
    expect(styleAt(m, pg, 2, 2)).toEqual({ bt: line, br: line, bb: { w: 2, style: 'solid', color: '#ff0000' }, bl: line });
    expect(pg.rows.map((row) => row.r)).toEqual([2]);
    expect(pg.maxRow).toBe(3);
    expect(pg.maxCol).toBe(3);
  });

  it('병합 기준 칸이 숨긴 열, 행에 있으면 보이는 첫 칸으로 옮긴다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '제목';
    ws.mergeCells('A1:C1');
    ws.getColumn(1).hidden = true;
    ws.getCell('B3').value = '세로';
    ws.mergeCells('B3:B5');
    ws.getRow(3).hidden = true;
    const r = await processXlsx(await toBuffer(wb), 'm.xlsx');
    const m = expectInvariants(r);
    const pg = m.pages[0]!;
    expect(r.pages[0]!.text).toBe('제목\n세로');
    expect(cellAt(pg, 1, 2)?.t).toBe('제목');
    expect(cellAt(pg, 4, 2)?.t).toBe('세로');
    expect(pg.merges).toEqual([
      [1, 2, 1, 3],
      [4, 2, 5, 2],
    ]);
    expect(pg.colWidths[0]).toBe(0);
  });

  it('1904 날짜 체계 통합문서', async () => {
    const wb = new ExcelJS.Workbook();
    wb.properties.date1904 = true;
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = new Date(Date.UTC(2026, 0, 2));
    ws.getCell('A1').numFmt = 'yyyy-mm-dd (aaa)';
    const r = await processXlsx(await toBuffer(wb), 'd.xlsx');
    expectInvariants(r);
    expect(r.pages[0]!.text).toBe('2026-01-02 (금)');
  });

  it('서식 정의 없이 번호만 쓴 한국어 기본 날짜 서식(31)을 되살린다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = serial(2026, 1, 2);
    ws.getCell('A1').numFmt = 'yyyy"년" mm"월" dd"일"';
    const buf = patchZip(await toBuffer(wb), {
      'xl/styles.xml': (s) => s.replace(/<numFmt numFmtId="164"[^>]*\/>/, '').replace(/numFmtId="164"/g, 'numFmtId="31"'),
    });
    const r = await processXlsx(buf, 'k.xlsx');
    expectInvariants(r);
    expect(r.pages[0]!.text).toBe('2026년 01월 02일');
  });

  it('사용자 서식의 역슬래시 글자(\\m, \\%)를 지키고 날짜로 오인하지 않는다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 2.5;
    ws.getCell('A1').numFmt = '0.0\\m';
    ws.getCell('B1').value = 5;
    ws.getCell('B1').numFmt = '0.0\\%';
    const r = await processXlsx(await toBuffer(wb), 'e.xlsx');
    const m = expectInvariants(r);
    expect(r.pages[0]!.text).toBe('2.5m\t5.0%');
    expect(styleAt(m, m.pages[0]!, 1, 1)?.num).toBe(true);
  });

  it('메모, 그림 부속이 ExcelJS 의 예상과 달라도 읽는다 (쓰지 않는 부속은 떼어 낸다)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '메모 있음';
    ws.getCell('A1').note = '메모 글자';
    ws.getCell('A2').value = { text: '링크', hyperlink: 'https://example.com' };
    ws.addImage(wb.addImage({ buffer: PNG_1PX as unknown as ArrayBuffer, extension: 'png' }), 'C2:D3');
    const buf = await toBuffer(wb);
    // ExcelJS 4.4.0 은 둘 다 TypeError 로 멈춘다: 메모 부속 이름이 commentsN.xml 이 아님, 그림 관계 빠짐
    const renamedComments = patchZip(
      buf,
      { 'xl/worksheets/_rels/sheet1.xml.rels': (s) => s.replace('../comments1.xml', '../comments/comment1.xml') },
      { 'xl/comments1.xml': 'xl/comments/comment1.xml' },
    );
    const missingImageRel = patchZip(buf, {
      'xl/drawings/_rels/drawing1.xml.rels': (s) => s.replace(/<Relationship [^>]*\/>/g, ''),
    });
    for (const b of [buf, renamedComments, missingImageRel]) {
      const r = await processXlsx(b, 'c.xlsx');
      expectInvariants(r);
      expect(r.pages[0]!.text).toBe('메모 있음\n링크');
      expect(r.render.toString('utf8')).not.toContain('메모 글자');
    }
  });

  it('요소 이름에 접두사를 쓴 SpreadsheetML(<x:row> 등, .NET 내보내기)도 읽는다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('목록');
    ws.getCell('A1').value = '장비';
    ws.getCell('B1').value = 1234.5;
    ws.getCell('B1').numFmt = '#,##0.0';
    ws.getCell('A2').value = '숨김';
    ws.getRow(2).hidden = true;
    ws.getCell('A3').value = '병합';
    ws.mergeCells('A3:B3');
    const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const prefixAll = (s: string): string =>
      s.replace(`xmlns="${MAIN}"`, `xmlns:x="${MAIN}"`).replace(/<(\/?)([A-Za-z]\w*)(?=[\s>/])/g, '<$1x:$2');
    const prefixed = patchZip(await toBuffer(wb), {
      'xl/workbook.xml': prefixAll,
      'xl/worksheets/sheet1.xml': prefixAll,
      'xl/sharedStrings.xml': prefixAll,
      'xl/styles.xml': prefixAll,
    });
    const plain = new ExcelJS.Workbook();
    const plainReads = await plain.xlsx.load(prefixed as unknown as ArrayBuffer).then(
      () => plain.worksheets.length > 0,
      () => false,
    );
    expect(plainReads).toBe(false); // ExcelJS 만으로는 읽지 못한다
    for (const trimSheetBytes of [Number.POSITIVE_INFINITY, 0]) {
      const r = await processXlsx(prefixed, 'p.xlsx', { trimSheetBytes });
      const m = expectInvariants(r);
      expect(r.pages[0]!.label).toBe('목록');
      expect(r.pages[0]!.text).toBe('장비\t1,234.5\n병합');
      expect(m.pages[0]!.merges).toEqual([[3, 1, 3, 2]]);
    }
  });

  it('아주 큰 병합 범위는 빼고 읽는다 (메모리 보호)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '머리';
    ws.getCell('B2').value = '값';
    const buf = patchZip(await toBuffer(wb), {
      'xl/worksheets/sheet1.xml': (s) =>
        s.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>'),
    });
    const started = performance.now();
    const r = await processXlsx(buf, 'big.xlsx');
    expect(performance.now() - started).toBeLessThan(5000);
    const m = expectInvariants(r);
    expect(m.pages[0]!.merges).toEqual([]);
    expect(r.pages[0]!.text).toBe('머리\n값');
  });

  describe('상한: 색인과 표시를 같은 자리에서 자른다', () => {
    async function grid(): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const a = wb.addWorksheet('A');
      for (let r = 1; r <= 5; r += 1) for (let c = 1; c <= 4; c += 1) a.getRow(r).getCell(c).value = `a${r}${c}`;
      const b = wb.addWorksheet('B');
      b.getCell('A1').value = 'b1';
      b.getCell('A2').value = 'b2';
      return toBuffer(wb);
    }

    it('열 상한', async () => {
      const r = await processXlsx(await grid(), 'g.xlsx', { maxCols: 2 });
      const m = expectInvariants(r);
      expect(r.pages[0]!.text.split('\n')[0]).toBe('a11\ta12');
      expect(m.pages[0]!.maxCol).toBe(2);
      expect(m.pages[0]!.truncated).toBe(true);
      expect(m.pages[1]!.truncated).toBeUndefined();
      expect(r.truncated).toBe('표가 커서 앞 2열까지만 색인하고 보여줍니다.');
    });

    it('시트당 행 상한', async () => {
      const r = await processXlsx(await grid(), 'g.xlsx', { maxRowsPerSheet: 2 });
      const m = expectInvariants(r);
      expect(r.pages[0]!.text).toBe('a11\ta12\ta13\ta14\na21\ta22\ta23\ta24');
      expect(r.pages[1]!.text).toBe('b1\nb2');
      expect(m.pages[0]!.truncated).toBe(true);
      expect(m.pages[1]!.truncated).toBeUndefined();
      expect(m.pages[0]!.maxRow).toBe(2);
      expect(r.truncated).toContain('시트마다 앞 2행');
    });

    it('전체 셀 상한: 뒤 시트는 빈 쪽으로 남긴다', async () => {
      const r = await processXlsx(await grid(), 'g.xlsx', { maxCellsTotal: 6 });
      const m = expectInvariants(r);
      expect(r.pages[0]!.text).toBe('a11\ta12\ta13\ta14');
      expect(r.pages.map((p) => p.label)).toEqual(['A', 'B']);
      expect(r.pages[1]!.text).toBe('');
      expect(m.pages[1]!.rows).toEqual([]);
      expect(m.pages[1]!.truncated).toBe(true);
      expect(r.truncated).toContain('전체 6개 셀');
    });

    it('큰 시트는 ExcelJS 에 넘기기 전에 행을 잘라 낸다: 자르지 않은 결과와 같다', async () => {
      const buf = await grid();
      const cut = await processXlsx(buf, 'g.xlsx', { maxRowsPerSheet: 2, trimSheetBytes: 0 });
      const full = await processXlsx(buf, 'g.xlsx', { maxRowsPerSheet: 2, trimSheetBytes: Number.POSITIVE_INFINITY });
      const m = expectInvariants(cut);
      expect(cut.pages).toEqual(full.pages);
      expect(m).toEqual(modelOf(full));
      expect(m.pages[0]!.truncated).toBe(true);
      expect(m.pages[1]!.truncated).toBeUndefined(); // 2행뿐인 시트는 자르지 않는다
      expect(cut.truncated).toBe('표가 커서 시트마다 앞 2행까지만 색인하고 보여줍니다.');
    });

    it('미리 자를 때 전체 셀 상한도 추출기와 같은 순서로 쓴다: 뒤 시트는 비운다', async () => {
      const buf = await grid();
      const cut = await processXlsx(buf, 'g.xlsx', { maxCellsTotal: 6, trimSheetBytes: 0 });
      const full = await processXlsx(buf, 'g.xlsx', { maxCellsTotal: 6, trimSheetBytes: Number.POSITIVE_INFINITY });
      const m = expectInvariants(cut);
      expect(cut.pages).toEqual(full.pages);
      expect(m).toEqual(modelOf(full));
      expect(cut.pages.map((p) => p.text)).toEqual(['a11\ta12\ta13\ta14', '']);
      expect(cut.truncated).toBe('표가 커서 전체 6개 셀까지만 색인하고 보여줍니다.');
    });

    it('미리 자를 때 화면에 나오지 않는 숨긴 시트는 넘기지 않고, 열 상한 밖 셀은 세지 않는다', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      for (let r = 1; r <= 3; r += 1) {
        ws.getCell(r, 1).value = `v${r}`;
        ws.getCell(r, 5).value = 'far'; // 열 상한(2) 밖
      }
      const hidden = wb.addWorksheet('H', { state: 'hidden' });
      for (let r = 1; r <= 50; r += 1) hidden.getCell(r, 1).value = r;
      const buf = await toBuffer(wb);
      const opts = { maxCols: 2, maxCellsTotal: 3 };
      const cut = await processXlsx(buf, 'h.xlsx', { ...opts, trimSheetBytes: 0 });
      const full = await processXlsx(buf, 'h.xlsx', { ...opts, trimSheetBytes: Number.POSITIVE_INFINITY });
      expectInvariants(cut);
      expect(cut.pages).toEqual(full.pages);
      expect(cut.pages.map((p) => p.text)).toEqual(['v1\nv2\nv3']);
      expect(cut.truncated).toBe('표가 커서 앞 2열까지만 색인하고 보여줍니다.');
    });

    it('미리 덜어 낼 때 숨긴 행의 셀은 비우되 병합 기준 칸과 공유 수식 기준 셀은 지킨다', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = '보임';
      ws.getCell('A2').value = '숨김';
      ws.getCell('B3').value = '병합 제목'; // 숨긴 행에 있는 병합 기준 칸
      ws.mergeCells('B3:C4');
      ws.getCell('D5').value = { formula: 'A1&"!"', result: '보임!', shareType: 'shared', ref: 'D5:D6' } as unknown as ExcelJS.CellValue;
      ws.getCell('D6').value = { sharedFormula: 'D5', result: '공유 결과' } as unknown as ExcelJS.CellValue;
      for (const r of [2, 3, 5]) ws.getRow(r).hidden = true;
      ws.getCell('A7').value = '끝';
      const buf = await toBuffer(wb);
      const cut = await processXlsx(buf, 's.xlsx', { trimSheetBytes: 0 });
      const full = await processXlsx(buf, 's.xlsx', { trimSheetBytes: Number.POSITIVE_INFINITY });
      const m = expectInvariants(cut);
      expect(cut.pages).toEqual(full.pages);
      expect(m).toEqual(modelOf(full));
      expect(cut.pages[0]!.text).toBe('보임\n병합 제목\n공유 결과\n끝');
      expect(m.pages[0]!.merges).toEqual([[4, 2, 4, 3]]);
      expect(cut.truncated).toBeNull();
    });

    it('미리 자를 때 숨긴 행은 세지 않는다', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      for (let r = 1; r <= 4; r += 1) ws.getCell(r, 1).value = `r${r}`;
      ws.getRow(2).hidden = true;
      const r = await processXlsx(await toBuffer(wb), 'h.xlsx', { maxRowsPerSheet: 2, trimSheetBytes: 0 });
      const m = expectInvariants(r);
      expect(r.pages[0]!.text).toBe('r1\nr3');
      expect(m.pages[0]!.truncated).toBe(true);
    });

    it('자른 뒤에도 시트 내용이 너무 크면 안내와 함께 거부한다', async () => {
      const p = processXlsx(await grid(), 'g.xlsx', { maxSheetXmlBytes: 100 });
      await expect(p).rejects.toBeInstanceOf(OfficeParseError);
      await expect(p).rejects.toThrow('너무 커서');
    });

    it('전체 글자 상한', async () => {
      // 한 행 = 글자 3자 셀 4개 + 구분자 = 16자로 센다: 두 행(32자)까지 들어간다
      const r = await processXlsx(await grid(), 'g.xlsx', { maxTextChars: 35 });
      const m = expectInvariants(r);
      expect(r.pages[0]!.text).toBe('a11\ta12\ta13\ta14\na21\ta22\ta23\ta24');
      expect(r.pages[1]!.text).toBe('');
      expect(m.pages[1]!.truncated).toBe(true);
      expect(r.truncated).toContain('전체 35자');
    });
  });

  describe('숨긴 행: 높이 0 행으로 낸다', () => {
    /** 자동 필터처럼 머리글 + 30행 중 5의 배수 행만 보이고, 숨긴 행을 가로지르는 병합이 있다 */
    async function filtered(): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('목록');
      ws.getCell('A1').value = '검사';
      ws.getCell('B1').value = '결과';
      for (let r = 2; r <= 31; r += 1) {
        ws.getCell(r, 1).value = r % 5 === 0 ? 'HbA1c' : 'CBC';
        ws.getCell(r, 2).value = r;
        if (r % 5 !== 0) ws.getRow(r).hidden = true;
      }
      ws.autoFilter = 'A1:B31';
      ws.getCell('D5').value = '병합';
      ws.mergeCells('D5:D10'); // 6~9행이 숨겨져 있다
      return toBuffer(wb);
    }

    it('그리는 범위 안의 숨긴 행마다 글자 없는 h 0 행, 화면에는 보이는 행만', async () => {
      for (const trimSheetBytes of [Number.POSITIVE_INFINITY, 0]) {
        const r = await processXlsx(await filtered(), 'f.xlsx', { trimSheetBytes });
        const m = expectInvariants(r);
        const pg = m.pages[0]!;
        expect(r.pages[0]!.text).toBe(['검사\t결과', 'HbA1c\t5\t병합', 'HbA1c\t10', 'HbA1c\t15', 'HbA1c\t20', 'HbA1c\t25', 'HbA1c\t30'].join('\n'));
        expect(pg.maxRow).toBe(30); // 31행(숨김)은 그리는 범위 밖이라 내지 않는다
        const hidden = pg.rows.filter((row) => row.h === 0);
        const expected = Array.from({ length: 29 }, (_, i) => i + 2).filter((n) => n % 5 !== 0);
        expect(hidden.map((row) => row.r)).toEqual(expected);
        for (const row of hidden) expect(row.cells).toEqual([]);
        expect(drawnRows(pg)).toEqual([1, 5, 10, 15, 20, 25, 30]);
        // 병합은 보이는 행 5, 10 을 잇는다 (SheetView 는 그 사이 숨긴 행을 세지 않는다)
        expect(pg.merges).toEqual([[5, 4, 10, 4]]);
      }
    });

    it('첫 내용 행 앞의 숨긴 행도 낸다', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      for (let r = 1; r <= 4; r += 1) ws.getCell(r, 1).value = `r${r}`;
      ws.getRow(1).hidden = true;
      ws.getRow(2).hidden = true;
      const m = expectInvariants(await processXlsx(await toBuffer(wb), 'h.xlsx'));
      expect(m.pages[0]!.rows.map((row) => [row.r, row.h])).toEqual([
        [1, 0],
        [2, 0],
        [3, undefined],
        [4, undefined],
      ]);
      expect(drawnRows(m.pages[0]!)).toEqual([3, 4]);
    });

    it('높이 0 행 수 상한(maxHiddenRows): 넘는 숨긴 행은 내지 않는다', async () => {
      const r = await processXlsx(await filtered(), 'f.xlsx', { maxHiddenRows: 3 });
      const m = expectInvariants(r);
      expect(m.pages[0]!.rows.filter((row) => row.h === 0).map((row) => row.r)).toEqual([2, 3, 4]);
      expect(r.truncated).toBeNull(); // 색인에는 영향이 없다
    });
  });

  describe('ExcelJS 에 넘기는 패키지: 쓰는 부속만, 실제 크기를 확인하며', () => {
    it('적힌 크기보다 크게 풀리는 부속(ZIP 폭탄 꼴)은 끝까지 풀지 않고 거부한다', async () => {
      const buf = withDeclaredSize(await sampleWorkbook(), 'xl/worksheets/sheet1.xml', 100);
      const p = processXlsx(buf, 'bomb.xlsx');
      await expect(p).rejects.toBeInstanceOf(OfficeParseError);
      await expect(p).rejects.toThrow('손상');
    });

    it('쓰지 않는 부속(그림, 인쇄 설정 등)은 손상돼 있어도 넘기지 않으므로 읽는다', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = '본문';
      ws.addImage(wb.addImage({ buffer: PNG_1PX as unknown as ArrayBuffer, extension: 'png' }), 'C2:D3');
      const buf = withDeclaredSize(await toBuffer(wb), 'xl/media/image1.png', 50_000_000);
      const r = await processXlsx(buf, 'img.xlsx');
      expectInvariants(r);
      expect(r.pages[0]!.text).toBe('본문');
    });

    it("ZIP 항목 이름 앞의 '/' 를 ExcelJS 처럼 떼고 읽으며, 크기 상한에도 센다", async () => {
      const base = await sampleWorkbook();
      const dir = readZipDirectory(base)!;
      const slashed = patchZip(base, {}, Object.fromEntries(dir.map((e) => [e.name, `/${e.name}`])));
      const r = await processXlsx(slashed, 's.xlsx');
      expectInvariants(r);
      expect(r.pages.map((p) => p.label)).toEqual(['장비 목록', '메모']);
      const p = processXlsx(slashed, 's.xlsx', { maxSheetXmlBytes: 1000 });
      await expect(p).rejects.toThrow('너무 커서');
    });

    it('통합문서가 가리키지 않는 시트 부속과, 보이는 시트가 있을 때의 숨긴 시트는 넘기지 않는다', async () => {
      const base = await sampleWorkbook(); // sheet3 = 숨긴 시트 '비밀'
      const sheet1 = readZipEntry(base, readZipDirectory(base)!.find((e) => e.name === 'xl/worksheets/sheet1.xml')!)!;
      const extra = zipEntries([
        ...readZipDirectory(base)!.map((e) => ({ name: e.name, data: readZipEntry(base, e)!, date: new Date(1980, 0, 1) })),
        // 아무도 가리키지 않는 시트 둘: ExcelJS 4.4.0 은 이름 없는 시트 둘이 겹친다며 거부한다
        { name: 'xl/worksheets/sheet7.xml', data: sheet1, date: new Date(1980, 0, 1) },
        { name: 'xl/worksheets/sheet8.xml', data: sheet1, date: new Date(1980, 0, 1) },
      ]);
      const broken = patchZip(extra, { 'xl/worksheets/sheet3.xml': () => '<worksheet><sheetData><row' });
      const r = await processXlsx(broken, 'o.xlsx');
      expectInvariants(r);
      expect(r.pages.map((p) => p.label)).toEqual(['장비 목록', '메모']);
    });

    it('보이는 시트가 차트 시트뿐이고 워크시트는 모두 숨김: 미리 덜어 내도 숨긴 워크시트를 모두 쪽으로 낸다', async () => {
      const wb = new ExcelJS.Workbook();
      const a = wb.addWorksheet('Data', { state: 'hidden' });
      a.getCell('A1').value = 'glucose';
      a.getCell('B1').value = 95;
      wb.addWorksheet('Calc', { state: 'hidden' }).getCell('A1').value = 'mean';
      const CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet';
      const withChart = patchZip(await toBuffer(wb), {
        'xl/workbook.xml': (s) => s.replace('<sheets>', '<sheets><sheet name="Chart1" sheetId="9" r:id="rIdChart"/>'),
        'xl/_rels/workbook.xml.rels': (s) =>
          s.replace('</Relationships>', `<Relationship Id="rIdChart" Type="${CHART}" Target="chartsheets/sheet1.xml"/></Relationships>`),
      });
      const dir = readZipDirectory(withChart)!;
      const buf = zipEntries([
        ...dir.map((e) => ({ name: e.name, data: readZipEntry(withChart, e)!, date: new Date(1980, 0, 1) })),
        { name: 'xl/chartsheets/sheet1.xml', data: Buffer.from('<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'), date: new Date(1980, 0, 1) },
      ]);
      const full = await processXlsx(buf, 'c.xlsx', { trimSheetBytes: Number.POSITIVE_INFINITY });
      const cut = await processXlsx(buf, 'c.xlsx', { trimSheetBytes: 0 });
      expectInvariants(cut);
      expect(cut.pages).toEqual(full.pages);
      expect(modelOf(cut)).toEqual(modelOf(full));
      expect(cut.pages.map((p) => [p.label, p.text])).toEqual([
        ['Data', 'glucose\t95'],
        ['Calc', 'mean'],
      ]);
      expect(cut.truncated).toBeNull();
    });
  });

  describe('ExcelJS 가 파일 전체를 거부하던 변형', () => {
    async function base(): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = 'head';
      ws.getCell('B1').value = 12;
      ws.getCell('A2').value = 'tail';
      return toBuffer(wb);
    }
    const sheet = (fix: (s: string) => string) => ({ 'xl/worksheets/sheet1.xml': fix });

    it('31자를 넘는 시트 이름(openpyxl, pandas), 겹치는 이름, 쓸 수 없는 글자: 원래 이름을 쪽 라벨로', async () => {
      const wb = new ExcelJS.Workbook();
      for (const n of ['A', 'B', 'C', 'D', 'E']) wb.addWorksheet(n).getCell('A1').value = `v${n}`;
      const long1 = 'Hematology QC results 2026 January-March';
      const long2 = 'Hematology QC results 2026 January-June';
      const buf = patchZip(await toBuffer(wb), {
        'xl/workbook.xml': (s) =>
          s
            .replace('name="A"', `name="${long1}"`)
            .replace('name="B"', `name="${long2}"`)
            .replace('name="C"', 'name="QC/Cal"')
            .replace('name="D"', 'name="History"')
            .replace('name="E"', 'name="Sheet1"'),
      });
      const r = await processXlsx(buf, 'n.xlsx');
      expectInvariants(r);
      expect(r.pages.map((p) => [p.label, p.text])).toEqual([
        [long1, 'vA'],
        [long2, 'vB'],
        ['QC/Cal', 'vC'],
        ['History', 'vD'],
        ['Sheet1', 'vE'],
      ]);
    });

    it('시트 번호(sheetId)가 0 이거나 겹쳐도 시트를 잃지 않는다', async () => {
      const wb = new ExcelJS.Workbook();
      for (const n of ['가', '나', '다']) wb.addWorksheet(n).getCell('A1').value = n;
      const zero = patchZip(await toBuffer(wb), { 'xl/workbook.xml': (s) => s.replace('sheetId="1"', 'sheetId="0"') });
      const dup = patchZip(await toBuffer(wb), { 'xl/workbook.xml': (s) => s.replace('sheetId="3"', 'sheetId="2"') });
      for (const buf of [zero, dup]) {
        const r = await processXlsx(buf, 'id.xlsx');
        expectInvariants(r);
        expect(r.pages.map((p) => [p.label, p.text])).toEqual([
          ['가', '가'],
          ['나', '나'],
          ['다', '다'],
        ]);
      }
    });

    it('r 이 없는 행, 행의 첫 셀부터 r 이 없는 셀 (CT_Row, CT_Cell 의 r 은 선택 속성)', async () => {
      const noRowRef = patchZip(await base(), sheet((s) => s.replace(/<row r="\d+"/g, '<row')));
      const noCellRef = patchZip(await base(), sheet((s) => s.replace(/<c r="[A-Z]+\d+"/g, '<c')));
      for (const buf of [noRowRef, noCellRef]) {
        const r = await processXlsx(buf, 'r.xlsx');
        const m = expectInvariants(r);
        expect(r.pages[0]!.text).toBe('head\t12\ntail');
        expect(cellAt(m.pages[0]!, 1, 2)?.t).toBe('12');
        expect(cellAt(m.pages[0]!, 2, 1)?.t).toBe('tail');
      }
    });

    it('같은 병합이 두 번 적혔거나 겹치는 병합: 문서 순서로 먼저 온 것만 쓴다', async () => {
      const merges =
        '<mergeCells count="4"><mergeCell ref="A2:B2"/><mergeCell ref="A2:B2"/><mergeCell ref="B2:C3"/><mergeCell ref="A5:A5"/></mergeCells>';
      const buf = patchZip(await base(), sheet((s) => s.replace('</sheetData>', `</sheetData>${merges}`)));
      const r = await processXlsx(buf, 'm.xlsx');
      const m = expectInvariants(r);
      expect(r.pages[0]!.text).toBe('head\t12\ntail');
      expect(m.pages[0]!.merges).toEqual([[2, 1, 2, 2]]);
    });

    it('t="d" (ISO 8601 날짜) 셀을 날짜로 읽는다: 날짜 서식은 서식대로, 서식 없으면 yyyy-mm-dd, 날짜 아닌 글자는 그대로', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = new Date(Date.UTC(2000, 0, 1));
      ws.getCell('A1').numFmt = 'yyyy-mm-dd';
      ws.getCell('B1').value = new Date(Date.UTC(2000, 0, 1));
      ws.getCell('B1').numFmt = 'yyyy-mm-dd hh:mm';
      ws.getCell('C1').value = 1;
      ws.getCell('D1').value = { formula: 'TODAY()', result: new Date(Date.UTC(2000, 0, 1)) };
      ws.getCell('D1').numFmt = 'yyyy"년" m"월" d"일"';
      ws.getCell('E1').value = 2;
      ws.getCell('F1').value = 3;
      const iso: Record<string, string> = {
        A1: '2026-01-02T00:00:00Z',
        B1: '2026-01-02T13:30:00',
        C1: 'not-a-date',
        D1: '2026-03-01',
        E1: '2026-01-02T08:05:00',
        F1: '1999-12-31',
      };
      const buf = patchZip(await toBuffer(wb), {
        'xl/worksheets/sheet1.xml': (s) =>
          s.replace(/<c r="([A-F]1)"([^>]*)>([\s\S]*?)<v>[^<]*<\/v><\/c>/g, (_all, ref: string, attrs: string, f: string) => {
            return `<c r="${ref}"${attrs.replace(/\st="\w+"/, '')} t="d">${f}<v>${iso[ref]}</v></c>`;
          }),
      });
      expect(readZipEntry(buf, readZipDirectory(buf)!.find((e) => e.name === 'xl/worksheets/sheet1.xml')!)!.toString()).toContain(
        't="d"><f>TODAY()</f><v>2026-03-01</v>',
      );
      const r = await processXlsx(buf, 'd.xlsx');
      const m = expectInvariants(r);
      expect(r.pages[0]!.text).toBe('2026-01-02\t2026-01-02 13:30\tnot-a-date\t2026년 3월 1일\t2026-01-02 8:05:00\t1999-12-31');
      expect(styleAt(m, m.pages[0]!, 1, 1)?.num).toBe(true);
    });

    it('isoToSerial: 1900 체계의 가짜 윤일, 1904 체계, 시각만, 읽을 수 없는 값', () => {
      expect(isoToSerial('2026-01-02', false)).toBe(serial(2026, 1, 2));
      expect(isoToSerial('2026-01-02T12:00:00Z', false)).toBe(serial(2026, 1, 2) + 0.5);
      expect(isoToSerial('2026-01-02 06:00:00+09:00', false)).toBe(serial(2026, 1, 2) + 0.25);
      expect(isoToSerial('1900-01-01', false)).toBe(1);
      expect(isoToSerial('1900-02-28', false)).toBe(59);
      expect(isoToSerial('1900-03-01', false)).toBe(61);
      expect(isoToSerial('1904-01-01', true)).toBe(0);
      expect(isoToSerial('2026-01-02', true)).toBe(serial(2026, 1, 2) - 1462);
      expect(isoToSerial('18:00', false)).toBe(0.75);
      for (const bad of ['', '2026-02-30', '2026-13-01', '1899-12-29', 'abc', '2026-01-02T25:00:00', '12345']) {
        expect(isoToSerial(bad, false), bad).toBeNull();
      }
    });

    it('date1904="true" 도 1904 날짜 체계로 읽는다 (ExcelJS 는 "1" 만 알아본다)', async () => {
      const wb = new ExcelJS.Workbook();
      wb.properties.date1904 = true;
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = new Date(Date.UTC(2026, 0, 2));
      ws.getCell('A1').numFmt = 'yyyy-mm-dd';
      const one = await toBuffer(wb);
      const yes = patchZip(one, { 'xl/workbook.xml': (s) => s.replace('date1904="1"', 'date1904="true"') });
      for (const buf of [one, yes]) {
        const r = await processXlsx(buf, 'd.xlsx');
        expectInvariants(r);
        expect(r.pages[0]!.text).toBe('2026-01-02');
      }
    });

    it('엑셀 한계 밖 행 번호와 아주 큰 <col> 범위: 멈추거나 메모리를 다 쓰지 않는다', async () => {
      const farRow = patchZip(
        await base(),
        sheet((s) => s.replace('</sheetData>', '<row r="2000000000"><c r="A2000000000" t="inlineStr"><is><t>far</t></is></c></row></sheetData>')),
      );
      const hugeCols = patchZip(
        await base(),
        sheet((s) => s.replace('<sheetData>', '<cols><col min="1" max="200000000" width="12" customWidth="1"/></cols><sheetData>')),
      );
      const started = performance.now();
      const a = await processXlsx(farRow, 'a.xlsx');
      expectInvariants(a);
      expect(a.pages[0]!.text).toBe('head\t12\ntail');
      const b = await processXlsx(hugeCols, 'b.xlsx');
      const m = expectInvariants(b);
      expect(b.pages[0]!.text).toBe('head\t12\ntail');
      expect(m.pages[0]!.colWidths).toEqual([84, 84]);
      expect(performance.now() - started).toBeLessThan(5000);
    });

    it('병합이 많아도 빠르다 (ExcelJS 는 병합마다 이미 붙인 병합 전부와 비교한다)', async () => {
      const n = 10_000;
      let rows = '';
      let merges = '';
      for (let r = 1; r <= n; r += 1) {
        rows += `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>v${r}</t></is></c></row>`;
        merges += `<mergeCell ref="A${r}:B${r}"/>`;
      }
      const buf = patchZip(
        await base(),
        sheet((s) => s.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${rows}</sheetData><mergeCells count="${n}">${merges}</mergeCells>`)),
      );
      const started = performance.now();
      const r = await processXlsx(buf, 'many.xlsx', { maxRowsPerSheet: n });
      expect(performance.now() - started).toBeLessThan(4000);
      const m = expectInvariants(r);
      expect(m.pages[0]!.merges).toHaveLength(n);
      expect(m.pages[0]!.merges[n - 1]).toEqual([n, 1, n, 2]);
    }, 20_000);
  });

  it('병합 기준 칸이 파일에 없어도(행 요소 없음, 행의 셀이 기준 칸 앞에서 끝남) 끝 칸의 테두리로 병합을 그린다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '머리';
    ws.getCell('B4').border = { bottom: thin }; // 2행에는 행 요소가 없다
    ws.getCell('A6').value = '왼쪽'; // 6행은 A 열에서 끝난다
    ws.getCell('B7').border = { bottom: thin };
    const merges = '<mergeCells count="2"><mergeCell ref="B2:C4"/><mergeCell ref="B6:C7"/></mergeCells>';
    const buf = patchZip(await toBuffer(wb), {
      'xl/worksheets/sheet1.xml': (s) => s.replace('</sheetData>', `</sheetData>${merges}`),
    });
    expect(readZipEntry(buf, readZipDirectory(buf)!.find((e) => e.name === 'xl/worksheets/sheet1.xml')!)!.toString()).not.toContain(
      '<row r="2"',
    );
    const r = await processXlsx(buf, 'b.xlsx');
    const m = expectInvariants(r);
    const pg = m.pages[0]!;
    expect(r.pages[0]!.text).toBe('머리\n왼쪽');
    expect(pg.merges).toEqual([
      [2, 2, 4, 3],
      [6, 2, 7, 3],
    ]);
    const line = { w: 1, style: 'solid', color: '#000000' };
    expect(styleAt(m, pg, 2, 2)).toEqual({ bb: line });
    expect(styleAt(m, pg, 6, 2)).toEqual({ bb: line });
    expect(pg.maxRow).toBe(7);
  });

  it('통합문서 기본 글꼴이 Calibri 11pt 가 아니면 서식 없는 칸과 같은 글꼴을 쓴 칸에도 크기, 이름을 적는다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '기본';
    ws.getCell('B1').value = '굵게';
    ws.getCell('B1').font = { name: '굴림', size: 9, bold: true };
    ws.getCell('C1').value = '명시';
    ws.getCell('C1').font = { name: '굴림', size: 9 };
    ws.getCell('D1').value = 7;
    const buf = patchZip(await toBuffer(wb), {
      // fonts[0](표준 스타일 글꼴)을 굴림 9pt 로
      'xl/styles.xml': (s) => s.replace('<sz val="11"/>', '<sz val="9"/>').replace('<name val="Calibri"/>', '<name val="굴림"/>'),
    });
    const m = expectInvariants(await processXlsx(buf, 'f.xlsx'));
    const pg = m.pages[0]!;
    expect(styleAt(m, pg, 1, 1)).toEqual({ sz: 9, font: '굴림' });
    expect(styleAt(m, pg, 1, 2)).toEqual({ b: true, sz: 9, font: '굴림' });
    expect(styleAt(m, pg, 1, 3)).toEqual({ sz: 9, font: '굴림' });
    expect(styleAt(m, pg, 1, 4)).toEqual({ sz: 9, font: '굴림', num: true });
  });

  it('열 너비: 파일 값(여백 5px 포함)을 ECMA-376 식으로, defaultColWidth 도 같은 식으로', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getColumn(1).width = 8.7109375; // 엑셀에서 8자 = 61px
    ws.getColumn(2).width = 20.7109375; // 20자 = 145px
    ws.getCell('C1').value = 'c';
    ws.getCell('A1').value = 'a';
    const wide = wb.addWorksheet('W', { properties: { defaultColWidth: 12 } });
    wide.getCell('B1').value = 'b';
    const m = expectInvariants(await processXlsx(await toBuffer(wb), 'w.xlsx'));
    expect(m.pages[0]!.colWidths).toEqual([61, 145, 64]);
    expect(m.pages[1]!.colWidths).toEqual([84, 84]);
  });

  it('날짜 서식인데 날짜로 나타낼 수 없는 숫자: NaN 글자를 색인하지 않는다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 1e9;
    ws.getCell('A1').numFmt = 'YYYY'; // ExcelJS 는 대문자 서식을 날짜로 보지 않아 숫자로 넘긴다
    ws.getCell('B1').value = 123456789012;
    ws.getCell('B1').numFmt = 'DD"일"';
    ws.getCell('C1').value = 2026;
    ws.getCell('C1').numFmt = 'YYYY';
    const r = await processXlsx(await toBuffer(wb), 'n.xlsx');
    expectInvariants(r);
    expect(r.pages[0]!.text).toBe('1000000000\t123456789012\t1905');
  });

  describe('읽을 수 없는 파일', () => {
    it('ZIP 이 아니면 OfficeParseError', async () => {
      await expect(processXlsx(Buffer.from('xlsx 가 아닌 글자'), 'x.xlsx')).rejects.toBeInstanceOf(OfficeParseError);
    });

    it('xlsx 구조가 아닌 ZIP 이면 OfficeParseError', async () => {
      const zip = zipEntries([{ name: 'hello.txt', data: Buffer.from('hi'), date: new Date(1980, 0, 1) }]);
      await expect(processXlsx(zip, 'x.xlsx')).rejects.toBeInstanceOf(OfficeParseError);
    });

    it('시트가 하나도 없으면 OfficeParseError', async () => {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('S').getCell('A1').value = 'x';
      const buf = patchZip(await toBuffer(wb), {
        'xl/workbook.xml': (s) => s.replace(/<sheets>[\s\S]*<\/sheets>/, '<sheets></sheets>'),
      });
      await expect(processXlsx(buf, 'x.xlsx')).rejects.toThrow('시트가 없습니다');
    });
  });

  describe('손상되거나 꾸민 XML: 태그 정규식이 시간을 제곱으로 쓰지 않는다', () => {
    async function base(): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = 'head';
      ws.getCell('B1').value = 12;
      return toBuffer(wb);
    }
    // 고치기 전에는 여는 태그마다 파일 끝까지 되훑어 이 크기(약 576KB)에서 수 초씩 서버 전체가 멈췄다
    const N = 64_000;

    it('닫는 태그 없는 t="d" 셀이 이어진 시트: 오래 붙잡지 않고 거부한다', async () => {
      const buf = patchZip(await base(), {
        'xl/worksheets/sheet1.xml': (s) => s.replace('</sheetData>', `${'<c t="d">'.repeat(N)}</sheetData>`),
      });
      const started = performance.now();
      await expect(processXlsx(buf, 'bad.xlsx')).rejects.toBeInstanceOf(OfficeParseError);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('글꼴 목록 끝의 긴 주석(정상 XML): 결과는 그대로이고 빠르다', async () => {
      const buf = patchZip(await base(), {
        'xl/styles.xml': (s) => s.replace('</fonts>', `<!--${'<font '.repeat(N)}--></fonts>`),
      });
      const started = performance.now();
      const r = await processXlsx(buf, 'comment.xlsx');
      expect(performance.now() - started).toBeLessThan(2000);
      expectInvariants(r);
      expect(r.pages[0]!.text).toBe('head\t12');
    });

    it('닫는 > 없이 끝나는 관계 부속: 오래 붙잡지 않고 거부한다', async () => {
      const buf = patchZip(await base(), {
        'xl/_rels/workbook.xml.rels': (s) => s + '<Relationship '.repeat(N),
      });
      const started = performance.now();
      await expect(processXlsx(buf, 'rels.xlsx')).rejects.toBeInstanceOf(OfficeParseError);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('큰 시트 덜어 내기: 행 안에 닫히지 않은 <c 가 이어져도 오래 붙잡지 않는다(보이는 행, 숨긴 행)', async () => {
      // 덜어 내기는 시트 XML 이 trimSheetBytes 를 넘을 때만 돈다: 시험에서는 상한을 낮춰 들어간다
      const bad = '<c r="B1" '.repeat(60_000);
      const hiddenBad = ' t="shared" '.repeat(60_000);
      for (const fix of [
        (s: string) => s.replace('</sheetData>', `<row r="5">${bad}</row></sheetData>`),
        (s: string) => s.replace('</sheetData>', `<row r="5" hidden="1">${hiddenBad}</row></sheetData>`),
      ]) {
        const buf = patchZip(await base(), { 'xl/worksheets/sheet1.xml': fix });
        const started = performance.now();
        await processXlsx(buf, 'trim.xlsx', { trimSheetBytes: 1024 }).catch(() => undefined);
        expect(performance.now() - started).toBeLessThan(2500);
      }
    });

    it('정상 XML 주석 안의 셀 모양 글자가 t="d" 날짜 변환을 막지 않는다', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = 1;
      ws.getCell('B1').value = 2;
      const buf = patchZip(await toBuffer(wb), {
        'xl/worksheets/sheet1.xml': (s) =>
          s
            .replace(/<c r="A1"([^>]*)>[\s\S]*?<\/c>/, '<c r="A1" t="d"><!-- <c > --><v>2026-01-02</v></c>')
            .replace(/<c r="B1"([^>]*)>[\s\S]*?<\/c>/, '<c r="B1" t="d"><v>2026-03-04</v></c><!-- <c t="d"><v>1999-01-01</v></c> -->'),
      });
      const r = await processXlsx(buf, 'comment-date.xlsx');
      expectInvariants(r);
      expect(r.pages[0]!.text).toBe('2026-01-02\t2026-03-04');
    });
  });
});
