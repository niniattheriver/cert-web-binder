/**
 * 흐름 문서(docx, hwpx) 렌더러: 서버가 만든 FlowModel(office/model.ts)만 React 로 그린다
 *
 * 원본 바이트는 브라우저에 오지 않는다. 이 컴포넌트는 props 의 순수 함수이고, 쪽마다 memo 한다.
 *
 * 렌더 불변식 (뷰어의 선택 → 정본 오프셋, 정본 오프셋 → 강조가 여기에 기댄다)
 * - 정본 글자 조각(o 가 있는 run)마다 data-o={o} 요소가 정확히 하나 있고, 그 요소의 자식은 t 와 길이가
 *   같은 글자 노드 하나뿐이다. 사설영역 글머리 기호만 같은 길이의 표준 글자로 바꿔 보인다(text-utils).
 * - 한 쪽 안에서 조각은 모델 순서대로 그리므로 DOM 순서와 o 순서가 같다.
 * - 머리말, 꼬리말, 빈 문단의 한 줄 높이, 번호 자리 묶음 같은 표시 전용 요소에는 data-o 가 없다.
 * - 빈 조각(t = '')은 그리지 않는다(글자가 없고, 같은 o 가 두 요소에 붙지 않게).
 *
 * 치수와 해석
 * - 모델 길이는 px(96dpi), 글자 크기는 pt 이므로 CSS 도 px, pt 로 그대로 쓴다.
 * - 줄 간격: linePx 가 있으면 그 px. 배수 m 은 CSS line-height m × 배율. 배율은 모델의 선택 필드
 *   lineScale(있으면), 없으면 LINE_SCALE(1.15). 워드의 배수는 '한 줄'(글꼴 높이) 기준이고 그 높이가 글꼴마다
 *   다르므로(맑은 고딕 1.73배, Arial 1.15배: 추출기 fontmetrics.ts) docx 추출기는 문단마다 linePx 를 싣는다.
 *   배율 1.15 는 linePx 가 없는 모델의 어림이다. 한글(hwpx)의 % 줄 간격은 글자 크기 기준이라 배율 1 이 맞다
 *   (실물 55개 미리보기 그림과 비교해 1.15 면 쪽이 약 11% 길어진다). hwpx 추출기가 lineScale 1 을 싣는다.
 * - linePx 문단(.ofv-lpx)의 글자 조각은 line-height 0 이다: 조각의 글꼴(없는 글꼴을 대신한 글꼴 포함)마다 위아래
 *   비율이 달라 기준선을 맞추면 줄 상자가 line-height 보다 커진다(PDF 짝에서 맑은 고딕 문단 안 Calibri 조각이
 *   줄마다 약 0.7pt 늘였다). 줄 높이는 문단 상자(strut)의 line-height 하나로 정해진다.
 * - 문단 간격: 앞 문단 아래 + 뒤 문단 위를 더한다(워드, 한글과 같게). 블록 목록을 flex 세로 배치로
 *   그려 CSS 여백 겹침(margin collapse)을 막는다.
 * - 테두리 상자 문단이 이어지면 한 상자로 잇는다(워드 방식, joinOf): 네 테두리가 같으면 사이 테두리를
 *   지우고, 추출기가 이미 묶은 꼴(뒤 문단에 위 테두리 없음)이면 그대로 둔다. 사이 간격은 안쪽 여백으로.
 * - 표 칸 테두리: 칸별 테두리(bt..bl)가 있으면 그것만, 없으면 border === true 일 때만 1px 실선.
 * - 내어쓰기(indent < 0) 문단의 앞쪽 번호 조각(lbl)은 너비가 내어쓰기 폭 이상인 inline-block 으로 묶어,
 *   번호 뒤 글자가 왼쪽 여백(marginLeft) 자리에서 시작한다. 묶음 안의 탭은 폭 0 이다(tab-size 0).
 *   묶음에는 안쪽 여백이 없다: 번호가 내어쓰기 폭 안에 들면 묶음 폭이 꼭 내어쓰기 폭이다. 번호가 폭보다
 *   길면 글자가 번호 바로 뒤에 붙는다(워드는 다음 탭 자리로 가지만 CSS 로는 그 갈림을 나타낼 수 없다).
 * - 표: border-collapse. 열 너비는 colWidths, 없으면 칸 너비(w)로 열 격자를 풀어 고정 배치한다. 칸 좌우 여백은
 *   테두리 반쪽만큼 덜어 글자 자리를 워드(여백을 칸 가장자리에서 잰다)와 같게 한다.
 *   앞쪽 머리글 행은 thead 로 묶는다. 다만 HTML 은 rowSpan 을 행 묶음(thead, tbody) 경계에서 잘라 뒤 칸을
 *   밀어 버리므로, 머리글 행의 세로 병합이 머리글 끝을 넘으면 thead 없이 한 tbody 로 그린다.
 * - 그림: width, height 속성과 같은 비율의 aspect-ratio 를 인라인으로 준다. 속성만 두면 비율이 auto 라
 *   그림이 오면 원래 비율로 높이를 다시 잡아, 워드나 한글이 늘이거나 줄인 그림의 높이가 틀어진다.
 *   칸보다 넓으면 max-width 로 줄고 높이는 모델 비율대로 따라간다.
 * - 쪽: 종이 크기(w, min-height h)와 여백(padding). 머리말은 위끝에서 headerDist, 꼬리말은 아래끝에서
 *   footerDist 자리에 두고, 머리말이 여백보다 길면 본문을 밀어낸다(워드와 같은 규칙).
 * - 화면 읽기 프로그램에는 쪽마다 이름 있는 묶음(role="group", aria-label)으로 쪽 경계를 알린다. 이름은
 *   pageLabel(있으면), 없으면 'N쪽'. 랜드마크가 아니라서 쪽이 많아도 랜드마크 목록을 채우지 않는다.
 * - 잘림 안내는 첫 쪽 위와 마지막 쪽 아래에 둔다(PlainView 와 같다): 끝까지 내려가지 않아도 보인다.
 */
import { memo, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import type {
  Border,
  FlowBlock,
  FlowBox,
  FlowImage,
  FlowModel,
  FlowPage,
  FlowPara,
  FlowTable,
  FlowTableCell,
  FlowTableRow,
  RunStyle,
} from './model';
import {
  borderCss,
  borderWidth,
  cropOf,
  cropPlacement,
  cssColor,
  cssFontStack,
  isSymbolFont,
  mapPuaText,
  num,
  round,
  sanitizeFont,
} from './text-utils';
import './flowview.css';

export interface FlowViewProps {
  model: FlowModel;
  /** media 색인 → 그림 주소 (/api/docs/versions/:vid/media/:index) */
  mediaUrl: (index: number) => string;
  /** 쪽 요소 등록/해제 (스크롤 이동, 보이는 쪽 추적용). 해제 때는 el = null */
  onPageElement?: (pageNo: number, el: HTMLElement | null) => void;
  /**
   * 쪽 묶음의 접근성 이름 (화면 읽기 프로그램용, 화면에는 보이지 않는다). 없으면 'N쪽'.
   * 앱의 쪽 표기와 맞추려면 (n) => pageRefLabel(fileKind, n, label) 을 넘긴다(hwpx 는 '구간 N').
   */
  pageLabel?: (pageNo: number) => string;
}

/** 배수 줄 간격 → CSS line-height 배율 (머리 주석 참고) */
export const LINE_SCALE = 1.15;
/** 모델에 기본 탭 간격이 없을 때 px */
const DEFAULT_TAB_PX = 48;
/** 쪽 테두리 px: 여백에서 빼서 글자 자리를 종이 기준 그대로 둔다 */
const PAGE_BORDER_PX = 1;
/** 문단 테두리와 글자 사이 [위아래, 좌우] px (워드 기본 1pt, 4pt 근사) */
const PARA_BORDER_PAD: [number, number] = [1, 5];
/** 칸 안쪽 여백 기본값 [위, 오른쪽, 아래, 왼쪽] px (워드 0, 5.4pt 와 한글 0.5mm, 1.8mm 사이) */
const DEFAULT_CELL_PAD: [number, number, number, number] = [1, 6, 1, 6];
/** 테두리 표시만 켜진 칸의 선 */
const DEFAULT_CELL_BORDER = '1px solid #000000';
/** 위/아래 첨자 글자 크기 비율 */
const SCRIPT_SCALE = 0.65;

/** 정본 조각(FlowRun)과 표시 전용 조각(FlowDisplayRun)을 함께 다루는 꼴 */
type AnyRun = RunStyle & { t: string; o?: number; sup?: true; sub?: true; bg?: string; lbl?: true };
type AnyBlock = FlowBlock<AnyRun>;
type AnyPara = FlowPara<AnyRun>;
type AnyTable = FlowTable<AnyRun>;
type AnyRow = FlowTableRow<AnyRun>;
type AnyCell = FlowTableCell<AnyRun>;
type AnyBox = FlowBox<AnyRun>;

interface Ctx {
  /** media 색인 → 주소 */
  urls: readonly string[];
  /** true: 표시 전용(머리말, 꼬리말)이라 data-o 를 달지 않는다 */
  display: boolean;
  /** 배수 줄 간격 → CSS line-height 배율 */
  lineScale: number;
}

const ALIGN_CSS: Record<string, CSSProperties['textAlign']> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
};

const VALIGN_CSS: Record<string, CSSProperties['verticalAlign']> = {
  top: 'top',
  middle: 'middle',
  bottom: 'bottom',
};

function isEmptyStyle(s: CSSProperties): boolean {
  for (const _ in s) return false;
  return true;
}

// ─────────────────────────────── 글자 조각 ───────────────────────────────

function runStyle(r: AnyRun, font: string | undefined, substituted: boolean): CSSProperties | undefined {
  const s: CSSProperties = {};
  if (r.b) s.fontWeight = 700;
  if (r.i) s.fontStyle = 'italic';
  const deco = `${r.u ? 'underline ' : ''}${r.strike ? 'line-through' : ''}`.trim();
  if (deco) s.textDecorationLine = deco;
  const sz = num(r.sz, 1, 400);
  if (sz !== undefined) s.fontSize = `${round(sz)}pt`;
  const color = cssColor(r.color);
  if (color) s.color = color;
  const bg = cssColor(r.bg);
  if (bg) s.backgroundColor = bg;
  // 기호 글꼴 글자를 표준 글자로 바꿨다면 그 글꼴은 빼고 공통 스택으로 그린다
  if (font && !(substituted && isSymbolFont(font))) s.fontFamily = cssFontStack(font);
  else if (font) s.fontFamily = cssFontStack(null);
  if (r.sup || r.sub) {
    s.fontSize = sz !== undefined ? `${round(sz * SCRIPT_SCALE)}pt` : `${SCRIPT_SCALE}em`;
    // vertical-align 대신 상대 위치: 줄 높이를 키우지 않는다
    s.position = 'relative';
    s.top = r.sup ? '-0.5em' : '0.25em';
  }
  return isEmptyStyle(s) ? undefined : s;
}

function runSpan(r: AnyRun, key: number, ctx: Ctx): ReactNode {
  const font = sanitizeFont(r.font);
  const text = mapPuaText(r.t, font);
  const style = runStyle(r, font, text !== r.t);
  const o = !ctx.display && typeof r.o === 'number' ? r.o : undefined;
  return (
    <span key={key} data-o={o} style={style}>
      {text}
    </span>
  );
}

/** 글자가 있는 조각만 (빈 조각은 그리지 않는다) */
function visibleRuns(p: AnyPara): AnyRun[] {
  const runs = Array.isArray(p.runs) ? p.runs : [];
  return runs.filter((r) => typeof r.t === 'string' && r.t.length > 0);
}

function renderRuns(runs: AnyRun[], hang: number, ctx: Ctx): ReactNode[] {
  let k = 0;
  while (k < runs.length && runs[k]!.lbl) k += 1;
  const out: ReactNode[] = [];
  if (k > 0 && hang > 0) {
    const label: ReactNode[] = [];
    for (let i = 0; i < k; i += 1) label.push(runSpan(runs[i]!, i, ctx));
    out.push(
      <span key="lbl" className="ofv-lbl" style={{ minWidth: hang }}>
        {label}
      </span>,
    );
  } else {
    k = 0;
  }
  for (let i = k; i < runs.length; i += 1) out.push(runSpan(runs[i]!, i, ctx));
  return out;
}

// ─────────────────────────────── 문단 ───────────────────────────────

/** 모든 조각이 같은 값을 가지면 그 값 (문단 기본 글자 모양이 없을 때 줄 높이 기준으로 쓴다) */
function commonFont(runs: AnyRun[]): string | undefined {
  let font: string | undefined;
  for (const r of runs) {
    const f = sanitizeFont(r.font);
    if (!f || (font !== undefined && f !== font)) return undefined;
    font = f;
  }
  return font;
}

/**
 * 첨자가 아닌 조각이 모두 크기를 가지면 그중 가장 작은 값. CSS 는 문단 글자 크기로 줄마다 최소
 * 높이(strut)를 잡으므로, 문단 기본 크기가 없을 때 이 값을 써야 작은 글자 문단이 앱 기본 크기만큼
 * 벌어지지 않는다. 크기 없는 조각이 하나라도 있으면 그 조각이 물려받을 값이므로 건드리지 않는다.
 */
function minRunSize(runs: AnyRun[]): number | undefined {
  let min: number | undefined;
  for (const r of runs) {
    if (r.sup || r.sub) continue;
    const sz = num(r.sz, 1, 400);
    if (sz === undefined) return undefined;
    min = min === undefined ? sz : Math.min(min, sz);
  }
  return min;
}

/** 줄 높이 px (모델 linePx, 범위 밖이면 없음) */
function lineHeightPx(p: AnyPara): number | undefined {
  return num(p.linePx, 1, 2000);
}

function lineHeightCss(p: AnyPara, scale: number): string | number | undefined {
  const px = lineHeightPx(p);
  if (px !== undefined) return `${round(px)}px`;
  const m = num(p.lineHeight, 0.1, 20);
  if (m !== undefined) return round(m * scale, 3);
  return undefined;
}

function sameBorder(a: Border | undefined, b: Border | undefined): boolean {
  if (!a || !b) return a === b;
  return a.w === b.w && a.style === b.style && a.color === b.color;
}

/** 이웃 문단과 한 테두리 상자로 이을 때: none 은 따로, keep 은 테두리 그대로, merge 는 사이 테두리를 지운다 */
type Join = 'none' | 'keep' | 'merge';

/**
 * 테두리 상자 잇기 (워드는 테두리 설정이 같은 연속 문단을 한 상자로 그린다)
 * - merge: 네 테두리가 모두 같은 문단이 이어진 모델(추출기가 묶지 않은 꼴). 사이 위/아래 테두리를 지운다.
 * - keep: 추출기가 이미 묶은 꼴(뒤 문단에 위 테두리가 없고 좌우 테두리가 같다). 앞 문단의 아래 테두리는
 *   사이 선(between)이거나 없으므로 그대로 둔다.
 * 어느 쪽이든 사이 간격은 안쪽 여백으로 옮겨 좌우 테두리와 음영이 끊기지 않게 한다.
 */
function joinOf(a: AnyBlock | undefined, b: AnyBlock | undefined): Join {
  if (!a || !b || a.type !== 'p' || b.type !== 'p') return 'none';
  if (
    !sameBorder(a.bl, b.bl) ||
    !sameBorder(a.br, b.br) ||
    cssColor(a.bg) !== cssColor(b.bg) ||
    (num(a.marginLeft) ?? 0) !== (num(b.marginLeft) ?? 0) ||
    (num(a.marginRight) ?? 0) !== (num(b.marginRight) ?? 0)
  ) {
    return 'none';
  }
  if (a.bb && b.bt) return sameBorder(a.bt, b.bt) && sameBorder(a.bb, b.bb) ? 'merge' : 'none';
  if (!b.bt && (a.bl || a.br)) return 'keep';
  return 'none';
}

function paraStyle(p: AnyPara, runs: AnyRun[], prev: Join, next: Join, lineScale: number): CSSProperties {
  const s: CSSProperties = {};
  const joinPrev = prev !== 'none';
  const joinNext = next !== 'none';
  const align = ALIGN_CSS[p.align ?? ''];
  if (align && align !== 'left') s.textAlign = align;

  let ml = num(p.marginLeft) ?? 0;
  let mr = num(p.marginRight) ?? 0;
  let padT = 0;
  let padB = 0;
  let padL = 0;
  let padR = 0;
  const before = Math.max(0, num(p.spaceBefore) ?? 0);
  const after = Math.max(0, num(p.spaceAfter) ?? 0);

  // 테두리: 글자 자리는 그대로 두고 테두리와 안쪽 여백을 바깥(여백 쪽)으로 민다
  const [padY, padX] = PARA_BORDER_PAD;
  const bt = prev === 'merge' ? undefined : borderCss(p.bt);
  const bb = next === 'merge' ? undefined : borderCss(p.bb);
  const bl = borderCss(p.bl);
  const br = borderCss(p.br);
  if (bt) {
    s.borderTop = bt;
    padT += padY;
  }
  if (bb) {
    s.borderBottom = bb;
    padB += padY;
  }
  if (bl) {
    s.borderLeft = bl;
    padL += padX;
    ml -= padX + borderWidth(p.bl);
  }
  if (br) {
    s.borderRight = br;
    padR += padX;
    mr -= padX + borderWidth(p.br);
  }
  const bg = cssColor(p.bg);
  if (bg) s.backgroundColor = bg;

  // 이어진 상자 안의 간격은 안쪽 여백으로 (테두리, 음영이 끊기지 않게)
  if (joinPrev) padT += before;
  else if (before > 0) s.marginTop = round(before);
  if (joinNext) padB += after;
  else if (after > 0) s.marginBottom = round(after);
  if (padT > 0) s.paddingTop = round(padT);
  if (padB > 0) s.paddingBottom = round(padB);
  if (padL > 0) s.paddingLeft = round(padL);
  if (padR > 0) s.paddingRight = round(padR);
  if (ml !== 0) s.marginLeft = round(ml);
  if (mr !== 0) s.marginRight = round(mr);

  const indent = num(p.indent);
  if (indent !== undefined && indent !== 0) s.textIndent = round(indent);
  const lh = lineHeightCss(p, lineScale);
  if (lh !== undefined) s.lineHeight = lh;

  const sz = num(p.sz, 1, 400) ?? minRunSize(runs);
  if (sz !== undefined) s.fontSize = `${round(sz)}pt`;
  const font = sanitizeFont(p.font) ?? commonFont(runs);
  if (font) s.fontFamily = cssFontStack(isSymbolFont(font) ? null : font);
  return s;
}

function renderPara(p: AnyPara, key: number, ctx: Ctx, prev: Join, next: Join): ReactNode {
  const runs = visibleRuns(p);
  const style = paraStyle(p, runs, prev, next, ctx.lineScale);
  const hang = Math.max(0, -(num(p.indent) ?? 0));
  const empty = runs.length === 0;
  // 줄 높이 px 문단은 글자 조각이 줄 상자를 키우지 않게 한다(flowview.css .ofv-lpx, 머리 주석)
  const cls = `ofv-p${empty ? ' ofv-empty' : ''}${lineHeightPx(p) !== undefined ? ' ofv-lpx' : ''}`;
  return (
    <div key={key} className={cls} style={isEmptyStyle(style) ? undefined : style}>
      {empty ? null : renderRuns(runs, hang, ctx)}
    </div>
  );
}

// ─────────────────────────────── 표 ───────────────────────────────

/**
 * 표 열 너비: colWidths, 없으면 칸 너비(w)와 병합 정보로 열 격자를 푼다. 모르면 null(자동 배치).
 * 행의 칸이 colWidths 보다 많은 열을 차지하면 모자란 열은 평균 너비로 채운다(고정 배치에서 폭 0 이 되지 않게).
 */
function tableColumns(t: AnyTable): number[] | null {
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const placed: { col: number; span: number; w: number | undefined }[] = [];
  const busy: number[] = []; // 열별: 위 행의 rowSpan 이 몇 행 더 차지하는가
  let ncols = 0;
  for (const row of rows) {
    let col = 0;
    for (const cell of row.cells ?? []) {
      while ((busy[col] ?? 0) > 0) col += 1;
      const span = Math.max(1, Math.floor(num(cell.colSpan, 1, 1000) ?? 1));
      const rs = Math.max(1, Math.floor(num(cell.rowSpan, 1, 10000) ?? 1));
      placed.push({ col, span, w: num(cell.w, 1, 20000) });
      for (let c = col; c < col + span; c += 1) busy[c] = Math.max(busy[c] ?? 0, rs);
      col += span;
      ncols = Math.max(ncols, col);
    }
    for (let c = 0; c < busy.length; c += 1) if ((busy[c] ?? 0) > 0) busy[c] = busy[c]! - 1;
  }
  const given = Array.isArray(t.colWidths) ? t.colWidths : [];
  if (given.length > 0 && given.every((w) => num(w, 0, 20000) !== undefined) && given.some((w) => w > 0)) {
    const cols = given.map((w) => round(w));
    if (ncols > cols.length && ncols <= 1000) {
      const avg = round(cols.reduce((a, b) => a + b, 0) / cols.length);
      while (cols.length < ncols) cols.push(avg);
    }
    return cols;
  }
  if (ncols === 0 || ncols > 1000 || !placed.some((p) => p.w !== undefined)) return null;
  const widths: (number | undefined)[] = new Array<number | undefined>(ncols).fill(undefined);
  for (const p of placed) if (p.span === 1 && p.w !== undefined && widths[p.col] === undefined) widths[p.col] = p.w;
  // 여러 열에 걸친 칸: 모르는 열에 남은 너비를 고르게 나눈다 (몇 차례 되풀이)
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const p of placed) {
      if (p.w === undefined || p.span === 1) continue;
      let known = 0;
      const unknown: number[] = [];
      for (let c = p.col; c < p.col + p.span && c < ncols; c += 1) {
        const w = widths[c];
        if (w === undefined) unknown.push(c);
        else known += w;
      }
      if (unknown.length === 0 || p.w - known <= 0) continue;
      const each = (p.w - known) / unknown.length;
      for (const c of unknown) widths[c] = each;
      changed = true;
    }
    if (!changed) break;
  }
  const knownW = widths.filter((w): w is number => w !== undefined);
  const fill = knownW.length > 0 ? knownW.reduce((a, b) => a + b, 0) / knownW.length : 48;
  return widths.map((w) => round(w ?? fill));
}

function cellPad(cell: AnyCell): [number, number, number, number] {
  const p = cell.pad;
  if (Array.isArray(p) && p.length === 4 && p.every((v) => num(v, 0, 500) !== undefined)) {
    return [p[0], p[1], p[2], p[3]];
  }
  return DEFAULT_CELL_PAD;
}

function cellStyle(cell: AnyCell, pad: [number, number, number, number]): CSSProperties {
  // 접힌 테두리(border-collapse)는 테두리 반쪽을 칸 안쪽에서 뺀다. 워드는 칸 여백을 칸 가장자리에서 재므로 좌우
  // 여백에서 테두리 반쪽을 덜어 글자 자리를 워드와 같게 한다(PDF 짝: 열 너비에 꼭 맞는 세 글자 이름이 두 줄로 갈렸다)
  const own = Boolean(cell.bt || cell.br || cell.bb || cell.bl);
  const half = (b: Border | undefined): number => (own ? borderWidth(b) : cell.border === true ? 1 : 0) / 2;
  const left = Math.max(0, pad[3] - half(cell.bl));
  const right = Math.max(0, pad[1] - half(cell.br));
  const s: CSSProperties = {
    padding: `${round(pad[0])}px ${round(right)}px ${round(pad[2])}px ${round(left)}px`,
  };
  const va = VALIGN_CSS[cell.va ?? ''];
  if (va && va !== 'top') s.verticalAlign = va;
  const bg = cssColor(cell.bg);
  if (bg) s.backgroundColor = bg;
  if (cell.bt || cell.br || cell.bb || cell.bl) {
    s.borderTop = borderCss(cell.bt) ?? 'none';
    s.borderRight = borderCss(cell.br) ?? 'none';
    s.borderBottom = borderCss(cell.bb) ?? 'none';
    s.borderLeft = borderCss(cell.bl) ?? 'none';
  } else if (cell.border === true) {
    // 칸별 테두리 없이 표시 여부만 있는 칸 (없으면 테두리 없음: 추출기가 칸별 테두리를 다 풀어 준다)
    s.border = DEFAULT_CELL_BORDER;
  }
  return s;
}

/** 행 높이 고정(exact)인 행에만 걸친 칸은 넘치는 글자를 자른다: 그 높이 합에서 위아래 여백을 뺀 값 */
function cellClip(rows: AnyRow[], r: number, rowSpan: number, pad: [number, number, number, number]): number | undefined {
  let sum = 0;
  for (let i = r; i < r + rowSpan; i += 1) {
    const row = rows[i];
    if (!row) break;
    const h = num(row.h, 1, 5000);
    if (row.hRule !== 'exact' || h === undefined) return undefined;
    sum += h;
  }
  const clip = sum - pad[0] - pad[2];
  return clip > 0 ? round(clip) : undefined;
}

function renderRow(rows: AnyRow[], r: number, ctx: Ctx): ReactNode {
  const row = rows[r]!;
  const h = num(row.h, 1, 5000);
  const cells = Array.isArray(row.cells) ? row.cells : [];
  return (
    <tr key={r} style={h !== undefined ? { height: round(h) } : undefined}>
      {cells.map((cell, c) => {
        const colSpan = Math.max(1, Math.floor(num(cell.colSpan, 1, 1000) ?? 1));
        const rowSpan = Math.max(1, Math.floor(num(cell.rowSpan, 1, 10000) ?? 1));
        const pad = cellPad(cell);
        const clip = cellClip(rows, r, rowSpan, pad);
        return (
          <td
            key={c}
            colSpan={colSpan > 1 ? colSpan : undefined}
            rowSpan={rowSpan > 1 ? rowSpan : undefined}
            style={cellStyle(cell, pad)}
          >
            <div className="ofv-cell" style={clip !== undefined ? { maxHeight: clip, overflow: 'hidden' } : undefined}>
              {renderBlocks(cell.blocks, ctx)}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

/** 앞쪽 headN 행 안의 칸 중 rowSpan 이 headN 행을 넘어 내려가는 칸이 있는가 */
function spanCrosses(rows: AnyRow[], headN: number): boolean {
  for (let r = 0; r < headN; r += 1) {
    const cells = Array.isArray(rows[r]?.cells) ? rows[r]!.cells : [];
    for (const cell of cells) {
      const rs = Math.max(1, Math.floor(num(cell.rowSpan, 1, 10000) ?? 1));
      if (r + rs > headN) return true;
    }
  }
  return false;
}

function renderTable(t: AnyTable, key: number, ctx: Ctx): ReactNode {
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const cols = tableColumns(t);
  const colSum = cols ? round(cols.reduce((a, b) => a + b, 0)) : 0;
  const width = num(t.width, 1, 20000) ?? (cols && colSum > 0 ? colSum : undefined);
  const s: CSSProperties = { width: width !== undefined ? round(width) : '100%' };
  if (cols) s.tableLayout = 'fixed';
  if (t.align === 'center') {
    s.marginLeft = 'auto';
    s.marginRight = 'auto';
  } else if (t.align === 'right') {
    s.marginLeft = 'auto';
  } else {
    const indent = num(t.indent);
    if (indent !== undefined && indent !== 0) s.marginLeft = round(indent);
  }
  // 앞쪽의 연속 머리글 행은 thead (인쇄할 때 쪽마다 되풀이). 머리글 행의 세로 병합이 머리글 끝을 넘으면
  // thead 를 두지 않는다: HTML 은 rowSpan 을 행 묶음 경계에서 잘라 아래 행 칸을 한 칸씩 당긴다
  let headN = 0;
  while (headN < rows.length && rows[headN]!.header) headN += 1;
  if (headN > 0 && spanCrosses(rows, headN)) headN = 0;
  const body: ReactNode[] = [];
  const head: ReactNode[] = [];
  for (let r = 0; r < rows.length; r += 1) (r < headN ? head : body).push(renderRow(rows, r, ctx));
  return (
    <table key={key} className="ofv-table" style={s}>
      {cols ? (
        <colgroup>
          {cols.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
      ) : null}
      {head.length > 0 ? <thead>{head}</thead> : null}
      {body.length > 0 ? <tbody>{body}</tbody> : null}
    </table>
  );
}

// ─────────────────────────────── 그림, 글상자 ───────────────────────────────

/** 그림 가로 정렬: 흐름 상자(.ofv-img 는 flex 항목) 안에서 align-self 로 */
function imgAlignStyle(align: unknown): CSSProperties | undefined {
  if (align === 'center') return { alignSelf: 'center' };
  if (align === 'right') return { alignSelf: 'flex-end' };
  return undefined;
}

function renderImage(b: FlowImage, key: number, ctx: Ctx): ReactNode {
  const w = num(b.w, 1, 20000);
  const h = num(b.h, 1, 20000);
  const url = Number.isInteger(b.media) && b.media >= 0 ? ctx.urls[b.media] : undefined;
  if (!url || w === undefined || h === undefined) {
    // 그릴 수 없는 그림: 자리만 (표시 전용)
    return <div key={key} className="ofv-img-missing" style={{ width: round(w ?? 48), height: round(h ?? 48) }} />;
  }
  const iw = Math.max(1, Math.round(w));
  const ih = Math.max(1, Math.round(h));
  const crop = cropOf(b.crop);
  if (crop) {
    // 잘라 낸 그림: 틀(잘라 낸 뒤 크기, 칸보다 넓으면 줄어든다) 안에서 원본을 키워 밀어 그린다(text-utils cropPlacement)
    return (
      <div key={key} className="ofv-img" style={imgAlignStyle(b.align)}>
        <div className="ofv-crop" style={{ width: iw, aspectRatio: `${iw} / ${ih}` }}>
          <img src={url} style={cropPlacement(crop)} alt="" draggable={false} />
        </div>
      </div>
    );
  }
  // 비율을 속성과 같게 고정한다(머리 주석): CSS height: auto 가 그림 원래 비율을 쓰지 않게
  return (
    <div key={key} className="ofv-img" style={imgAlignStyle(b.align)}>
      <img src={url} width={iw} height={ih} style={{ aspectRatio: `${iw} / ${ih}` }} alt="" draggable={false} />
    </div>
  );
}

function renderBox(b: AnyBox, key: number, ctx: Ctx): ReactNode {
  const w = num(b.w, 1, 20000);
  const s: CSSProperties = {};
  if (w !== undefined) {
    s.width = round(w);
    s.alignSelf = 'flex-start';
  }
  if (b.border === false) s.border = 'none';
  return (
    <div key={key} className="ofv-box" style={isEmptyStyle(s) ? undefined : s}>
      {renderBlocks(b.blocks, ctx)}
    </div>
  );
}

// ─────────────────────────────── 블록 목록 ───────────────────────────────

function renderBlocks(blocks: readonly AnyBlock[] | undefined, ctx: Ctx): ReactNode[] {
  if (!Array.isArray(blocks)) return [];
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    switch (b.type) {
      case 'p':
        out.push(renderPara(b, i, ctx, joinOf(blocks[i - 1], b), joinOf(b, blocks[i + 1])));
        break;
      case 'table':
        out.push(renderTable(b, i, ctx));
        break;
      case 'img':
        out.push(renderImage(b, i, ctx));
        break;
      case 'box':
        out.push(renderBox(b, i, ctx));
        break;
      default:
        break; // 모르는 블록(이후 판의 모델): 그리지 않는다
    }
  }
  return out;
}

// ─────────────────────────────── 쪽 ───────────────────────────────

interface PageGeometry {
  style: CSSProperties;
  /** 머리말, 꼬리말 칸의 최소 높이 (여백 안 자리) */
  headerMin: number;
  footerMin: number;
}

function pageGeometry(page: FlowPage, hasHeader: boolean, hasFooter: boolean): PageGeometry {
  const w = num(page.w, 50, 20000) ?? 794;
  const h = num(page.h, 50, 40000) ?? 1123;
  const m = Array.isArray(page.margin) ? page.margin : [];
  const side = (v: unknown, dim: number): number => Math.min(num(v, 0, 20000) ?? 0, dim / 2);
  const mt = side(m[0], h);
  const mr = side(m[1], w);
  const mb = side(m[2], h);
  const ml = side(m[3], w);
  const hd = hasHeader ? Math.min(num(page.headerDist, 0, 20000) ?? Math.min(48, mt / 2), mt) : mt;
  const fd = hasFooter ? Math.min(num(page.footerDist, 0, 20000) ?? Math.min(48, mb / 2), mb) : mb;
  const b = PAGE_BORDER_PX;
  return {
    style: {
      width: round(w),
      minHeight: round(h),
      paddingTop: round(Math.max(0, hd - b)),
      paddingRight: round(Math.max(0, mr - b)),
      paddingBottom: round(Math.max(0, fd - b)),
      paddingLeft: round(Math.max(0, ml - b)),
    },
    headerMin: round(Math.max(0, mt - hd)),
    footerMin: round(Math.max(0, mb - fd)),
  };
}

interface PageViewProps {
  page: FlowPage;
  urls: readonly string[];
  lineScale: number;
  /** 쪽 묶음의 접근성 이름 */
  label: string;
  onPageElement?: (pageNo: number, el: HTMLElement | null) => void;
}

const PageView = memo(function PageView({ page, urls, lineScale, label, onPageElement }: PageViewProps): JSX.Element {
  const pageNo = page.pageNo;
  const ref = useCallback(
    (el: HTMLElement | null) => {
      onPageElement?.(pageNo, el);
    },
    [onPageElement, pageNo],
  );
  // 쪽 내용은 쪽 모델, 그림 주소, 줄 간격 배율에만 기댄다: 등록 콜백이 바뀌어도 다시 그리지 않는다
  const content = useMemo(() => {
    const header = Array.isArray(page.header) && page.header.length > 0 ? page.header : null;
    const footer = Array.isArray(page.footer) && page.footer.length > 0 ? page.footer : null;
    const geo = pageGeometry(page, header !== null, footer !== null);
    const shown: Ctx = { urls, display: true, lineScale };
    const canon: Ctx = { urls, display: false, lineScale };
    return {
      style: geo.style,
      children: (
        <>
          {header ? (
            <div className="ofv-hdr" style={{ minHeight: geo.headerMin }}>
              {renderBlocks(header, shown)}
            </div>
          ) : null}
          <div className="ofv-body">{renderBlocks(page.blocks, canon)}</div>
          {footer ? (
            <div className="ofv-ftr" style={{ minHeight: geo.footerMin }}>
              {renderBlocks(footer, shown)}
            </div>
          ) : null}
        </>
      ),
    };
  }, [page, urls, lineScale]);
  return (
    <section ref={ref} className="ofv-page" data-page={pageNo} role="group" aria-label={label} style={content.style}>
      {content.children}
    </section>
  );
});

/** 쪽 묶음 이름: pageLabel 이 빈 글자가 아닌 값을 주면 그것, 아니면 'N쪽' */
function pageName(pageNo: number, pageLabel: FlowViewProps['pageLabel']): string {
  const s = pageLabel?.(pageNo);
  return typeof s === 'string' && s.trim() !== '' ? s : `${pageNo}쪽`;
}

export default function FlowView({ model, mediaUrl, onPageElement, pageLabel }: FlowViewProps): JSX.Element {
  const media = Array.isArray(model.media) ? model.media : [];
  const list = media.map((_, i) => mediaUrl(i));
  const signature = list.join('\n');
  // 주소 내용이 같으면 같은 배열을 넘겨 쪽 memo 를 살린다(mediaUrl 이 렌더마다 새 함수여도)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const urls = useMemo(() => list, [signature]);
  const tab = num(model.defaultTab, 4, 2000) ?? DEFAULT_TAB_PX;
  // 배수 줄 간격(lineHeight) → CSS line-height 배율: 모델 값(hwpx 는 1), 없으면 LINE_SCALE (머리 주석)
  const lineScale = num(model.lineScale, 0.5, 3) ?? LINE_SCALE;
  const pages = Array.isArray(model.pages) ? model.pages : [];
  const trunc = typeof model.truncated === 'string' && model.truncated !== '' ? model.truncated : null;
  // translate="no": 브라우저 자동 번역이 글자 노드를 갈아 끼우면 오프셋 대응이 깨지므로 막는다
  return (
    <div className="ofv-flow" translate="no" style={{ tabSize: `${round(tab)}px` }}>
      {trunc ? (
        <p className="ofv-note ofv-trunc ofv-trunc-top" role="note">
          {trunc}
        </p>
      ) : null}
      {pages.map((page) => (
        <PageView
          key={page.pageNo}
          page={page}
          urls={urls}
          lineScale={lineScale}
          label={pageName(page.pageNo, pageLabel)}
          onPageElement={onPageElement}
        />
      ))}
      {pages.length === 0 ? <p className="ofv-note">표시할 쪽이 없습니다.</p> : null}
      {trunc && pages.length > 0 ? (
        <p className="ofv-note ofv-trunc ofv-trunc-end" role="note">
          {trunc}
        </p>
      ) : null}
    </div>
  );
}
