/**
 * 시트 보기(xlsx, csv): 서버가 만든 SheetModel 을 엑셀처럼 그린다
 *
 * 그리는 방식
 * - 브라우저는 원본 바이트를 해석하지 않는다. 업로드 때 서버가 한 번 만든 JSON 모델만 그린다.
 * - 시트 하나 = 쪽 하나(page_text 의 한 쪽). 시트가 둘 이상이면 아래쪽에 시트 탭(칩)을 둔다.
 * - 격자는 <table> 하나다. 열 머리(A, B, ...), 행 머리(1, 2, ...), 틀 고정 행/열은 position: sticky.
 *   창을 넷으로 나누지 않는 까닭: 칸의 DOM 순서가 행 우선(위에서 아래, 왼쪽에서 오른쪽)이어야 글자 조각의
 *   DOM 순서가 정본 오프셋 순서와 같고, 마우스로 끌어 고른 범위도 정본 글자 순서와 같아진다.
 *
 * 정본 글자와의 대응 (문서 보기 공통 불변식)
 * - 글자가 있는 칸은 <span data-o={o}>{t}</span> 하나로 그린다. 그 span 의 자식은 글자 노드 하나뿐이다.
 *   바꾸어 보이는 글자는 사설영역 기호뿐이다(text-utils mapPuaText: 한 글자를 한 글자로, 길이 그대로).
 * - 열 머리, 행 머리, 빈 시트 안내, 시트 탭 같은 표시 전용 글자에는 data-o 가 없다.
 * - 칸이 화면에 없는 글자(숨긴 행/열, 병합에 가려진 칸. 서버 추출기는 내지 않지만 모델 계약상 올 수 있다)는
 *   DOM 순서상 바로 앞 칸 안에 보이지 않는 span(osv-ghost)으로 둔다. 조각이 빠지지 않고 순서도 지켜진다.
 *   숨긴 행은 h <= 0 인 행으로 본다. 행이나 열이 모두 숨겨져 격자가 없으면 안내 문구 뒤에 오프셋 순서로 둔다.
 *
 * 큰 시트
 * - 보이는 행이 400개를 넘거나 칸(행 x 열)이 5000개를 넘으면 @tanstack/react-virtual 로 행을 가상화한다.
 *   그리지 않는 행들은 빈 줄 묶음(tr.osv-gap)으로 높이를 지키고, 틀 고정 행은 늘 그린다.
 * - 그리는 행에 걸친 병합 때문에 창을 넓히지 않는다(세로로 긴 병합 하나가 시트 전체를 그리게 만든다).
 *   대신 빈 줄 묶음을 그 병합의 첫 행과 마지막 행 다음에서 잘라, 기준 칸이 rowSpan(걸친 tr 수)으로 묶음을
 *   건너 병합 전체 높이에 걸치게 한다(layoutBands). 첫 행이 창 밖이면 기준 칸은 그 행에서 시작하는 묶음
 *   줄에 들어간다. 그래서 글자 조각의 DOM 순서가 정본 순서 그대로이고, 세로 맞춤도 병합 전체가 기준이다.
 * - 그리는 행이 바뀌거나 고정 칸의 자리가 바뀌면 onRowsRendered 를 불러, 겹쳐 그리는 표시(하이라이트)가
 *   사각형을 다시 잴 수 있게 한다. 틀 고정이 있으면 스크롤할 때도 부른다(고정 칸은 스크롤로 자리가 바뀐다).
 *
 * 글자가 칸보다 길 때
 * - 줄 바꿈 서식이 없는 글자는 엑셀처럼 한 줄로 두고 옆의 빈 칸 위로 흘려 보이며(왼쪽 맞춤은 오른쪽으로,
 *   오른쪽 맞춤은 왼쪽으로, 가운데 맞춤은 양쪽으로), 흘릴 자리가 끝나는 곳에서 잘린다. 글자 안의 줄바꿈도
 *   엑셀처럼 한 줄로 이어 보인다(CSS 만 바꾼다. 글자 노드는 정본 그대로). 자르기는 clip-path 로 한다
 *   (overflow 는 visible 그대로라 바깥에서 overflow 로 자를 상자를 찾는 코드가 칸 하나에 갇히지 않는다).
 *   실제로 잘린 칸에는 그린 뒤에 재어서 title 로 전체 글자를 단다.
 *   실제 시트 표본에서 칸 안에서 줄을 바꾸게 했더니 행 높이가 엑셀보다 크게 늘어(중앙값 1.9배, 상위 10%
 *   6.5배) 엑셀과 전혀 다르게 보였다. 그래서 엑셀처럼 한 줄로 자른다.
 * - 줄 바꿈 서식(wrap, 양쪽 맞춤) 칸은 칸 폭에서 줄을 바꾸고, 모자라면 행이 늘어난다(행 높이는 최소값).
 * - 숫자, 날짜는 줄 바꿈 서식과 상관없이 한 줄이다. 맞춤 반대쪽 빈 칸으로 흘리고, 그래도 넘치면 그린 뒤에
 *   재어서 글자 크기를 줄여 칸에 맞춘다(엑셀의 셀에 맞춤. 엑셀 기본은 #### 이지만 글자를 숨길 수 없다).
 *   55% 보다 더 줄여야 하면 칸 안에서 줄을 바꾼다. 잘린 숫자는 다른 값으로 읽히므로 자르지 않는다.
 * - 마지막 열의 글자는 표 오른쪽 바깥(엑셀의 빈 열 자리)으로도 흐른다. 표 밖에는 고정 칸이 없으므로, 열 머리와
 *   고정 행 높이의 그 자리는 덮개(osv-tailcap, sticky, z-index 1)가 가려 아래로 지나가는 행의 글자가 비치지 않는다.
 * - 잘린 글자의 Range 사각형은 칸 밖으로 뻗는다. 하이라이트를 겹쳐 그리는 쪽은 사각형을 조각의 부모
 *   (.osv-c, 보이는 글자 상자)의 사각형과 겹치는 만큼만 그리면 된다.
 * - 모델에 통합문서 기본 글꼴이 없다. 서식 없는 칸은 11pt 에 Calibri 를 먼저 쓴다: 모델의 열 너비(px)가
 *   엑셀 숫자 폭 7px(Calibri 11pt) 기준으로 계산되어 있어서다. 없으면 앱 글꼴 스택으로 받친다.
 *
 * z-index 층: 일반 칸(없음) < 고정 열 1 < 고정 행 2 < 둘 다 3 < 행 머리 5 < 고정 행의 행 머리 6
 *   < 열 머리 7 < 고정 열의 열 머리, 모서리 8. 시트 보기는 쌓임 맥락을 따로 만들지 않으므로 바깥 하이라이트 층
 *   (OfficeViewerPane: 검색 3, 조각 4, 배지 6, 툴바 9, 팝오버 10)과 이 순서로 섞인다. 하이라이트는 고정 칸 위,
 *   행/열 머리 아래에 그려지고, 툴바와 팝오버는 격자 전체보다 위에 뜬다.
 * - 틀 고정 칸의 글자가 오른쪽 빈 칸으로 흐를 때: sticky 칸은 칸마다 쌓임 맥락이 생기고 바탕이 불투명해서,
 *   같은 층에서 DOM 순서상 뒤인 칸이 앞 칸에서 흘러온 글자를 덮는다. 그래서 받는 칸은 바탕을 비우고
 *   (투명, 마우스 통과: osv-clear) 원본 칸이 받는 칸들의 채우기를 옮긴 밑판(osv-under)을 자기 쌓임 맥락 안의
 *   글자 아래(z-index -1)에 깐다. 밑판이 고정 띠 아래로 지나가는 칸을 가리므로 층 번호는 그대로다.
 *   왼쪽으로 흐르는 글자는 받는 칸이 DOM 순서상 앞이라 그대로 보인다. 고정 칸을 0 층으로 내려 층을 아끼면
 *   안 된다: 일반 칸의 잘린 글자 상자(clip-path)도 0 층에 그려져, DOM 순서상 뒤 칸의 글자가 고정 띠 위로 온다.
 * - 고정 칸 아래로 스크롤해 들어간 칸의 하이라이트를 잘라 내려면 쪽 요소의 data-sticky-top, data-sticky-left
 *   (스크롤 상자 안쪽 위, 왼쪽에서 고정 띠가 덮는 px)를 쓴다. 고정 칸 자신(td[data-frozen])은 자르지 않는다.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { useVirtualizer, type Range } from '@tanstack/react-virtual';
import type { CellStyle, SheetCell, SheetModel, SheetPage, SheetRow, TextPiece } from './model';
import { FONT_FALLBACK, borderCss, borderWidth, cssColor, mapPuaText, sanitizeFont } from './text-utils';
import './sheetview.css';

// ─────────────────────────────── 공개 타입 ───────────────────────────────

/** 칸으로 이동 요청: nonce 가 바뀔 때마다 한 번 움직인다 */
export interface SheetScrollTarget {
  pageNo: number;
  /** 1-기준 행 */
  r: number;
  /** 1-기준 열 */
  c: number;
  nonce: number;
}

export interface SheetViewProps {
  model: SheetModel;
  /** 지금 보이는 시트의 pageNo (없는 번호면 첫 시트를 보인다) */
  activePage: number;
  /** 시트 탭을 누르거나 scrollToCell 이 다른 시트를 가리킬 때 */
  onActivePageChange: (pageNo: number) => void;
  /** 격자 요소(data-page)가 붙으면 (pageNo, 요소), 떨어지면 (pageNo, null) */
  onPageElement?: (pageNo: number, el: HTMLElement | null) => void;
  /** 그리는 행이나 고정 칸의 자리가 바뀐 뒤. 하이라이트 사각형을 다시 잴 때 쓴다 */
  onRowsRendered?: () => void;
  scrollToCell?: SheetScrollTarget | null;
}

// ─────────────────────────────── 상수 ───────────────────────────────

/** 보이는 행이 이보다 많거나, 칸 수(행 x 열)가 VIRTUAL_MAX_CELLS 를 넘으면 가상화한다 */
const VIRTUAL_MIN_ROWS = 400;
/** 열이 많은 시트는 행이 적어도 한 번에 그리는 칸이 많아 첫 그림이 느려진다(60열 x 200행이면 0.5초) */
const VIRTUAL_MAX_CELLS = 5000;
const OVERSCAN = 10;
const DEFAULT_COL_W = 64;
const DEFAULT_ROW_H = 20;
/** 열 머리 행 높이 px */
const HEAD_ROW_H = 20;
/** 글자를 흘려 보낼 수 있는 빈 칸 수 상한 */
const MAX_SPILL_COLS = 32;
/** 마지막 열의 글자가 표 오른쪽 바깥(엑셀의 빈 열 자리)으로 흘러갈 수 있는 폭 상한 px, 어림 폭에 더할 여유 px */
const TAIL_SPILL_PX = 320;
const TAIL_SLACK_PX = 24;
/** 모델 이상값 방어(엑셀의 한계) */
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;
/** 서식 없는 칸의 글자 크기 pt (엑셀 기본값, sheetview.css 의 .osv-grid 와 같다) */
const DEFAULT_PT = 11;
/** 들여쓰기 한 단계 px */
const INDENT_PX = 9;
/** 칸 글자의 좌우 안쪽 여백 px (sheetview.css 의 .osv-c 와 같다) */
const CELL_PAD = 3;
/** 고정 칸이 스크롤 상자를 이보다 많이 덮으면 고정을 풀고 그린다(좁은 창에서 내용이 안 보이지 않게) */
const MAX_FROZEN_H_RATIO = 0.6;
const MAX_FROZEN_W_RATIO = 0.7;
/** 이동한 칸 테두리 표시 시간 ms */
const MARK_MS = 2400;
/** 넘치는 숫자를 줄여 맞출 때의 최소 배율 (더 작아져야 하면 줄을 바꾼다) */
const MIN_NUM_SCALE = 0.55;
/** 병합 칸 오른쪽 테두리를 옆 칸의 왼쪽 테두리에서 찾을 때 살펴볼 행 수 상한 (긴 세로 병합의 비용을 막는다) */
const BORDER_SCAN_ROWS = 64;
/** 채우기 없는 고정 칸의 바탕 (sheetview.css 의 td.osv-fr, td.osv-fc 와 같다) */
const SURFACE = 'var(--surface)';
const EMPTY_STYLES: readonly CellStyle[] = [];

/** 한국어 글꼴 이름 → 영문 이름(맥 같은 환경에서 영문 이름으로만 찾는 경우) */
const FONT_ALIASES: Readonly<Record<string, string>> = {
  '맑은 고딕': 'Malgun Gothic',
  굴림: 'Gulim',
  굴림체: 'GulimChe',
  돋움: 'Dotum',
  돋움체: 'DotumChe',
  바탕: 'Batang',
  바탕체: 'BatangChe',
  궁서: 'Gungsuh',
  궁서체: 'GungsuhChe',
  나눔고딕: 'NanumGothic',
  나눔명조: 'NanumMyeongjo',
};

// ─────────────────────────────── 서식 → CSS ───────────────────────────────

/** 문서 글꼴을 맨 앞에 두고(한국어 이름이면 영문 이름도) 앱 글꼴 스택으로 받친다 */
function fontStack(name: string): string | undefined {
  const clean = sanitizeFont(name);
  if (!clean) return undefined;
  const alias = FONT_ALIASES[clean];
  return `"${clean}", ${alias ? `"${alias}", ` : ''}${FONT_FALLBACK}`;
}

/** 칸(td) 공통 서식: 글꼴, 색, 채우기, 맞춤 */
function cellCss(st: CellStyle): CSSProperties {
  const css: CSSProperties = {};
  if (st.b) css.fontWeight = 700;
  if (st.i) css.fontStyle = 'italic';
  if (st.u || st.strike) {
    css.textDecorationLine = st.u && st.strike ? 'underline line-through' : st.u ? 'underline' : 'line-through';
  }
  if (typeof st.sz === 'number' && st.sz >= 1 && st.sz <= 409) css.fontSize = `${st.sz}pt`;
  const family = typeof st.font === 'string' ? fontStack(st.font) : undefined;
  if (family) css.fontFamily = family;
  const color = cssColor(st.color);
  if (color) css.color = color;
  const bg = cssColor(st.bg);
  if (bg) css.backgroundColor = bg;
  if (st.ha) css.textAlign = st.ha;
  else if (st.num) css.textAlign = 'right';
  if (st.va === 'top' || st.va === 'middle' || st.va === 'bottom') css.verticalAlign = st.va;
  return css;
}

function indentPx(st: CellStyle | undefined): number {
  const n = st?.indent;
  return typeof n === 'number' && n > 0 ? Math.min(n, 30) * INDENT_PX : 0;
}

/** 글자 폭 어림 px: 흘려 보낼 칸 수와 격자선을 숨길 칸을 정하는 데만 쓴다. singleLine 이면 줄바꿈도 한 칸 띄움 */
function estimateTextPx(t: string, st: CellStyle | undefined, singleLine = false): number {
  const pt = typeof st?.sz === 'number' && st.sz > 0 ? st.sz : DEFAULT_PT;
  const px = (pt * 4) / 3;
  let max = 0;
  let cur = 0;
  for (const ch of t) {
    if (ch === '\n' && !singleLine) {
      max = Math.max(max, cur);
      cur = 0;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    let em: number;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000
    ) {
      em = 1;
    } else if (ch === ' ' || ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === '!' || ch === '|') {
      em = 0.3;
    } else if (ch === 'i' || ch === 'l' || ch === 'j' || ch === 'I' || ch === "'" || ch === '(' || ch === ')') {
      em = 0.3;
    } else if ((ch >= 'A' && ch <= 'Z') || ch === 'm' || ch === 'w' || ch === 'M' || ch === 'W') {
      em = 0.68;
    } else {
      em = 0.57;
    }
    cur += em;
  }
  max = Math.max(max, cur);
  return max * px * (st?.b ? 1.07 : 1);
}

// ─────────────────────────────── 시트 기하 ───────────────────────────────

interface MergeInfo {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** 화면에 그리는 기준 칸(숨긴 행, 열을 건너뛴 왼쪽 위). 보이는 칸이 없으면 0 */
  dr: number;
  dc: number;
  /** 화면에 보이는 마지막 행, 열 */
  er: number;
  ec: number;
  rowSpan: number;
  colSpan: number;
}

const EMPTY_MERGES: readonly MergeInfo[] = [];

type CellPiece = SheetCell & TextPiece;

function hasPiece(cell: SheetCell | undefined): cell is CellPiece {
  return !!cell && typeof cell.t === 'string' && cell.t !== '' && typeof cell.o === 'number';
}

/** 오름차순 배열에서 x 이상인 첫 색인 */
function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 오름차순 배열에서 x 보다 큰 첫 색인 */
function upperBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function toInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** 한 시트를 그리는 데 필요한 색인과 치수 (모델이 같으면 한 번만 만든다) */
class SheetGeom {
  readonly page: SheetPage;
  readonly styles: readonly CellStyle[];
  readonly maxRow: number;
  readonly maxCol: number;
  readonly defaultRowH: number;
  /** 화면에 보이는 행 수(행 색인 0..rowCount-1) */
  readonly rowCount: number;
  /** 보이는 열 번호, 오름차순 (열 색인 = 이 배열의 색인) */
  readonly cols: number[] = [];
  /** 열 색인 → 표 왼쪽 끝에서의 x (행 머리 폭 포함) */
  readonly colLeft: number[] = [];
  readonly rowHeadW: number;
  readonly tableW: number;
  /** 틀 고정 안쪽의 보이는 행 수, 열 수, 고정 열 전체 폭 */
  readonly frozenRowN: number;
  readonly frozenColN: number;
  readonly frozenW: number;
  /** 보이는 칸이 있는 병합 */
  readonly merges: MergeInfo[] = [];
  /** 보이는 행 번호. null 이면 1..maxRow 전부 */
  private readonly shown: number[] | null;
  /** 숨긴 행(h <= 0) 가운데 글자가 있는 행, 행 번호 오름차순 */
  private readonly hiddenRows: SheetRow[] = [];
  private readonly hiddenRowNos: number[] = [];
  private readonly colPos: Int32Array;
  private readonly widths: number[];
  private readonly rowsByR = new Map<number, SheetRow>();
  private readonly cellMaps = new Map<number, Map<number, SheetCell>>();
  private readonly mergeRows = new Map<number, MergeInfo[]>();
  private readonly cssCache = new Map<number, CSSProperties>();
  private readonly tailW = new Map<number, number>();

  constructor(page: SheetPage, styles: readonly CellStyle[]) {
    this.page = page;
    this.styles = styles;
    const rows = Array.isArray(page.rows) ? page.rows : [];
    let lastRow = 0;
    let lastCol = 0;
    const hiddenSet = new Set<number>();
    for (const row of rows) {
      if (!Number.isInteger(row.r) || row.r < 1 || row.r > MAX_ROWS) continue;
      this.rowsByR.set(row.r, row);
      lastRow = Math.max(lastRow, row.r);
      for (const cell of row.cells ?? []) {
        if (Number.isInteger(cell.c) && cell.c >= 1 && cell.c <= MAX_COLS) lastCol = Math.max(lastCol, cell.c);
      }
      if (typeof row.h === 'number' && row.h <= 0) {
        hiddenSet.add(row.r);
        if ((row.cells ?? []).some(hasPiece)) {
          this.hiddenRows.push(row);
          this.hiddenRowNos.push(row.r);
        }
      }
    }
    const rects: [number, number, number, number][] = [];
    for (const m of Array.isArray(page.merges) ? page.merges : []) {
      if (!Array.isArray(m) || m.length < 4) continue;
      const [a, b, c, d] = [toInt(m[0]), toInt(m[1]), toInt(m[2]), toInt(m[3])];
      const r1 = Math.max(1, Math.min(a, c));
      const r2 = Math.min(MAX_ROWS, Math.max(a, c));
      const c1 = Math.max(1, Math.min(b, d));
      const c2 = Math.min(MAX_COLS, Math.max(b, d));
      if (r2 < r1 || c2 < c1 || (r1 === r2 && c1 === c2)) continue;
      rects.push([r1, c1, r2, c2]);
      lastRow = Math.max(lastRow, r2);
      lastCol = Math.max(lastCol, c2);
    }
    // 모델의 maxRow, maxCol 을 따르되 내용보다 터무니없이 큰 값은 줄인다
    this.maxRow = Math.min(MAX_ROWS, Math.max(lastRow, Math.min(toInt(page.maxRow), lastRow + 1000)));
    this.maxCol = Math.min(MAX_COLS, Math.max(lastCol, Math.min(toInt(page.maxCol), lastCol + 200)));
    const defH = page.defaultRowHeight;
    this.defaultRowH =
      typeof defH === 'number' && Number.isFinite(defH) && defH > 0 ? Math.min(400, Math.max(4, defH)) : DEFAULT_ROW_H;

    if (hiddenSet.size > 0) {
      const shown: number[] = [];
      for (let r = 1; r <= this.maxRow; r += 1) if (!hiddenSet.has(r)) shown.push(r);
      this.shown = shown;
      this.rowCount = shown.length;
    } else {
      this.shown = null;
      this.rowCount = this.maxRow;
    }

    this.rowHeadW = Math.max(32, Math.round(14 + 7.5 * String(Math.max(1, this.maxRow)).length));
    this.colPos = new Int32Array(this.maxCol + 2);
    this.widths = new Array<number>(this.maxCol + 1).fill(DEFAULT_COL_W);
    let x = this.rowHeadW;
    for (let c = 1; c <= this.maxCol; c += 1) {
      const raw = Array.isArray(page.colWidths) ? page.colWidths[c - 1] : undefined;
      const w =
        typeof raw === 'number' && Number.isFinite(raw) ? (raw <= 0 ? 0 : Math.min(2000, Math.max(2, raw))) : DEFAULT_COL_W;
      this.widths[c] = w;
      if (w === 0) continue;
      this.colPos[c] = this.cols.length + 1;
      this.cols.push(c);
      this.colLeft.push(x);
      x += w;
    }
    this.tableW = x;

    const fr = Math.max(0, Math.min(this.maxRow, toInt(page.frozen?.rows)));
    const fc = Math.max(0, Math.min(this.maxCol, toInt(page.frozen?.cols)));
    this.frozenRowN = fr > 0 ? this.firstIndexAtLeast(fr + 1) : 0;
    this.frozenColN = fc > 0 ? lowerBound(this.cols, fc + 1) : 0;
    let fw = 0;
    for (let k = 0; k < this.frozenColN; k += 1) fw += this.colW(this.cols[k] ?? 0);
    this.frozenW = fw;

    for (const [r1, c1, r2, c2] of rects) this.addMerge(r1, c1, r2, c2);
  }

  private addMerge(r1: number, c1: number, r2: number, c2: number): void {
    // 겹치는 병합(엑셀은 만들지 않는다)은 먼저 온 것만 쓴다: 겹치면 표 칸이 밀린다
    for (let r = r1; r <= r2; r += 1) {
      for (const m of this.mergeRows.get(r) ?? []) if (m.c1 <= c2 && c1 <= m.c2) return;
    }
    const i1 = this.firstIndexAtLeast(r1);
    const iEnd = this.firstIndexAtLeast(r2 + 1) - 1;
    const k1 = lowerBound(this.cols, c1);
    const kEnd = lowerBound(this.cols, c2 + 1) - 1;
    const visible = iEnd >= i1 && kEnd >= k1;
    const info: MergeInfo = {
      r1,
      c1,
      r2,
      c2,
      dr: visible ? this.rowAt(i1) : 0,
      dc: visible ? (this.cols[k1] ?? 0) : 0,
      er: visible ? this.rowAt(iEnd) : 0,
      ec: visible ? (this.cols[kEnd] ?? 0) : 0,
      rowSpan: visible ? iEnd - i1 + 1 : 0,
      colSpan: visible ? kEnd - k1 + 1 : 0,
    };
    if (visible) this.merges.push(info);
    for (let r = r1; r <= r2; r += 1) {
      const list = this.mergeRows.get(r);
      if (list) list.push(info);
      else this.mergeRows.set(r, [info]);
    }
  }

  /** 행 색인 → 행 번호 */
  rowAt(i: number): number {
    return this.shown ? (this.shown[i] ?? 0) : i + 1;
  }

  /** 행 번호가 r 이상인 첫 보이는 행의 색인 (없으면 rowCount) */
  firstIndexAtLeast(r: number): number {
    if (this.shown) return lowerBound(this.shown, r);
    return Math.max(0, Math.min(this.rowCount, r - 1));
  }

  /** 행 번호 → 그 행(숨겨졌으면 다음 보이는 행)의 색인, 0..rowCount-1 */
  indexOfRow(r: number): number {
    return Math.max(0, Math.min(this.rowCount - 1, this.firstIndexAtLeast(r)));
  }

  /** r 다음의 보이는 행 번호 (없으면 0) */
  nextShownRow(r: number): number {
    const i = this.firstIndexAtLeast(r + 1);
    return i < this.rowCount ? this.rowAt(i) : 0;
  }

  /** c 다음의 보이는 열 번호 (없으면 0) */
  nextShownCol(c: number): number {
    return this.cols[lowerBound(this.cols, c + 1)] ?? 0;
  }

  isColShown(c: number): boolean {
    return c >= 1 && c <= this.maxCol && (this.colPos[c] ?? 0) > 0;
  }

  /** 열 번호 → 열 색인 (숨긴 열이면 -1) */
  colIndex(c: number): number {
    return c >= 1 && c <= this.maxCol ? (this.colPos[c] ?? 0) - 1 : -1;
  }

  colW(c: number): number {
    return this.widths[c] ?? DEFAULT_COL_W;
  }

  rowH(r: number): number {
    const h = this.rowsByR.get(r)?.h;
    return typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.min(h, 2000) : this.defaultRowH;
  }

  row(r: number): SheetRow | undefined {
    return this.rowsByR.get(r);
  }

  cell(r: number, c: number): SheetCell | undefined {
    let map = this.cellMaps.get(r);
    if (!map) {
      const row = this.rowsByR.get(r);
      if (!row) return undefined;
      map = new Map();
      for (const cell of row.cells ?? []) map.set(cell.c, cell);
      this.cellMaps.set(r, map);
    }
    return map.get(c);
  }

  styleOf(cell: SheetCell | undefined): CellStyle | undefined {
    return cell && typeof cell.s === 'number' ? this.styles[cell.s] : undefined;
  }

  style(r: number, c: number): CellStyle | undefined {
    return r > 0 && c > 0 ? this.styleOf(this.cell(r, c)) : undefined;
  }

  /** 스타일 색인 → 칸 CSS (캐시). 서식이 없으면 undefined */
  baseCss(s: number | undefined): CSSProperties | undefined {
    if (typeof s !== 'number') return undefined;
    let css = this.cssCache.get(s);
    if (!css) {
      const st = this.styles[s];
      css = st ? cellCss(st) : {};
      this.cssCache.set(s, css);
    }
    return css;
  }

  mergeAt(r: number, c: number): MergeInfo | undefined {
    const list = this.mergeRows.get(r);
    if (!list) return undefined;
    for (const m of list) if (c >= m.c1 && c <= m.c2) return m;
    return undefined;
  }

  /** 행 번호 r 을 덮는 병합 전부 (보이는 칸이 없는 병합은 dr = 0) */
  mergesOnRow(r: number): readonly MergeInfo[] {
    return this.mergeRows.get(r) ?? EMPTY_MERGES;
  }

  /**
   * 스크롤되는 행(고정 행이 아닌 행)의 왼쪽 맞춤 글자가 마지막 열 너머(표 오른쪽 바깥)로 흐르는 자리의 최대 폭 px,
   * 없으면 0. rowSpill 의 마지막 열 너머 자리와 같은 셈이다(가운데 맞춤은 넣지 않는다). 열 머리와 고정 행 높이에서
   * 그 자리를 덮는 덮개(osv-tailcap)의 너비로 쓴다: 표 밖이라 그 아래로 지나가는 행의 글자를 가려 줄 고정 칸이
   * 없다. 고정 행의 글자는 덮개 위에 그려지고, 떠 있는 고정 열의 글자는 틀 경계에서 멈추므로 세지 않는다.
   */
  tailCoverW(stickyRows: boolean, stickyCols: boolean): number {
    const key = (stickyRows ? 1 : 0) + (stickyCols ? 2 : 0);
    const known = this.tailW.get(key);
    if (known !== undefined) return known;
    let max = 0;
    const last = this.cols.length - 1;
    for (const row of this.rowsByR.values()) {
      if (last < 0 || (typeof row.h === 'number' && row.h <= 0)) continue;
      if (stickyRows && this.firstIndexAtLeast(row.r) < this.frozenRowN) continue;
      let best: CellPiece | null = null;
      for (const cell of row.cells ?? []) {
        if (hasPiece(cell) && this.isColShown(cell.c) && (!best || cell.c > best.c)) best = cell;
      }
      const src = best;
      if (!src || this.mergeAt(row.r, src.c)) continue;
      const k = this.colIndex(src.c);
      if (last - k >= MAX_SPILL_COLS || (stickyCols && k < this.frozenColN)) continue;
      if (this.mergesOnRow(row.r).some((m) => m.dr > 0 && m.ec > src.c)) continue;
      const st = this.styleOf(src);
      if (st?.wrap || (st?.ha ?? (st?.num ? 'right' : 'left')) !== 'left') continue;
      const right = this.tableW - (this.colLeft[k] ?? 0) - this.colW(src.c);
      const rest = estimateTextPx(src.t, st, true) - (this.colW(src.c) - 1 - 2 * CELL_PAD - indentPx(st)) - right;
      if (rest > 0) max = Math.max(max, Math.min(TAIL_SPILL_PX, Math.ceil(rest) + TAIL_SLACK_PX));
    }
    this.tailW.set(key, max);
    return max;
  }

  /** 행 색인 i 바로 앞에 숨긴 행들의 글자 조각 (DOM 에서 그 행 머리 안에 둔다) */
  piecesBeforeRow(i: number): CellPiece[] {
    if (this.hiddenRows.length === 0) return [];
    return this.hiddenPieces(i > 0 ? this.rowAt(i - 1) : 0, this.rowAt(i));
  }

  /** 마지막 보이는 행 뒤의 숨긴 행 글자 조각 */
  piecesAfterLastRow(): CellPiece[] {
    if (this.hiddenRows.length === 0) return [];
    return this.hiddenPieces(this.rowCount > 0 ? this.rowAt(this.rowCount - 1) : 0, Number.POSITIVE_INFINITY);
  }

  private hiddenPieces(after: number, before: number): CellPiece[] {
    const out: CellPiece[] = [];
    for (let k = lowerBound(this.hiddenRowNos, after + 1); k < this.hiddenRows.length; k += 1) {
      const row = this.hiddenRows[k];
      if (!row || row.r >= before) break;
      for (const cell of row.cells ?? []) if (hasPiece(cell)) out.push(cell);
    }
    return out;
  }

  /** 이동 요청 칸 → 화면에 실제로 있는 칸(숨긴 행, 열은 다음 칸, 병합은 기준 칸) */
  anchorOf(r: number, c: number): { r: number; c: number } | null {
    if (this.rowCount === 0 || this.cols.length === 0) return null;
    const row = this.rowAt(this.indexOfRow(Math.max(1, toInt(r))));
    const k = Math.min(this.cols.length - 1, lowerBound(this.cols, Math.max(1, toInt(c))));
    const col = this.cols[k] ?? 0;
    const m = this.mergeAt(row, col);
    return m && m.dr > 0 ? { r: m.dr, c: m.dc } : { r: row, c: col };
  }

  /**
   * 가상화 창: 보이는 범위 + 여유 행, 그리고 늘 그리는 고정 행(앞쪽 pinned 개). 오름차순.
   * 병합 때문에 넓히지 않는다: 창에 걸친 병합은 layoutBands 가 빈 줄 묶음을 잘라 전체 높이로 그린다.
   */
  windowIndexes(range: Range, pinned: number): number[] {
    if (range.count <= 0) return [];
    const s = Math.max(0, range.startIndex - range.overscan);
    const e = Math.min(range.count - 1, range.endIndex + range.overscan);
    const pe = Math.min(pinned, range.count) - 1;
    const out: number[] = [];
    for (let i = 0; i <= pe && i < s; i += 1) out.push(i);
    for (let i = s; i <= Math.max(e, pe); i += 1) out.push(i);
    return out;
  }
}

/** 가상화 때 tbody 의 줄 하나: 그리는 행 하나, 또는 그리지 않는 행들의 묶음 하나 */
type Band =
  | { kind: 'row'; i: number }
  | {
      kind: 'gap';
      /** 묶음의 첫 행 색인과 높이 px */
      i1: number;
      h: number;
      /** 이 묶음 자리에서 시작하는 병합(기준 칸을 여기에 그린다)과 그 칸이 걸칠 tr 수. 열 순서 */
      masters: [MergeInfo, number][];
      /** 위 줄에서 내려와 이 묶음을 지나는 병합: 첫 열 색인 → 열 수 */
      covers: Map<number, number>;
    };
type GapBandInfo = Extract<Band, { kind: 'gap' }>;

interface BandLayout {
  bands: Band[];
  /** 그리는 행 색인 → 그 행에 기준 칸이 있고 빈 줄 묶음을 지나는 병합의 tr 수 ("열:수,열:수") */
  spans: Map<number, string>;
  /** 줄 배치가 바뀌었는지 가리는 값 (onRowsRendered) */
  sig: string;
}

/**
 * 가상화 창의 tbody 줄 배치. 그리는 행 사이는 빈 줄 묶음으로 채우되, 그리는 행에 걸친 병합의 첫 행과
 * 마지막 행 다음에서 묶음을 자른다. 그러면 기준 칸의 rowSpan(걸친 tr 수)이 병합 전체 높이와 맞는다.
 * 기준 칸의 행이 그리지 않는 행이면 그 칸은 그 행에서 시작하는 묶음 줄에 그린다: DOM 에서 그 행 자리라
 * 글자 조각 순서가 정본 순서와 같다. 그리는 행은 창 크기 그대로이고, 늘어나는 것은 묶음 줄 몇 개뿐이다.
 * startOf(i) 는 행 색인 i 의 위끝 px (i = rowCount 이면 전체 높이).
 */
function layoutBands(g: SheetGeom, rendered: readonly number[], startOf: (i: number) => number): BandLayout {
  const n = g.rowCount;
  const isRow = new Set(rendered);
  const cuts = new Set<number>([0]);
  const live = new Map<MergeInfo, [number, number]>();
  for (const i of rendered) {
    cuts.add(i);
    cuts.add(i + 1);
    for (const m of g.mergesOnRow(g.rowAt(i))) {
      if (m.dr <= 0 || m.rowSpan <= 1 || live.has(m)) continue;
      const a = g.indexOfRow(m.dr);
      const b = g.indexOfRow(m.er);
      live.set(m, [a, b]);
      cuts.add(a);
      cuts.add(b + 1);
    }
  }
  const starts = Array.from(cuts)
    .filter((x) => x >= 0 && x < n)
    .sort((x, y) => x - y);
  const bands: Band[] = starts.map((s, k): Band => {
    if (isRow.has(s)) return { kind: 'row', i: s };
    const end = starts[k + 1] ?? n;
    return { kind: 'gap', i1: s, h: Math.max(0, startOf(end) - startOf(s)), masters: [], covers: new Map() };
  });
  const spanParts = new Map<number, string[]>();
  for (const [m, [a, b]] of live) {
    const ba = upperBound(starts, a) - 1;
    const bb = upperBound(starts, b) - 1;
    const rows = bb - ba + 1;
    const head = bands[ba];
    if (head?.kind === 'gap') head.masters.push([m, rows]);
    else if (rows !== m.rowSpan) {
      const list = spanParts.get(a) ?? [];
      list.push(`${m.dc}:${rows}`);
      spanParts.set(a, list);
    }
    const k1 = g.colIndex(m.dc);
    for (let k = ba + 1; k <= bb; k += 1) {
      const band = bands[k];
      if (band?.kind === 'gap') band.covers.set(k1, m.colSpan);
    }
  }
  const sig: string[] = [];
  for (const b of bands) {
    if (b.kind === 'row') sig.push(String(b.i));
    else {
      b.masters.sort((x, y) => x[0].dc - y[0].dc);
      sig.push(`${b.i1}@${Math.round(b.h)}`);
    }
  }
  const spans = new Map<number, string>();
  for (const [i, list] of spanParts) spans.set(i, list.join(','));
  return { bands, spans, sig: sig.join(',') };
}

/** "열:수,열:수" → 열 → 수 */
function parseSpans(s: string): Map<number, number> | null {
  if (s === '') return null;
  const out = new Map<number, number>();
  for (const part of s.split(',')) {
    const [c, n] = part.split(':');
    out.set(Number(c), Number(n));
  }
  return out;
}

// ─────────────────────────────── 행 그리기 ───────────────────────────────

interface RowCtx {
  g: SheetGeom;
  stickyRows: boolean;
  stickyCols: boolean;
  /** 고정 행 색인 → sticky top px */
  tops: readonly number[];
}

interface RowSpill {
  /** 열 → [왼쪽, 오른쪽] 으로 글자 상자를 넓힐 px */
  boxes: Map<number, [number, number]>;
  /** 오른쪽 격자선을 숨길 열(흘린 글자가 지나가는 경계) */
  noGrid: Set<number>;
  /** 틀 고정 칸의 오른쪽 흘림: 원본 열 → 받는 칸들의 너비와 채우기 (밑판, 머리 주석 z-index 층) */
  under: Map<number, { widths: number[]; fills: string[] }>;
  /** 밑판이 깔리는 받는 칸(열): 바탕을 비운다 */
  clear: Set<number>;
}

/** 받는 칸들의 채우기를 이어 붙인 밑판 바탕 (모두 같으면 한 색) */
function underBackground(widths: readonly number[], fills: readonly string[]): string {
  const first = fills[0] ?? SURFACE;
  if (fills.every((f) => f === first)) return first;
  let x = 0;
  const stops = fills.map((f, j) => {
    const a = x;
    x += widths[j] ?? 0;
    return `${f} ${a}px ${x}px`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** 앞에서부터 너비를 더해 need 를 덮는 데 필요한 칸 수 */
function coverCount(widths: readonly number[], need: number): number {
  let acc = 0;
  for (let k = 0; k < widths.length; k += 1) {
    if (acc >= need) return k;
    acc += widths[k] ?? 0;
  }
  return widths.length;
}

function sum(widths: readonly number[]): number {
  let s = 0;
  for (const w of widths) s += w;
  return s;
}

/** 한 행에서 칸 밖으로 흘려 보일 글자와 그 자리. frozenRow: 이 행이 고정 행으로 떠 있다 */
function rowSpill(
  g: SheetGeom,
  r: number,
  row: SheetRow | undefined,
  stickyCols: boolean,
  frozenRow: boolean,
): RowSpill | null {
  if (!row) return null;
  let out: RowSpill | null = null;
  for (const cell of row.cells ?? []) {
    if (!hasPiece(cell) || !g.isColShown(cell.c) || g.mergeAt(r, cell.c)) continue;
    const st = g.styleOf(cell);
    if (st?.wrap || st?.ha === 'justify') continue;
    const ha = st?.ha ?? (st?.num ? 'right' : 'left');
    const k = g.colIndex(cell.c);
    const need = estimateTextPx(cell.t, st, true) - (g.colW(cell.c) - 1 - 2 * CELL_PAD - indentPx(st));
    if (need <= 0) continue;
    const pane = stickyCols && k < g.frozenColN;
    /** 열 색인 kk 가 글자를 받을 수 있으면 그 너비, 아니면 -1 */
    const free = (kk: number): number => {
      if (kk < 0 || kk >= g.cols.length) return -1;
      if (stickyCols && (kk < g.frozenColN) !== pane) return -1;
      const cc = g.cols[kk] ?? 0;
      if (hasPiece(g.cell(r, cc)) || g.mergeAt(r, cc)) return -1;
      return g.colW(cc);
    };
    const right: number[] = [];
    if (ha !== 'right') {
      for (let kk = k + 1; right.length < MAX_SPILL_COLS; kk += 1) {
        if (kk >= g.cols.length) {
          // 마지막 열 너머: 엑셀은 빈 열이 이어진다. 빈 상자도 스크롤 넓이에 들어가므로 필요한 만큼만
          const rest = need - sum(right);
          if (rest > 0) right.push(Math.min(TAIL_SPILL_PX, Math.ceil(rest) + TAIL_SLACK_PX));
          break;
        }
        const w = free(kk);
        if (w < 0) break;
        right.push(w);
      }
    }
    const left: number[] = [];
    if (ha !== 'left') {
      for (let kk = k - 1; left.length < MAX_SPILL_COLS; kk -= 1) {
        const w = free(kk);
        if (w < 0) break;
        left.push(w);
      }
    }
    let boxL = 0;
    let boxR = 0;
    let hideL = 0;
    let hideR = 0;
    if (ha === 'right') {
      boxL = sum(left);
      hideL = coverCount(left, need);
    } else if (ha === 'center') {
      const s = Math.min(sum(left), sum(right));
      boxL = s;
      boxR = s;
      hideL = coverCount(left, Math.min(need / 2, s));
      hideR = coverCount(right, Math.min(need / 2, s));
    } else {
      boxR = sum(right);
      hideR = coverCount(right, need);
    }
    if (boxL === 0 && boxR === 0) continue;
    out ??= { boxes: new Map(), noGrid: new Set(), under: new Map(), clear: new Set() };
    out.boxes.set(cell.c, [boxL, boxR]);
    for (let j = 0; j < hideR; j += 1) out.noGrid.add(g.cols[k + j] ?? 0);
    for (let j = 1; j <= hideL; j += 1) out.noGrid.add(g.cols[k - j] ?? 0);
    // 떠 있는 칸에서 오른쪽으로 흐르면 글자 상자가 닿는 받는 칸 전부(어림이 아니라 상자 기준)에 밑판을 깐다
    if (boxR > 0 && (frozenRow || pane)) {
      const n = coverCount(right, boxR);
      const fills: string[] = [];
      for (let j = 0; j < n; j += 1) {
        const cc = g.cols[k + 1 + j];
        if (cc === undefined) {
          fills.push(SURFACE); // 마지막 열 너머(표 바깥)
          continue;
        }
        fills.push(cssColor(g.style(r, cc)?.bg) ?? SURFACE);
        out.clear.add(cc);
      }
      out.under.set(cell.c, { widths: right.slice(0, n), fills });
    }
  }
  return out;
}

/** td 하나의 그리기 정보 */
interface Slot {
  key: string;
  c: number;
  /** 틀 고정 칸: 'r' 행, 'c' 열, 'rc' 둘 다 (data-frozen) */
  frozen?: 'r' | 'c' | 'rc';
  className?: string;
  style?: CSSProperties;
  rowSpan?: number;
  colSpan?: number;
  /** 칸 글자: shown 은 piece.t 와 길이가 같은 표시 글자(사설영역 기호만 바뀐다) */
  text?: { piece: TextPiece; shown: string; className: string; style?: CSSProperties };
  /** 오른쪽으로 흘린 고정 칸의 밑판 자리와 바탕 (osv-under) */
  under?: CSSProperties;
  /** 이 칸 안 끝에 보이지 않게 둘 글자 조각 */
  ghosts: TextPiece[];
}

function ghostSpan(p: TextPiece): ReactNode {
  return (
    <span key={`g${p.o}`} className="osv-ghost" data-o={p.o}>
      {mapPuaText(p.t)}
    </span>
  );
}

/** 칸 하나의 td. ariaCol: 앞 칸이 접근성 트리에서 빠진 줄(빈 줄 묶음)에서 열 위치를 알린다 */
function slotTd(s: Slot, ariaCol?: number): JSX.Element {
  return (
    <td
      key={s.key}
      data-c={s.c}
      data-frozen={s.frozen}
      className={s.className}
      style={s.style}
      rowSpan={s.rowSpan}
      colSpan={s.colSpan}
      aria-colindex={ariaCol}
    >
      {s.text ? (
        <div className={s.text.className} style={s.text.style}>
          <span data-o={s.text.piece.o}>{s.text.shown}</span>
        </div>
      ) : null}
      {s.under ? <div className="osv-under" style={s.under} aria-hidden="true" /> : null}
      {s.ghosts.length > 0 ? s.ghosts.map(ghostSpan) : null}
    </td>
  );
}

/** 칸 글자 상자 */
function textBox(piece: TextPiece, st: CellStyle | undefined, box: [number, number] | undefined): Slot['text'] {
  const num = !!st?.num;
  const wraps = !!st?.wrap || st?.ha === 'justify';
  // 줄 바꿈 서식이 없는 글자만 자른다. 숫자는 잘리면 다른 값으로 읽히므로 줄여서 맞춘다(fitCells)
  const clip = !wraps && !num;
  const ha = st?.ha ?? (num ? 'right' : 'left');
  const style: CSSProperties = {};
  if (box) {
    style.width = `calc(100% + ${box[0] + box[1]}px)`;
    if (box[0] > 0) style.marginLeft = -box[0];
  }
  const ind = indentPx(st);
  if (ind > 0) {
    if (ha === 'right') style.paddingRight = CELL_PAD + ind;
    else if (ha !== 'center') style.paddingLeft = CELL_PAD + ind;
  }
  // 줄바꿈이 든 한 줄 칸(osv-nl)은 CSS 로만 줄바꿈을 띄어쓰기처럼 보인다(엑셀이 그렇게 그린다)
  let className = 'osv-c';
  if (num) className = 'osv-c osv-num';
  else if (clip) className = piece.t.includes('\n') ? 'osv-c osv-clip osv-nl' : 'osv-c osv-clip';
  return {
    piece,
    shown: mapPuaText(piece.t, st?.font),
    className,
    ...(Object.keys(style).length > 0 ? { style } : {}),
  };
}

/**
 * 그린 뒤에 잰 값으로 칸을 다듬는다(어림이 아니라 실제 폭). React 는 여기서 쓰는 title, data-fit, 인라인
 * fontSize 와 whiteSpace 를 다루지 않으므로 서로 덮어쓰지 않는다. 읽기를 먼저 모아 레이아웃을 한 번만 잰다.
 * - 잘린 한 줄 칸(.osv-clip): 실제로 잘린 칸에만 전체 글자를 title 로 단다.
 * - 숫자 칸(.osv-num): 넘치면 글자 크기를 줄여 맞추고(최소 MIN_NUM_SCALE), 그보다 작아져야 하면 줄을 바꾼다.
 *   한 번 다듬은 칸은 data-fit 으로 표시해 거듭 줄이지 않는다(행이 다시 그려져 요소가 새로 생기면 다시 잰다).
 */
function fitCells(root: HTMLElement | null): void {
  if (!root) return;
  const clips = Array.from(root.querySelectorAll<HTMLElement>('.osv-c.osv-clip'));
  const nums = Array.from(root.querySelectorAll<HTMLElement>('.osv-c.osv-num:not([data-fit])'));
  const over = clips.map((el) => el.scrollWidth > el.clientWidth + 1);
  const numPlan = nums.map((el) => {
    const span = el.firstElementChild;
    if (!(span instanceof HTMLElement)) return null;
    const cs = getComputedStyle(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const natural = span.getBoundingClientRect().width;
    return { scale: natural > avail + 0.5 && natural > 0 ? avail / natural : 1, fs: parseFloat(cs.fontSize) };
  });
  clips.forEach((el, k) => {
    const want = over[k] ? (el.textContent ?? '') : '';
    if (want !== '') {
      if (el.title !== want) el.title = want;
    } else if (el.hasAttribute('title')) {
      el.removeAttribute('title');
    }
  });
  nums.forEach((el, k) => {
    const plan = numPlan[k];
    el.dataset.fit = '1';
    if (!plan || plan.scale >= 1) return;
    if (plan.scale >= MIN_NUM_SCALE && Number.isFinite(plan.fs)) {
      el.style.fontSize = `${Math.floor(plan.fs * plan.scale * 10) / 10}px`;
    } else {
      el.style.whiteSpace = 'pre-wrap';
      el.style.overflowWrap = 'anywhere';
    }
  });
}

/** 보이는 칸(일반 칸이나 병합 기준 칸) 하나. rows: 이 칸이 걸칠 tr 수(가상화의 빈 줄 묶음도 한 줄) */
function cellSlot(
  ctx: RowCtx,
  i: number,
  r: number,
  c: number,
  cell: SheetCell | undefined,
  piece: CellPiece | null,
  m: MergeInfo | undefined,
  spill: RowSpill | null,
  marked: boolean,
  rows: number,
): Slot {
  const { g, stickyRows, stickyCols, tops } = ctx;
  // 병합의 글자와 서식은 정본 기준 칸(r1, c1)의 것. 기준 칸이 숨겨져 있으면 그 글자는 다른 자리의 유령 조각이다
  const own = m ? (m.r1 === r && m.c1 === c ? piece : null) : piece;
  const styleCell = m ? (g.cell(m.r1, m.c1) ?? cell) : cell;
  const st = g.styleOf(styleCell);
  const r2 = m ? m.er : r;
  const c2 = m ? m.ec : c;
  const i2 = m ? g.indexOfRow(r2) : i;
  const k1 = g.colIndex(c);
  const k2 = g.colIndex(c2);
  const fr = stickyRows && i2 < g.frozenRowN;
  const fc = stickyCols && k2 < g.frozenColN;
  const frb = fr && i2 === g.frozenRowN - 1;
  const fcb = fc && k2 === g.frozenColN - 1;

  const css: CSSProperties = { ...g.baseCss(styleCell?.s) };
  if (fr) css.top = tops[i] ?? 0;
  if (fc) css.left = g.colLeft[k1] ?? 0;

  // 테두리: 오른쪽, 아래는 이 칸이 그린다(이 칸의 br/bb, 없으면 옆, 아래 칸의 bl/bt). 위, 왼쪽은 첫 행, 첫 열만
  const below = g.nextShownRow(r2);
  const rightC = g.nextShownCol(c2);
  let bb = st?.bb;
  for (let k = k1; !bb && below > 0 && k <= k2; k += 1) bb = g.style(below, g.cols[k] ?? 0)?.bt;
  let br = st?.br;
  const iScan = Math.min(i2, i + BORDER_SCAN_ROWS - 1);
  for (let ii = i; !br && rightC > 0 && ii <= iScan; ii += 1) br = g.style(g.rowAt(ii), rightC)?.bl;
  if (i === 0 && st?.bt) css.borderTop = borderCss(st.bt);
  if (k1 === 0 && st?.bl) css.borderLeft = borderCss(st.bl);
  // 채우기가 있는 칸의 격자선은 엑셀처럼 채우기에 묻힌다(고정 경계선은 남긴다)
  const fill = css.backgroundColor !== undefined;
  if (bb) css.borderBottom = borderCss(bb);
  else if (!frb && (fill || cssColor(g.style(below, c)?.bg))) css.borderBottomColor = 'transparent';
  if (br) css.borderRight = borderCss(br);
  else if (!fcb && (fill || cssColor(g.style(r, rightC)?.bg) || spill?.noGrid.has(c2))) {
    css.borderRightColor = 'transparent';
  }

  const cls: string[] = [];
  const frozenAttr = fr && fc ? 'rc' : fr ? 'r' : fc ? 'c' : undefined;
  if (fr) cls.push('osv-fr');
  if (fc) cls.push('osv-fc');
  if (frb) cls.push('osv-frb');
  if (fcb) cls.push('osv-fcb');
  // 떠 있는 칸에서 흘러온 글자를 받는 빈 칸: 바탕은 원본 칸의 밑판이 대신 그린다(채우기도 밑판에 옮겼다)
  if (!m && !piece && (fr || fc) && spill?.clear.has(c)) {
    css.backgroundColor = 'transparent';
    cls.push('osv-clear');
  }
  if (marked) cls.push('osv-mark');
  const slot: Slot = { key: `c${c}`, c, ghosts: !own && piece ? [piece] : [] };
  if (frozenAttr) slot.frozen = frozenAttr;
  if (cls.length > 0) slot.className = cls.join(' ');
  if (Object.keys(css).length > 0) slot.style = css;
  if (rows > 1) slot.rowSpan = rows;
  if (m && m.colSpan > 1) slot.colSpan = m.colSpan;
  if (own) slot.text = textBox(own, st, spill?.boxes.get(c));
  const under = own && !m ? spill?.under.get(c) : undefined;
  if (under) {
    // td(sticky)의 안쪽 여백 상자가 기준: 오른쪽 테두리 너머 받는 칸의 왼쪽 끝부터, 행의 위아래 끝까지
    slot.under = {
      left: `calc(100% + ${br ? borderWidth(br) : 1}px)`,
      top: i === 0 && st?.bt ? -borderWidth(st.bt) : 0,
      bottom: -(bb ? borderWidth(bb) : 1),
      width: sum(under.widths),
      background: underBackground(under.widths, under.fills),
    };
  }
  return slot;
}

interface RowProps {
  ctx: RowCtx;
  /** 행 색인 */
  i: number;
  /** 이동 표시할 열 번호 (0 = 없음) */
  markC: number;
  /** 이 행에 기준 칸이 있고 빈 줄 묶음을 지나는 병합의 tr 수 ("열:수,..."), 없으면 '' (layoutBands) */
  spans: string;
  measure: ((el: HTMLTableRowElement | null) => void) | undefined;
}

const SheetRowView = memo(function SheetRowView({ ctx, i, markC, spans, measure }: RowProps): JSX.Element {
  const { g, stickyRows, stickyCols, tops } = ctx;
  const r = g.rowAt(i);
  const row = g.row(r);
  const frozen = stickyRows && i < g.frozenRowN;
  const spill = rowSpill(g, r, row, stickyCols, frozen);
  const spanOf = parseSpans(spans);

  // 칸이 없는 글자 조각은 DOM 순서상 바로 앞에 그린 칸(첫 칸이면 행 머리) 끝에 붙인다
  const headGhosts: TextPiece[] = [];
  const slots: Slot[] = [];
  let tail: TextPiece[] = headGhosts;
  const cells = row?.cells ?? [];
  let ci = 0;
  for (let c = 1; c <= g.maxCol; c += 1) {
    while (ci < cells.length && (cells[ci]?.c ?? 0) < c) ci += 1;
    const cell = cells[ci]?.c === c ? cells[ci] : undefined;
    const piece = hasPiece(cell) ? cell : null;
    if (!g.isColShown(c)) {
      if (piece) tail.push(piece);
      continue;
    }
    const m = g.mergeAt(r, c);
    if (m && (m.dr !== r || m.dc !== c)) {
      if (piece) tail.push(piece); // 병합에 가려진 칸
      continue;
    }
    const rows = m ? (spanOf?.get(c) ?? m.rowSpan) : 1;
    const slot = cellSlot(ctx, i, r, c, cell, piece, m, spill, markC === c, rows);
    slots.push(slot);
    tail = slot.ghosts;
  }
  if (i === g.rowCount - 1) tail.push(...g.piecesAfterLastRow());

  const thCls = ['osv-rh'];
  if (frozen) thCls.push('osv-fr');
  if (frozen && i === g.frozenRowN - 1) thCls.push('osv-frb');
  return (
    <tr data-r={r} data-index={i} ref={measure} style={{ height: g.rowH(r) }} aria-rowindex={i + 2}>
      <th scope="row" className={thCls.join(' ')} style={frozen ? { top: tops[i] ?? 0 } : undefined}>
        {g.piecesBeforeRow(i).map(ghostSpan)}
        {r}
        {headGhosts.map(ghostSpan)}
      </th>
      {slots.map((s) => slotTd(s))}
    </tr>
  );
});

/**
 * 가상화로 그리지 않는 행들의 묶음 한 줄. 빈 채움 칸으로 높이만 지키되, 이 묶음 첫 행에서 시작해 창으로
 * 이어지는 병합의 기준 칸(글자 포함)을 제 열 자리에 그리고, 위에서 내려와 지나가는 병합의 열은 비운다.
 */
function GapBand({ ctx, band, markC }: { ctx: RowCtx; band: GapBandInfo; markC: number }): JSX.Element {
  const { g } = ctx;
  const at = new Map<number, [MergeInfo, number]>();
  for (const mm of band.masters) at.set(g.colIndex(mm[0].dc), mm);
  const cells: ReactNode[] = [];
  let free = 1; // 행 머리 자리부터 센다
  const flush = (key: string): void => {
    if (free > 0) cells.push(<td key={key} className="osv-fill" colSpan={free} aria-hidden="true" />);
    free = 0;
  };
  for (let k = 0; k < g.cols.length; ) {
    const hit = at.get(k);
    if (hit) {
      const [m, rows] = hit;
      flush(`f${k}`);
      const cell = g.cell(m.dr, m.dc);
      const slot = cellSlot(ctx, band.i1, m.dr, m.dc, cell, hasPiece(cell) ? cell : null, m, null, markC === m.dc, rows);
      cells.push(slotTd(slot, k + 2));
      k += Math.max(1, m.colSpan);
      continue;
    }
    const cover = band.covers.get(k);
    if (cover !== undefined) {
      flush(`f${k}`);
      k += Math.max(1, cover);
      continue;
    }
    free += 1;
    k += 1;
  }
  flush('fz');
  const bare = band.masters.length === 0;
  return (
    <tr
      className="osv-gap"
      style={{ height: band.h }}
      aria-hidden={bare ? true : undefined}
      aria-rowindex={bare ? undefined : band.i1 + 2}
    >
      {cells}
    </tr>
  );
}

/** 열 글자 (A, B, ..., Z, AA, ...) */
function columnLetter(c: number): string {
  let s = '';
  let n = c;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ─────────────────────────────── 시트 한 장 ───────────────────────────────

interface Callbacks {
  onActivePageChange: (pageNo: number) => void;
  onPageElement?: (pageNo: number, el: HTMLElement | null) => void;
  onRowsRendered?: () => void;
}

interface Metrics {
  /** 열 머리 행 높이 */
  headH: number;
  /** 고정 행 색인 → sticky top */
  tops: number[];
  /** 고정 행 전체 높이 */
  frozenH: number;
}

interface ScrollPos {
  top: number;
  left: number;
}

function estimateMetrics(g: SheetGeom): Metrics {
  const tops: number[] = [];
  let acc = HEAD_ROW_H;
  for (let i = 0; i < g.frozenRowN; i += 1) {
    tops.push(acc);
    acc += g.rowH(g.rowAt(i));
  }
  return { headH: HEAD_ROW_H, tops, frozenH: acc - HEAD_ROW_H };
}

function sameMetrics(a: Metrics, b: Metrics): boolean {
  if (Math.abs(a.headH - b.headH) > 0.5 || Math.abs(a.frozenH - b.frozenH) > 0.5) return false;
  if (a.tops.length !== b.tops.length) return false;
  return a.tops.every((t, k) => Math.abs(t - (b.tops[k] ?? 0)) <= 0.5);
}

interface GridProps {
  page: SheetPage;
  styles: readonly CellStyle[];
  cbs: MutableRefObject<Callbacks>;
  /** 시트별 스크롤 자리 (탭을 오가도 제자리로) */
  scrollMemo: Map<string, ScrollPos>;
  memoKey: string;
  target: { r: number; c: number; nonce: number } | null;
  onTargetDone: (nonce: number) => void;
  /** 시트 탭이 있을 때: 스크롤 상자를 탭 패널로 (id, 지금 탭의 id) */
  panel?: { id: string; labelledBy: string };
}

/** 쪽의 모든 글자 조각, 오프셋 순서 (격자가 없을 때 유령 조각으로 둔다) */
function allPieces(page: SheetPage): CellPiece[] {
  const out: CellPiece[] = [];
  for (const row of Array.isArray(page.rows) ? page.rows : []) {
    for (const cell of row.cells ?? []) if (hasPiece(cell)) out.push(cell);
  }
  return out.sort((a, b) => a.o - b.o);
}

function SheetGrid({ page, styles, cbs, scrollMemo, memoKey, target, onTargetDone, panel }: GridProps): JSX.Element {
  const g = useMemo(() => new SheetGeom(page, styles), [page, styles]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headRowRef = useRef<HTMLTableRowElement | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);
  const [saved] = useState<ScrollPos | null>(() => (target ? null : (scrollMemo.get(memoKey) ?? null)));
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(() => estimateMetrics(g));
  const [mark, setMark] = useState<{ r: number; c: number } | null>(null);

  const stickyRows =
    g.frozenRowN > 0 &&
    g.frozenRowN < g.rowCount &&
    (box === null || metrics.headH + metrics.frozenH <= box.h * MAX_FROZEN_H_RATIO);
  const stickyCols =
    g.frozenColN > 0 &&
    g.frozenColN < g.cols.length &&
    (box === null || g.rowHeadW + g.frozenW <= box.w * MAX_FROZEN_W_RATIO);
  const virtual = g.rowCount > VIRTUAL_MIN_ROWS || g.rowCount * g.cols.length > VIRTUAL_MAX_CELLS;
  const pinned = stickyRows ? g.frozenRowN : 0;

  const estimateSize = useCallback((i: number) => g.rowH(g.rowAt(i)), [g]);
  const getItemKey = useCallback((i: number) => g.rowAt(i), [g]);
  const rangeExtractor = useCallback((range: Range) => g.windowIndexes(range, pinned), [g, pinned]);
  const v = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtual ? g.rowCount : 0,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    scrollMargin: metrics.headH,
    initialOffset: saved?.top ?? 0,
    // 스크롤 상자를 재기 전 첫 그림에도 앞쪽 행이 들어오게
    initialRect: { width: 1200, height: 720 },
  });

  // 스크롤 상자 크기: 고정 칸이 너무 크면 고정을 푼다
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const read = (): void => {
      const w = sc.clientWidth;
      const h = sc.clientHeight;
      setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  // 열 머리와 고정 행의 실제 높이로 sticky top 을 맞춘다(줄바꿈으로 행이 늘어날 수 있다)
  useLayoutEffect(() => {
    const head = headRowRef.current;
    const body = bodyRef.current;
    if (!head || !body) return undefined;
    const frozenTr = (i: number): HTMLElement | null =>
      body.querySelector<HTMLElement>(`:scope > tr[data-index="${i}"]`);
    const measure = (): void => {
      const headH = head.getBoundingClientRect().height || HEAD_ROW_H;
      const tops: number[] = [];
      let acc = headH;
      for (let i = 0; i < g.frozenRowN; i += 1) {
        tops.push(acc);
        const tr = frozenTr(i);
        acc += tr ? tr.getBoundingClientRect().height : g.rowH(g.rowAt(i));
      }
      const next: Metrics = { headH, tops, frozenH: acc - headH };
      setMetrics((prev) => (sameMetrics(prev, next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(head);
    for (let i = 0; i < g.frozenRowN; i += 1) {
      const tr = frozenTr(i);
      if (tr) ro.observe(tr);
    }
    return () => ro.disconnect();
  }, [g]);

  // 붙을 때 이 시트의 지난 스크롤 자리로
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !saved) return;
    sc.scrollTop = saved.top;
    sc.scrollLeft = saved.left;
  }, [saved]);

  const pageRef = useCallback(
    (el: HTMLDivElement | null) => {
      cbs.current.onPageElement?.(page.pageNo, el);
    },
    [cbs, page.pageNo],
  );

  const rafRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    scrollMemo.set(memoKey, { top: sc.scrollTop, left: sc.scrollLeft });
    // 고정 칸은 스크롤하면 내용에 대해 자리가 바뀐다: 하이라이트를 다시 재게 한다(한 프레임에 한 번)
    if (!(stickyRows || stickyCols) || rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      cbs.current.onRowsRendered?.();
    });
  }, [scrollMemo, memoKey, stickyRows, stickyCols, cbs]);

  const ctx = useMemo<RowCtx>(
    () => ({ g, stickyRows, stickyCols, tops: metrics.tops }),
    [g, stickyRows, stickyCols, metrics.tops],
  );

  const colgroup = useMemo(
    () => (
      <colgroup>
        <col style={{ width: g.rowHeadW }} />
        {g.cols.map((c) => (
          <col key={c} style={{ width: g.colW(c) }} />
        ))}
      </colgroup>
    ),
    [g],
  );

  const headRow = useMemo(
    () => (
      <tr ref={headRowRef} style={{ height: HEAD_ROW_H }} aria-rowindex={1}>
        <th className="osv-corner" scope="col" aria-label="행 열 머리" />
        {g.cols.map((c, k) => {
          const fc = stickyCols && k < g.frozenColN;
          const cls = ['osv-ch'];
          if (fc) cls.push('osv-fc');
          if (fc && k === g.frozenColN - 1) cls.push('osv-fcb');
          return (
            <th key={c} scope="col" className={cls.join(' ')} style={fc ? { left: g.colLeft[k] ?? 0 } : undefined}>
              {columnLetter(c)}
            </th>
          );
        })}
      </tr>
    ),
    [g, stickyCols],
  );

  // 본문 행: 가상화면 창 안의 행만 그리고, 그 사이는 빈 줄 묶음(병합 끝에서 자른다: layoutBands)
  const markFor = (r: number): number => (mark && mark.r === r ? mark.c : 0);
  const body: ReactNode[] = [];
  let drawnSig: string;
  if (!virtual) {
    for (let i = 0; i < g.rowCount; i += 1) {
      const r = g.rowAt(i);
      body.push(<SheetRowView key={r} ctx={ctx} i={i} markC={markFor(r)} spans="" measure={undefined} />);
    }
    drawnSig = `all:${g.rowCount}`;
  } else {
    const items = v.getVirtualItems();
    const sm = v.options.scrollMargin;
    const total = v.getTotalSize();
    const meas = v.measurementsCache;
    const startOf = (i: number): number => (i >= g.rowCount ? total : (meas[i]?.start ?? sm) - sm);
    const lay = layoutBands(
      g,
      items.map((it) => it.index),
      startOf,
    );
    for (const b of lay.bands) {
      if (b.kind === 'row') {
        const r = g.rowAt(b.i);
        body.push(
          <SheetRowView
            key={r}
            ctx={ctx}
            i={b.i}
            markC={markFor(r)}
            spans={lay.spans.get(b.i) ?? ''}
            measure={v.measureElement}
          />,
        );
      } else {
        body.push(<GapBand key={`g${b.i1}`} ctx={ctx} band={b} markC={markFor(g.rowAt(b.i1))} />);
      }
    }
    drawnSig = lay.sig;
  }

  // 그린 행이나 고정 칸 자리가 바뀌었을 때 알린다(붙을 때 한 번 포함)
  const renderSig = `${drawnSig}|${metrics.headH}|${metrics.tops.join(',')}|${stickyRows ? 1 : 0}${stickyCols ? 1 : 0}`;
  useLayoutEffect(() => {
    fitCells(bodyRef.current);
    cbs.current.onRowsRendered?.();
  }, [renderSig, cbs]);

  // 칸으로 이동: 가상화로 행이 아직 없으면 어림 자리로 스크롤한 뒤 행이 생기면 정확히 맞춘다
  const live = useRef<Live>({ g, v, virtual, metrics, stickyRows, stickyCols });
  useLayoutEffect(() => {
    live.current = { g, v, virtual, metrics, stickyRows, stickyCols };
  });
  const targetNonce = target?.nonce;
  const targetR = target?.r ?? 0;
  const targetC = target?.c ?? 0;
  useEffect(() => {
    if (targetNonce === undefined) return undefined;
    let raf = 0;
    let tries = 0;
    let calm = 0;
    let cancelled = false;
    const step = (): void => {
      if (cancelled) return;
      const sc = scrollRef.current;
      const res = sc ? revealCell(sc, live.current, targetR, targetC) : 'ok';
      tries += 1;
      calm = res === 'ok' ? calm + 1 : 0;
      if (calm >= 2 || tries > 40) {
        setMark(live.current.g.anchorOf(targetR, targetC));
        onTargetDone(targetNonce);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [targetNonce, targetR, targetC, onTargetDone]);

  useEffect(() => {
    if (!mark) return undefined;
    const t = window.setTimeout(() => setMark(null), MARK_MS);
    return () => window.clearTimeout(t);
  }, [mark]);

  const empty = g.rowCount === 0 || g.cols.length === 0;
  // 행이나 열이 모두 숨겨져 격자가 없어도 쪽 글자의 조각은 빠뜨리지 않는다(보이지 않는 span, 오프셋 순서)
  const orphans = useMemo(() => (empty ? allPieces(page) : []), [empty, page]);
  const stickyTop = empty ? 0 : Math.round((metrics.headH + (stickyRows ? metrics.frozenH : 0)) * 2) / 2;
  const stickyLeft = empty ? 0 : g.rowHeadW + (stickyCols ? g.frozenW : 0);
  const tailCap = empty ? 0 : g.tailCoverW(stickyRows, stickyCols);
  return (
    <div
      className="osv-scroll"
      ref={scrollRef}
      onScroll={onScroll}
      role={panel ? 'tabpanel' : undefined}
      id={panel?.id}
      aria-labelledby={panel?.labelledBy}
    >
      <div
        className="osv-page"
        data-page={page.pageNo}
        data-sticky-top={stickyTop}
        data-sticky-left={stickyLeft}
        ref={pageRef}
        translate="no"
      >
        {tailCap > 0 ? (
          <div className="osv-tailcap" aria-hidden="true">
            <div style={{ left: g.tableW, width: tailCap, height: stickyTop }} />
          </div>
        ) : null}
        {empty ? (
          <>
            <p className="osv-empty">{orphans.length > 0 ? '숨긴 행/열에만 내용이 있습니다.' : '빈 시트입니다.'}</p>
            {orphans.map(ghostSpan)}
          </>
        ) : (
          <table
            className="osv-grid"
            style={{ width: g.tableW }}
            aria-label={page.name || `시트 ${page.pageNo}`}
            aria-rowcount={g.rowCount + 1}
            aria-colcount={g.cols.length + 1}
          >
            {colgroup}
            <thead>{headRow}</thead>
            <tbody ref={bodyRef}>{body}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type Live = {
  g: SheetGeom;
  v: { measurementsCache: { start: number }[] };
  virtual: boolean;
  metrics: Metrics;
  stickyRows: boolean;
  stickyCols: boolean;
};

/** 칸 하나를 고정 칸에 가리지 않는 자리로 스크롤한다. 'wait' = 행이 아직 그려지지 않았다 */
function revealCell(sc: HTMLDivElement, live: Live, r: number, c: number): 'ok' | 'moved' | 'wait' {
  const { g, v, virtual, metrics, stickyRows, stickyCols } = live;
  const a = g.anchorOf(r, c);
  if (!a) return 'ok';
  const td = sc.querySelector<HTMLElement>(`tr[data-r="${a.r}"] > td[data-c="${a.c}"]`);
  const stickTop = metrics.headH + (stickyRows ? metrics.frozenH : 0);
  if (!td) {
    if (!virtual) return 'ok';
    const item = v.measurementsCache[g.indexOfRow(a.r)];
    if (item) {
      const want = Math.max(0, item.start - stickTop - Math.max(0, (sc.clientHeight - stickTop) / 3));
      if (Math.abs(sc.scrollTop - want) > 1) sc.scrollTop = want;
    }
    return 'wait';
  }
  const scRect = sc.getBoundingClientRect();
  const rect = td.getBoundingClientRect();
  let moved = false;
  if (!td.classList.contains('osv-fr')) {
    const top = rect.top - scRect.top - sc.clientTop + sc.scrollTop;
    if (top < sc.scrollTop + stickTop - 0.5 || top + rect.height > sc.scrollTop + sc.clientHeight + 0.5) {
      const room = sc.clientHeight - stickTop;
      const before = sc.scrollTop;
      sc.scrollTop = Math.max(0, top - stickTop - Math.max(0, (room - rect.height) / 3));
      moved = Math.abs(sc.scrollTop - before) > 0.5;
    }
  }
  if (!td.classList.contains('osv-fc')) {
    const stickLeft = g.rowHeadW + (stickyCols ? g.frozenW : 0);
    const left = rect.left - scRect.left - sc.clientLeft + sc.scrollLeft;
    if (left < sc.scrollLeft + stickLeft - 0.5 || left + rect.width > sc.scrollLeft + sc.clientWidth + 0.5) {
      const room = sc.clientWidth - stickLeft;
      const before = sc.scrollLeft;
      sc.scrollLeft = Math.max(0, left - stickLeft - Math.max(0, (room - rect.width) / 2));
      moved = moved || Math.abs(sc.scrollLeft - before) > 0.5;
    }
  }
  return moved ? 'moved' : 'ok';
}

// ─────────────────────────────── 시트 보기 ───────────────────────────────

let modelSeq = 0;
const modelIds = new WeakMap<SheetModel, number>();
function modelId(m: SheetModel): number {
  let id = modelIds.get(m);
  if (id === undefined) {
    modelSeq += 1;
    id = modelSeq;
    modelIds.set(m, id);
  }
  return id;
}

export default function SheetView(props: SheetViewProps): JSX.Element {
  const { model, activePage, onActivePageChange, onPageElement, onRowsRendered, scrollToCell } = props;

  // 부모가 렌더마다 새 함수를 넘겨도 ref 콜백과 효과가 되풀이되지 않게 최신 콜백을 ref 로 읽는다.
  // useInsertionEffect 는 ref 가 붙기 전에 돌므로 새로 붙는 격자도 최신 콜백을 받는다.
  const cbs = useRef<Callbacks>({ onActivePageChange, onPageElement, onRowsRendered });
  useInsertionEffect(() => {
    cbs.current = { onActivePageChange, onPageElement, onRowsRendered };
  });

  const pages = Array.isArray(model.pages) ? model.pages : [];
  const page = pages.find((p) => p.pageNo === activePage) ?? pages[0];
  const curPage = page?.pageNo;
  const mid = modelId(model);
  const scrollMemo = useRef(new Map<string, ScrollPos>()).current;
  // 시트 탭과 격자(탭 패널)를 잇는 id
  const uid = useId();
  const panelId = `${uid}panel`;
  const tabId = (no: number): string => `${uid}tab${no}`;

  // 칸 이동: 다른 시트면 먼저 시트를 바꾸고, 그 시트 격자가 붙은 뒤 움직인다
  const [doneNonce, setDoneNonce] = useState<number | null>(null);
  const pending = scrollToCell && scrollToCell.nonce !== doneNonce ? scrollToCell : null;
  const pendingNonce = pending?.nonce;
  const pendingPage = pending?.pageNo;
  const pendingR = pending?.r ?? 0;
  const pendingC = pending?.c ?? 0;
  const pendingKnown = pendingPage !== undefined && pages.some((p) => p.pageNo === pendingPage);
  const curPageRef = useRef(curPage);
  useLayoutEffect(() => {
    curPageRef.current = curPage;
  });
  // 새 요청이 올 때만 시트를 바꿔 달라고 한다(시트가 바뀔 때마다 다시 조르지 않는다)
  useEffect(() => {
    if (pendingNonce === undefined || pendingPage === undefined) return;
    if (!pendingKnown) setDoneNonce(pendingNonce);
    else if (curPageRef.current !== pendingPage) cbs.current.onActivePageChange(pendingPage);
  }, [pendingNonce, pendingPage, pendingKnown]);
  // 이동이 끝나기 전에 사용자나 부모가 다른 시트로 옮기면 그 요청은 버린다(되돌려 끌고 가지 않는다)
  const prevPageRef = useRef(curPage);
  useEffect(() => {
    const prev = prevPageRef.current;
    prevPageRef.current = curPage;
    if (prev === curPage || pendingNonce === undefined) return;
    if (curPage !== pendingPage) setDoneNonce(pendingNonce);
  }, [curPage, pendingNonce, pendingPage]);
  const target = useMemo(
    () =>
      pendingNonce !== undefined && pendingKnown && pendingPage === curPage
        ? { r: pendingR, c: pendingC, nonce: pendingNonce }
        : null,
    [pendingNonce, pendingKnown, pendingPage, curPage, pendingR, pendingC],
  );
  const onTargetDone = useCallback((nonce: number) => setDoneNonce(nonce), []);

  // 시트 탭: 방향키로 옮기고, 고른 탭이 탭 줄 밖이면 보이게 민다
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const focusTab = useRef<number | null>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    const btn = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !btn) return;
    if (btn.offsetLeft < strip.scrollLeft) strip.scrollLeft = Math.max(0, btn.offsetLeft - 8);
    else if (btn.offsetLeft + btn.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = btn.offsetLeft + btn.offsetWidth - strip.clientWidth + 8;
    }
    if (focusTab.current === curPage) {
      btn.focus();
      focusTab.current = null;
    }
  }, [curPage]);
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const idx = pages.findIndex((p) => p.pageNo === curPage);
    let next = -1;
    if (e.key === 'ArrowRight') next = Math.min(pages.length - 1, idx + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = pages.length - 1;
    const no = pages[next]?.pageNo;
    if (no === undefined || next === idx) return;
    e.preventDefault();
    focusTab.current = no;
    cbs.current.onActivePageChange(no);
  };

  const note = page?.truncated
    ? (model.truncated ?? '이 시트는 앞부분만 보여 줍니다.')
    : pages.some((p) => p.truncated)
      ? null
      : model.truncated;

  return (
    <div className="osv-root">
      {page ? (
        <SheetGrid
          key={`${mid}:${page.pageNo}`}
          page={page}
          styles={Array.isArray(model.styles) ? model.styles : EMPTY_STYLES}
          cbs={cbs}
          scrollMemo={scrollMemo}
          memoKey={`${mid}:${page.pageNo}`}
          target={target}
          onTargetDone={onTargetDone}
          {...(pages.length > 1 ? { panel: { id: panelId, labelledBy: tabId(page.pageNo) } } : {})}
        />
      ) : (
        <p className="osv-empty">표시할 시트가 없습니다.</p>
      )}
      {pages.length > 1 || note ? (
        <div className="osv-foot">
          {pages.length > 1 ? (
            <div className="osv-tabs" role="tablist" aria-label="시트" ref={tabsRef} onKeyDown={onTabKey}>
              {pages.map((p) => {
                const on = p.pageNo === curPage;
                const name = typeof p.name === 'string' && p.name.trim() !== '' ? p.name : `시트 ${p.pageNo}`;
                return (
                  <button
                    key={p.pageNo}
                    type="button"
                    role="tab"
                    id={tabId(p.pageNo)}
                    aria-controls={panelId}
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    className={on ? 'chip is-on' : 'chip'}
                    title={name}
                    onClick={() => cbs.current.onActivePageChange(p.pageNo)}
                  >
                    <span className="osv-tab-label">{name}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {note ? (
            <span className="osv-note" role="note">
              {note}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
