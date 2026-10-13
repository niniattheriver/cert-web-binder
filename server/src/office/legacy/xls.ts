/**
 * 구형 엑셀(xls: Excel 97~2003, BIFF8) → 정본 쪽 글자 + 시트 렌더 모델
 *
 * xlsx 추출기(xlsx.ts)와 결과 규칙을 맞춘다: 보이는 시트 하나가 한 쪽(라벨 = 시트 이름), 쪽 글자와 셀 오프셋은
 * sheet-text.ts(buildSheetText) 한 곳에서 함께 만들고, 숫자는 xlsx.ts 의 formatNumber 로 엑셀 화면 글자를
 * 만든다(같은 서식 문자열이면 xlsx 와 같은 글자). 상한(열, 시트당 행, 전체 셀, 전체 글자)과 안내 문구도 같다.
 * 그래서 같은 통합문서를 xls 와 xlsx 로 저장해 올리면 쪽 글자가 같다(시험으로 확인).
 *
 * 읽는 것 (MS-XLS, Workbook 스트림의 BIFF8 레코드)
 * - 통합문서: BOF, FILEPASS(암호 → 거부), DATEMODE(1904 날짜), FORMAT, FONT, XF, PALETTE, BOUNDSHEET8(시트
 *   이름, 숨김, 시트 BOF 위치), SST(공유 문자열: CONTINUE 레코드에 걸친 문자열은 이어지는 레코드 첫 바이트가
 *   새 문자 폭 표지다).
 * - 시트: DEFCOLWIDTH, COLINFO(너비, 숨김), DEFAULTROWHEIGHT, ROW(높이, 숨김), MERGEDCELLS, WINDOW2 + PANE(틀
 *   고정), 셀(LABELSST, LABEL, RSTRING, NUMBER, RK, MULRK, BOOLERR, FORMULA 의 저장된 결과와 뒤따르는 STRING),
 *   BLANK, MULBLANK(서식만 있는 칸).
 * - 서식: 글꼴(굵게, 기울임, 밑줄, 취소선, 크기, 색, 이름), 맞춤(가로, 세로, 줄 바꿈, 들여쓰기), 테두리, 단색 채우기.
 * - 다루지 않는 것: 그림, 차트, 메모, 조건부 서식, 시트 보호 정보(media: []).
 * BIFF5 이하(Excel 95 이전)는 문자열이 코드 페이지 바이트라 다루지 않고 안내한다.
 */
import { normalizeText } from '../../pdf/normalize.js';
import { stripControls } from '../controls.js';
import { OfficeParseError } from '../errors.js';
import {
  RENDER_MODEL_VERSION,
  type Border,
  type CellStyle,
  type OfficeExtractResult,
  type SheetModel,
  type SheetPage,
} from '../model.js';
import { buildSheetText, type RawSheetCell, type RawSheetRow } from '../sheet-text.js';
import {
  colWidthPx,
  DEFAULT_COL_PX,
  formatNumber,
  INDEXED_COLORS,
  KO_BUILTIN_FORMATS,
  ptToPx,
  truncationNotice,
  XLSX_LIMITS,
  type XlsxLimits,
} from '../xlsx.js';
import { Cfb } from './cfb.js';

export const XLS_EXTRACTOR = 'xls-v1';

const ERR_CORRUPT = '엑셀(xls) 파일을 읽을 수 없습니다. 파일이 손상되었을 수 있습니다. 엑셀에서 다시 저장해 올려 주세요.';
const ERR_ENCRYPTED = '암호(열람 제한)가 걸린 엑셀(xls) 파일입니다. 암호를 해제해 저장한 뒤 다시 올려 주세요.';
const ERR_OLD = '엑셀 95 이전 형식(xls)은 읽을 수 없습니다. 엑셀에서 xlsx로 저장해 올려 주세요.';
const ERR_NO_SHEET = '엑셀 파일에 시트가 없습니다.';
const ERR_TOO_BIG = '엑셀(xls) 파일이 너무 커서 열 수 없습니다. 필요한 시트만 남기거나 나눠서 다시 올려 주세요.';

/** Workbook 스트림 상한 */
const MAX_STREAM = 200 * 1024 * 1024;
/** 공유 문자열 개수 상한 */
const MAX_SST = 2_000_000;
/** 레코드 수 상한 (시트 하나) */
const MAX_RECORDS_PER_SHEET = 5_000_000;
/** 병합 수 상한 (통합문서 전체) */
const MAX_MERGES_TOTAL = 50_000;

// 레코드 번호
const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  CONTINUE: 0x003c,
  FORMAT: 0x041e,
  FONT: 0x0031,
  XF: 0x00e0,
  PALETTE: 0x0092,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  DEFCOLWIDTH: 0x0055,
  COLINFO: 0x007d,
  DEFAULTROWHEIGHT: 0x0225,
  ROW: 0x0208,
  MERGEDCELLS: 0x00e5,
  WINDOW2: 0x023e,
  PANE: 0x0041,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BLANK: 0x0201,
  MULBLANK: 0x00be,
} as const;

/** ExcelJS 기본 서식표와 같은 값 (xlsx 결과와 글자를 맞추기 위해) */
const BUILTIN_FORMATS = new Map<number, string>([
  [0, 'General'], [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'], [9, '0%'], [10, '0.00%'], [11, '0.00E+00'],
  [12, '# ?/?'], [13, '# ??/??'], [14, 'mm-dd-yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yy "h":mm'],
  [37, '#,##0 ;(#,##0)'], [38, '#,##0 ;[Red](#,##0)'], [39, '#,##0.00 ;(#,##0.00)'], [40, '#,##0.00 ;[Red](#,##0.00)'],
  [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'], [48, '##0.0E+0'], [49, '@'],
  ...KO_BUILTIN_FORMATS,
]);

const ERROR_TEXT = new Map<number, string>([
  [0x00, '#NULL!'], [0x07, '#DIV/0!'], [0x0f, '#VALUE!'], [0x17, '#REF!'], [0x1d, '#NAME?'], [0x24, '#NUM!'], [0x2a, '#N/A'],
  [0x2b, '#GETTING_DATA'],
]);

interface Rec {
  type: number;
  data: Buffer;
  /** 레코드 머리 위치 */
  pos: number;
}

/** 레코드를 차례로 읽는다. 끝이 잘린 레코드에서 멈춘다 */
function* records(b: Buffer, from: number): Generator<Rec> {
  let p = from;
  while (p + 4 <= b.length) {
    const type = b.readUInt16LE(p);
    const len = b.readUInt16LE(p + 2);
    if (p + 4 + len > b.length) return;
    yield { type, data: b.subarray(p + 4, p + 4 + len), pos: p };
    p += 4 + len;
  }
}

/**
 * CONTINUE 에 걸친 문자열을 읽는 커서. 문자 바이트를 읽다가 조각 끝에 닿으면 다음 조각의 첫 바이트가 새 문자 폭
 * 표지(fHighByte)다. 서식 런, 확장 정보처럼 문자가 아닌 바이트는 표지 없이 이어진다.
 */
class SegReader {
  private seg = 0;
  private pos = 0;
  constructor(private readonly segs: Buffer[]) {}

  private ensure(): boolean {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg]!.length) {
      this.seg += 1;
      this.pos = 0;
    }
    return this.seg < this.segs.length;
  }

  done(): boolean {
    return !this.ensure();
  }

  u8(): number {
    if (!this.ensure()) throw new OfficeParseError(ERR_CORRUPT);
    return this.segs[this.seg]![this.pos++]!;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n: number): void {
    let left = n;
    while (left > 0) {
      if (!this.ensure()) throw new OfficeParseError(ERR_CORRUPT);
      const s = this.segs[this.seg]!;
      const take = Math.min(left, s.length - this.pos);
      this.pos += take;
      left -= take;
    }
  }

  /** cch 글자. 조각 경계마다 새 폭 표지를 읽는다 */
  chars(cch: number, high: boolean): string {
    let out = '';
    let left = cch;
    let wide = high;
    while (left > 0) {
      if (!this.ensure()) throw new OfficeParseError(ERR_CORRUPT);
      let s = this.segs[this.seg]!;
      if (this.pos >= s.length) continue;
      const width = wide ? 2 : 1;
      const avail = Math.floor((s.length - this.pos) / width);
      const take = Math.min(left, avail);
      if (take > 0) {
        out += wide ? s.toString('utf16le', this.pos, this.pos + take * 2) : s.toString('latin1', this.pos, this.pos + take);
        this.pos += take * width;
        left -= take;
      }
      if (left > 0) {
        // 조각 끝: 다음 조각 첫 바이트가 새 폭 표지
        if (this.pos < s.length) this.pos = s.length; // 홀수 바이트 찌꺼기
        this.seg += 1;
        this.pos = 0;
        if (this.seg >= this.segs.length) throw new OfficeParseError(ERR_CORRUPT);
        s = this.segs[this.seg]!;
        wide = (s[0]! & 1) === 1;
        this.pos = 1;
      }
    }
    return out;
  }
}

/** XLUnicodeRichExtendedString (SST 항목) */
function readRichString(r: SegReader): string {
  const cch = r.u16();
  const flags = r.u8();
  const high = (flags & 0x01) !== 0;
  const ext = (flags & 0x04) !== 0;
  const rich = (flags & 0x08) !== 0;
  const runs = rich ? r.u16() : 0;
  const extLen = ext ? r.u32() : 0;
  const s = r.chars(cch, high);
  if (runs) r.skip(runs * 4);
  if (extLen) r.skip(extLen);
  return s;
}

/** XLUnicodeString (LABEL, STRING, FORMAT): 한 레코드 안 */
function readUnicodeString(b: Buffer, at: number, cchBytes: 1 | 2): { s: string; end: number } {
  if (at + cchBytes + 1 > b.length) return { s: '', end: b.length };
  const cch = cchBytes === 2 ? b.readUInt16LE(at) : b[at]!;
  const flags = b[at + cchBytes]!;
  let p = at + cchBytes + 1;
  const high = (flags & 0x01) !== 0;
  const rich = (flags & 0x08) !== 0;
  const ext = (flags & 0x04) !== 0;
  let runs = 0;
  let extLen = 0;
  if (rich && p + 2 <= b.length) {
    runs = b.readUInt16LE(p);
    p += 2;
  }
  if (ext && p + 4 <= b.length) {
    extLen = b.readUInt32LE(p);
    p += 4;
  }
  const width = high ? 2 : 1;
  const end = Math.min(b.length, p + cch * width);
  const s = high ? b.toString('utf16le', p, end - ((end - p) % 2)) : b.toString('latin1', p, end);
  return { s, end: end + runs * 4 + extLen };
}

/** RK 값 → 숫자 */
function rkValue(rk: number): number {
  let v: number;
  if (rk & 0x02) {
    v = rk >> 2; // 30비트 부호 있는 정수
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeUInt32LE(0, 0);
    tmp.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = tmp.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

interface FontRec {
  heightTw: number;
  italic: boolean;
  strike: boolean;
  color: number;
  bold: boolean;
  underline: boolean;
  name: string;
}

interface XfRec {
  font: number;
  fmt: number;
  halign: number;
  wrap: boolean;
  valign: number;
  indent: number;
  border: { l: number; r: number; t: number; b: number; cl: number; cr: number; ct: number; cb: number };
  fill: number;
  fore: number;
}

interface SheetInfo {
  name: string;
  pos: number;
  hidden: boolean;
  type: number;
}

interface Book {
  stream: Buffer;
  date1904: boolean;
  formats: Map<number, string>;
  fonts: FontRec[];
  xfs: XfRec[];
  palette: string[];
  sheets: SheetInfo[];
  sst: string[];
}

function readBook(stream: Buffer): Book {
  const first = records(stream, 0).next();
  if (first.done || first.value.type !== R.BOF) {
    // BIFF5 이하는 BOF 번호가 다르다 (0x0009, 0x0209, 0x0409)
    if (!first.done && [0x0009, 0x0209, 0x0409].includes(first.value.type)) throw new OfficeParseError(ERR_OLD);
    throw new OfficeParseError(ERR_CORRUPT);
  }
  const vers = first.value.data.length >= 2 ? first.value.data.readUInt16LE(0) : 0;
  if (vers !== 0x0600) throw new OfficeParseError(vers === 0x0500 ? ERR_OLD : ERR_CORRUPT);
  const book: Book = {
    stream,
    date1904: false,
    formats: new Map(BUILTIN_FORMATS),
    fonts: [],
    xfs: [],
    palette: INDEXED_COLORS.slice(),
    sheets: [],
    sst: [],
  };
  let sstSegs: Buffer[] | null = null;
  let inSst = false;
  for (const rec of records(stream, 0)) {
    if (rec.pos === 0) continue;
    const d = rec.data;
    if (inSst && rec.type === R.CONTINUE) {
      sstSegs!.push(d);
      continue;
    }
    inSst = false;
    switch (rec.type) {
      case R.FILEPASS:
        throw new OfficeParseError(ERR_ENCRYPTED);
      case R.DATEMODE:
        book.date1904 = d.length >= 2 && d.readUInt16LE(0) === 1;
        break;
      case R.FORMAT: {
        if (d.length < 5) break;
        const id = d.readUInt16LE(0);
        book.formats.set(id, readUnicodeString(d, 2, 2).s);
        break;
      }
      case R.FONT: {
        if (d.length < 15) break;
        book.fonts.push({
          heightTw: d.readUInt16LE(0),
          italic: (d.readUInt16LE(2) & 0x02) !== 0,
          strike: (d.readUInt16LE(2) & 0x08) !== 0,
          color: d.readUInt16LE(4),
          bold: d.readUInt16LE(6) >= 700,
          underline: d[10]! !== 0,
          name: readUnicodeString(d, 14, 1).s,
        });
        break;
      }
      case R.XF: {
        if (d.length < 20) break;
        const b1 = d.readUInt32LE(10);
        const b2 = d.readUInt32LE(14);
        const f = d.readUInt16LE(18);
        book.xfs.push({
          font: d.readUInt16LE(0),
          fmt: d.readUInt16LE(2),
          halign: d[6]! & 0x07,
          wrap: (d[6]! & 0x08) !== 0,
          valign: (d[6]! >> 4) & 0x07,
          indent: d[8]! & 0x0f,
          border: {
            l: b1 & 0x0f,
            r: (b1 >> 4) & 0x0f,
            t: (b1 >> 8) & 0x0f,
            b: (b1 >> 12) & 0x0f,
            cl: (b1 >> 16) & 0x7f,
            cr: (b1 >> 23) & 0x7f,
            ct: b2 & 0x7f,
            cb: (b2 >> 7) & 0x7f,
          },
          fill: (b2 >>> 26) & 0x3f,
          fore: f & 0x7f,
        });
        break;
      }
      case R.PALETTE: {
        if (d.length < 2) break;
        const n = d.readUInt16LE(0);
        for (let i = 0; i < n && 2 + i * 4 + 3 <= d.length; i += 1) {
          const o = 2 + i * 4;
          const hex = [d[o]!, d[o + 1]!, d[o + 2]!].map((x) => x.toString(16).padStart(2, '0')).join('');
          if (8 + i < book.palette.length) book.palette[8 + i] = hex.toUpperCase();
        }
        break;
      }
      case R.BOUNDSHEET: {
        if (d.length < 8) break;
        const name = readUnicodeString(d, 6, 1).s;
        book.sheets.push({ pos: d.readUInt32LE(0), hidden: (d[4]! & 0x03) !== 0, type: d[5]!, name });
        break;
      }
      case R.SST:
        sstSegs = [d.subarray(8)];
        inSst = true;
        if (d.length >= 8 && d.readUInt32LE(4) > MAX_SST) throw new OfficeParseError(ERR_TOO_BIG);
        break;
      case R.EOF:
        // 통합문서 부분 끝 (시트 부분은 BOUNDSHEET 위치에서 따로 읽는다)
        if (sstSegs) book.sst = readSst(sstSegs);
        return book;
      default:
        break;
    }
  }
  if (sstSegs) book.sst = readSst(sstSegs);
  return book;
}

function readSst(segs: Buffer[]): string[] {
  const r = new SegReader(segs);
  const out: string[] = [];
  try {
    while (!r.done() && out.length < MAX_SST) out.push(readRichString(r));
  } catch {
    // 끝이 잘린 SST: 읽은 데까지 쓴다
  }
  return out;
}

// ─────────────────────────────── 서식 ───────────────────────────────

function borderOf(style: number, color: string | undefined): Border | undefined {
  if (style === 0) return undefined;
  const c = color ?? '#000000';
  switch (style) {
    case 2:
    case 8:
    case 10:
    case 12:
      return { w: 2, style: style === 2 ? 'solid' : 'dashed', color: c };
    case 5:
      return { w: 3, style: 'solid', color: c };
    case 6:
      return { w: 3, style: 'double', color: c };
    case 3:
    case 9:
    case 11:
    case 13:
      return { w: 1, style: 'dashed', color: c };
    case 4:
    case 7:
      return { w: 1, style: 'dotted', color: c };
    default:
      return { w: 1, style: 'solid', color: c };
  }
}

/** xlsx.ts 와 같은 값: 모델에 통합문서 기본 글꼴 필드가 없어 화면 기본값과 다르면 칸마다 적는다 */
const VIEW_FONT_PT = 11;
const VIEW_FONT_NAME = 'calibri';
const SAFE_FONT_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

const HALIGN: Record<number, CellStyle['ha']> = { 1: 'left', 2: 'center', 3: 'right', 5: 'justify', 6: 'center', 7: 'justify' };
const VALIGN: Record<number, CellStyle['va']> = { 0: 'top', 1: 'middle', 2: 'bottom' };

class Styles {
  readonly list: CellStyle[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly byXf = new Map<number, number | undefined>();
  constructor(private readonly book: Book) {}

  private color(icv: number): string | undefined {
    if (icv === 0x7fff || icv === 64 || icv === 65 || icv >= this.book.palette.length + 2) return undefined;
    const hex = this.book.palette[icv];
    return hex ? `#${hex.toLowerCase()}` : undefined;
  }

  private font(ifnt: number): FontRec | undefined {
    // 글꼴 번호 4 는 비어 있다(BIFF 관례): 4 이상은 하나 앞 항목
    return this.book.fonts[ifnt >= 4 ? ifnt - 1 : ifnt];
  }

  /** 셀 서식 번호 → 모델 스타일 색인 (기본 모양이면 undefined) */
  styleOf(ixfe: number, numeric: boolean): number | undefined {
    const cacheKey = ixfe * 2 + (numeric ? 1 : 0);
    if (this.byXf.has(cacheKey)) return this.byXf.get(cacheKey);
    const xf = this.book.xfs[ixfe];
    const st: CellStyle = {};
    if (xf) {
      const f = this.font(xf.font);
      if (f) {
        if (f.bold) st.b = true;
        if (f.italic) st.i = true;
        if (f.underline) st.u = true;
        if (f.strike) st.strike = true;
        // xlsx.ts StyleTable 과 같은 규칙: 화면 기본값(Calibri 11pt)과 다를 때만 적는다
        const pt = Math.round((f.heightTw / 20) * 10) / 10;
        if (pt > 0 && pt !== VIEW_FONT_PT) st.sz = pt;
        const c = this.color(f.color);
        if (c && c !== '#000000') st.color = c;
        if (f.name && f.name.toLowerCase() !== VIEW_FONT_NAME && SAFE_FONT_NAME.test(f.name)) st.font = f.name;
      }
      const ha = HALIGN[xf.halign];
      if (ha) st.ha = ha;
      const va = VALIGN[xf.valign];
      if (va && va !== 'bottom') st.va = va;
      if (xf.wrap) st.wrap = true;
      if (xf.indent) st.indent = xf.indent;
      const b = xf.border;
      const bt = borderOf(b.t, this.color(b.ct));
      const br = borderOf(b.r, this.color(b.cr));
      const bb = borderOf(b.b, this.color(b.cb));
      const bl = borderOf(b.l, this.color(b.cl));
      if (bt) st.bt = bt;
      if (br) st.br = br;
      if (bb) st.bb = bb;
      if (bl) st.bl = bl;
      if (xf.fill === 1) {
        const bg = this.color(xf.fore);
        if (bg && bg !== '#ffffff') st.bg = bg;
      }
    }
    if (numeric) st.num = true;
    let idx: number | undefined;
    if (Object.keys(st).length > 0) {
      const key = JSON.stringify(st);
      idx = this.byKey.get(key);
      if (idx === undefined) {
        idx = this.list.length;
        this.list.push(st);
        this.byKey.set(key, idx);
      }
    }
    this.byXf.set(cacheKey, idx);
    return idx;
  }

  /** 서식만 있고 값이 없는 칸도 모델에 넣을 만큼 보이는 서식(채우기, 테두리)인가 */
  visibleFormat(ixfe: number): boolean {
    const xf = this.book.xfs[ixfe];
    if (!xf) return false;
    const b = xf.border;
    return xf.fill === 1 || b.l !== 0 || b.r !== 0 || b.t !== 0 || b.b !== 0;
  }

  numFmt(ixfe: number): string | undefined {
    const xf = this.book.xfs[ixfe];
    return xf ? this.book.formats.get(xf.fmt) : undefined;
  }
}

// ─────────────────────────────── 시트 ───────────────────────────────

interface Env {
  book: Book;
  lim: XlsxLimits;
  styles: Styles;
  budget: { cells: number; chars: number; merges: number; hidden: number; exhausted: boolean };
  flags: { rows: boolean; cols: boolean; cells: boolean; chars: boolean };
}

interface CellVal {
  text: string;
  numeric: boolean;
  ixfe: number;
}

function extractSheet(sheet: SheetInfo, pageNo: number, env: Env): { page: SheetPage; text: string } {
  const { book, lim, styles } = env;
  const name = normalizeText(stripControls(sheet.name));
  const page: SheetPage = {
    pageNo,
    name,
    colWidths: [],
    defaultRowHeight: ptToPx(15),
    rows: [],
    merges: [],
    maxRow: 0,
    maxCol: 0,
  };
  if (env.budget.exhausted) {
    page.truncated = true;
    return { page, text: '' };
  }
  const cells = new Map<number, Map<number, CellVal>>();
  const fmtOnly = new Map<number, Map<number, number>>();
  const rowH = new Map<number, number>();
  const rowHidden = new Set<number>();
  const colW: number[] = [];
  const colHidden = new Set<number>();
  let defColPx = DEFAULT_COL_PX;
  const merges: [number, number, number, number][] = [];
  let frozenFlag = false;
  let pane: { rows: number; cols: number } | undefined;
  let pendingFormula: { r: number; c: number; ixfe: number } | null = null;
  let sheetTruncated = false;

  const put = (r0: number, c0: number, v: CellVal): void => {
    const r = r0 + 1;
    const c = c0 + 1;
    if (c > lim.maxCols) {
      if (v.text) {
        env.flags.cols = true;
        sheetTruncated = true;
      }
      return;
    }
    let row = cells.get(r);
    if (!row) {
      row = new Map();
      cells.set(r, row);
    }
    row.set(c, v);
  };
  const putFmt = (r0: number, c0: number, ixfe: number): void => {
    if (c0 + 1 > lim.maxCols || !styles.visibleFormat(ixfe)) return;
    let row = fmtOnly.get(r0 + 1);
    if (!row) {
      row = new Map();
      fmtOnly.set(r0 + 1, row);
    }
    row.set(c0 + 1, ixfe);
  };
  const numText = (n: number, ixfe: number): CellVal => ({
    text: formatNumber(n, styles.numFmt(ixfe), book.date1904),
    numeric: true,
    ixfe,
  });

  let count = 0;
  let started = false;
  for (const rec of records(book.stream, sheet.pos)) {
    if (!started) {
      if (rec.type !== R.BOF) throw new OfficeParseError(ERR_CORRUPT);
      started = true;
      continue;
    }
    if (++count > MAX_RECORDS_PER_SHEET) break;
    const d = rec.data;
    if (rec.type === R.EOF) break;
    if (pendingFormula && rec.type !== R.STRING) {
      pendingFormula = null; // 문자열 결과 표지가 있었는데 STRING 이 오지 않았다
    }
    switch (rec.type) {
      case R.DEFCOLWIDTH:
        if (d.length >= 2) defColPx = Math.round((DEFAULT_COL_PX * d.readUInt16LE(0)) / 8) || DEFAULT_COL_PX;
        break;
      case R.COLINFO: {
        if (d.length < 10) break;
        const first = d.readUInt16LE(0);
        const last = Math.min(d.readUInt16LE(2), lim.maxCols - 1);
        const w = d.readUInt16LE(4) / 256;
        const hidden = (d.readUInt16LE(8) & 0x01) !== 0;
        for (let c = first; c <= last; c += 1) {
          colW[c + 1] = w;
          if (hidden) colHidden.add(c + 1);
        }
        break;
      }
      case R.DEFAULTROWHEIGHT:
        if (d.length >= 4) {
          const tw = d.readUInt16LE(2);
          if (tw > 0) page.defaultRowHeight = ptToPx(tw / 20);
        }
        break;
      case R.ROW: {
        if (d.length < 16) break;
        const r = d.readUInt16LE(0) + 1;
        const heightTw = d.readUInt16LE(6) & 0x7fff;
        const flags = d.readUInt32LE(12);
        if (flags & 0x20) rowHidden.add(r);
        else if (flags & 0x40 && heightTw > 0) rowH.set(r, ptToPx(heightTw / 20));
        break;
      }
      case R.MERGEDCELLS: {
        if (d.length < 2) break;
        const n = d.readUInt16LE(0);
        for (let i = 0; i < n && 2 + i * 8 + 8 <= d.length; i += 1) {
          if (env.budget.merges >= MAX_MERGES_TOTAL) break;
          const o = 2 + i * 8;
          const r1 = d.readUInt16LE(o) + 1;
          const r2 = d.readUInt16LE(o + 2) + 1;
          const c1 = d.readUInt16LE(o + 4) + 1;
          const c2 = d.readUInt16LE(o + 6) + 1;
          if (r2 < r1 || c2 < c1 || c1 > lim.maxCols) continue;
          merges.push([r1, c1, r2, Math.min(c2, lim.maxCols)]);
          env.budget.merges += 1;
        }
        break;
      }
      case R.WINDOW2:
        if (d.length >= 2) frozenFlag = (d.readUInt16LE(0) & 0x08) !== 0;
        break;
      case R.PANE:
        if (d.length >= 4) pane = { cols: d.readUInt16LE(0), rows: d.readUInt16LE(2) };
        break;
      case R.LABELSST:
        if (d.length >= 10) {
          const i = d.readUInt32LE(6);
          put(d.readUInt16LE(0), d.readUInt16LE(2), { text: book.sst[i] ?? '', numeric: false, ixfe: d.readUInt16LE(4) });
        }
        break;
      case R.LABEL:
      case R.RSTRING:
        if (d.length >= 9) {
          put(d.readUInt16LE(0), d.readUInt16LE(2), { text: readUnicodeString(d, 6, 2).s, numeric: false, ixfe: d.readUInt16LE(4) });
        }
        break;
      case R.NUMBER:
        if (d.length >= 14) put(d.readUInt16LE(0), d.readUInt16LE(2), numText(d.readDoubleLE(6), d.readUInt16LE(4)));
        break;
      case R.RK:
        if (d.length >= 10) put(d.readUInt16LE(0), d.readUInt16LE(2), numText(rkValue(d.readInt32LE(6)), d.readUInt16LE(4)));
        break;
      case R.MULRK: {
        if (d.length < 6) break;
        const r = d.readUInt16LE(0);
        const c0 = d.readUInt16LE(2);
        const n = Math.floor((d.length - 6) / 6);
        for (let i = 0; i < n; i += 1) {
          const o = 4 + i * 6;
          put(r, c0 + i, numText(rkValue(d.readInt32LE(o + 2)), d.readUInt16LE(o)));
        }
        break;
      }
      case R.BOOLERR:
        if (d.length >= 8) {
          const v = d[6]!;
          const isErr = d[7]! === 1;
          put(d.readUInt16LE(0), d.readUInt16LE(2), {
            text: isErr ? (ERROR_TEXT.get(v) ?? '#N/A') : v ? 'TRUE' : 'FALSE',
            numeric: false,
            ixfe: d.readUInt16LE(4),
          });
        }
        break;
      case R.FORMULA: {
        if (d.length < 20) break;
        const r = d.readUInt16LE(0);
        const c = d.readUInt16LE(2);
        const ixfe = d.readUInt16LE(4);
        if (d.readUInt16LE(12) === 0xffff) {
          const kind = d[6]!;
          if (kind === 0) pendingFormula = { r, c, ixfe }; // 결과 글자는 뒤따르는 STRING 레코드에
          else if (kind === 1) put(r, c, { text: d[8]! ? 'TRUE' : 'FALSE', numeric: false, ixfe });
          else if (kind === 2) put(r, c, { text: ERROR_TEXT.get(d[8]!) ?? '#N/A', numeric: false, ixfe });
          // kind 3 = 빈 문자열
        } else {
          put(r, c, numText(d.readDoubleLE(6), ixfe));
        }
        break;
      }
      case R.STRING:
        if (pendingFormula && d.length >= 3) {
          put(pendingFormula.r, pendingFormula.c, { text: readUnicodeString(d, 0, 2).s, numeric: false, ixfe: pendingFormula.ixfe });
        }
        pendingFormula = null;
        break;
      case R.BLANK:
        if (d.length >= 6) putFmt(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4));
        break;
      case R.MULBLANK: {
        if (d.length < 6) break;
        const r = d.readUInt16LE(0);
        const c0 = d.readUInt16LE(2);
        const n = Math.floor((d.length - 6) / 2);
        for (let i = 0; i < n; i += 1) putFmt(r, c0 + i, d.readUInt16LE(4 + i * 2));
        break;
      }
      default:
        break;
    }
  }
  if (frozenFlag && pane && (pane.rows > 0 || pane.cols > 0)) page.frozen = pane;

  // 병합: 가려진 칸의 글자는 내지 않는다 (기준 칸 = 왼쪽 위)
  const covered = new Set<string>();
  for (const [r1, c1, r2, c2] of merges) {
    for (let r = r1; r <= r2 && r - r1 < 2000; r += 1) {
      for (let c = c1; c <= c2; c += 1) if (r !== r1 || c !== c1) covered.add(`${r}:${c}`);
    }
  }

  const rowNos = [...new Set([...cells.keys(), ...fmtOnly.keys(), ...rowH.keys()])].sort((a, b) => a - b);
  const raw: RawSheetRow[] = [];
  let emittedRows = 0;
  let maxCol = 0;
  let maxRow = 0;
  for (const r of rowNos) {
    if (rowHidden.has(r)) continue;
    if (emittedRows >= lim.maxRowsPerSheet) {
      if (cells.has(r)) {
        env.flags.rows = true;
        sheetTruncated = true;
      }
      break;
    }
    const vals = cells.get(r);
    const fmts = fmtOnly.get(r);
    const cols = [...new Set([...(vals?.keys() ?? []), ...(fmts?.keys() ?? [])])].sort((a, b) => a - b);
    const out: RawSheetCell[] = [];
    for (const c of cols) {
      if (colHidden.has(c) || covered.has(`${r}:${c}`)) continue;
      const v = vals?.get(c);
      if (env.budget.cells >= lim.maxCellsTotal) {
        env.flags.cells = true;
        env.budget.exhausted = true;
        sheetTruncated = true;
        break;
      }
      if (v) {
        if (env.budget.chars + v.text.length > lim.maxTextChars) {
          env.flags.chars = true;
          env.budget.exhausted = true;
          sheetTruncated = true;
          break;
        }
        env.budget.chars += v.text.length;
        env.budget.cells += 1;
        const cell: RawSheetCell = { c, text: v.text };
        const s = styles.styleOf(v.ixfe, v.numeric);
        if (s !== undefined) cell.s = s;
        out.push(cell);
      } else if (fmts?.has(c)) {
        const s = styles.styleOf(fmts.get(c)!, false);
        out.push({ c, text: '', ...(s !== undefined ? { s } : {}) });
      }
      if (c > maxCol) maxCol = c;
    }
    if (out.length > 0 || rowH.has(r)) {
      const row: RawSheetRow = { r, cells: out };
      const h = rowH.get(r);
      if (h !== undefined) row.h = h;
      raw.push(row);
      emittedRows += 1;
      maxRow = r;
    }
    if (env.budget.exhausted) break;
  }
  // 숨긴 행: 그리는 범위 안의 것을 높이 0 행으로 낸다 (xlsx 와 같은 상한)
  for (const r of [...rowHidden].sort((a, b) => a - b)) {
    if (r > maxRow || env.budget.hidden <= 0) break;
    raw.push({ r, h: 0, cells: [] });
    env.budget.hidden -= 1;
  }
  raw.sort((a, b) => a.r - b.r);
  for (const [r1, c1, r2, c2] of merges) {
    maxRow = Math.max(maxRow, r1);
    maxCol = Math.max(maxCol, Math.min(c2, lim.maxCols));
    page.merges.push([r1, c1, r2, c2]);
  }
  const built = buildSheetText(raw);
  // 숨긴 행(h: 0)은 buildSheetText 가 빈 행으로 남긴다 (h 만 있는 행)
  page.rows = built.rows;
  maxCol = Math.max(maxCol, 1);
  for (let c = 1; c <= maxCol; c += 1) {
    if (colHidden.has(c)) page.colWidths.push(0);
    else page.colWidths.push(colW[c] !== undefined && colW[c]! > 0 ? colWidthPx(colW[c]!) : defColPx);
  }
  page.maxRow = Math.max(maxRow, 1);
  page.maxCol = maxCol;
  if (sheetTruncated) page.truncated = true;
  return { page, text: built.text };
}

/**
 * xls 하나를 해석한다. 던지는 것은 OfficeParseError(사용자에게 보일 한국어 문장)뿐이다.
 * @param limits 상한 바꾸기(시험용). 빠진 값은 XLSX_LIMITS
 */
export function processXls(buf: Buffer, _fileName: string, limits: Partial<XlsxLimits> = {}): OfficeExtractResult {
  try {
    return extract(buf, { ...XLSX_LIMITS, ...limits });
  } catch (e) {
    if (e instanceof OfficeParseError) throw e;
    const err = new OfficeParseError(ERR_CORRUPT);
    err.cause = e;
    throw err;
  }
}

function extract(buf: Buffer, lim: XlsxLimits): OfficeExtractResult {
  const cfb = Cfb.open(buf);
  if (!cfb) throw new OfficeParseError(ERR_CORRUPT);
  if (cfb.has('EncryptionInfo') || cfb.has('EncryptedPackage')) throw new OfficeParseError(ERR_ENCRYPTED);
  const stream = cfb.read('Workbook', MAX_STREAM, ERR_TOO_BIG);
  if (!stream) {
    if (cfb.has('Book')) throw new OfficeParseError(ERR_OLD);
    throw new OfficeParseError(ERR_CORRUPT);
  }
  const book = readBook(stream);
  const work = book.sheets.filter((s) => s.type === 0 && s.pos > 0 && s.pos < stream.length);
  if (work.length === 0) throw new OfficeParseError(ERR_NO_SHEET);
  const shown = work.filter((s) => !s.hidden);
  const sheets = shown.length > 0 ? shown : work;
  const env: Env = {
    book,
    lim,
    styles: new Styles(book),
    budget: { cells: 0, chars: 0, merges: 0, hidden: lim.maxHiddenRows, exhausted: false },
    flags: { rows: false, cols: false, cells: false, chars: false },
  };
  const pages: SheetPage[] = [];
  const texts: string[] = [];
  sheets.forEach((s, i) => {
    const { page, text } = extractSheet(s, i + 1, env);
    pages.push(page);
    texts.push(text);
  });
  const truncated = truncationNotice(env.flags, lim);
  const model: SheetModel = {
    v: RENDER_MODEL_VERSION,
    kind: 'sheet',
    media: [],
    truncated,
    styles: env.styles.list,
    pages,
  };
  return {
    fileKind: 'xlsx',
    extractor: XLS_EXTRACTOR,
    pages: pages.map((p, i) => ({ pageNo: p.pageNo, text: texts[i] ?? '', label: p.name })),
    render: Buffer.from(JSON.stringify(model), 'utf8'),
    renderMime: 'application/json',
    truncated,
  };
}
