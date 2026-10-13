/**
 * 엑셀(xlsx) → 정본 쪽 글자 + 시트 렌더 모델
 *
 * 규칙
 * - 보이는 시트 하나가 한 쪽이다(통합문서 순서, 라벨 = 시트 이름). 숨긴 시트(hidden, veryHidden)는
 *   빼되, 모든 시트가 숨겨져 있으면 전부 넣는다.
 * - 쪽 글자와 셀 오프셋은 sheet-text.ts(buildSheetText) 한 곳에서 함께 만든다(색인 = 화면).
 * - 셀 글자는 엑셀 화면에 보이는 글자다: 표시 서식(numFmt)을 적용하고, 수식은 저장된 계산 결과를 쓴다.
 * - 값이 있거나 보이는 서식(채우기, 테두리)이 있는 셀만 모델에 넣는다(빈 표의 격자도 그리기 위해).
 * - 병합: 글자는 기준 칸(왼쪽 위)에서만 내고, 가려진 칸은 아무것도 내지 않는다.
 * - 숨긴 행, 열의 셀은 글자와 모델에서 뺀다. 숨긴 열은 너비 0, 숨긴 행은 높이 0 인 빈 행으로 낸다
 *   (SheetView 는 h <= 0 행을 숨긴다. 빼 버리면 그 자리를 기본 높이의 빈 행으로 그린다).
 * - 상한(열, 시트당 행, 전체 셀, 전체 글자)에 걸리면 색인과 표시를 같은 자리에서 자르고 알린다.
 * - 그림, 차트, 메모, 조건부 서식은 다루지 않는다(media: []).
 *
 * ExcelJS 4.4.0 보정
 * - 넘기기 전(buildPackage): 쓰는 부속만 골라 실제 크기를 확인하며 풀고 저장 방식 ZIP 으로 다시 묶는다.
 *   ExcelJS 는 ZIP 의 모든 항목을 끝까지 풀어 메모리에 올리는데 이 서버는 프로세스 하나라서다.
 *   큰 시트는 추출기가 쓰지 않을 행을 덜어 내고, 그래도 크면 거부한다. 요소 이름에 접두사를 쓴
 *   SpreadsheetML(<x:row>)은 접두사를 지우고, t="d"(ISO 8601 날짜) 셀은 날짜로 읽히게 고친다.
 * - load() 안쪽(XLSX#reconcile 훅): 사용자 서식 문자열의 역슬래시(\m 같은 글자 표시), 정의 없이
 *   번호만 쓴 한국어 로캘 기본 서식, 소수 글꼴 크기(10.5pt)를 되살리고, 쓰지 않는 부속(그림, 메모,
 *   표 개체)을 떼어 내고, ExcelJS 가 파일 전체를 거부하는 변형(긴 시트 이름, 시트 번호 0, r 없는 행,
 *   겹치는 병합)을 고친다. 병합은 ExcelJS 에 맡기지 않고 따로 읽는다(병합 수의 제곱만큼 느려진다).
 */
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import { readZipDirectory, readZipEntry, readZipFile, type ZipDirEntry } from '../files/unzip.js';
import { normalizeText } from '../pdf/normalize.js';
import { stripControls } from './controls.js';
import { OfficeParseError } from './errors.js';
import {
  RENDER_MODEL_VERSION,
  type Border,
  type CellStyle,
  type OfficeExtractResult,
  type SheetModel,
  type SheetPage,
} from './model.js';
import { buildSheetText, columnLetter, type RawSheetCell, type RawSheetRow } from './sheet-text.js';
import { attr, childEls, localName, parseXml, unescapeXml, type XElement } from './xml.js';

export const XLSX_EXTRACTOR = 'xlsx-v1';

/** 색인과 표시에 똑같이 적용하는 상한 */
export interface XlsxLimits {
  /** 시트마다 앞에서부터 읽는 열 수 */
  maxCols: number;
  /** 시트마다 넣는 행 수(글자나 서식이 있는 행) */
  maxRowsPerSheet: number;
  /** 통합문서 전체에서 넣는 셀 수 */
  maxCellsTotal: number;
  /** 통합문서 전체 글자 수 */
  maxTextChars: number;
  /** 압축을 푼 시트 XML 이 이보다 큰 시트가 있으면 ExcelJS 에 넘기기 전에 쓰지 않을 행을 덜어 낸다(바이트) */
  trimSheetBytes: number;
  /** 덜어 낸 뒤에도 ExcelJS 에 넘길 부속(시트, 공유 문자열, 서식 등)을 실제로 푼 크기의 합이 이보다 크면 거부한다(바이트) */
  maxSheetXmlBytes: number;
  /**
   * 통합문서 전체에서 높이 0 행(숨긴 행 표시)으로 내는 수. 넘으면 나머지 숨긴 행은 화면에 빈 행으로
   * 보인다(색인과 글자 조각에는 영향이 없다). 자동 필터로 수십만 행을 숨긴 시트에서 모델이 불어나지 않게
   */
  maxHiddenRows: number;
}

export const XLSX_LIMITS: Readonly<XlsxLimits> = {
  maxCols: 100,
  maxRowsPerSheet: 5000,
  maxCellsTotal: 300_000,
  maxTextChars: 3_000_000,
  // ExcelJS 는 시트 XML 의 10~15배 메모리를 쓴다(실측 77MB → 1.1GB): 서버 프로세스 하나를 지킨다
  trimSheetBytes: 4 * 1024 * 1024,
  maxSheetXmlBytes: 80 * 1024 * 1024,
  maxHiddenRows: 100_000,
};

/** 병합 하나의 칸 수, 통합문서 전체 병합 칸 수 상한: 화면(SheetView)이 병합의 행마다 돈다 */
const MAX_MERGE_AREA = 100_000;
const MAX_MERGE_AREA_TOTAL = 1_000_000;
/** 통합문서에서 살펴보는 병합 수 상한(넘는 병합은 표시에서만 빠지고 글자는 그대로 남는다) */
const MAX_MERGES_TOTAL = 50_000;
/** 엑셀의 행, 열 한계 */
const MAX_SHEET_ROWS = 1_048_576;
const MAX_SHEET_COLS = 16_384;
/** styles.xml 을 따로 읽을 때의 크기 상한 */
const MAX_STYLES_XML_BYTES = 64 * 1024 * 1024;
/** ZIP 항목 하나를 풀 때의 크기 상한 (판별 단계가 전체 400MB 로 막는다) */
const MAX_PART_BYTES = 512 * 1024 * 1024;
/** ExcelJS 4.4.0 이 워크시트로 읽는 이름 규칙. ExcelJS 와 같게 앞뒤를 고정하지 않는다 */
const EXCELJS_SHEET_PART = /xl\/worksheets\/sheet(\d+)[.]xml/;
/** 테마 부속 (색 해석에 theme1 을 쓴다) */
const THEME_PART = /^xl\/theme\/[a-zA-Z0-9]+\.xml$/;
/** ExcelJS 에 늘 넘기는 통합문서 부속 */
const BOOK_PARTS = ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml'] as const;
const CORRUPT_MESSAGE = '엑셀 파일을 읽을 수 없습니다. 파일이 손상되었을 수 있습니다.';

const MS_PER_DAY = 86_400_000;
/** 1970-01-01 의 엑셀 일련번호(1900 날짜 체계) */
const SERIAL_1970 = 25_569;

// ─────────────────────────────── 표시 서식(numFmt) ───────────────────────────────

/** 서식 조각 */
type Tok =
  | { k: 'lit'; v: string }
  | { k: 'ph'; v: '0' | '#' | '?' }
  | { k: 'dot' }
  | { k: 'comma' }
  | { k: 'pct' }
  | { k: 'slash' }
  | { k: 'exp'; v: string; plus: boolean }
  | { k: 'at' }
  | { k: 'gen' }
  | { k: 'y' | 'mo' | 'mi' | 'd' | 'aaa' | 'h' | 's' | 'fs'; n: number }
  | { k: 'ampm'; v: string }
  | { k: 'el'; u: 'h' | 'm' | 's'; n: number };

/** 숫자 구역의 자리 배치 */
interface NumLayout {
  all: Tok[];
  intToks: Tok[];
  fracToks: Tok[];
  expToks: Tok[];
  hasDot: boolean;
  exp: { v: string; plus: boolean } | null;
  /** 정수부, 소수부 자리표시(0 # ?) 수 */
  nInt: number;
  nFrac: number;
  /** 정수부에 # 이 있는가 (공학 표기 판정) */
  intHash: boolean;
  /** 천 단위 쉼표 */
  grouping: boolean;
  /** 끝 쉼표 수: 1,000 으로 나누는 횟수 */
  scale: number;
  /** % 개수: 100 을 곱하는 횟수 */
  pct: number;
}

interface Section {
  kind: 'num' | 'date' | 'text' | 'gen' | 'empty';
  toks: Tok[];
  cond: { op: string; v: number } | null;
  /** 한국어 로캘([$-412] 등): 오전/오후, 요일, 월 이름 */
  ko: boolean;
  num: NumLayout | null;
}

/** 1차 어휘 조각 */
type Raw =
  | { k: 'q'; v: string }
  | { k: 'br'; v: string }
  | { k: 'c'; v: string }
  | { k: 'gen' }
  | { k: 'ampm'; v: string }
  | { k: 'exp'; v: string; plus: boolean };

/** 시스템 긴 날짜, 시간([$-x-sysdate], [$-x-systime]): 한국어 Windows 기본값 */
const KO_LONG_DATE = 'yyyy"년" m"월" d"일" aaaa';
const KO_LONG_TIME = '[$-412]AM/PM h:mm:ss';

/** 로캘마다 다르게 보이는 기본 서식: 한국어 엑셀 화면으로 바꾼다 */
const LOCALE_FORMATS = new Map<string, string>([
  ['mm-dd-yy', 'yyyy-mm-dd'], // 기본 서식 14 (간단한 날짜)
  ['m/d/yy "h":mm', 'yyyy-mm-dd h:mm'], // 기본 서식 22 (ExcelJS 표기)
  ['m/d/yy h:mm', 'yyyy-mm-dd h:mm'],
]);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KO_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 구역 구분자 ';' 로 자른다 (따옴표, 대괄호, 역슬래시, _x, *x 안의 ';' 는 글자) */
function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < fmt.length; i += 1) {
    const ch = fmt[i]!;
    if (quoted) {
      cur += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      cur += ch + (fmt[i + 1] ?? '');
      i += 1;
    } else if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (ch === ';' && !bracket) {
      out.push(cur);
      cur = '';
    } else {
      if (ch === '[') bracket = true;
      else if (ch === ']') bracket = false;
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function lexSection(src: string): Raw[] {
  const out: Raw[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      const end = j < 0 ? src.length : j;
      out.push({ k: 'q', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === '\\') {
      if (i + 1 < src.length) out.push({ k: 'q', v: src[i + 1]! });
      i += 2;
    } else if (ch === '_' || ch === '*') {
      i += 2; // 너비 맞춤(_x), 반복 채움(*x): 보이는 글자가 아니다
    } else if (ch === '[') {
      const j = src.indexOf(']', i + 1);
      if (j < 0) {
        out.push({ k: 'c', v: ch });
        i += 1;
      } else {
        out.push({ k: 'br', v: src.slice(i + 1, j) });
        i = j + 1;
      }
    } else if ((ch === 'G' || ch === 'g') && src.slice(i, i + 7).toLowerCase() === 'general') {
      out.push({ k: 'gen' });
      i += 7;
    } else if ((ch === 'A' || ch === 'a') && src.slice(i, i + 5).toLowerCase() === 'am/pm') {
      out.push({ k: 'ampm', v: src.slice(i, i + 5) });
      i += 5;
    } else if ((ch === 'A' || ch === 'a') && src.slice(i, i + 3).toLowerCase() === 'a/p') {
      out.push({ k: 'ampm', v: src.slice(i, i + 3) });
      i += 3;
    } else if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      out.push({ k: 'exp', v: ch, plus: src[i + 1] === '+' });
      i += 2;
    } else {
      out.push({ k: 'c', v: ch });
      i += 1;
    }
  }
  return out;
}

function rawText(r: Raw): string {
  switch (r.k) {
    case 'q':
    case 'c':
    case 'ampm':
      return r.v;
    case 'gen':
      return 'General';
    case 'exp':
      return r.v + (r.plus ? '+' : '-');
    default:
      return '';
  }
}

function pushLit(toks: Tok[], v: string): void {
  if (v === '') return;
  const last = toks[toks.length - 1];
  if (last && last.k === 'lit') last.v += v;
  else toks.push({ k: 'lit', v });
}

function buildSection(src: string): Section {
  const sec: Section = { kind: 'empty', toks: [], cond: null, ko: false, num: null };
  if (src === '') return sec;
  const pre: Raw[] = [];
  let sys: 'date' | 'time' | null = null;
  for (const r of lexSection(src)) {
    if (r.k !== 'br') {
      pre.push(r);
      continue;
    }
    const b = r.v.trim();
    if (/^(h+|m+|s+)$/i.test(b)) {
      pre.push({ k: 'br', v: b }); // 경과 시간 [h] [mm] [ss]
    } else if (b.startsWith('$')) {
      // [$기호-로캘]: 기호는 글자로, 로캘은 언어 판정에만 쓴다
      const dash = b.indexOf('-');
      const sym = dash < 0 ? b.slice(1) : b.slice(1, dash);
      const loc = dash < 0 ? '' : b.slice(dash + 1).toLowerCase();
      if (sym) pre.push({ k: 'q', v: sym });
      if (loc === 'x-sysdate' || loc === 'f800') sys = 'date';
      else if (loc === 'x-systime' || loc === 'f400') sys = 'time';
      else if (loc.startsWith('ko') || (/^[0-9a-f]{1,8}$/.test(loc) && (parseInt(loc, 16) & 0xffff) === 0x412)) {
        sec.ko = true;
      }
    } else {
      const m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(b);
      if (m) sec.cond = { op: m[1]!, v: Number(m[2]) };
      // 그 밖(색 이름, [Color10], [DBNum1] 등)은 보이는 글자에 영향이 없다
    }
  }
  if (sys) {
    const sysSec = buildSection(sys === 'date' ? KO_LONG_DATE : KO_LONG_TIME);
    sysSec.ko = true;
    sysSec.cond = sec.cond;
    return sysSec;
  }

  const isDateRaw = (r: Raw, i: number): boolean => {
    if (r.k === 'ampm' || r.k === 'br') return true;
    if (r.k !== 'c') return false;
    if (/^[yYmMdDhHsS]$/.test(r.v)) return true;
    // aaa, aaaa: 요일
    if (r.v !== 'a' && r.v !== 'A') return false;
    const n1 = pre[i + 1];
    const n2 = pre[i + 2];
    return n1?.k === 'c' && n2?.k === 'c' && n1.v.toLowerCase() === 'a' && n2.v.toLowerCase() === 'a';
  };

  if (pre.some(isDateRaw)) {
    sec.kind = 'date';
    sec.toks = dateTokens(pre);
  } else if (pre.some((r) => r.k === 'c' && r.v === '@')) {
    sec.kind = 'text';
    for (const r of pre) {
      if (r.k === 'c' && r.v === '@') sec.toks.push({ k: 'at' });
      else pushLit(sec.toks, rawText(r));
    }
  } else if (pre.some((r) => r.k === 'gen')) {
    sec.kind = 'gen';
    for (const r of pre) {
      if (r.k === 'gen') sec.toks.push({ k: 'gen' });
      else pushLit(sec.toks, rawText(r));
    }
  } else {
    const toks = numTokens(pre);
    const layout = analyzeNum(toks);
    if (layout) {
      sec.kind = 'num';
      sec.toks = toks;
      sec.num = layout;
    } else {
      // 분수 서식(# ?/?)은 일반 서식으로 대신 보인다
      sec.kind = 'gen';
      sec.toks = [{ k: 'gen' }];
    }
  }
  return sec;
}

function dateTokens(pre: Raw[]): Tok[] {
  const toks: Tok[] = [];
  for (let i = 0; i < pre.length; i += 1) {
    const r = pre[i]!;
    if (r.k === 'ampm') {
      toks.push({ k: 'ampm', v: r.v });
      continue;
    }
    if (r.k === 'br') {
      const u = r.v[0]!.toLowerCase() as 'h' | 'm' | 's';
      toks.push({ k: 'el', u, n: r.v.length });
      continue;
    }
    if (r.k !== 'c') {
      pushLit(toks, rawText(r));
      continue;
    }
    const lower = r.v.toLowerCase();
    if (lower.length === 1 && 'ymdhsa'.includes(lower)) {
      let n = 1;
      for (;;) {
        const nx = pre[i + n];
        if (nx && nx.k === 'c' && nx.v.toLowerCase() === lower) n += 1;
        else break;
      }
      if (lower === 'a') {
        if (n >= 3) toks.push({ k: 'aaa', n: n >= 4 ? 4 : 3 });
        else pushLit(toks, pre.slice(i, i + n).map(rawText).join(''));
      } else if (lower === 'y') toks.push({ k: 'y', n: n <= 2 ? 2 : 4 });
      else if (lower === 'm') toks.push({ k: 'mo', n: Math.min(n, 5) });
      else if (lower === 'd') toks.push({ k: 'd', n: Math.min(n, 4) });
      else if (lower === 'h') toks.push({ k: 'h', n: Math.min(n, 2) });
      else toks.push({ k: 's', n: Math.min(n, 2) });
      i += n - 1;
      continue;
    }
    if (r.v === '.') {
      // 초 뒤 소수: ss.0 ss.00 ss.000
      const prev = toks[toks.length - 1];
      if (prev && (prev.k === 's' || (prev.k === 'el' && prev.u === 's'))) {
        let n = 0;
        for (;;) {
          const nx = pre[i + 1 + n];
          if (nx && nx.k === 'c' && nx.v === '0') n += 1;
          else break;
        }
        if (n > 0) {
          toks.push({ k: 'fs', n: Math.min(n, 3) });
          i += n;
          continue;
        }
      }
    }
    pushLit(toks, r.v);
  }
  // m, mm 은 시(h) 바로 뒤나 초(s) 바로 앞이면 분이다 (사이의 글자는 건너뛴다)
  const isHour = (t: Tok | undefined): boolean => !!t && (t.k === 'h' || (t.k === 'el' && t.u === 'h'));
  const isSec = (t: Tok | undefined): boolean => !!t && (t.k === 's' || (t.k === 'el' && t.u === 's'));
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.k !== 'mo' || t.n > 2) continue;
    let p = i - 1;
    while (p >= 0 && toks[p]!.k === 'lit') p -= 1;
    let q = i + 1;
    while (q < toks.length && toks[q]!.k === 'lit') q += 1;
    if (isHour(toks[p]) || isSec(toks[q])) toks[i] = { k: 'mi', n: t.n };
  }
  return toks;
}

function numTokens(pre: Raw[]): Tok[] {
  const toks: Tok[] = [];
  let seenDot = false;
  for (const r of pre) {
    if (r.k === 'exp') {
      toks.push({ k: 'exp', v: r.v, plus: r.plus });
    } else if (r.k === 'c') {
      const ch = r.v;
      if (ch === '0' || ch === '#' || ch === '?') toks.push({ k: 'ph', v: ch });
      else if (ch === '.' && !seenDot) {
        toks.push({ k: 'dot' });
        seenDot = true;
      } else if (ch === ',') toks.push({ k: 'comma' });
      else if (ch === '%') toks.push({ k: 'pct' });
      else if (ch === '/') toks.push({ k: 'slash' });
      else pushLit(toks, ch);
    } else {
      pushLit(toks, rawText(r));
    }
  }
  return toks;
}

/** 숫자 구역의 자리 배치. 분수 서식이면 null */
function analyzeNum(toks: Tok[]): NumLayout | null {
  const expIdx = toks.findIndex((t) => t.k === 'exp');
  const mantEnd = expIdx >= 0 ? expIdx : toks.length;
  let dotIdx = toks.findIndex((t) => t.k === 'dot');
  if (dotIdx >= mantEnd) dotIdx = -1;
  const intEnd = dotIdx >= 0 ? dotIdx : mantEnd;
  let firstPh = -1;
  let lastPh = -1;
  for (let i = 0; i < mantEnd; i += 1) {
    if (toks[i]!.k !== 'ph') continue;
    if (firstPh < 0) firstPh = i;
    lastPh = i;
  }
  let grouping = false;
  let scale = 0;
  let pct = 0;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.k === 'pct') pct += 1;
    else if (t.k === 'slash' && i > firstPh && i < lastPh) return null;
    else if (t.k === 'comma' && i < mantEnd && lastPh >= 0) {
      if (i > lastPh) scale += 1; // 마지막 자리표시 뒤 쉼표
      else if (i > firstPh && i < intEnd) grouping = true; // 정수부 자리표시 사이 쉼표
    }
  }
  const intToks = toks.slice(0, intEnd);
  const fracToks = dotIdx >= 0 ? toks.slice(dotIdx + 1, mantEnd) : [];
  const expTok = expIdx >= 0 ? toks[expIdx] : undefined;
  const isPh = (t: Tok): boolean => t.k === 'ph';
  return {
    all: toks,
    intToks,
    fracToks,
    expToks: expIdx >= 0 ? toks.slice(expIdx + 1) : [],
    hasDot: dotIdx >= 0,
    exp: expTok && expTok.k === 'exp' ? { v: expTok.v, plus: expTok.plus } : null,
    nInt: intToks.filter(isPh).length,
    nFrac: fracToks.filter(isPh).length,
    intHash: intToks.some((t) => t.k === 'ph' && t.v === '#'),
    grouping,
    scale,
    pct,
  };
}

const FORMAT_CACHE = new Map<string, Section[]>();

function parseFormat(fmt: string): Section[] {
  let secs = FORMAT_CACHE.get(fmt);
  if (!secs) {
    secs = splitSections(fmt).slice(0, 4).map(buildSection);
    if (FORMAT_CACHE.size >= 2000) FORMAT_CACHE.clear();
    FORMAT_CACHE.set(fmt, secs);
  }
  return secs;
}

/** 일반 서식이면 null, 로캘 기본 서식이면 한국어 화면 서식으로 */
function effectiveFormat(numFmt: string | undefined): string | null {
  if (!numFmt || numFmt.trim().toLowerCase() === 'general') return null;
  return LOCALE_FORMATS.get(numFmt) ?? numFmt;
}

/** x(부호 무시) = 0.digits × 10^exp10. 엑셀 정밀도(유효숫자 15자리)로 자른 10진 표현 */
function decimalDigits(x: number): { digits: string; exp10: number } {
  const a = Math.abs(x);
  if (a === 0 || !Number.isFinite(a)) return { digits: '', exp10: 0 };
  const s = a.toPrecision(15);
  const eAt = s.indexOf('e');
  const mant = eAt < 0 ? s : s.slice(0, eAt);
  const ex = eAt < 0 ? 0 : Number(s.slice(eAt + 1));
  const dot = mant.indexOf('.');
  const intPart = dot < 0 ? mant : mant.slice(0, dot);
  let all = intPart + (dot < 0 ? '' : mant.slice(dot + 1));
  let point = intPart.length + ex;
  const lead = /^0*/.exec(all)![0].length;
  all = all.slice(lead).replace(/0+$/, '');
  point -= lead;
  return all === '' ? { digits: '', exp10: 0 } : { digits: all, exp10: point };
}

function incrementDigits(s: string): string {
  const a = s.split('');
  for (let i = a.length - 1; i >= 0; i -= 1) {
    if (a[i] === '9') {
      a[i] = '0';
    } else {
      a[i] = String.fromCharCode(a[i]!.charCodeAt(0) + 1);
      return a.join('');
    }
  }
  return `1${a.join('')}`;
}

/** 0 이상 실수를 소수 d 자리로 반올림한 10진 숫자열 (0.5 는 올린다, 이진 오차 없음) */
function roundDecimal(v: number, d: number): { int: string; frac: string } {
  const { digits, exp10 } = decimalDigits(v);
  const keep = exp10 + d; // round(v × 10^d) 의 자리 수
  let n: string;
  if (digits === '' || keep < 0) n = '0';
  else if (keep === 0) n = digits.charCodeAt(0) >= 53 ? '1' : '0';
  else if (digits.length <= keep) n = digits + '0'.repeat(keep - digits.length);
  else {
    n = digits.slice(0, keep);
    if (digits.charCodeAt(keep) >= 53) n = incrementDigits(n);
  }
  if (d === 0) return { int: n, frac: '' };
  const padded = n.padStart(d + 1, '0');
  return { int: padded.slice(0, padded.length - d), frac: padded.slice(padded.length - d) };
}

/** v × 10^k (10진 자리 이동, 이진 오차 없이) */
function shift10(v: number, k: number): number {
  const { digits, exp10 } = decimalDigits(v);
  return digits === '' ? 0 : Number(`0.${digits}e${exp10 + k}`);
}

function plainDecimal(digits: string, exp10: number): string {
  if (digits === '') return '0';
  if (exp10 <= 0) return `0.${'0'.repeat(-exp10)}${digits}`;
  if (exp10 >= digits.length) return digits + '0'.repeat(exp10 - digits.length);
  return `${digits.slice(0, exp10)}.${digits.slice(exp10)}`;
}

/** 일반(General) 서식: 정수는 그대로, 소수는 유효숫자 10자리(정수부가 더 길면 그 길이, 최대 15)까지 */
function formatGeneral(n: number): string {
  if (n === 0) return '0';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e15 || a < 1e-9) {
    const [m = '0', e = '0'] = a.toExponential(5).split('e');
    const mant = m.includes('.') ? m.replace(/\.?0+$/, '') : m;
    const ev = Number(e);
    return `${sign}${mant}E${ev < 0 ? '-' : '+'}${String(Math.abs(ev)).padStart(2, '0')}`;
  }
  if (Number.isInteger(a)) return sign + String(a);
  const intDigits = Math.max(decimalDigits(a).exp10, 0);
  const sig = Math.min(15, Math.max(10, intDigits));
  const { digits, exp10 } = decimalDigits(Number(a.toPrecision(sig)));
  return sign + plainDecimal(digits, exp10);
}

function literalOf(t: Tok): string {
  switch (t.k) {
    case 'lit':
      return t.v;
    case 'pct':
      return '%';
    case 'slash':
      return '/';
    case 'dot':
      return '.';
    default:
      return '';
  }
}

/** 정수부: 오른쪽 자리표시부터 숫자를 채우고, 가장 왼쪽 자리표시가 남은 숫자를 모두 받는다 */
function fillInt(toks: Tok[], digits: string, grouping: boolean): string {
  let acc = '';
  let di = digits.length;
  let count = 0;
  const firstPh = toks.findIndex((t) => t.k === 'ph');
  const put = (ch: string): void => {
    if (grouping && count > 0 && count % 3 === 0) acc = `,${acc}`;
    acc = ch + acc;
    count += 1;
  };
  for (let i = toks.length - 1; i >= 0; i -= 1) {
    const t = toks[i]!;
    if (t.k === 'ph') {
      if (di > 0) {
        di -= 1;
        put(digits[di]!);
      } else if (t.v === '0') put('0');
      else if (t.v === '?') acc = ` ${acc}`;
      if (i === firstPh) {
        while (di > 0) {
          di -= 1;
          put(digits[di]!);
        }
      }
    } else {
      acc = literalOf(t) + acc;
    }
  }
  return acc;
}

/** 소수부: 왼쪽부터 채우고, 끝의 0 은 # 이면 지우고 ? 이면 공백으로 */
function fillFrac(toks: Tok[], frac: string): string {
  const kinds: string[] = [];
  for (const t of toks) if (t.k === 'ph') kinds.push(t.v);
  const shown = kinds.map((_, j) => frac[j] ?? '0');
  for (let j = kinds.length - 1; j >= 0; j -= 1) {
    if (shown[j] !== '0' || kinds[j] === '0') break;
    shown[j] = kinds[j] === '?' ? ' ' : '';
  }
  let out = '';
  let j = 0;
  for (const t of toks) {
    if (t.k === 'ph') {
      out += shown[j] ?? '';
      j += 1;
    } else {
      out += literalOf(t);
    }
  }
  return out;
}

function mantissaText(L: NumLayout, r: { int: string; frac: string }, grouping: boolean): string {
  const digits = r.int === '0' ? '' : r.int;
  const intStr =
    L.nInt > 0 ? fillInt(L.intToks, digits, grouping) : L.intToks.map(literalOf).join('') + digits;
  return intStr + (L.hasDot ? '.' : '') + fillFrac(L.fracToks, r.frac);
}

function renderSci(L: NumLayout, exp: { v: string; plus: boolean }, v: number): string {
  const eng = L.intHash && L.nInt > 1; // ##0.0E+0: 지수를 정수부 자리 수의 배수로
  const width = eng ? L.nInt : Math.max(L.nInt, 1);
  let e = 0;
  if (v !== 0) {
    const e10 = decimalDigits(v).exp10 - 1; // floor(log10 v)
    e = eng ? Math.floor(e10 / width) * width : e10 - (width - 1);
  }
  let r = roundDecimal(shift10(v, -e), L.nFrac);
  if (v !== 0 && r.int.length > width) {
    e += eng ? width : 1;
    r = roundDecimal(shift10(v, -e), L.nFrac);
  }
  let minDigits = 0;
  let after = '';
  let seenPh = false;
  for (const t of L.expToks) {
    if (t.k === 'ph') {
      seenPh = true;
      if (t.v === '0') minDigits += 1;
    } else if (seenPh) after += literalOf(t);
  }
  const sign = e < 0 ? '-' : exp.plus ? '+' : '';
  return `${mantissaText(L, r, false)}${exp.v}${sign}${String(Math.abs(e)).padStart(minDigits, '0')}${after}`;
}

function renderNum(L: NumLayout, x: number): string {
  if (L.nInt + L.nFrac === 0) return L.all.map(literalOf).join(''); // 글자만 있는 구역
  const v = (x * 100 ** L.pct) / 1000 ** L.scale;
  if (L.exp) return renderSci(L, L.exp, v);
  return mantissaText(L, roundDecimal(v, L.nFrac), L.grouping);
}

function renderGen(toks: Tok[], x: number): string {
  let out = '';
  for (const t of toks) out += t.k === 'gen' ? formatGeneral(x) : literalOf(t);
  return out;
}

interface DateParts {
  y: number;
  m: number;
  d: number;
  /** 요일 0 = 일요일 */
  dow: number;
  H: number;
  M: number;
  S: number;
  /** 초 아래 (10^fracDigits 단위) */
  sub: number;
  days: number;
}

/** 엑셀 일련번호 → 날짜, 시각. 1900 체계의 가짜 윤일(1900-02-29)과 0일(1900-01-00)을 그대로 따른다 */
function serialParts(serial: number, date1904: boolean, fracDigits: number): DateParts | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const perSec = 10 ** fracDigits;
  const perDay = 86_400 * perSec;
  const ticks = Math.round(serial * perDay);
  const days = Math.floor(ticks / perDay);
  let rem = ticks - days * perDay;
  const sub = rem % perSec;
  rem = (rem - sub) / perSec;
  const S = rem % 60;
  rem = (rem - S) / 60;
  const M = rem % 60;
  const H = (rem - M) / 60;
  let y: number;
  let m: number;
  let d: number;
  if (!date1904 && days === 0) {
    [y, m, d] = [1900, 1, 0];
  } else if (!date1904 && days === 60) {
    [y, m, d] = [1900, 2, 29];
  } else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const dt = new Date(base + days * MS_PER_DAY);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  // JS 날짜 범위를 넘는 일련번호는 Invalid Date(NaN)다: 엑셀도 날짜로 보이지 못한다(#####)
  if (!Number.isFinite(y) || y > 9999) return null;
  return { y, m, d, dow: (days + (date1904 ? 5 : 6)) % 7, H, M, S, sub, days };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function ampmText(v: string, hour: number, ko: boolean): string {
  const pm = hour >= 12;
  const lower = v[0] === v[0]!.toLowerCase();
  if (v.length === 5) {
    if (ko) return pm ? '오후' : '오전';
    const s = pm ? 'PM' : 'AM';
    return lower ? s.toLowerCase() : s;
  }
  const s = pm ? 'P' : 'A';
  return lower ? s.toLowerCase() : s;
}

function renderDate(sec: Section, serial: number, date1904: boolean): string | null {
  let fracDigits = 0;
  let h12 = false;
  for (const t of sec.toks) {
    if (t.k === 'fs') fracDigits = Math.max(fracDigits, t.n);
    else if (t.k === 'ampm') h12 = true;
  }
  const p = serialParts(serial, date1904, fracDigits);
  if (!p) return null;
  const total = p.days * 86_400 + p.H * 3600 + p.M * 60 + p.S;
  let out = '';
  for (const t of sec.toks) {
    switch (t.k) {
      case 'lit':
        out += t.v;
        break;
      case 'y':
        out += t.n <= 2 ? pad2(p.y % 100) : String(p.y).padStart(4, '0');
        break;
      case 'mo':
        if (t.n === 1) out += String(p.m);
        else if (t.n === 2) out += pad2(p.m);
        else if (sec.ko) out += `${p.m}월`;
        else if (t.n === 3) out += MONTHS[p.m - 1]!.slice(0, 3);
        else if (t.n === 4) out += MONTHS[p.m - 1]!;
        else out += MONTHS[p.m - 1]![0]!;
        break;
      case 'mi':
        out += t.n >= 2 ? pad2(p.M) : String(p.M);
        break;
      case 'd':
        if (t.n === 1) out += String(p.d);
        else if (t.n === 2) out += pad2(p.d);
        else if (sec.ko) out += t.n === 3 ? KO_WEEKDAYS[p.dow]! : `${KO_WEEKDAYS[p.dow]!}요일`;
        else out += t.n === 3 ? WEEKDAYS[p.dow]!.slice(0, 3) : WEEKDAYS[p.dow]!;
        break;
      case 'aaa':
        out += t.n === 3 ? KO_WEEKDAYS[p.dow]! : `${KO_WEEKDAYS[p.dow]!}요일`;
        break;
      case 'h': {
        const hour = h12 ? p.H % 12 || 12 : p.H;
        out += t.n >= 2 ? pad2(hour) : String(hour);
        break;
      }
      case 's':
        out += t.n >= 2 ? pad2(p.S) : String(p.S);
        break;
      case 'fs':
        out += `.${String(p.sub).padStart(fracDigits, '0').slice(0, t.n)}`;
        break;
      case 'ampm':
        out += ampmText(t.v, p.H, sec.ko);
        break;
      case 'el': {
        const v = t.u === 'h' ? Math.floor(total / 3600) : t.u === 'm' ? Math.floor(total / 60) : total;
        out += String(v).padStart(t.n, '0');
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function testCond(c: { op: string; v: number }, n: number): boolean {
  switch (c.op) {
    case '<':
      return n < c.v;
    case '<=':
      return n <= c.v;
    case '>':
      return n > c.v;
    case '>=':
      return n >= c.v;
    case '=':
      return n === c.v;
    default:
      return n !== c.v;
  }
}

/** 숫자에 쓸 구역과 앞에 붙일 부호 */
function pickSection(secs: Section[], n: number): { sec: Section; sign: string } | null {
  const [s0, s1, s2] = secs;
  if (!s0) return null;
  if (s0.cond || s1?.cond) {
    let sec: Section | undefined;
    if (s0.cond && testCond(s0.cond, n)) sec = s0;
    else if (s1?.cond && testCond(s1.cond, n)) sec = s1;
    else if (!s0.cond) sec = s0;
    else if (s1 && !s1.cond && s1.kind !== 'text') sec = s1;
    else if (s2 && s2.kind !== 'text') sec = s2;
    if (!sec) return null;
    // [<0] 처럼 음수만 받는 구역은 부호를 스스로 쓴다
    const negOnly = !!sec.cond && ((sec.cond.op === '<' && sec.cond.v <= 0) || (sec.cond.op === '<=' && sec.cond.v < 0));
    return { sec, sign: n < 0 && !negOnly ? '-' : '' };
  }
  if (!s1) return { sec: s0, sign: n < 0 ? '-' : '' };
  if (n < 0) return { sec: s1, sign: '' };
  if (n === 0 && s2) return { sec: s2, sign: '' };
  return { sec: s0, sign: '' };
}

/** 숫자 하나를 표시 서식으로 (엑셀 화면 글자). 모르는 서식은 일반(General) 서식으로 보인다 */
export function formatNumber(n: number, numFmt?: string, date1904 = false): string {
  if (!Number.isFinite(n)) return '#NUM!';
  const fmt = effectiveFormat(numFmt);
  if (fmt === null) return formatGeneral(n);
  const picked = pickSection(parseFormat(fmt), n);
  if (!picked) return formatGeneral(n);
  const { sec, sign } = picked;
  switch (sec.kind) {
    case 'empty':
      return '';
    case 'date':
      return renderDate(sec, n, date1904) ?? formatGeneral(n);
    case 'num':
      return sec.num ? sign + renderNum(sec.num, Math.abs(n)) : formatGeneral(n);
    case 'gen':
      return sign + renderGen(sec.toks, Math.abs(n));
    default:
      return formatGeneral(n);
  }
}

/** 글자 값: 글자 구역(넷째 구역이나 @ 가 있는 구역)이 있으면 적용 */
function formatText(s: string, numFmt: string | undefined): string {
  if (!numFmt) return s;
  const secs = parseFormat(numFmt);
  const sec = secs.length >= 4 ? secs[3] : secs.find((x) => x.kind === 'text');
  if (!sec) return s;
  let out = '';
  for (const t of sec.toks) out += t.k === 'at' ? s : literalOf(t);
  return out;
}

function richTextOf(runs: unknown[]): string {
  let out = '';
  for (const run of runs) {
    const t = run && typeof run === 'object' ? (run as { text?: unknown }).text : undefined;
    if (typeof t === 'string') out += t;
  }
  return out;
}

function formatValue(v: unknown, numFmt: string | undefined, date1904: boolean): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(v, numFmt, date1904);
  if (typeof v === 'string') return formatText(v, numFmt);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) return '';
    // ExcelJS 는 날짜 서식 숫자를 UTC Date 로 준다: 일련번호로 되돌려 엑셀 규칙대로 보인다
    const serial = ms / MS_PER_DAY + SERIAL_1970 - (date1904 ? 1462 : 0);
    if (effectiveFormat(numFmt) === null) {
      return formatNumber(serial, Number.isInteger(serial) ? 'yyyy-mm-dd' : 'yyyy-mm-dd h:mm:ss', date1904);
    }
    return formatNumber(serial, numFmt, date1904);
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o || 'result' in o) return formatValue(o.result, numFmt, date1904);
    if (Array.isArray(o.richText)) return richTextOf(o.richText);
    if ('hyperlink' in o || 'text' in o) return formatValue(o.text, numFmt, date1904);
    if (typeof o.error === 'string') return o.error;
  }
  return '';
}

/**
 * ExcelJS 셀 값 → 엑셀 화면 글자.
 * null, 숫자, 글자, Date, 참/거짓, 리치 텍스트, 하이퍼링크, 수식(저장된 결과), 오류를 다룬다.
 * date1904 는 통합문서의 1904 날짜 체계 여부(wb.properties.date1904).
 */
export function formatCellValue(cell: { value: unknown; numFmt?: string }, date1904 = false): string {
  return formatValue(cell.value, cell.numFmt, date1904);
}

/** 숫자, 날짜 값인가 (수식은 결과로 판단): 기본 정렬이 오른쪽 */
function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number' || v instanceof Date) return true;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o || 'result' in o) return isNumericValue(o.result);
  }
  return false;
}

// ─────────────────────────────── 색 ───────────────────────────────

/** SpreadsheetML 테마 색 색인 순서: 0 lt1, 1 dk1, 2 lt2, 3 dk2, 4-9 accent1-6, 10 hlink, 11 folHlink */
const THEME_SLOTS = [
  'lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink',
] as const;
/** 테마가 없을 때: Office 2013 이후 기본 테마 */
const DEFAULT_THEME = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72',
];
/** 옛 색인 팔레트(indexed 0-63). 64 = 시스템 전경(검정), 65 = 시스템 배경(흰색) */
export const INDEXED_COLORS = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/**
 * 색 밝기 조정(tint, -1..1): HSL 의 L 을 tint < 0 이면 L × (1 + tint), tint > 0 이면
 * L × (1 - tint) + tint 로 바꾼다 (ECMA-376 의 tint 정의). 'RRGGBB' → 'RRGGBB'
 */
export function applyTint(hex: string, tint: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const t = Math.max(-1, Math.min(1, tint));
  const l2 = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const hex2 = (x: number): string =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  if (s === 0) return hex2(l2).repeat(3).toUpperCase();
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
  const p = 2 * l2 - q;
  const channel = (x0: number): number => {
    let x = x0;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return (hex2(channel(h + 1 / 3)) + hex2(channel(h)) + hex2(channel(h - 1 / 3))).toUpperCase();
}

class ColorResolver {
  constructor(private readonly theme: readonly string[]) {}

  /** ExcelJS 색 {argb} {theme, tint} {indexed} → '#rrggbb'. 자동 색이거나 알 수 없으면 undefined */
  resolve(c: unknown): string | undefined {
    if (!c || typeof c !== 'object') return undefined;
    const col = c as { argb?: unknown; theme?: unknown; tint?: unknown; indexed?: unknown };
    let hex: string | undefined;
    if (typeof col.argb === 'string') hex = /^(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(col.argb.trim())?.[1];
    else if (typeof col.theme === 'number') hex = this.theme[col.theme];
    else if (typeof col.indexed === 'number') {
      hex = col.indexed === 64 ? '000000' : col.indexed === 65 ? 'FFFFFF' : INDEXED_COLORS[col.indexed];
    }
    if (!hex) return undefined;
    const tint = typeof col.tint === 'number' ? col.tint : 0;
    return `#${(tint ? applyTint(hex, tint) : hex).toLowerCase()}`;
  }
}

function findByLocalName(el: XElement, name: string): XElement | undefined {
  for (const c of childEls(el)) {
    if (localName(c.name) === name) return c;
    const hit = findByLocalName(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** 통합문서 테마의 색 12개(SpreadsheetML 색인 순서). 없거나 읽지 못하면 기본 Office 테마 */
function readThemeColors(wb: ExcelJS.Workbook): string[] {
  // ExcelJS 4.4.0 은 xl/theme/theme1.xml 원문을 wb._themes 에 보관한다(공개 API 아님)
  const themes = (wb as unknown as { _themes?: Record<string, unknown> })._themes;
  let xml: unknown = themes?.theme1;
  if (typeof xml !== 'string' && themes) xml = Object.values(themes).find((v) => typeof v === 'string');
  if (typeof xml !== 'string') return DEFAULT_THEME.slice();
  try {
    const scheme = findByLocalName(parseXml(xml).root, 'clrScheme');
    if (!scheme) return DEFAULT_THEME.slice();
    const found = new Map<string, string>();
    for (const slot of childEls(scheme)) {
      const clr = childEls(slot)[0];
      if (!clr) continue;
      const kind = localName(clr.name);
      let hex: string | undefined;
      if (kind === 'srgbClr') hex = attr(clr, 'val');
      else if (kind === 'sysClr') hex = attr(clr, 'lastClr') ?? (attr(clr, 'val') === 'window' ? 'FFFFFF' : '000000');
      if (hex && /^[0-9a-f]{6}$/i.test(hex)) found.set(localName(slot.name), hex.toUpperCase());
    }
    return THEME_SLOTS.map((name, i) => found.get(name) ?? DEFAULT_THEME[i]!);
  } catch {
    return DEFAULT_THEME.slice();
  }
}

// ─────────────────────────────── 셀 서식 ───────────────────────────────

const BORDER_STYLES: Record<string, { w: Border['w']; style: Border['style'] }> = {
  thin: { w: 1, style: 'solid' },
  hair: { w: 1, style: 'dotted' },
  dotted: { w: 1, style: 'dotted' },
  dashed: { w: 1, style: 'dashed' },
  dashDot: { w: 1, style: 'dashed' },
  dashDotDot: { w: 1, style: 'dashed' },
  medium: { w: 2, style: 'solid' },
  mediumDashed: { w: 2, style: 'dashed' },
  mediumDashDot: { w: 2, style: 'dashed' },
  mediumDashDotDot: { w: 2, style: 'dashed' },
  slantDashDot: { w: 2, style: 'dashed' },
  thick: { w: 3, style: 'solid' },
  double: { w: 3, style: 'double' },
};

const H_ALIGN: Record<string, CellStyle['ha']> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
  fill: 'left',
  centerContinuous: 'center',
  distributed: 'justify',
};

const V_ALIGN: Record<string, CellStyle['va']> = {
  top: 'top',
  middle: 'middle',
  center: 'middle',
  bottom: 'bottom',
  distributed: 'middle',
  justify: 'middle',
};

interface Resolved {
  idx?: number;
  /** 채우기나 테두리가 있다(빈 셀도 그린다) */
  visible: boolean;
}

/** 글꼴 이름은 화면 CSS(font-family)로 간다: 글자, 숫자, 공백, '.', '_', '-' 만 받는다 */
const SAFE_FONT_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

const NO_STYLE: Resolved = { visible: false };

/**
 * 화면(SheetView)이 글꼴 정보가 없는 칸에 쓰는 크기와 글꼴(sheetview.css: 11pt, Calibri).
 * 모델에 통합문서 기본 글꼴 필드가 없으므로, 칸의 실제 글꼴이 이와 다르면 크기, 이름을 칸마다 적는다.
 */
const VIEW_FONT_PT = 11;
const VIEW_FONT_NAME = 'calibri';

/** 셀 서식 표(중복 제거). 같은 xf 를 쓰는 셀은 ExcelJS 가 서식 객체를 공유하므로 객체 단위로 기억한다 */
class StyleTable {
  readonly list: CellStyle[] = [];
  private readonly index = new Map<string, number>();
  private readonly memo = new WeakMap<object, [Resolved | undefined, Resolved | undefined]>();
  /** 서식 없는 칸(글자, 숫자) */
  private readonly plain: [Resolved | undefined, Resolved | undefined] = [undefined, undefined];

  /** defFont: 통합문서 기본 글꼴(fonts[0], 표준 스타일). 서식 없는 칸은 엑셀에서 이 글꼴로 보인다 */
  constructor(
    private readonly colors: ColorResolver,
    private readonly defFont: Partial<ExcelJS.Font>,
  ) {}

  ofCell(style: Partial<ExcelJS.Style> | undefined, num: boolean): Resolved {
    if (!style || (!style.font && !style.fill && !style.border && !style.alignment)) {
      const k = num ? 1 : 0;
      return (this.plain[k] ??= this.intern(this.convert({}, num)));
    }
    let slot = this.memo.get(style);
    if (!slot) {
      slot = [undefined, undefined];
      this.memo.set(style, slot);
    }
    const k = num ? 1 : 0;
    const hit = slot[k];
    if (hit) return hit;
    const res = this.intern(this.convert(style, num));
    slot[k] = res;
    return res;
  }

  /** 병합 기준 칸: 오른쪽, 아래 테두리는 병합 범위 끝 칸의 것을 쓴다(엑셀이 그리는 방식) */
  ofMerged(
    style: Partial<ExcelJS.Style> | undefined,
    num: boolean,
    right: Partial<ExcelJS.Border> | undefined,
    bottom: Partial<ExcelJS.Border> | undefined,
  ): Resolved {
    return this.intern(this.convert(style ?? {}, num, right, bottom));
  }

  private intern(cs: CellStyle): Resolved {
    const key = JSON.stringify(cs);
    if (key === '{}') return NO_STYLE;
    let idx = this.index.get(key);
    if (idx === undefined) {
      idx = this.list.length;
      this.list.push(cs);
      this.index.set(key, idx);
    }
    const visible = cs.bg !== undefined || !!cs.bt || !!cs.br || !!cs.bb || !!cs.bl;
    return { idx, visible };
  }

  private edge(e: Partial<ExcelJS.Border> | undefined): Border | undefined {
    if (!e?.style) return undefined;
    const spec = BORDER_STYLES[e.style];
    if (!spec) return undefined;
    return { w: spec.w, style: spec.style, color: this.colors.resolve(e.color) ?? '#000000' };
  }

  /** 속성을 늘 같은 순서로 넣는다: JSON 문자열이 중복 제거 열쇠다 */
  private convert(
    st: Partial<ExcelJS.Style>,
    num: boolean,
    right?: Partial<ExcelJS.Border>,
    bottom?: Partial<ExcelJS.Border>,
  ): CellStyle {
    const cs: CellStyle = {};
    const def = this.defFont;
    // 글꼴이 없는 칸(서식 번호 0)은 표준 스타일 글꼴로 보인다
    const f = st.font ?? def;
    if (f.bold) cs.b = true;
    if (f.italic) cs.i = true;
    if (f.underline && f.underline !== 'none') cs.u = true;
    if (f.strike) cs.strike = true;
    // 크기, 이름이 빠진 글꼴은 기본 글꼴을 따른다. 화면 기본값과 같을 때만 뺀다
    const size = typeof f.size === 'number' && f.size > 0 ? f.size : def.size;
    if (typeof size === 'number' && size > 0 && size !== VIEW_FONT_PT) cs.sz = size;
    const name = typeof f.name === 'string' && f.name !== '' ? f.name : def.name;
    if (typeof name === 'string' && name.toLowerCase() !== VIEW_FONT_NAME && SAFE_FONT_NAME.test(name)) cs.font = name;
    const color = this.colors.resolve(f.color);
    if (color && color !== '#000000') cs.color = color;
    const fill = st.fill;
    if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
      const bg = this.colors.resolve(fill.fgColor);
      if (bg) cs.bg = bg;
    }
    const al = st.alignment;
    if (al) {
      const ha = al.horizontal ? H_ALIGN[al.horizontal] : undefined;
      if (ha) cs.ha = ha;
      const va = al.vertical ? V_ALIGN[al.vertical] : undefined;
      if (va) cs.va = va;
      if (al.wrapText) cs.wrap = true;
      if (typeof al.indent === 'number' && al.indent > 0) cs.indent = al.indent;
    }
    const bd = st.border;
    const bt = this.edge(bd?.top);
    if (bt) cs.bt = bt;
    const br = this.edge(right?.style ? right : bd?.right);
    if (br) cs.br = br;
    const bb = this.edge(bottom?.style ? bottom : bd?.bottom);
    if (bb) cs.bb = bb;
    const bl = this.edge(bd?.left);
    if (bl) cs.bl = bl;
    if (num) cs.num = true;
    return cs;
  }
}

// ─────────────────────────────── ExcelJS 읽기 보정 ───────────────────────────────

/** 한국어 엑셀의 로캘 기본 서식(ECMA-376 ko-KR): 서식 정의 없이 번호만 쓴 파일을 위해 */
export const KO_BUILTIN_FORMATS: ReadonlyArray<readonly [number, string]> = [
  [27, 'yyyy"年" mm"月" dd"日"'],
  [28, 'mm-dd'],
  [29, 'mm-dd'],
  [30, 'mm-dd-yy'],
  [31, 'yyyy"년" mm"월" dd"일"'],
  [32, 'h"시" mm"분"'],
  [33, 'h"시" mm"분" ss"초"'],
  [34, 'yyyy-mm-dd'],
  [35, 'yyyy-mm-dd'],
  [36, 'yyyy"年" mm"月" dd"日"'],
  [41, '_-* #,##0_-;\\-* #,##0_-;_-* "-"_-;_-@_-'],
  [43, '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-'],
  [50, 'yyyy"年" mm"月" dd"日"'],
  [51, 'mm-dd'],
  [52, 'yyyy-mm-dd'],
  [53, 'yyyy-mm-dd'],
  [54, 'mm-dd'],
  [55, 'yyyy-mm-dd'],
  [56, 'yyyy-mm-dd'],
  [57, 'yyyy"年" mm"月" dd"日"'],
  [58, 'mm-dd'],
];

interface LoadInfo {
  /** 통합문서 기본 글꼴(fonts[0], 표준 스타일) */
  defaultFont?: Partial<ExcelJS.Font>;
  /** 1904 날짜 체계 (workbook.xml 원문: ExcelJS 는 date1904="1" 만 알아본다) */
  date1904: boolean;
  /** 미리 행을 잘라 낸 시트 부속 번호(xl/worksheets/sheetN.xml 의 N) */
  trimmedParts: Map<string, TrimReason>;
  /** 그 시트들의 이름: ExcelJS 가 시트에 이름을 붙인 뒤 채운다 */
  trimmedNames: Map<string, TrimReason>;
  /** ExcelJS 에 맡기지 않고 따로 읽은 병합 범위 (시트 부속 번호별, 시트 이름별) */
  mergeParts: Map<string, Rect[]>;
  mergeNames: Map<string, Rect[]>;
  /** ExcelJS 가 받지 않는 시트 이름을 바꿨을 때: 안쪽 이름 → 원래 이름(쪽 라벨) */
  labels: Map<string, string>;
}

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 미리 잘라 낸 까닭: 시트당 행 상한, 전체 셀 상한 */
type TrimReason = 'rows' | 'cells';

const HIDDEN_ROW = /\shidden\s*=\s*["'](?:1|true)["']/;
const CELL_REF = /\sr\s*=\s*["']([A-Za-z]{1,3})\d+["']/;
/** 빈 칸이지만 기본(0)이 아닌 서식이 있다: 테두리나 채우기일 수 있어 센다 */
const EMPTY_CELL_STYLED = /\ss\s*=\s*["']0*[1-9]/;

/**
 * 행 안에서 추출기가 낼 수 있는 셀 수의 상한: 열 상한 밖 셀과 값도 서식도 없는 빈 칸(<c r=".."/>)은
 * 빼고 센다. 찾기는 그 행 바이트 안에서만 한다
 */
function countRowCells(xml: Buffer, from: number, to: number, maxCols: number): number {
  const row = xml.subarray(from, to);
  let n = 0;
  for (let p = row.indexOf('<c'); p >= 0; p = row.indexOf('<c', p + 2)) {
    const after = row[p + 2];
    // <color> 같은 다른 요소는 건너뛴다
    if (after !== 0x20 && after !== 0x3e && after !== 0x2f && after !== 0x09 && after !== 0x0a && after !== 0x0d) continue;
    // 시작 태그 끝 '>' 는 다음 '<' 앞에서만 찾는다: 닫히지 않은 <c 가 이어진 손상 행에서 태그마다 행 끝까지
    // 되훑으면 시간이 제곱으로 는다(속성 값에는 '<' 가 올 수 없다)
    const lt = row.indexOf(0x3c, p + 1);
    const limit = lt < 0 ? row.length : lt;
    const found = row.subarray(p, limit).indexOf(0x3e);
    const tagEnd = found < 0 ? limit : p + found;
    const tag = row.toString('latin1', p, tagEnd);
    if (row[tagEnd - 1] === 0x2f && !EMPTY_CELL_STYLED.test(tag)) continue;
    const ref = CELL_REF.exec(tag);
    if (!ref || columnNumber(ref[1]!) <= maxCols) n += 1;
  }
  return n;
}

/** 병합 범위의 첫 행, 끝 행 번호 (</sheetData> 뒤 <mergeCell ref>): 추출기가 이 행의 셀을 읽는다 */
function mergeEdgeRows(xml: Buffer, from: number): Set<number> {
  const rows = new Set<number>();
  const tail = xml.toString('latin1', from);
  for (const m of tail.matchAll(/<(?:\w+:)?mergeCell\s[^<>]*?\bref\s*=\s*["']\$?[A-Za-z]{1,3}\$?(\d+)(?::\$?[A-Za-z]{1,3}\$?(\d+))?["']/g)) {
    rows.add(Number(m[1]));
    if (m[2]) rows.add(Number(m[2]));
  }
  return rows;
}

/**
 * 행 안에 공유 수식의 기준 셀(<f t="shared" ref=...>)이 있는가: 다른 행의 수식이 이 셀을 가리킨다.
 * 찾기는 그 행 바이트 안에서만 한다(시트 끝까지 찾으면 숨긴 행마다 전체를 훑게 된다)
 */
function hasSharedFormulaMaster(xml: Buffer, from: number, to: number): boolean {
  const row = xml.subarray(from, to);
  if (row.indexOf('t="shared"') < 0) return false;
  // 태그를 앞에서부터 하나씩(다음 '<' 앞까지만) 본다: 't="shared"' 마다 앞뒤로 되훑으면 손상 행에서 시간이 제곱으로 는다
  for (let p = row.indexOf(0x3c); p >= 0; ) {
    const next = row.indexOf(0x3c, p + 1);
    const limit = next < 0 ? row.length : next;
    const gt = row.subarray(p, limit).indexOf(0x3e);
    if (gt > 0) {
      const tag = row.toString('latin1', p, p + gt);
      if (tag.includes('t="shared"') && /\sref\s*=/.test(tag)) return true;
    }
    p = next;
  }
  return false;
}

/**
 * 시트 XML 을 추출기가 쓸 만큼만 남긴다. 바이트에서 바로 찾는다(수백 MB 를 문자열로 바꾸지 않는다).
 * - 숨긴 행: 셀을 비우고 행 요소(속성)만 남긴다. 병합의 첫 행, 끝 행과 공유 수식 기준 셀이 있는 행은 그대로.
 * - 추출기처럼 숨기지 않은 행의 열 상한 안 셀만 세어, 행 수가 maxRows 를 또는 셀 수가 maxCells 를
 *   넘기게 되는 행부터 </sheetData> 앞까지 버린다(reason).
 * 바뀐 것이 없으면 out = null.
 */
function trimSheetXml(
  xml: Buffer,
  maxRows: number,
  maxCells: number,
  maxCols: number,
): { out: Buffer | null; cells: number; reason?: TrimReason } {
  const open = xml.indexOf('<sheetData');
  const openEnd = open < 0 ? -1 : xml.indexOf('>', open);
  const close = xml.lastIndexOf('</sheetData>');
  if (openEnd < 0 || xml[openEnd - 1] === 0x2f || close < openEnd) return { out: null, cells: 0 }; // 행 없음
  const keepRows = mergeEdgeRows(xml, close);
  const parts: Buffer[] = [];
  let copied = 0; // parts 로 옮긴 원문 끝
  let hollowed = false;
  let pos = openEnd + 1;
  let rows = 0;
  let cells = 0;
  let reason: TrimReason | undefined;
  let cutAt = -1;
  while (pos < close) {
    const start = xml.indexOf('<row', pos);
    if (start < 0 || start >= close) break;
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0 || tagEnd >= close) break;
    let next = tagEnd + 1;
    let rowCells = 0;
    if (xml[tagEnd - 1] !== 0x2f) {
      const end = xml.indexOf('</row>', tagEnd);
      if (end < 0 || end > close) break;
      next = end + 6;
      const startTag = xml.toString('latin1', start, tagEnd);
      if (!HIDDEN_ROW.test(startTag)) {
        rowCells = countRowCells(xml, tagEnd, end, maxCols);
      } else {
        const rowNo = /\sr\s*=\s*["'](\d+)["']/.exec(startTag)?.[1];
        if (!(rowNo && keepRows.has(Number(rowNo))) && !hasSharedFormulaMaster(xml, tagEnd, end)) {
          parts.push(xml.subarray(copied, start), Buffer.from(`${startTag}/>`, 'latin1'));
          copied = next;
          hollowed = true;
        }
      }
    }
    if (rowCells > 0) {
      reason = rows + 1 > maxRows ? 'rows' : cells + rowCells > maxCells ? 'cells' : undefined;
      if (reason) {
        cutAt = start;
        break;
      }
      rows += 1;
      cells += rowCells;
    }
    pos = next;
  }
  if (cutAt < 0 && !hollowed) return { out: null, cells };
  parts.push(xml.subarray(copied, cutAt >= 0 ? cutAt : close), xml.subarray(close));
  const out = Buffer.concat(parts);
  return reason ? { out, cells, reason } : { out, cells };
}

/** 워크시트 부속 하나 */
interface SheetPart {
  /** ZIP 안 이름 (ExcelJS 규칙으로 만든 경로) */
  path: string;
  /** 부속 번호(sheetN.xml 의 N) = ExcelJS 의 sheetNo */
  no: string;
  hidden: boolean;
}

/** 시작 태그와 속성 문자열 (따옴표 안의 '>' 는 건너뛴다) */
const tagPattern = (name: string): RegExp => new RegExp(`<(?:[\\w.-]+:)?${name}\\s((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>`, 'g');

/**
 * 통합문서 순서의 워크시트 부속과 숨김 여부(workbook.xml 과 그 관계). ExcelJS 가 워크시트로 읽는 이름이고
 * ZIP 에 있는 것만 낸다: 차트 시트, 대화 상자 시트는 ExcelJS 가 읽지 않는다.
 */
function workbookSheets(wbXml: Buffer | undefined, relXml: Buffer | undefined, has: (name: string) => boolean): SheetPart[] {
  if (!wbXml || !relXml) return [];
  const targets = new Map<string, string>();
  for (const m of relXml.toString('utf8').matchAll(tagPattern('Relationship'))) {
    const id = /\bId\s*=\s*["']([^"']*)["']/.exec(m[1]!)?.[1];
    const target = /\bTarget\s*=\s*["']([^"']*)["']/.exec(m[1]!)?.[1];
    if (id && target) targets.set(id, unescapeXml(target));
  }
  const out: SheetPart[] = [];
  const seen = new Set<string>();
  for (const m of wbXml.toString('utf8').matchAll(tagPattern('sheet'))) {
    const attrs = m[1]!;
    const rid = /\b[\w.-]+:id\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (!target) continue;
    // ExcelJS 와 같은 경로 규칙
    const path = `xl/${target.replace(/^(\s|\/xl\/)+/, '')}`;
    const no = EXCELJS_SHEET_PART.exec(path)?.[1];
    if (no === undefined || seen.has(path) || !has(path)) continue;
    seen.add(path);
    const state = /\bstate\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    out.push({ path, no, hidden: state === 'hidden' || state === 'veryHidden' });
  }
  return out;
}

/** 1904 날짜 체계인가 (<workbookPr date1904="1">) */
function readDate1904(wbXml: Buffer | undefined): boolean {
  if (!wbXml) return false;
  const pr = tagPattern('workbookPr').exec(wbXml.toString('utf8'))?.[1];
  return !!pr && /\bdate1904\s*=\s*["'](?:1|true)["']/.test(pr);
}

/** 접두사를 지울 수 있는 뿌리 요소와 그 이름공간 (SpreadsheetML 본문, 패키지 관계) */
const PREFIXABLE_ROOT = /<(\w+):(workbook|worksheet|sst|styleSheet|Relationships)\b[^<>]*>/;
const PREFIXABLE_NS = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
  'http://schemas.openxmlformats.org/package/2006/relationships',
]);

/** 부속 XML 의 뿌리 요소가 SpreadsheetML 이름공간에 묶인 접두사를 쓰면 그 접두사(<x:worksheet> 의 x) */
function rootPrefix(xml: Buffer): string | null {
  const m = PREFIXABLE_ROOT.exec(xml.toString('latin1', 0, Math.min(xml.length, 8192)));
  if (!m) return null;
  const ns = new RegExp(`\\sxmlns:${m[1]}\\s*=\\s*["']([^"']*)["']`).exec(m[0])?.[1];
  return ns && PREFIXABLE_NS.has(ns) ? m[1]! : null;
}

/**
 * 요소 이름의 접두사를 지운다(<x:row> → <row>, </x:row> → </row>). ExcelJS 는 이름공간을 따지지 않고
 * 이름을 글자 그대로 맞춰 보므로 접두사를 쓴 파일(.NET OpenXML SDK 로 만든 내보내기 등)을 읽지 못한다.
 * 바이트를 그대로 옮겨 적는다(글자 인코딩을 건드리지 않는다).
 */
function stripElementPrefix(xml: Buffer, prefix: string): Buffer {
  const pat = Buffer.from(`${prefix}:`, 'latin1');
  const out = Buffer.allocUnsafe(xml.length);
  let o = 0;
  let copied = 0;
  for (let p = xml.indexOf(0x3c); p >= 0; p = xml.indexOf(0x3c, p + 1)) {
    const q = xml[p + 1] === 0x2f ? p + 2 : p + 1;
    if (q + pat.length <= xml.length && xml.compare(pat, 0, pat.length, q, q + pat.length) === 0) {
      o += xml.copy(out, o, copied, q);
      copied = q + pat.length;
    }
  }
  o += xml.copy(out, o, copied);
  return out.subarray(0, o);
}

/** 접두사를 썼으면 지운 부속 (SpreadsheetML, 패키지 관계 이름공간일 때만) */
function unprefixed(xml: Buffer): Buffer {
  const prefix = rootPrefix(xml);
  return prefix ? stripElementPrefix(xml, prefix) : xml;
}

/**
 * ISO 8601 날짜, 시각 글자 → 엑셀 일련번호. 읽지 못하거나 일련번호로 나타낼 수 없으면 null.
 * 시간대 표시(Z, +09:00)는 무시한다: 엑셀 일련번호에는 시간대가 없다.
 */
export function isoToSerial(text: string, date1904: boolean): number | null {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2}))?(?:[T ]?(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
    text.trim(),
  );
  if (!m || (m[1] === undefined && m[4] === undefined)) return null;
  let days = 0;
  if (m[1] !== undefined) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const utc = Date.UTC(y, mo - 1, d);
    const dt = new Date(utc);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // 2026-02-30 등
    if (date1904) {
      days = (utc - Date.UTC(1904, 0, 1)) / MS_PER_DAY;
    } else {
      days = (utc - Date.UTC(1899, 11, 30)) / MS_PER_DAY;
      if (days < 61) days -= 1; // 1900-03-01 앞: 엑셀의 가짜 윤일(1900-02-29) 때문에 하루 적다
    }
    if (days < 0) return null;
  }
  if (m[4] === undefined) return days;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), m[6] === undefined ? 0 : Number(m[6])];
  if (h > 24 || mi > 59 || s >= 61) return null;
  return days + (h * 3600 + mi * 60 + s) / 86_400;
}

/**
 * 값이 있는 셀 요소 <c ...>...</c> (자기닫힘 <c .../> 은 맞지 않는다).
 * 몸통은 다음 셀의 시작 태그를 넘지 않고, 속성 자리는 '<' 를 넘지 않는다: 닫는 태그가 없는 셀이 이어진 손상 파일에서
 * 여는 태그마다 끝까지 되훑으면 시간이 제곱으로 늘어(576KB 에 8초) 그동안 서버 전체가 멈춘다. 정상 XML 결과는 같다.
 * 이 파일의 다른 태그 정규식도 같은 규칙을 따른다(files/preview.ts collectTagText 머리 주석과 같은 문제).
 */
const CELL_WITH_BODY = /<((?:[\w.-]+:)?c)(\s(?:[^<>"'/]|"[^"<]*"|'[^'<]*'|\/(?!>))*)>((?:(?!<(?:[\w.-]+:)?c[\s>/])[\s\S])*?)<\/\1>/g;

/**
 * XML 주석(<!-- ... -->)을 지운다(선형 시간). 주석 안의 태그 모양 글자가 셀이나 서식으로 읽히거나(위 정규식이 주석 속
 * '<c ' 를 다음 셀로 보고 날짜 셀을 건너뛰던 문제), 서식 목록의 순서를 밀지 않게. 닫히지 않은 주석부터는 그대로 둔다
 * (손상 XML 은 ExcelJS 가 거부한다).
 */
function stripXmlComments(s: string): string {
  let i = s.indexOf('<!--');
  if (i < 0) return s;
  let out = '';
  let pos = 0;
  while (i >= 0) {
    const j = s.indexOf('-->', i + 4);
    if (j < 0) break;
    out += s.slice(pos, i);
    pos = j + 3;
    i = s.indexOf('<!--', pos);
  }
  return out + s.slice(pos);
}

/** 엑셀 기본 서식 가운데 날짜, 시각 서식 번호 (한국어 로캘의 27-36, 50-58 포함) */
const BUILTIN_DATE_FMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** styles.xml 의 셀 서식(cellXfs) 가운데 날짜 표시 서식을 쓰는 서식 번호 */
function dateStyleIds(stylesXml: string): Set<number> {
  const out = new Set<number>();
  const block = /<(?:\w+:)?cellXfs\b[^<>]*>((?:(?!<(?:\w+:)?cellXfs\b)[\s\S])*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)?.[1];
  if (!block) return out;
  const custom = rawNumFmts(stylesXml);
  let i = 0;
  for (const m of block.matchAll(/<(?:\w+:)?xf\b([^<>]*)>/g)) {
    const id = Number(/\bnumFmtId\s*=\s*["'](\d+)["']/.exec(m[1]!)?.[1] ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? parseFormat(code).some((s) => s.kind === 'date') : BUILTIN_DATE_FMT_IDS.has(id)) out.add(i);
    i += 1;
  }
  return out;
}

/**
 * t="d"(ISO 8601 날짜, ISO/IEC 29500) 셀을 고친다. ExcelJS 4.4.0 은 t="d" 를 몰라 '2026-01-02' 를 parseFloat 로
 * 2026 으로 읽는다. 날짜 서식 칸은 일련번호 숫자 셀로(서식대로 보인다), 그 밖의 칸은 날짜 글자 셀(t="str",
 * 서식 없는 Date 와 같은 yyyy-mm-dd [h:mm:ss])로, 날짜로 읽지 못한 값은 원래 글자 셀로 바꾼다.
 * 바이트를 latin1 로 그대로 옮겨 고친다(바꾸는 글자는 모두 ASCII). 바꾼 것이 없으면 null.
 */
function convertIsoDateCells(xml: Buffer, date1904: boolean, dateStyles: () => ReadonlySet<number>): Buffer | null {
  if (xml.indexOf('t="d"') < 0 && xml.indexOf("t='d'") < 0) return null;
  let changed = false;
  const out = stripXmlComments(xml.toString('latin1')).replace(CELL_WITH_BODY, (all: string, tag: string, attrs: string, body: string) => {
    const t = /\st\s*=\s*(["'])d\1/.exec(attrs);
    if (!t) return all;
    changed = true;
    const v = /<((?:[\w.-]+:)?v)>([^<]*)<\/\1>/.exec(body);
    const serial = v ? isoToSerial(unescapeXml(v[2]!), date1904) : null;
    if (!v || serial === null) return `<${tag}${attrs.replace(t[0], ' t="str"')}>${body}</${tag}>`;
    const s = Number(/\ss\s*=\s*["'](\d+)["']/.exec(attrs)?.[1] ?? 0);
    const value = (text: string): string => body.replace(v[0], `<${v[1]!}>${text}</${v[1]!}>`);
    if (dateStyles().has(s)) return `<${tag}${attrs.replace(t[0], '')}>${value(String(serial))}</${tag}>`;
    const shown = formatNumber(serial, Number.isInteger(serial) ? 'yyyy-mm-dd' : 'yyyy-mm-dd h:mm:ss', date1904);
    return `<${tag}${attrs.replace(t[0], ' t="str"')}>${value(shown)}</${tag}>`;
  });
  return changed ? Buffer.from(out, 'latin1') : null;
}

/** 부속들을 저장 방식(압축 없음) ZIP 으로 묶는다: 동기 압축으로 이벤트 루프를 막지 않게 */
function storedZip(parts: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_DATE_1980_01_01 = 0x21;
  for (const [name, data] of parts) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // 필요한 버전 1.0 (저장)
    local.writeUInt16LE(0x0800, 6); // UTF-8 이름
    local.writeUInt16LE(0, 8); // 방식 0: 저장
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    out.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(10, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, dir, eocd]);
}

function tooLarge(total: number, lim: XlsxLimits): OfficeParseError {
  const mb = (n: number): string => `${Math.ceil(n / 1048576).toLocaleString('ko-KR')}MB`;
  return new OfficeParseError(
    `엑셀 파일이 너무 커서 열 수 없습니다(시트 내용 ${mb(total)}, 최대 ${mb(lim.maxSheetXmlBytes)}). 필요한 시트만 남기거나 나눠서 다시 올려 주세요.`,
  );
}

/**
 * ExcelJS 에 넘길 패키지를 새로 묶는다.
 * - 쓰는 부속만 넣는다: 통합문서, 관계, 서식, 공유 문자열, 테마, 화면에 나올 워크시트와 그 관계.
 *   ExcelJS 4.4.0 의 load() 는 ZIP 의 모든 항목을 끝까지 풀어 메모리에 올린다(그림, 포함 개체, 알 수
 *   없는 항목까지). 보이는 워크시트가 있으면 숨긴 워크시트도 넣지 않는다(화면에 나오지 않는다).
 * - 부속마다 실제로 푼 크기가 ZIP 목차에 적힌 크기와 같아야 한다. 적힌 크기보다 더 풀지 않으므로
 *   ZIP 폭탄을 끝까지 풀지 않는다(JSZip 은 다 푼 뒤에야 크기를 비교한다).
 * - 크기 보호: ExcelJS 는 시트 XML 의 10~15배 메모리를 쓴다(실측 77MB → 1.1GB). 큰 시트가 있으면
 *   추출기가 어차피 버릴 것(숨긴 행의 셀, 시트당 행 상한 뒤, 전체 셀 상한 뒤)을 덜어 낸다. 넘길 부속을
 *   실제로 푼 크기의 합이 상한을 넘으면 거부한다. 상한 때문에 잘라 낸 시트는 색인과 화면 모두 '잘림'이다.
 * - 접두사를 쓴 SpreadsheetML 은 접두사를 지우고, t="d" 셀은 날짜로 읽히게 고친다(convertIsoDateCells).
 * - 저장 방식으로 묶는다(압축하지 않는다).
 */
function buildPackage(buf: Buffer, lim: XlsxLimits, info: LoadInfo): Buffer {
  const dir = readZipDirectory(buf);
  if (!dir) return buf; // ZIP 이 아니면 ExcelJS 가 알맞은 오류를 낸다
  // ExcelJS 처럼 이름 앞의 '/' 하나를 뗀다. 같은 이름이 둘이면 뒤의 것(ExcelJS 가 나중에 읽는 것)
  const entries = new Map<string, ZipDirEntry>();
  for (const e of dir) if (!e.name.endsWith('/')) entries.set(e.name.startsWith('/') ? e.name.slice(1) : e.name, e);
  const declared = (name: string): number => entries.get(name)?.uncompressedSize ?? 0;
  const read = (name: string): Buffer | undefined => {
    const e = entries.get(name);
    if (!e) return undefined;
    if (e.uncompressedSize > MAX_PART_BYTES) throw tooLarge(e.uncompressedSize, lim);
    const data = readZipEntry(buf, e, Math.max(1, e.uncompressedSize));
    if (!data || data.length !== e.uncompressedSize) throw new OfficeParseError(CORRUPT_MESSAGE);
    return data;
  };

  const bookNames = [...BOOK_PARTS.filter((n) => entries.has(n)), ...[...entries.keys()].filter((n) => THEME_PART.test(n))];
  // 풀기 전에 적힌 크기로 먼저 막는다(풀면서 적힌 크기와 같은지 확인한다)
  let declaredTotal = bookNames.reduce((s, n) => s + declared(n), 0);
  if (declaredTotal > lim.maxSheetXmlBytes) throw tooLarge(declaredTotal, lim);
  const parts = new Map<string, Buffer>();
  for (const name of bookNames) parts.set(name, read(name)!);
  // 통합문서 본문이 접두사를 쓰면 넘길 부속마다 접두사를 지운다
  const wbRaw = parts.get('xl/workbook.xml');
  const prefixed = !!wbRaw && rootPrefix(wbRaw) !== null;
  if (prefixed) for (const [name, data] of parts) parts.set(name, unprefixed(data));

  const wbXml = parts.get('xl/workbook.xml');
  const sheets = workbookSheets(wbXml, parts.get('xl/_rels/workbook.xml.rels'), (n) => entries.has(n));
  // 보이는 워크시트가 없으면 숨긴 워크시트를 모두 쪽으로 낸다(추출기와 같은 규칙)
  const anyShown = sheets.some((s) => !s.hidden);
  const onScreen = sheets.filter((s) => !anyShown || !s.hidden);
  info.date1904 = readDate1904(wbXml);
  const relName = (s: SheetPart): string => `xl/worksheets/_rels/sheet${s.no}.xml.rels`;
  const big = onScreen.some((s) => declared(s.path) > lim.trimSheetBytes);
  if (!big) {
    for (const s of onScreen) declaredTotal += declared(s.path) + declared(relName(s));
    if (declaredTotal > lim.maxSheetXmlBytes) throw tooLarge(declaredTotal, lim);
  }

  let cellBudget = lim.maxCellsTotal;
  let dateStyles: Set<number> | undefined; // t="d" 셀이 있을 때만 서식표를 읽는다
  const getDateStyles = (): Set<number> => (dateStyles ??= dateStyleIds(stripXmlComments(parts.get('xl/styles.xml')?.toString('utf8') ?? '')));
  for (const s of onScreen) {
    let xml = read(s.path)!;
    if (prefixed) xml = unprefixed(xml);
    if (big) {
      const res = trimSheetXml(xml, lim.maxRowsPerSheet, cellBudget, lim.maxCols);
      if (res.out) xml = res.out;
      if (res.reason) info.trimmedParts.set(s.no, res.reason);
      // 추출기처럼: 셀 상한에 걸리면 뒤 시트는 모두 비운다
      cellBudget = res.reason === 'cells' ? 0 : cellBudget - res.cells;
    }
    parts.set(s.path, convertIsoDateCells(xml, info.date1904, getDateStyles) ?? xml);
    const rels = read(relName(s));
    if (rels) parts.set(relName(s), prefixed ? unprefixed(rels) : rels);
  }
  let total = 0;
  for (const data of parts.values()) total += data.length;
  if (total > lim.maxSheetXmlBytes) throw tooLarge(total, lim);
  return storedZip([...parts]);
}

/** 시트 부속 번호로 모은 정보 → 시트 이름 (ExcelJS 가 시트에 이름을 붙인 뒤에 부른다) */
function noteSheetNames(model: unknown, info: LoadInfo): void {
  if (!model || typeof model !== 'object') return;
  const sheets = (model as { worksheets?: unknown }).worksheets;
  if (!Array.isArray(sheets)) return;
  for (const ws of sheets as unknown[]) {
    if (!ws || typeof ws !== 'object') continue;
    const s = ws as { sheetNo?: unknown; name?: unknown };
    if (typeof s.name !== 'string') continue;
    const reason = info.trimmedParts.get(String(s.sheetNo));
    if (reason) info.trimmedNames.set(s.name, reason);
    const merges = info.mergeParts.get(String(s.sheetNo));
    if (merges) info.mergeNames.set(s.name, merges);
  }
}

/** styles.xml 의 사용자 서식 원문(역슬래시 포함). ExcelJS 는 읽으면서 역슬래시를 지운다 */
function rawNumFmts(stylesXml: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<(?:\w+:)?numFmt\s([^<>]*)>/g)) {
    const attrs = m[1]!;
    const id = /\bnumFmtId\s*=\s*["'](\d+)["']/.exec(attrs)?.[1];
    const code = /\bformatCode\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    if (id !== undefined && code) out.set(Number(id), unescapeXml(code[1] ?? code[2] ?? ''));
  }
  return out;
}

/** styles.xml 의 글꼴 크기(<fonts> 안 순서대로). 크기가 없는 글꼴은 undefined */
function rawFontSizes(stylesXml: string): (number | undefined)[] {
  const block = /<(?:\w+:)?fonts\b[^<>]*>((?:(?!<(?:\w+:)?fonts\b)[\s\S])*?)<\/(?:\w+:)?fonts>/.exec(stylesXml)?.[1];
  if (!block) return [];
  const out: (number | undefined)[] = [];
  for (const f of block.matchAll(/<(?:\w+:)?font\b[^<>]*?(?:\/>|>((?:(?!<(?:\w+:)?font\b)[\s\S])*?)<\/(?:\w+:)?font>)/g)) {
    const sz = f[1] ? /<(?:\w+:)?sz\s[^<>]*?\bval\s*=\s*["']([\d.]+)["']/.exec(f[1])?.[1] : undefined;
    out.push(sz === undefined ? undefined : Number(sz));
  }
  return out;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 'A1:C2' → 범위. 읽지 못하거나 엑셀 한계(1,048,576행, 16,384열) 밖이면 null */
function parseRange(ref: string): Rect | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(ref.trim());
  if (!m) return null;
  const c1 = columnNumber(m[1]!);
  const r1 = Number(m[2]);
  const c2 = m[3] ? columnNumber(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  const rect = { top: Math.min(r1, r2), left: Math.min(c1, c2), bottom: Math.max(r1, r2), right: Math.max(c1, c2) };
  if (rect.top < 1 || rect.left < 1 || rect.bottom > MAX_SHEET_ROWS || rect.right > MAX_SHEET_COLS) return null;
  return rect;
}

/** 쓰지 않는 부속의 관계 종류: 그림(drawing), 메모(comments, vmlDrawing), 표 개체(table) */
const UNUSED_REL = /\/(?:drawing|vmlDrawing|comments|table)$/;

/**
 * 그림, 메모, 표 개체를 모델에서 떼어 낸다. 렌더 모델에 쓰지 않고, 부속 이름이 ExcelJS 의 예상과
 * 다르거나 빠진 파일(다른 프로그램이 저장한 xlsx)에서 load() 가 TypeError 로 멈추는 자리이기도 하다.
 */
function detachUnusedParts(m: Record<string, unknown>): void {
  // 1) 남길 관계를 계산만 한다
  const relTable = m.worksheetRels && typeof m.worksheetRels === 'object' ? (m.worksheetRels as Record<string, unknown>) : {};
  const kept = new Map<string, unknown[]>();
  for (const key of Object.keys(relTable)) {
    const rels = relTable[key];
    if (!Array.isArray(rels)) continue;
    kept.set(
      key,
      rels.filter((rel: unknown) => {
        const type = rel && typeof rel === 'object' ? (rel as { Type?: unknown }).Type : undefined;
        return !(typeof type === 'string' && UNUSED_REL.test(type));
      }),
    );
  }
  // 2) 시트가 그 부속을 가리키지 않게 한다 (여기서 멈춰도 가리키던 대상은 아직 그대로다)
  if (Array.isArray(m.worksheets)) {
    for (const ws of m.worksheets as unknown[]) {
      if (!ws || typeof ws !== 'object') continue;
      const sheet = ws as { drawing?: unknown; tables?: unknown; hyperlinks?: unknown; sheetNo?: unknown };
      delete sheet.drawing;
      sheet.tables = [];
      if (Array.isArray(sheet.hyperlinks)) {
        // 관계가 없는 외부 링크 표시는 버린다(셀 글자는 그대로 남는다)
        const ids = new Set((kept.get(String(sheet.sheetNo)) ?? []).map((rel) => String((rel as { Id?: unknown }).Id)));
        sheet.hyperlinks = (sheet.hyperlinks as unknown[]).filter((h) => {
          const rId = h && typeof h === 'object' ? (h as { rId?: unknown }).rId : undefined;
          return rId === undefined || ids.has(String(rId));
        });
      }
    }
  }
  // 3) 관계와 부속을 뗀다
  for (const [key, rels] of kept) relTable[key] = rels;
  m.drawings = {};
  m.drawingRels = {};
  m.comments = {};
  m.vmlDrawings = {};
  m.tables = {};
  m.media = [];
  m.mediaIndex = {};
}

/** 사용자 서식 원문(역슬래시 포함)과 정의 없는 한국어 로캘 기본 서식을 서식 색인에 넣는다 */
function restoreNumFmts(m: Record<string, unknown>, stylesXml: string): void {
  const index = (m.styles as { index?: { numFmt?: unknown } } | undefined)?.index?.numFmt;
  if (!Array.isArray(index)) return;
  for (const [id, code] of rawNumFmts(stylesXml)) index[id] = code;
  for (const [id, code] of KO_BUILTIN_FORMATS) if (index[id] === undefined) index[id] = code;
}

/** 소수 글꼴 크기(10.5pt 등)를 되살린다: ExcelJS 는 크기를 정수로 읽는다 */
function restoreFontSizes(m: Record<string, unknown>, stylesXml: string): void {
  const fonts = (m.styles as { model?: { fonts?: unknown } } | undefined)?.model?.fonts;
  if (!Array.isArray(fonts)) return;
  const sizes = rawFontSizes(stylesXml);
  if (sizes.length !== fonts.length) return; // 순서를 맞출 수 없으면 손대지 않는다
  sizes.forEach((sz, i) => {
    const font: unknown = fonts[i];
    if (sz !== undefined && Number.isFinite(sz) && !Number.isInteger(sz) && font && typeof font === 'object') {
      (font as { size?: number }).size = sz;
    }
  });
}

function readDefaultFont(m: Record<string, unknown>, info: LoadInfo): void {
  const fonts = (m.styles as { model?: { fonts?: unknown } } | undefined)?.model?.fonts;
  const f0: unknown = Array.isArray(fonts) ? fonts[0] : undefined;
  if (f0 && typeof f0 === 'object') info.defaultFont = { ...(f0 as Partial<ExcelJS.Font>) };
}

/** ExcelJS 의 시트 이름 검사(Worksheet#name)를 통과하는가. 31자 넘는 이름은 자른 뒤 자기 자신과 겹친다고 거부한다 */
function isExcelJsSheetName(name: string): boolean {
  return name !== '' && name !== 'History' && name.length <= 31 && !/[*?:/\\[\]]/.test(name) && !/^'|'$/.test(name);
}

/**
 * 시트 목록 고치기(ExcelJS 가 시트를 잃거나 파일 전체를 거부하는 자리).
 * - 시트 번호(sheetId)를 배열 색인으로 쓰므로 0, 빠짐, 겹침이면 시트를 잃는다: 통합문서 순서로 1..N.
 * - 이름이 31자를 넘거나(openpyxl, pandas 는 긴 이름을 그대로 쓴다) 쓸 수 없는 글자가 있거나 대소문자만
 *   다르게 겹치면 거부한다: 안쪽 이름을 새로 붙이고 원래 이름은 쪽 라벨로 쓴다.
 */
function fixSheetList(m: Record<string, unknown>, info: LoadInfo): void {
  if (!Array.isArray(m.sheets)) return;
  const sheets = (m.sheets as unknown[]).filter((s): s is { id?: unknown; name?: unknown } => !!s && typeof s === 'object');
  const ids = sheets.map((s) => s.id);
  const idsOk = ids.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0) && new Set(ids).size === ids.length;
  if (!idsOk) {
    sheets.forEach((s, i) => {
      s.id = i + 1;
    });
  }
  const used = new Set<string>();
  const rename: { s: { name?: unknown }; i: number }[] = [];
  sheets.forEach((s, i) => {
    const name = typeof s.name === 'string' ? s.name : '';
    if (isExcelJsSheetName(name) && !used.has(name.toLowerCase())) used.add(name.toLowerCase());
    else rename.push({ s, i });
  });
  for (const { s, i } of rename) {
    let inner = `Sheet${i + 1}`;
    for (let k = 2; used.has(inner.toLowerCase()); k += 1) inner = `Sheet${i + 1} (${k})`;
    used.add(inner.toLowerCase());
    info.labels.set(inner, typeof s.name === 'string' && s.name !== '' ? s.name : inner);
    s.name = inner;
  }
}

/**
 * 행, 열 정의 고치기(ExcelJS 가 파일 전체를 거부하거나 멈추는 자리).
 * - r 이 없는 행(CT_Row 의 r 은 선택 속성): 첫 셀 주소의 행, 그것도 없으면 앞 행 + 1.
 * - 엑셀 한계(1,048,576행) 밖 행은 뺀다: 엑셀도 열지 못하고 화면도 그리지 않는다(행 번호만큼 도는 곳도 있다).
 * - r 이 없는 셀: 앞 셀 다음 열(행의 첫 셀이면 A 열). ExcelJS 는 행의 첫 셀에 r 이 없으면 멈춘다.
 *   16,384열 밖 셀은 뺀다(ExcelJS 가 파일 전체를 거부한다).
 * - <col> 범위는 1..16,384 안으로 줄인다: ExcelJS 는 범위의 열마다 객체를 만든다(max 가 크면 메모리를 다 쓴다).
 */
function fixRowsAndCols(m: Record<string, unknown>): void {
  if (!Array.isArray(m.worksheets)) return;
  for (const ws of m.worksheets as unknown[]) {
    if (!ws || typeof ws !== 'object') continue;
    const sheet = ws as { rows?: unknown; cols?: unknown };
    if (Array.isArray(sheet.rows)) {
      let prev = 0;
      const rows: unknown[] = [];
      for (const row of sheet.rows as unknown[]) {
        if (!row || typeof row !== 'object') continue;
        const rw = row as { number?: unknown; cells?: unknown };
        const cells = Array.isArray(rw.cells) ? (rw.cells as unknown[]) : [];
        let n = typeof rw.number === 'number' && Number.isInteger(rw.number) && rw.number >= 1 ? rw.number : 0;
        if (n === 0) {
          const first = cells.find((c) => !!c && typeof (c as { address?: unknown }).address === 'string');
          const fromCell = first ? Number(/(\d+)$/.exec((first as { address: string }).address)?.[1]) : 0;
          n = Number.isInteger(fromCell) && fromCell >= 1 ? fromCell : prev + 1;
          rw.number = n;
        }
        if (n > MAX_SHEET_ROWS) continue;
        prev = n;
        let col = 0;
        const kept: unknown[] = [];
        for (const cell of cells) {
          if (!cell || typeof cell !== 'object') continue;
          const c = cell as { address?: unknown };
          const ref = typeof c.address === 'string' ? /^\$?([A-Za-z]{1,3})\$?\d+$/.exec(c.address) : null;
          col = ref ? columnNumber(ref[1]!) : col + 1;
          if (col > MAX_SHEET_COLS) continue;
          if (!ref) c.address = `${columnLetter(col)}${n}`;
          kept.push(cell);
        }
        rw.cells = kept;
        rows.push(row);
      }
      sheet.rows = rows;
    }
    if (Array.isArray(sheet.cols)) {
      sheet.cols = (sheet.cols as unknown[]).filter((c) => {
        if (!c || typeof c !== 'object') return false;
        const col = c as { min?: unknown; max?: unknown };
        const min = Math.max(1, Math.trunc(Number(col.min)) || 1);
        const max = Math.min(MAX_SHEET_COLS, Math.trunc(Number(col.max)) || 0);
        if (min > max) return false;
        col.min = min;
        col.max = max;
        return true;
      });
    }
  }
}

/** 병합 겹침 검사: 64행 x 64열 구획마다 남긴 병합을 걸어 둔다 */
class MergeIndex {
  private readonly blocks = new Map<number, Rect[]>();

  private keys(a: Rect): number[] {
    const out: number[] = [];
    for (let rb = a.top >> 6; rb <= a.bottom >> 6; rb += 1) {
      for (let cb = a.left >> 6; cb <= a.right >> 6; cb += 1) out.push(rb * 512 + cb);
    }
    return out;
  }

  overlaps(a: Rect): boolean {
    for (const key of this.keys(a)) {
      for (const k of this.blocks.get(key) ?? []) {
        if (k.left <= a.right && a.left <= k.right && k.top <= a.bottom && a.top <= k.bottom) return true;
      }
    }
    return false;
  }

  add(a: Rect): void {
    for (const key of this.keys(a)) {
      const list = this.blocks.get(key);
      if (list) list.push(a);
      else this.blocks.set(key, [a]);
    }
  }
}

/**
 * 병합 범위를 ExcelJS 에 맡기지 않고 따로 보관한다(시트 부속 번호별). ExcelJS 는 병합마다 이미 붙인 병합
 * 전부와 겹침을 검사하고(병합 수의 제곱: 2만 개면 수십 초), 병합된 칸마다 셀 객체를 만들고, 같은 병합이
 * 두 번 적혔거나 겹치면 파일 전체를 거부한다. 여기서는 겹치는 병합은 문서 순서로 먼저 온 것만 남기고,
 * 한 칸짜리 병합(효과 없음)과 아주 큰 병합은 뺀다. 빠진 병합은 표시에서만 빠진다(글자는 기준 칸에 남는다).
 */
function takeMerges(m: Record<string, unknown>, info: LoadInfo): void {
  if (!Array.isArray(m.worksheets)) return;
  let area = 0;
  let seen = 0;
  for (const ws of m.worksheets as unknown[]) {
    if (!ws || typeof ws !== 'object') continue;
    const sheet = ws as { mergeCells?: unknown; sheetNo?: unknown };
    if (!Array.isArray(sheet.mergeCells)) continue;
    const kept: Rect[] = [];
    const index = new MergeIndex();
    for (const ref of sheet.mergeCells as unknown[]) {
      if (seen >= MAX_MERGES_TOTAL) break;
      seen += 1;
      const rect = typeof ref === 'string' ? parseRange(ref) : null;
      if (!rect) continue;
      const a = (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
      if (a < 2 || a > MAX_MERGE_AREA || area + a > MAX_MERGE_AREA_TOTAL || index.overlaps(rect)) continue;
      index.add(rect);
      kept.push(rect);
      area += a;
    }
    info.mergeParts.set(String(sheet.sheetNo), kept);
    sheet.mergeCells = [];
  }
}

/** ExcelJS 는 date1904="1" 만 알아본다: 원문이 "true" 여도 1904 체계로 읽게 한다 */
function fixDate1904(m: Record<string, unknown>, info: LoadInfo): void {
  if (!info.date1904) return;
  const props = m.properties && typeof m.properties === 'object' ? (m.properties as Record<string, unknown>) : {};
  props.date1904 = true;
  m.properties = props;
}

/** 해석이 끝난 모델을 워크북에 붙이기 직전에 고친다. 보정마다 따로: 하나가 실패해도 나머지는 한다 */
function prepareModel(model: unknown, buf: Buffer, info: LoadInfo): void {
  if (!model || typeof model !== 'object') return;
  const m = model as Record<string, unknown>;
  let stylesXml: string | null = null;
  const styles = (): string => {
    stylesXml ??= stripXmlComments(readZipFile(buf, 'xl/styles.xml', MAX_STYLES_XML_BYTES)?.toString('utf8') ?? '');
    return stylesXml;
  };
  const steps: (() => void)[] = [
    () => detachUnusedParts(m),
    () => restoreNumFmts(m, styles()),
    () => restoreFontSizes(m, styles()),
    () => readDefaultFont(m, info),
    () => fixDate1904(m, info),
    () => fixSheetList(m, info),
    () => fixRowsAndCols(m),
    () => takeMerges(m, info),
  ];
  for (const step of steps) {
    try {
      step();
    } catch {
      // 내부 구조가 예상과 다르면 이 보정만 건너뛴다
    }
  }
}

/** ExcelJS 4.4.0 의 load() 가 모델을 워크북에 붙이기 직전(XLSX#reconcile)에 끼어든다 */
function installLoadHook(wb: ExcelJS.Workbook, buf: Buffer, info: LoadInfo): void {
  const xlsx = wb.xlsx as unknown as { reconcile?: unknown };
  const original = xlsx.reconcile;
  if (typeof original !== 'function') return;
  xlsx.reconcile = function reconcileWithFixes(this: unknown, model: unknown, options: unknown): unknown {
    try {
      prepareModel(model, buf, info);
    } catch {
      // 보정은 덤이다: 실패해도 원래 흐름대로 읽는다
    }
    const result = (original as (m: unknown, o: unknown) => unknown).call(this, model, options);
    try {
      noteSheetNames(model, info);
    } catch {
      // 이름을 못 찾으면 processXlsx 가 전체 안내만 단다(그 시트의 병합은 표시에서 빠진다)
    }
    return result;
  };
}

// ─────────────────────────────── 시트 → 쪽 ───────────────────────────────

interface MergeBox {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** 보이는 기준 칸: 숨긴 행, 열을 건너뛴 첫 칸 */
  vr: number;
  vc: number;
  /** 기준 칸을 모델에 냈는가 */
  emitted: boolean;
}

interface Piece {
  text: string;
  s?: number;
}

interface Env {
  lim: XlsxLimits;
  styles: StyleTable;
  date1904: boolean;
  /** hidden: 더 낼 수 있는 높이 0 행(숨긴 행 표시) 수 */
  budget: { cells: number; chars: number; hidden: number; exhausted: boolean };
  flags: { rows: boolean; cols: boolean; cells: boolean; chars: boolean };
  /** ExcelJS 에 넘기기 전에 행을 잘라 낸 시트 이름과 까닭 */
  trimmed: Map<string, TrimReason>;
  /** ExcelJS 에 맡기지 않고 따로 읽은 병합 범위 (시트 이름별) */
  merges: Map<string, Rect[]>;
  /** 안쪽 시트 이름 → 원래 이름 (ExcelJS 가 받지 않는 이름을 바꾼 시트) */
  labels: Map<string, string>;
}

export const ptToPx = (pt: number): number => Math.round((pt * 96) / 72);

/**
 * 파일에 적힌 열 너비(숫자 폭의 글자 수, 양쪽 여백과 격자선 5px 포함) → px. ECMA-376 Part 1 §18.3.1.13 의
 * 식이고 숫자 폭은 7px(Calibri 11pt)로 둔다. 예: 8.7109375 → 61px, 20.7109375 → 145px
 */
export const colWidthPx = (w: number): number => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);
/** <col> 도 defaultColWidth 도 없을 때의 엑셀 기본 열 너비(8.43자) */
export const DEFAULT_COL_PX = 64;

function frozenOf(ws: ExcelJS.Worksheet): { rows: number; cols: number } | undefined {
  const v = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
  if (!v || v.state !== 'frozen') return undefined;
  const rows = Math.max(0, Math.floor(v.ySplit ?? 0));
  const cols = Math.max(0, Math.floor(v.xSplit ?? 0));
  return rows > 0 || cols > 0 ? { rows, cols } : undefined;
}

/**
 * ExcelJS 가 붙인 병합 범위(따로 읽지 못했을 때만 쓴다). ws.model 은 시트 전체 모델을 새로 만들므로(느림)
 * ExcelJS 내부 색인을 먼저 쓴다
 */
function mergeRects(ws: ExcelJS.Worksheet): Rect[] {
  const out: Rect[] = [];
  const internal = (ws as unknown as { _merges?: Record<string, Partial<Rect>> })._merges;
  if (internal && typeof internal === 'object') {
    for (const rg of Object.values(internal)) {
      if (rg && typeof rg.top === 'number' && typeof rg.left === 'number' && typeof rg.bottom === 'number' && typeof rg.right === 'number') {
        out.push({ top: rg.top, left: rg.left, bottom: rg.bottom, right: rg.right });
      }
    }
    return out;
  }
  const refs = ((ws.model as { merges?: unknown }).merges ?? []) as unknown[];
  for (const ref of refs) {
    const rect = typeof ref === 'string' ? parseRange(ref) : null;
    if (rect) out.push(rect);
  }
  return out;
}

/** 행 목록(행 번호 오름차순)에 숨긴 행을 높이 0 인 빈 행으로 끼워 넣는다 */
function withHiddenRows(raw: RawSheetRow[], hidden: readonly number[]): RawSheetRow[] {
  if (hidden.length === 0) return raw;
  const out: RawSheetRow[] = [];
  let i = 0;
  for (const r of hidden) {
    while (i < raw.length && raw[i]!.r < r) out.push(raw[i++]!);
    out.push({ r, h: 0, cells: [] });
  }
  while (i < raw.length) out.push(raw[i++]!);
  return out;
}

function hasValue(cell: ExcelJS.Cell | undefined): boolean {
  return !!cell && cell.type !== ExcelJS.ValueType.Null && cell.type !== ExcelJS.ValueType.Merge;
}

function cellPiece(cell: ExcelJS.Cell, env: Env): Piece | null {
  const value = cell.value;
  const text = formatValue(value, cell.numFmt, env.date1904);
  const st = env.styles.ofCell(cell.style, isNumericValue(value));
  if (text === '' && !st.visible) return null;
  return st.idx === undefined ? { text } : { text, s: st.idx };
}

function mergedPiece(ws: ExcelJS.Worksheet, m: MergeBox, env: Env): Piece | null {
  const master = ws.findCell(m.r1, m.c1);
  const value = master ? master.value : null;
  const text = master ? formatValue(value, master.numFmt, env.date1904) : '';
  const right = m.c2 > m.c1 ? ws.findCell(m.r1, m.c2)?.style?.border?.right : undefined;
  const bottom = m.r2 > m.r1 ? ws.findCell(m.r2, m.c1)?.style?.border?.bottom : undefined;
  const st = env.styles.ofMerged(master?.style, isNumericValue(value), right, bottom);
  if (text === '' && !st.visible) return null;
  return st.idx === undefined ? { text } : { text, s: st.idx };
}

function extractSheet(ws: ExcelJS.Worksheet, pageNo: number, env: Env): { page: SheetPage; text: string } {
  const { lim } = env;
  const props = ws.properties as Partial<ExcelJS.WorksheetProperties> | undefined;
  const defRowPx = ptToPx(props?.defaultRowHeight || 15);
  const defColW = props?.defaultColWidth;
  const defColPx = typeof defColW === 'number' && Number.isFinite(defColW) && defColW > 0 ? colWidthPx(defColW) : DEFAULT_COL_PX;
  const page: SheetPage = {
    pageNo,
    name: normalizeText(stripControls(env.labels.get(ws.name) ?? ws.name)),
    colWidths: [],
    defaultRowHeight: defRowPx,
    rows: [],
    merges: [],
    maxRow: 0,
    maxCol: 0,
  };
  const frozen = frozenOf(ws);
  if (frozen) page.frozen = frozen;
  if (env.budget.exhausted) {
    page.truncated = true; // 앞 시트에서 전체 상한을 다 썼다
    return { page, text: '' };
  }

  // 열: 상한 안쪽의 숨김 여부
  const colHidden: boolean[] = [true];
  for (let c = 1; c <= lim.maxCols; c += 1) {
    const col = ws.getColumn(c);
    colHidden.push(col.hidden || col.width === 0);
  }
  const rowHidden = (r: number): boolean => {
    const row = ws.findRow(r);
    return !!row && (row.hidden || row.height === 0);
  };
  let sheetTruncated = false;
  const trimmedFor = env.trimmed.get(ws.name);
  if (trimmedFor) {
    // 상한 뒤를 미리 잘라 냈다(buildPackage)
    env.flags[trimmedFor] = true;
    sheetTruncated = true;
    if (trimmedFor === 'cells') env.budget.exhausted = true;
  }

  // 병합: 숨긴 행, 열을 건너뛴 보이는 기준 칸을 찾는다
  const merges: MergeBox[] = [];
  for (const rg of env.merges.get(ws.name) ?? mergeRects(ws)) {
    let vr = rg.top;
    while (vr <= rg.bottom && rowHidden(vr)) vr += 1;
    const cEnd = Math.min(rg.right, lim.maxCols);
    let vc = rg.left;
    while (vc <= cEnd && colHidden[vc]) vc += 1;
    if (vr > rg.bottom) continue; // 모든 행이 숨겨졌다
    if (vc > cEnd) {
      // 보이는 열이 열 상한 밖에만 있다
      if (rg.right > lim.maxCols && hasValue(ws.findCell(rg.top, rg.left))) {
        env.flags.cols = true;
        sheetTruncated = true;
      }
      continue;
    }
    merges.push({ r1: rg.top, c1: rg.left, r2: rg.bottom, c2: rg.right, vr, vc, emitted: false });
  }
  merges.sort((a, b) => a.vr - b.vr);
  // 병합은 ExcelJS 에 맡기지 않으므로, 기준 칸이 있는 행은 행 요소나 셀이 없어도 훑는다
  let lastRow = Math.min(ws.rowCount, MAX_SHEET_ROWS);
  for (const m of merges) lastRow = Math.max(lastRow, m.vr);

  const raw: RawSheetRow[] = [];
  let pending: RawSheetRow[] = []; // 글자 없이 높이만 다른 행: 뒤에 내용 있는 행이 오면 함께 넣는다
  const hiddenRows: number[] = []; // 숨긴 행: 그리는 범위 안의 것을 높이 0 행으로 낸다
  let emittedRows = 0;
  let cutoff = Number.POSITIVE_INFINITY;
  let colsChecked = false;
  const active: MergeBox[] = [];
  let nextMerge = 0;
  for (let r = 1; r <= lastRow; r += 1) {
    const row = ws.findRow(r);
    if (row && (row.hidden || row.height === 0)) {
      if (hiddenRows.length < env.budget.hidden) hiddenRows.push(r);
      continue;
    }
    while (nextMerge < merges.length && merges[nextMerge]!.vr <= r) active.push(merges[nextMerge++]!);
    for (let k = active.length - 1; k >= 0; k -= 1) if (active[k]!.r2 < r) active.splice(k, 1);
    let anchorCol = 0;
    for (const m of active) if (m.vr === r) anchorCol = Math.max(anchorCol, m.vc);
    if (!row && anchorCol === 0) continue;

    const cellCount = row ? row.cellCount : 0;
    const limit = Math.min(Math.max(cellCount, anchorCol), lim.maxCols);
    let owner: (MergeBox | undefined)[] | null = null;
    if (active.length > 0) {
      owner = new Array<MergeBox | undefined>(limit + 1);
      for (const m of active) for (let c = m.vc; c <= Math.min(m.c2, limit); c += 1) owner[c] = m;
    }
    if (row && !colsChecked && cellCount > lim.maxCols) {
      for (let c = lim.maxCols + 1; c <= cellCount; c += 1) {
        if (hasValue(row.findCell(c))) {
          env.flags.cols = true;
          sheetTruncated = true;
          colsChecked = true;
          break;
        }
      }
    }

    const cells: RawSheetCell[] = [];
    const anchored: MergeBox[] = [];
    let chars = 0;
    for (let c = 1; c <= limit; c += 1) {
      if (colHidden[c]) continue;
      const m = owner?.[c];
      let piece: Piece | null;
      if (m) {
        if (r !== m.vr || c !== m.vc) continue; // 병합에 가려진 칸
        piece = mergedPiece(ws, m, env);
        if (piece) anchored.push(m);
      } else {
        const cell = row?.findCell(c);
        if (!cell || cell.type === ExcelJS.ValueType.Merge) continue;
        piece = cellPiece(cell, env);
      }
      if (!piece) continue;
      const out: RawSheetCell = { c, text: piece.text };
      if (piece.s !== undefined) out.s = piece.s;
      cells.push(out);
      chars += piece.text.length + 1;
    }

    const hPx = row?.height ? ptToPx(row.height) : undefined;
    const h = hPx !== undefined && hPx !== defRowPx ? hPx : undefined;
    if (cells.length === 0) {
      if (h !== undefined && pending.length < lim.maxRowsPerSheet) pending.push({ r, h, cells: [] });
      continue;
    }
    // 상한: 행 단위로 자른다 (색인과 표시가 같은 자리에서 끝난다)
    let stop: 'rows' | 'cells' | 'chars' | null = null;
    if (emittedRows + pending.length + 1 > lim.maxRowsPerSheet) stop = 'rows';
    else if (env.budget.cells + cells.length > lim.maxCellsTotal) stop = 'cells';
    else if (env.budget.chars + chars > lim.maxTextChars) stop = 'chars';
    if (stop) {
      env.flags[stop] = true;
      if (stop !== 'rows') env.budget.exhausted = true;
      sheetTruncated = true;
      cutoff = r - 1;
      break;
    }
    raw.push(...pending);
    emittedRows += pending.length + 1;
    pending = [];
    const rr: RawSheetRow = { r, cells };
    if (h !== undefined) rr.h = h;
    raw.push(rr);
    env.budget.cells += cells.length;
    env.budget.chars += chars;
    for (const m of anchored) m.emitted = true;
  }

  let maxRow = raw.length > 0 ? raw[raw.length - 1]!.r : 0;
  let maxCol = 0;
  for (const m of merges) {
    if (!m.emitted) continue;
    // 끝쪽의 숨긴 행, 열과 상한 밖은 병합에서 뺀다
    let r2 = Math.min(m.r2, cutoff);
    while (r2 > m.vr && rowHidden(r2)) r2 -= 1;
    let c2 = Math.min(m.c2, lim.maxCols);
    while (c2 > m.vc && colHidden[c2]) c2 -= 1;
    if (r2 === m.vr && c2 === m.vc) continue;
    page.merges.push([m.vr, m.vc, r2, c2]);
    maxRow = Math.max(maxRow, r2);
    maxCol = Math.max(maxCol, c2);
  }
  // 그리는 범위(1..maxRow) 안의 숨긴 행만 넣는다: 범위 밖 숨긴 행은 화면에 영향이 없다
  const hiddenShown = hiddenRows.filter((r) => r < maxRow);
  env.budget.hidden -= hiddenShown.length;
  const { text, rows } = buildSheetText(withHiddenRows(raw, hiddenShown));
  for (const row of rows) for (const cell of row.cells) maxCol = Math.max(maxCol, cell.c);
  for (let c = 1; c <= maxCol; c += 1) {
    const w = ws.getColumn(c).width;
    page.colWidths.push(colHidden[c] ? 0 : typeof w === 'number' && Number.isFinite(w) && w > 0 ? colWidthPx(w) : defColPx);
  }
  page.rows = rows;
  page.maxRow = maxRow;
  page.maxCol = maxCol;
  if (sheetTruncated) page.truncated = true;
  return { page, text };
}

export function truncationNotice(f: { rows: boolean; cols: boolean; cells: boolean; chars: boolean }, lim: XlsxLimits): string | null {
  const n = (x: number): string => x.toLocaleString('ko-KR');
  const parts: string[] = [];
  if (f.rows) parts.push(`시트마다 앞 ${n(lim.maxRowsPerSheet)}행`);
  if (f.cols) parts.push(`앞 ${n(lim.maxCols)}열`);
  if (f.cells) parts.push(`전체 ${n(lim.maxCellsTotal)}개 셀`);
  if (f.chars) parts.push(`전체 ${n(lim.maxTextChars)}자`);
  return parts.length === 0 ? null : `표가 커서 ${parts.join(', ')}까지만 색인하고 보여줍니다.`;
}

function parseError(message: string, cause: unknown): OfficeParseError {
  const err = new OfficeParseError(message);
  err.cause = cause;
  return err;
}

/**
 * xlsx 하나를 해석해 쪽 글자(보이는 시트마다 한 쪽)와 SheetModel JSON 을 만든다.
 * @param fileName 지금은 쓰지 않는다(쪽 라벨은 시트 이름). 다른 추출기와 호출 모양을 맞춘다.
 * @param limits 상한 바꾸기(시험용). 빠진 값은 XLSX_LIMITS
 */
export async function processXlsx(
  buf: Buffer,
  fileName: string,
  limits: Partial<XlsxLimits> = {},
): Promise<OfficeExtractResult> {
  const lim: XlsxLimits = { ...XLSX_LIMITS, ...limits };
  const info: LoadInfo = {
    date1904: false,
    trimmedParts: new Map(),
    trimmedNames: new Map(),
    mergeParts: new Map(),
    mergeNames: new Map(),
    labels: new Map(),
  };
  let source: Buffer;
  try {
    source = buildPackage(buf, lim, info);
  } catch (err) {
    if (err instanceof OfficeParseError) throw err;
    throw parseError(CORRUPT_MESSAGE, err);
  }
  const wb = new ExcelJS.Workbook();
  installLoadHook(wb, source, info);
  try {
    // ExcelJS 타입 선언은 인자를 ArrayBuffer 로 적지만 실제로는 Node Buffer 를 받는다
    await wb.xlsx.load(source as unknown as ArrayBuffer);
  } catch (err) {
    throw parseError('엑셀 파일을 읽을 수 없습니다. 파일이 손상되었거나 xlsx 형식이 아닐 수 있습니다.', err);
  }
  const all = wb.worksheets;
  if (all.length === 0) throw new OfficeParseError('엑셀 파일에 시트가 없습니다.');
  const shown = all.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  const sheets = shown.length > 0 ? shown : all;

  const env: Env = {
    lim,
    styles: new StyleTable(new ColorResolver(readThemeColors(wb)), info.defaultFont ?? {}),
    date1904: Boolean(wb.properties?.date1904),
    budget: { cells: 0, chars: 0, hidden: lim.maxHiddenRows, exhausted: false },
    flags: { rows: false, cols: false, cells: false, chars: false },
    trimmed: info.trimmedNames,
    merges: info.mergeNames,
    labels: info.labels,
  };
  // 잘라 낸 시트의 이름을 찾지 못했으면(내부 훅 실패) 쪽 표시 없이 전체 안내만 단다
  if (info.trimmedParts.size > info.trimmedNames.size) env.flags.rows = true;
  const pages: SheetPage[] = [];
  const texts: string[] = [];
  try {
    sheets.forEach((ws, i) => {
      const { page, text } = extractSheet(ws, i + 1, env);
      pages.push(page);
      texts.push(text);
    });
  } catch (err) {
    throw parseError('엑셀 파일 내용을 해석하는 중 문제가 생겼습니다.', err);
  }
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
    extractor: XLSX_EXTRACTOR,
    pages: pages.map((p, i) => ({ pageNo: p.pageNo, text: texts[i] ?? '', label: p.name })),
    render: Buffer.from(JSON.stringify(model), 'utf8'),
    renderMime: 'application/json',
    truncated,
  };
}
