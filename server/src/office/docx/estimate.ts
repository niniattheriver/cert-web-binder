/**
 * Word 쪽 정보가 모자란 쪽의 쪽 나눔 추정
 *
 * 왜 필요한가 (실물 88개 docx, 그중 PDF 짝 7개로 확인)
 * - Word 는 쪽 첫 줄에 w:lastRenderedPageBreak 를 적지만 늘 적지는 않는다. ① 첫 줄이 글자 조각이 없는 빈
 *   문단이거나 빈 표 행이면 적을 자리가 없다. ② 긴 표 안에서는 쪽이 바뀌어도 적지 않은 경우가 있었다.
 *   ③ 앞 몇 쪽에만 적고 나머지는 적지 않은 문서가 많다(쪽 나눔 계산을 다 끝내기 전에 저장한 듯).
 * - 그래서 표지(lrpb)만으로 나누면 쪽 수가 모자라고 한 쪽이 몇 쪽 분량이 된다.
 *
 * 방법
 * - 블록 높이를 어림한다: 문단 = 앞뒤 간격 + 줄 수 x 줄 높이(글자 너비로 줄 수를 어림), 표 = 행 높이 합
 *   (칸 내용 높이 + 안쪽 여백, 행 높이 규칙, 세로 병합 반영), 그림 = 높이. 쪽에 들어갈 높이 = 용지 높이 -
 *   위/아래 여백(머리말/꼬리말이 더 크면 그만큼 밀린다).
 * - 목표 쪽 수: docProps/app.xml 의 <Pages>(Word 가 저장할 때 센 쪽 수, PDF 짝 6개에서 PDF 쪽 수와 모두 같았다)가
 *   표지로 나눈 쪽 수보다 크면, 높이 배율 a 를 찾아 '넘치는 쪽을 앞에서부터 채워 가르기'의 결과가 그 수가
 *   되게 한다. 쪽 수는 Word 와 같아지고 경계 자리만 어림이다.
 *   배율은 그 수가 나오는 구간에서 1(어림 그대로)에 가장 가까운 값을 쓴다(구간 맨 끝 값을 쓰면 경계가 쪽
 *   끝으로 쏠린다). 표지만으로 쪽 수가 이미 같거나 많으면 표지를 그대로 믿는다.
 *   그럴듯한 쪽만 가른다: 배율 1 에서 거의 찬 쪽(SPLIT_FLOOR)만, 배율은 MAX_SCALE 까지. 그 안에서 닿지 못하는
 *   쪽 수는 쫓지 않는다(evenPage/oddPage 구역 앞의 빈 쪽은 미리 빼고 비교한다).
 * - <Pages> 가 없거나 1(세지 않은 문서)이면 쪽마다 floor(어림 비율 + 0.35) 쪽으로 가른다(1.65쪽 분량부터).
 *   쪽 수를 다 맞춘 문서들에서 Word 가 자연스럽게 넘긴 쪽의 어림 비율 중앙값은 0.96 이었다.
 * - 가르는 자리는 최상위 블록 사이, 표는 행 사이(머리글 행 되풀이). keepNext 문단은 다음 블록과 함께 넘긴다.
 */
import type { IRBlock, IRCell, IRPara, IRRow, IRTable, SectInfo } from './ir.js';
import { leadingHeaders, type PageIR } from './paginate.js';

const PT_PX = 96 / 72;
const DEFAULT_PT = 10;
const MIN_SCALE = 0.05;
/**
 * 목표 쪽 수를 맞출 때 쓸 수 있는 가장 큰 높이 배율. 실물 48개 문서가 쓴 배율은 0.51-1.04 였다. 그보다 크게
 * 부풀려야만 맞는 쪽 수는 넘치는 쪽 때문이 아니라고 보고(Word 가 넣은 빈 쪽, 낡은 app.xml 등) 쫓지 않는다.
 */
const MAX_SCALE = 1.5;
/**
 * 목표 쪽 수를 맞출 때 가를 수 있는 쪽: 어림 비율(배율 1)이 이 값 이상인 쪽만. 실물에서 가른 쪽 93개의 비율은
 * 모두 0.98 이상이었다. 이 값과 MAX_SCALE 이 없으면 34% 찬 쪽도 갈라 한 줄짜리 쪽이 생겼다.
 */
const SPLIT_FLOOR = 0.9;
/**
 * 목표 쪽 수가 없을 때 한 쪽을 몇 쪽으로 가를지: floor(어림 비율 + 이 값). 1.65쪽 분량부터 가른다
 * (Word 가 한 쪽에 담은 쪽의 어림 비율이 실물에서 1.3 까지 나왔다)
 */
const UNKNOWN_ROUND = 0.35;
/** 합칠 만큼 작은 쪽 (어림 비율) */
const TINY_PAGE = 0.35;
/** 어림 높이의 기본 배율(사전값): Word 가 자연스럽게 넘긴 쪽의 어림 비율 중앙값이 0.96 이었다 */
const PRIOR_SCALE = 1;

export interface EstimateCtx {
  sections: SectInfo[];
  /** docProps/app.xml <Pages> */
  appPages: number | undefined;
  /** 머리말/꼬리말이 본문을 밀어내는 효과를 넣은 위, 아래 여백 px */
  chrome: (sect: number, first: boolean) => { top: number; bottom: number };
  /** 기본 탭 간격 px */
  tab: number;
}

export interface EstimateResult {
  pages: PageIR[];
  mode: 'none' | 'target' | 'calibrated' | 'merged';
  /** 쓴 높이 배율 (진단용) */
  scale: number;
}

// ─────────────────────────────── 높이 어림 ───────────────────────────────

/**
 * 글꼴별 Word '한 줄' 높이 / 글자 크기. 맑은 고딕은 Word 에서 줄 간격이 유난히 넓다: PDF 짝 7개의 10pt 본문
 * 줄 간격이 글자 크기의 1.95-2.0배였고 그 문단들의 줄 간격 배수가 1.15 였다(1.71 = 1.97 / 1.15).
 */
function lineFactor(font: string | undefined): number {
  if (!font) return 1.2;
  if (/맑은|malgun/i.test(font)) return 1.71;
  if (/calibri/i.test(font)) return 1.22;
  if (/나눔|nanum/i.test(font)) return 1.45;
  if (/함초롬|hcr/i.test(font)) return 1.4;
  return 1.17;
}

/** 좁은 문장 부호 . , : ; ! ' | */
const NARROW = new Set([0x2e, 0x2c, 0x3a, 0x3b, 0x21, 0x27, 0x7c]);
/** 중간 폭 ( ) [ ] - / */
const MEDIUM = new Set([0x28, 0x29, 0x5b, 0x5d, 0x2d, 0x2f]);

/** 글자 하나의 너비 (em). 한글 글꼴(맑은 고딕 등)의 대략값 */
function charEm(code: number): number {
  if (code === 0x20 || code === 0xa0) return 0.27;
  if (code >= 0x30 && code <= 0x39) return 0.56;
  if (code >= 0x41 && code <= 0x5a) return 0.62;
  if (code >= 0x61 && code <= 0x7a) return 0.5;
  if (NARROW.has(code)) return 0.25;
  if (MEDIUM.has(code)) return 0.33;
  if (code < 0x80) return 0.55;
  if (code >= 0xac00 && code <= 0xd7a3) return 0.94;
  if (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return 1;
  }
  return 0.6;
}

export class HeightCache {
  private readonly block = new Map<IRBlock, number>();
  private readonly rows = new Map<IRTable, number[]>();

  constructor(private readonly tab: number) {}

  list(blocks: IRBlock[], width: number): number {
    let h = 0;
    for (const b of blocks) h += this.of(b, width);
    return h;
  }

  of(b: IRBlock, width: number): number {
    const hit = this.block.get(b);
    if (hit !== undefined) return hit;
    const h = b.k === 'p' ? this.para(b, width) : this.rowHeights(b, width).reduce((s, x) => s + x, 0);
    this.block.set(b, h);
    return h;
  }

  private para(p: IRPara, width: number): number {
    if (p.hidden) return 0;
    const props = p.props;
    const basePt = props.sz ?? DEFAULT_PT;
    let natural = lineFactor(props.font) * basePt * PT_PX;
    let hasText = false;
    for (const it of p.items) {
      if (it.k === 't') {
        natural = Math.max(natural, lineFactor(it.s.font ?? props.font) * (it.s.sz ?? basePt) * PT_PX);
        if (/\S/.test(it.t)) hasText = true;
      }
    }
    const lineH = props.linePx ?? (props.lineHeight ?? 1) * natural;
    const avail = Math.max(24, width - (props.marginLeft ?? 0) - (props.marginRight ?? 0));
    let lines = 0;
    let x = Math.max(0, props.indent ?? 0);
    let images = 0;
    let inlineImages = 0;
    for (const it of p.items) {
      if (it.k === 't') {
        const px = (it.s.sz ?? basePt) * PT_PX;
        for (let i = 0; i < it.t.length; i += 1) {
          const code = it.t.charCodeAt(i);
          if (code === 0x0a) {
            lines += Math.max(1, Math.ceil(x / avail));
            x = 0;
          } else if (code === 0x09) {
            x = (Math.floor(x / this.tab) + 1) * this.tab;
          } else {
            x += charEm(code) * px;
          }
        }
      } else if (it.k === 'img' && it.flow) {
        images += it.h;
        if (it.inline) inlineImages += 1;
      }
    }
    lines += Math.max(1, Math.ceil(x / avail));
    // 글자 안 그림은 자기 줄을 차지한다(그 줄 높이 = 그림 높이)
    const textH = !hasText && images > 0 ? 0 : Math.max(0, lines - Math.min(inlineImages, 1)) * lineH;
    return (props.spaceBefore ?? 0) + (props.spaceAfter ?? 0) + textH + images;
  }

  /** 표 행 높이 (세로 병합 칸은 병합 범위의 마지막 행에 모자란 높이를 더한다) */
  rowHeights(t: IRTable, width: number): number[] {
    const hit = this.rows.get(t);
    if (hit) return hit;
    let ncols = t.colWidths?.length ?? 0;
    for (const row of t.rows) for (const c of row.cells) ncols = Math.max(ncols, c.col + c.span);
    const gridW = t.colWidths?.reduce((s, x) => s + x, 0) ?? 0;
    const scale = gridW > 0 && t.width ? t.width / gridW : 1;
    const colW = (c: IRCell): number => {
      if (t.colWidths && t.colWidths.length >= c.col + c.span) {
        let w = 0;
        for (let k = c.col; k < c.col + c.span; k += 1) w += t.colWidths[k]!;
        return w * scale;
      }
      return c.w ?? (width / Math.max(1, ncols)) * c.span;
    };
    const cellH = (c: IRCell): number => {
      const pad = c.pad ?? [0, 7.2, 0, 7.2];
      return pad[0] + pad[2] + this.list(c.blocks, Math.max(12, colW(c) - pad[1] - pad[3]));
    };
    const hs = t.rows.map((row) => {
      let h = 0;
      for (const c of row.cells) {
        if (c.filler || c.vm) continue;
        h = Math.max(h, cellH(c));
      }
      if (row.h !== undefined) h = row.hRule === 'exact' ? row.h : Math.max(h, row.h);
      return Math.max(h, 8) + 1;
    });
    t.rows.forEach((row, r) => {
      for (const c of row.cells) {
        if (!c.vm || c.filler) continue;
        if (c.vm === 'continue' && r > 0 && t.rows[r - 1]!.cells.some((x) => x.vm && x.col === c.col)) continue;
        let span = 1;
        while (r + span < t.rows.length && t.rows[r + span]!.cells.some((x) => x.vm === 'continue' && x.col === c.col)) {
          span += 1;
        }
        const need = cellH(c);
        let have = 0;
        for (let k = r; k < r + span; k += 1) have += hs[k]!;
        if (need > have) hs[r + span - 1]! += need - have;
      }
    });
    this.rows.set(t, hs);
    return hs;
  }
}

/** 블록 목록 높이 px (머리말/꼬리말 높이 어림에도 쓴다) */
export function blocksHeight(blocks: IRBlock[], width: number, tab: number): number {
  return new HeightCache(tab).list(blocks, width);
}

// ─────────────────────────────── 채워 가르기 ───────────────────────────────

interface PageGeo {
  cap: number;
  width: number;
}

/** 쪽 하나를 높이 배율 a 로 앞에서부터 채워 가른다. 넘치지 않으면 그대로 */
function fill(page: PageIR, geo: PageGeo, a: number, hc: HeightCache): PageIR[] {
  const total = hc.list(page.blocks, geo.width) * a;
  if (total <= geo.cap) return [page];
  const out: PageIR[] = [];
  let cur: IRBlock[] = [];
  let acc = 0;
  const push = (): void => {
    out.push({ blocks: cur, sect: page.sect, start: out.length === 0 ? page.start : 'estimated' });
    cur = [];
    acc = 0;
  };
  /** 쪽을 넘길 때 앞 쪽 끝의 keepNext 문단을 새 쪽으로 데려간다 */
  const breakKeep = (): void => {
    const moved: IRBlock[] = [];
    while (cur.length > 1) {
      const last = cur[cur.length - 1]!;
      if (last.k !== 'p' || !last.keepNext) break;
      moved.unshift(cur.pop()!);
    }
    push();
    for (const m of moved) {
      cur.push(m);
      acc += hc.of(m, geo.width) * a;
    }
  };
  for (const b of page.blocks) {
    const h = hc.of(b, geo.width) * a;
    if (acc + h <= geo.cap) {
      cur.push(b);
      acc += h;
      continue;
    }
    if (b.k === 'tbl' && b.rows.length > 1) {
      const rh = hc.rowHeights(b, geo.width).map((x) => x * a);
      const H = leadingHeaders(b.rows);
      const headH = rh.slice(0, H).reduce((s, x) => s + x, 0);
      let rows: IRRow[] = [];
      let base = 0;
      b.rows.forEach((row, r) => {
        const bodyRows = rows.length - base;
        const room = acc + rh[r]! > geo.cap;
        if (room && (bodyRows > 0 || (rows.length === 0 && cur.length > 0)) && !(r < H && rows.length > 0)) {
          if (rows.length > base) {
            cur.push({ ...b, rows, src: b.src ?? b });
            push();
          } else {
            breakKeep(); // 표 시작 전에서 넘긴다: 앞의 keepNext 문단(표 제목 등)도 함께
          }
          if (r >= H && H > 0) {
            rows = b.rows.slice(0, H).map((x): IRRow => ({ ...x, header: true, copy: true }));
            base = H;
            acc = headH;
          } else {
            rows = [];
            base = 0;
          }
        }
        rows.push(row);
        acc += rh[r]!;
      });
      if (rows.length > base) cur.push({ ...b, rows, src: b.src ?? b });
      continue;
    }
    if (cur.length > 0) breakKeep();
    cur.push(b);
    acc += h;
  }
  if (cur.length > 0) push();
  return out;
}

// ─────────────────────────────── 쪽 합치기 ───────────────────────────────

/** 갈라진 두 조각(같은 원래 문단, 표)을 다시 잇는다. 이을 수 없으면 null */
function join(a: IRBlock, b: IRBlock): IRBlock | null {
  if (a.k === 'p' && b.k === 'p') {
    if (!b.cont || (a.src ?? a) !== (b.src ?? b)) return null;
    const props = { ...a.props };
    if (b.props.spaceAfter !== undefined) props.spaceAfter = b.props.spaceAfter;
    else delete props.spaceAfter;
    const out: IRPara = { ...a, items: [...a.items, ...b.items], props };
    if (b.sectEnd) out.sectEnd = true;
    return out;
  }
  if (a.k === 'tbl' && b.k === 'tbl' && (a.src ?? a) === (b.src ?? b)) {
    let k = 0;
    while (k < b.rows.length && b.rows[k]!.copy) k += 1;
    const rowsB = b.rows.slice(k);
    const last = a.rows[a.rows.length - 1];
    const firstB = rowsB[0];
    if (last && firstB && (last.src ?? last) === (firstB.src ?? firstB)) {
      const merged: IRRow = {
        ...last,
        cells: last.cells.map((c, i) => ({ ...c, blocks: joinLists(c.blocks, firstB.cells[i]?.blocks ?? []) })),
      };
      return { ...a, rows: [...a.rows.slice(0, -1), merged, ...rowsB.slice(1)] };
    }
    return { ...a, rows: [...a.rows, ...rowsB] };
  }
  return null;
}

function joinLists(x: IRBlock[], y: IRBlock[]): IRBlock[] {
  const lx = x[x.length - 1];
  const fy = y[0];
  if (lx && fy) {
    const j = join(lx, fy);
    if (j) return [...x.slice(0, -1), j, ...y.slice(1)];
  }
  return [...x, ...y];
}

/**
 * Word 가 센 쪽 수보다 표지 쪽이 많을 때: 표지(lrpb)로 시작한 아주 작은 쪽(어림 0.35쪽 미만)을 이웃 쪽에 합친다.
 * 실물에서 표 안 이웃한 두 행이 모두 칸 맨 앞 lrpb 를 가져 한 행짜리 쪽이 생기는 경우가 있었다(2건).
 */
function mergeTiny(pages: PageIR[], target: number, ratio: (pg: PageIR) => number): PageIR[] {
  const out = [...pages];
  while (out.length > target) {
    let best = -1;
    let bestR = TINY_PAGE;
    for (let i = 1; i < out.length; i += 1) {
      const pg = out[i]!;
      if (pg.start !== 'lrpb') continue;
      const r = ratio(pg);
      if (r < bestR) {
        bestR = r;
        best = i;
      }
    }
    if (best < 0) break;
    const pg = out[best]!;
    const prev = out[best - 1]!;
    const next = out[best + 1];
    const intoNext =
      next !== undefined && next.start === 'lrpb' && next.sect === pg.sect && ratio(next) <= ratio(prev);
    if (intoNext) {
      out.splice(best, 2, { blocks: joinLists(pg.blocks, next.blocks), sect: pg.sect, start: pg.start });
    } else {
      out.splice(best - 1, 2, { blocks: joinLists(prev.blocks, pg.blocks), sect: prev.sect, start: prev.start });
    }
  }
  return out;
}

/** 쪽 하나를 정확히 k 쪽으로 (앞에서부터 채우되, k 쪽이 되는 가장 작은 쪽 높이로) */
function fillK(page: PageIR, geo: PageGeo, k: number, hc: HeightCache): PageIR[] {
  if (k <= 1) return [page];
  const first = fill(page, geo, 1, hc);
  if (first.length <= k) return first;
  let lo = geo.cap;
  let hi = Math.max(geo.cap, hc.list(page.blocks, geo.width));
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (fill(page, { ...geo, cap: mid }, 1, hc).length <= k) hi = mid;
    else lo = mid;
  }
  return fill(page, { ...geo, cap: hi }, 1, hc);
}

// ─────────────────────────────── 진입점 ───────────────────────────────

/**
 * evenPage/oddPage 로 시작하는 구역 앞에 Word 가 넣는 빈 쪽 수 어림. 이 추출기는 빈 쪽을 만들지 않으므로(쪽 경계
 * 규칙 (d)) app.xml 쪽 수와 비교하기 전에 뺀다. 쪽 번호는 표지 쪽 순서로 세고 pgNumType start 를 따른다(머리말
 * PAGE 값과 같은 방식). 실물에는 evenPage/oddPage 구역이 없어 Word 와 대조하지 못한 어림이다.
 */
function expectedBlanks(pages: PageIR[], sections: SectInfo[]): number {
  let blanks = 0;
  let num = 0;
  pages.forEach((pg, i) => {
    const s = sections[Math.min(pg.sect, sections.length - 1)];
    const first = i === 0 || pages[i - 1]!.sect !== pg.sect;
    num = first && s?.pgStart !== undefined ? s.pgStart : i === 0 ? 1 : num + 1;
    if (i === 0 || !first || !s || (s.type !== 'evenPage' && s.type !== 'oddPage')) return;
    if ((num % 2 === 0) !== (s.type === 'evenPage')) {
      blanks += 1;
      // 빈 쪽이 번호 하나를 가져간다 (번호를 다시 시작하는 구역은 그대로)
      if (s.pgStart === undefined) num += 1;
    }
  });
  return blanks;
}

export function estimatePages(pages: PageIR[], ctx: EstimateCtx): EstimateResult {
  if (pages.length === 0) return { pages, mode: 'none', scale: 1 };
  const hc = new HeightCache(ctx.tab);
  const geoOf = (sect: number, first: boolean): PageGeo => {
    const s = ctx.sections[Math.min(sect, ctx.sections.length - 1)]!;
    const ch = ctx.chrome(sect, first);
    return { cap: Math.max(96, s.h - ch.top - ch.bottom), width: Math.max(48, s.w - s.margin[1] - s.margin[3]) };
  };
  const geos: PageGeo[] = pages.map((pg, i) => geoOf(pg.sect, i === 0 || pages[i - 1]!.sect !== pg.sect));
  const heights = pages.map((pg, i) => hc.list(pg.blocks, geos[i]!.width));

  const app = ctx.appPages;
  // Word 가 센 쪽 수가 표지 쪽 수와 같으면 표지를 믿는다(1 은 '세지 않음'으로 본다). 작으면 아주 작은 쪽만 합친다
  if (app !== undefined && app > 1 && app <= pages.length) {
    if (app === pages.length) return { pages, mode: 'none', scale: 1 };
    const ratio = (pg: PageIR): number => {
      const g = geoOf(pg.sect, false);
      return hc.list(pg.blocks, g.width) / g.cap;
    };
    const merged = mergeTiny(pages, app, ratio);
    return { pages: merged, mode: merged.length < pages.length ? 'merged' : 'none', scale: 1 };
  }
  const roughMax = heights.reduce((n, h, i) => n + Math.max(1, Math.ceil(h / geos[i]!.cap)), 0);
  if (app !== undefined && app > 1 && app <= roughMax * 3 + 5) {
    // Word 가 센 쪽 수가 더 많다. evenPage/oddPage 구역 앞의 빈 쪽은 만들지 않으므로 먼저 뺀다
    const want = app - expectedBlanks(pages, ctx.sections);
    if (want <= pages.length) return { pages, mode: 'none', scale: 1 };
    // 가를 수 있는 쪽은 배율 1 에서 거의 찬 쪽(SPLIT_FLOOR 이상)뿐이고 배율은 MAX_SCALE 까지만 쓴다.
    // 그 안에서 닿을 수 있는 쪽 수(reach)까지만 맞춘다: 모자란 쪽 수를 억지로 채우지 않는다
    const fillT = (i: number, a: number): PageIR[] =>
      heights[i]! / geos[i]!.cap >= SPLIT_FLOOR ? fill(pages[i]!, geos[i]!, a, hc) : [pages[i]!];
    const count = (a: number): number => pages.reduce((n, _pg, i) => n + fillT(i, a).length, 0);
    const apply = (a: number): EstimateResult => ({ pages: pages.flatMap((_pg, i) => fillT(i, a)), mode: 'target', scale: a });
    const goal = Math.min(want, count(MAX_SCALE));
    if (goal <= pages.length) return { pages, mode: 'none', scale: 1 };
    // 쪽 수가 goal 이 되는 배율 구간 [aMin, aNext) 에서 1(어림 그대로)에 가장 가까운 값.
    // 배율이 크면 쪽 수도 늘어난다(대체로 단조)
    const smallest = (n: number): number => {
      let lo = MIN_SCALE;
      let hi = MAX_SCALE;
      if (count(hi) < n) return hi;
      for (let k = 0; k < 40; k += 1) {
        const mid = (lo + hi) / 2;
        if (count(mid) >= n) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const aMin = smallest(goal);
    if (count(aMin) === goal) {
      const aNext = smallest(goal + 1);
      let a = Math.min(Math.max(PRIOR_SCALE, aMin), aNext);
      if (a >= aNext) a = (aMin + aNext) / 2;
      if (count(a) !== goal) a = aMin;
      return apply(a);
    }
    // 한 번에 goal 을 넘는다: 바로 아래 배율과 비교해 가까운 쪽
    const below = aMin * 0.999;
    return apply(goal - count(below) <= count(aMin) - goal ? below : aMin);
  }
  // 목표가 없으면 쪽마다 floor(어림 비율 + 0.35) 쪽으로 가른다 (경계 하나를 더 만드는 것보다 덜 만드는 쪽을 택한다)
  let changed = false;
  const out = pages.flatMap((pg, i) => {
    const k = Math.floor((heights[i]! * PRIOR_SCALE) / geos[i]!.cap + UNKNOWN_ROUND);
    if (k <= 1) return [pg];
    const parts = fillK(pg, geos[i]!, k, hc);
    if (parts.length > 1) changed = true;
    return parts;
  });
  return { pages: out, mode: changed ? 'calibrated' : 'none', scale: PRIOR_SCALE };
}
