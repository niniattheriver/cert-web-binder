/**
 * 텍스트 계열(txt, md, csv, tsv) → 정본 쪽 글자 + 렌더 모델
 *
 * - 글자 인코딩: BOM(UTF-8, UTF-16LE/BE) 우선, 없으면 UTF-8 엄격 해독, 실패하면 CP949(EUC-KR).
 *   한글 csv 는 엑셀이 CP949 로 저장하는 일이 흔하다.
 * - txt, md: 60줄 또는 6000자마다 한 쪽. 모델은 PlainModel(쪽 글자 그대로).
 * - csv, tsv: 파일 전체가 한 쪽(시트 한 장). 모델은 SheetModel, 글자 규칙은 sheet-text.ts.
 */
import path from 'node:path';
import { normalizeText } from '../pdf/normalize.js';
import { stripControls } from './controls.js';
import {
  RENDER_MODEL_VERSION,
  type OfficeExtractResult,
  type PlainModel,
  type SheetModel,
} from './model.js';
import { buildSheetText, type RawSheetRow } from './sheet-text.js';

export const TEXT_EXTRACTOR = 'text-v1';

const LINES_PER_PAGE = 60;
const CHARS_PER_PAGE = 6000;
/** 색인·표시 공통 상한 */
const MAX_TEXT_CHARS = 3_000_000;
const CSV_MAX_ROWS = 20_000;
const CSV_MAX_COLS = 200;

/** 바이트 → 글자 (BOM → UTF-8 엄격 → CP949) */
export function decodeTextBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  let body = buf;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(body);
    } catch {
      return body.toString('utf8');
    }
  }
}

/** txt/md 글자를 쪽으로 자른다 (줄 수·글자 수 상한 중 먼저 닿는 쪽) */
export function paginatePlain(text: string): string[] {
  const lines = text.split('\n');
  const pages: string[] = [];
  let cur: string[] = [];
  let curChars = 0;
  const flush = (): void => {
    pages.push(cur.join('\n'));
    cur = [];
    curChars = 0;
  };
  for (let line of lines) {
    // 아주 긴 한 줄은 글자 수로 쪼갠다
    while (line.length > CHARS_PER_PAGE) {
      if (cur.length > 0) flush();
      pages.push(line.slice(0, CHARS_PER_PAGE));
      line = line.slice(CHARS_PER_PAGE);
    }
    if (cur.length >= LINES_PER_PAGE || curChars + line.length > CHARS_PER_PAGE) flush();
    cur.push(line);
    curChars += line.length + 1;
  }
  if (cur.length > 0 || pages.length === 0) flush();
  return pages;
}

/** 구분자 추정: tsv 는 탭, csv 는 첫 줄들에서 쉼표/세미콜론/탭 중 많은 것 */
function guessDelimiter(src: string, format: 'csv' | 'tsv'): string {
  if (format === 'tsv') return '\t';
  const head = src.slice(0, 4096).split('\n').slice(0, 10).join('\n');
  const count = (ch: string): number => head.split(ch).length - 1;
  const cands: [string, number][] = [[',', count(',')], [';', count(';')], ['\t', count('\t')]];
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0]![1] > 0 ? cands[0]![0] : ',';
}

/** RFC 4180 식 csv 해석 (따옴표 안 구분자·줄바꿈·"" 이스케이프) */
export function parseDelimited(src: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function textWidthPx(s: string): number {
  // 한글·전각은 넓게, 나머지는 좁게 어림 (열 너비 추정용)
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 13 : 7;
  return w;
}

export function processText(
  buf: Buffer,
  format: 'txt' | 'md' | 'csv' | 'tsv',
  fileName: string,
): OfficeExtractResult {
  let decoded = normalizeText(stripControls(decodeTextBuffer(buf)));
  let truncated: string | null = null;
  if (decoded.length > MAX_TEXT_CHARS) {
    decoded = decoded.slice(0, MAX_TEXT_CHARS);
    truncated = `글자가 많아 앞부분 ${MAX_TEXT_CHARS.toLocaleString('ko-KR')}자만 색인하고 보여줍니다.`;
  }

  if (format === 'txt' || format === 'md') {
    const texts = paginatePlain(decoded);
    const model: PlainModel = {
      v: RENDER_MODEL_VERSION,
      kind: 'plain',
      media: [],
      truncated,
      pages: texts.map((t, i) => ({ pageNo: i + 1, t })),
    };
    return {
      fileKind: 'text',
      extractor: TEXT_EXTRACTOR,
      pages: texts.map((text, i) => ({ pageNo: i + 1, text, label: null })),
      render: Buffer.from(JSON.stringify(model), 'utf8'),
      renderMime: 'application/json',
      truncated,
    };
  }

  // csv / tsv → 시트 한 장
  const table = parseDelimited(decoded, guessDelimiter(decoded, format));
  let rowsIn = table;
  if (rowsIn.length > CSV_MAX_ROWS) {
    rowsIn = rowsIn.slice(0, CSV_MAX_ROWS);
    truncated = `행이 많아 앞 ${CSV_MAX_ROWS.toLocaleString('ko-KR')}행만 색인하고 보여줍니다.`;
  }
  let maxCol = 0;
  const raw: RawSheetRow[] = [];
  const widths: number[] = [];
  rowsIn.forEach((cells, ri) => {
    const lim = Math.min(cells.length, CSV_MAX_COLS);
    if (cells.length > CSV_MAX_COLS && !truncated) {
      truncated = `열이 많아 앞 ${CSV_MAX_COLS}열만 색인하고 보여줍니다.`;
    }
    const out: RawSheetRow = { r: ri + 1, cells: [] };
    for (let c = 0; c < lim; c += 1) {
      const text = cells[c] ?? '';
      if (text === '') continue;
      out.cells.push({ c: c + 1, text });
      maxCol = Math.max(maxCol, c + 1);
      const longestLine = text.split('\n').reduce((m, l) => Math.max(m, textWidthPx(l)), 0);
      widths[c] = Math.max(widths[c] ?? 0, longestLine);
    }
    if (out.cells.length > 0) raw.push(out);
  });
  const { text, rows } = buildSheetText(raw);
  const name = path.basename(fileName).replace(/\.[^.]+$/, '') || 'CSV';
  const colWidths = Array.from({ length: maxCol }, (_, i) =>
    Math.max(48, Math.min(360, Math.round((widths[i] ?? 0) + 16))),
  );
  const model: SheetModel = {
    v: RENDER_MODEL_VERSION,
    kind: 'sheet',
    media: [],
    truncated,
    styles: [],
    pages: [
      {
        pageNo: 1,
        name,
        colWidths,
        defaultRowHeight: 20,
        rows,
        merges: [],
        maxRow: rowsIn.length,
        maxCol,
        ...(truncated ? { truncated: true as const } : {}),
      },
    ],
  };
  return {
    fileKind: 'text',
    extractor: TEXT_EXTRACTOR,
    pages: [{ pageNo: 1, text, label: name }],
    render: Buffer.from(JSON.stringify(model), 'utf8'),
    renderMime: 'application/json',
    truncated,
  };
}
