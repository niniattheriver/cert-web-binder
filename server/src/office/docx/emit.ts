/**
 * 3단계: 쪽 IR → 모델 블록 + 정본 쪽 글자 + 오프셋
 *
 * 정본 글자 규칙 (page_text: 검색과 앵커 오프셋의 기준)
 * - 블록 목록(쪽, 칸, 글상자)은 글자가 있는 블록만 '\n' 으로 잇는다. 빈 문단은 글자에 넣지 않지만 모델에는
 *   runs [] 인 문단으로 남겨 세로 간격을 지킨다.
 * - 표: 글자 있는 행만 '\n', 행 안에서는 글자 있는 칸만 '\t', 칸 안 블록은 '\n'.
 * - 글상자는 그 자리(기준 문단 뒤)의 블록처럼 잇는다. 각주는 참조가 있는 쪽 끝에, 미주는 마지막 쪽 끝에 붙인다.
 * - 쪽 글자는 조각(run)과 위 구분자로만 이루어진다. 모든 조각에 대해 text.slice(o, o + t.length) === t.
 * - 한 문단 안 이웃 조각의 이음매도 정규화에 안정하다(settleRuns): 쪽 글자 전체를 다시 정규화해도 바뀌지 않는다.
 * - 글자 상한(MAX_TEXT)에 닿으면 그 자리에서 자르고 뒤는 버린다(색인과 표시가 같은 범위).
 *
 * 머리말/꼬리말은 표시 전용(FlowDisplayRun, o 없음)이다. PAGE, NUMPAGES, SECTIONPAGES 는 쪽마다 계산한 값.
 * 쪽마다 되풀이되므로 JSON 합을 MAX_CHROME_JSON 으로 묶는다(index.ts).
 */
import type {
  Border,
  FlowBlock,
  FlowBox,
  FlowDisplayRun,
  FlowImage,
  FlowPara,
  FlowRun,
  FlowTable,
  FlowTableCell,
  FlowTableRow,
} from '../model.js';
import { formatPageNumber, type PageField } from './fields.js';
import { blockVisible, type IRBlock, type IRCell, type IRItem, type IRPara, type IRTable } from './ir.js';
import { MAX_TEXT } from './limits.js';
import { canon, COMBINING_HEAD, sliceSafe } from './units.js';

/** 크기를 어디서도 정하지 않은 글자의 Word 기본 크기 pt */
const DEFAULT_RUN_PT = 10;

/** 오프셋을 달기 전 조각 (머리말이면 쪽 번호 자리표시를 가질 수 있다) */
export type PreRun = Omit<FlowRun, 'o'> & { pf?: PageField; ptab?: 'center' | 'right' };
export type PreBlock = FlowBlock<PreRun>;

// ─────────────────────────────── IR → 모델 모양 ───────────────────────────────

/**
 * 한 모델 문단의 조각은 쪽 글자에서 구분자 없이 이웃한다. 그래서 결합 글자(결합 표지, 한글 중성/종성 자모)로
 * 시작하는 조각은 그 앞머리를 앞 조각에 붙여 다시 정규화한다: 쪽 글자 전체를 정규화해도 바뀌지 않게
 * (예: 'ᄒ' 굵게 + 'ᅡᆫ' 보통 → '한'). 사이의 떠 있는 그림, 글상자, 각주 표지는 문단 뒤로 옮겨지거나 글자가
 * 없으므로 이 문단 조각들은 여전히 이웃한다. 이어지는 결합 조각은 모아서 한 번에 정규화한다(조각 수에 선형).
 * 머리말 쪽 번호 자리표시(pf)에는 붙이지 않는다.
 */
export function settleRuns(runs: PreRun[]): PreRun[] {
  let any = false;
  for (let i = 1; i < runs.length && !any; i += 1) any = COMBINING_HEAD.test(runs[i]!.t);
  if (!any) return runs;
  const out: PreRun[] = [];
  let pend: string[] = [];
  const settle = (): void => {
    if (pend.length === 0) return;
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ...last, t: canon(last.t + pend.join('')) };
    pend = [];
  };
  for (const r of runs) {
    const prev = out[out.length - 1];
    const head = prev && !prev.pf && !prev.ptab && !r.pf ? COMBINING_HEAD.exec(r.t)?.[0] : undefined;
    if (head === undefined) {
      settle();
      out.push(r);
      continue;
    }
    pend.push(head);
    if (head.length < r.t.length) {
      settle();
      out.push({ ...r, t: r.t.slice(head.length) });
    }
  }
  settle();
  return out;
}

const hasContent = (it: IRItem): boolean => it.k === 't' || it.k === 'img' || it.k === 'box';

/**
 * 쪽 나눔(w:br type=page) 뒤에 아무것도 없는 문단의, 새 쪽으로 넘어온 빈 조각인가. Word 는 그 문단 표지를 쪽
 * 나눔과 같은 줄(앞 쪽 끝)에 두므로 새 쪽 맨 위에는 아무것도 그리지 않는다. 그리면 새 쪽 위끝에 Word 에 없는 빈
 * 줄이 생겼다(PDF 짝 대조). 쪽 나눔 어림과 정본 글자는 그대로다(빈 문단은 글자가 없다)
 */
function pageBreakOnly(p: IRPara): boolean {
  if (p.items.some(hasContent)) return false;
  const src = (p.src ?? p).items;
  let lastPb = -1;
  src.forEach((it, i) => {
    if (it.k === 'pb') lastPb = i;
  });
  return lastPb >= 0 && !src.slice(lastPb + 1).some(hasContent);
}

function expandPara(p: IRPara, out: PreBlock[], top: boolean): void {
  if (p.hidden) return;
  if (top && pageBreakOnly(p)) return;
  const after: PreBlock[] = [];
  let runs: PreRun[] = [];
  let seg = 0;
  let emitted = false;
  const flush = (final: boolean): void => {
    if (runs.length === 0 && !(final && !emitted)) return;
    const props = { ...p.props };
    // 화면 값(ir.ts IRPara.render): 바로잡은 들여쓰기와 Word 식 줄 높이. props 의 값은 쪽 나눔 어림용이다
    if (p.render) {
      const r = p.render;
      for (const k of ['marginLeft', 'marginRight', 'indent'] as const) {
        if (r[k]) props[k] = r[k];
        else delete props[k];
      }
      if (r.linePx !== undefined) props.linePx = r.linePx;
    }
    if (seg > 0 || p.cont) {
      delete props.indent;
      delete props.spaceBefore;
    }
    if (!final) delete props.spaceAfter;
    const para: FlowPara<PreRun> = { type: 'p', ...props, runs: settleRuns(runs) };
    out.push(para);
    runs = [];
    seg += 1;
    emitted = true;
  };
  for (const it of p.items) {
    if (it.k === 't') {
      const r: PreRun = { t: it.t, ...it.s };
      // 크기를 어디서도 정하지 않은 글자는 Word 기본 10pt (비워 두면 화면이 문단 표지 크기를 물려줘, 문단 표지만
      // 12pt 인 문단을 Word 보다 크게 그렸다: PDF 짝 7개에서 1,646자)
      if (r.sz === undefined) r.sz = DEFAULT_RUN_PT;
      if (it.lbl) r.lbl = true;
      if (it.pf) r.pf = it.pf;
      if (it.ptab) r.ptab = it.ptab;
      runs.push(r);
    } else if (it.k === 'img') {
      const img: FlowImage = { type: 'img', media: it.media, w: it.w, h: it.h };
      if (it.crop) img.crop = it.crop;
      // 글 줄에 놓인 그림은 문단 정렬을 따른다 (가운데 정렬 문단의 로고, 흐름도)
      if (it.inline && (p.props.align === 'center' || p.props.align === 'right')) img.align = p.props.align;
      if (it.inline) {
        if (runs.length > 0) flush(false);
        out.push(img);
        emitted = true;
      } else {
        after.push(img);
      }
    } else if (it.k === 'box') {
      const box: FlowBox<PreRun> = { type: 'box', blocks: expandList(it.blocks), border: it.border };
      if (it.w !== undefined) box.w = it.w;
      after.push(box);
    }
  }
  flush(true);
  for (const b of after) out.push(b);
}

function flowCell(c: IRCell): FlowTableCell<PreRun> {
  const cell: FlowTableCell<PreRun> = { blocks: c.filler ? [] : expandList(c.blocks), border: false };
  if (c.span > 1) cell.colSpan = c.span;
  if (c.w !== undefined) cell.w = c.w;
  if (c.filler) return cell;
  if (c.bg) cell.bg = c.bg;
  if (c.bt) cell.bt = c.bt;
  if (c.br) cell.br = c.br;
  if (c.bb) cell.bb = c.bb;
  if (c.bl) cell.bl = c.bl;
  if (c.va) cell.va = c.va;
  if (c.pad) cell.pad = c.pad;
  return cell;
}

/** 표 한 조각: 세로 병합(vMerge)을 이 조각 안에서 rowSpan 으로 바꾼다 */
function expandTable(t: IRTable): FlowTable<PreRun> {
  const rows: FlowTableRow<PreRun>[] = [];
  const active = new Map<number, { cell: FlowTableCell<PreRun>; span: number }>();
  let prevCopy = false;
  for (const row of t.rows) {
    // 조각 머리에 되풀이한 머리글 행(copy) 다음 본문 행은 머리글 칸의 세로 병합을 잇지 않는다: 본문의 이어지는
    // 칸은 아래 '조각 맨 위' 규칙대로 새 시작 칸이 된다 (머리글 병합은 되풀이한 머리글 행 안에서만 rowSpan)
    if (prevCopy && !row.copy) active.clear();
    prevCopy = row.copy === true;
    const cells: FlowTableCell<PreRun>[] = [];
    const seen = new Set<number>();
    for (const c of row.cells) {
      if (c.vm === 'continue') {
        const a = active.get(c.col);
        if (a && a.span === c.span) {
          a.cell.rowSpan = (a.cell.rowSpan ?? 1) + 1;
          const extra = c.blocks.filter(blockVisible);
          if (extra.length > 0) for (const b of expandList(extra)) a.cell.blocks.push(b);
          setBottom(a.cell, c.bb);
          seen.add(c.col);
          continue;
        }
        // 조각 맨 위의 이어지는 칸: 새 시작 칸이 된다
      }
      const fc = flowCell(c);
      cells.push(fc);
      if (c.vm) {
        active.set(c.col, { cell: fc, span: c.span });
        seen.add(c.col);
      }
    }
    for (const col of [...active.keys()]) if (!seen.has(col)) active.delete(col);
    const fr: FlowTableRow<PreRun> = { cells };
    if (row.h !== undefined) {
      fr.h = row.h;
      if (row.hRule) fr.hRule = row.hRule;
    }
    if (row.header) fr.header = true;
    rows.push(fr);
  }
  const out: FlowTable<PreRun> = { type: 'table', rows };
  if (t.colWidths) out.colWidths = t.colWidths;
  if (t.width !== undefined) out.width = t.width;
  if (t.align) out.align = t.align;
  if (t.indent !== undefined) out.indent = t.indent;
  return out;
}

function setBottom(cell: FlowTableCell<PreRun>, bb: Border | undefined): void {
  if (bb) cell.bb = bb;
  else delete cell.bb;
}

/** IR 블록 목록 → 모델 블록. top = 쪽 본문의 최상위 목록(표 칸, 글상자, 머리말, 각주가 아님) */
export function expandList(blocks: IRBlock[], top = false): PreBlock[] {
  const out: PreBlock[] = [];
  for (const b of blocks) {
    if (b.k === 'p') expandPara(b, out, top);
    else out.push(expandTable(b));
  }
  return out;
}

// ─────────────────────────────── 오프셋 ───────────────────────────────

export interface LayoutState {
  /** 앞 쪽들 글자 수 합 */
  total: number;
  stopped: boolean;
  /** 글자 상한에서 잘랐는가 */
  cut: boolean;
}

interface Laid<T> {
  block: T | null;
  text: string;
}

function toRun(r: PreRun, t: string, o: number): FlowRun {
  const { pf: _pf, ptab: _ptab, ...rest } = r;
  return { ...rest, t, o };
}

/** 블록 목록: 글자가 있는 블록만 '\n' 으로 잇는다. start = 이 목록 글자가 쪽 글자에서 시작할 자리 */
export function layoutList(blocks: PreBlock[], start: number, st: LayoutState): { blocks: FlowBlock[]; text: string } {
  const out: FlowBlock[] = [];
  let text = '';
  for (const b of blocks) {
    if (st.stopped) break;
    const sep = text.length > 0 ? 1 : 0;
    const r = layoutBlock(b, start + text.length + sep, st);
    if (r.block) out.push(r.block);
    if (r.text.length > 0) text += (sep ? '\n' : '') + r.text;
  }
  return { blocks: out, text };
}

function layoutBlock(b: PreBlock, start: number, st: LayoutState): Laid<FlowBlock> {
  if (b.type === 'img') return { block: b, text: '' };
  if (b.type === 'p') {
    const runs: FlowRun[] = [];
    let text = '';
    for (const r of b.runs) {
      const o = start + text.length;
      let t = r.t;
      const room = MAX_TEXT - st.total - o;
      if (t.length > room) {
        t = sliceSafe(t, room);
        st.stopped = true;
        st.cut = true;
      }
      if (t.length > 0) {
        runs.push(toRun(r, t, o));
        text += t;
      }
      if (st.stopped) break;
    }
    if (st.stopped && runs.length === 0 && b.runs.length > 0) return { block: null, text: '' };
    return { block: { ...b, runs }, text };
  }
  if (b.type === 'box') {
    const r = layoutList(b.blocks, start, st);
    const box: FlowBox = { ...b, blocks: r.blocks };
    if (st.stopped && r.blocks.length === 0) return { block: null, text: '' };
    return { block: box, text: r.text };
  }
  // 표: 칸 '\t', 행 '\n' (글자 있는 칸, 행만)
  const rows: FlowTableRow[] = [];
  let text = '';
  for (const row of b.rows) {
    if (st.stopped) break;
    const rsep = text.length > 0 ? 1 : 0;
    const rowStart = start + text.length + rsep;
    let rowText = '';
    const cells: FlowTableCell[] = [];
    for (const cell of row.cells) {
      if (st.stopped) break;
      const csep = rowText.length > 0 ? 1 : 0;
      const r = layoutList(cell.blocks, rowStart + rowText.length + csep, st);
      cells.push({ ...cell, blocks: r.blocks });
      if (r.text.length > 0) rowText += (csep ? '\t' : '') + r.text;
    }
    rows.push({ ...row, cells });
    if (rowText.length > 0) text += (rsep ? '\n' : '') + rowText;
  }
  if (st.stopped && rows.length === 0) return { block: null, text: '' };
  return { block: { ...b, rows }, text };
}

// ─────────────────────────────── 머리말/꼬리말 ───────────────────────────────

export interface PageNumbers {
  page: number;
  total: number;
  sectionPages: number;
  sectFmt?: string;
}

function hasPageField(blocks: PreBlock[]): boolean {
  for (const b of blocks) {
    if (b.type === 'p' && b.runs.some((r) => r.pf)) return true;
    if (b.type === 'box' && hasPageField(b.blocks)) return true;
    if (b.type === 'table') for (const row of b.rows) for (const c of row.cells) if (hasPageField(c.blocks)) return true;
  }
  return false;
}

function displayRun(r: PreRun, nums: PageNumbers): FlowDisplayRun {
  const { pf, ptab: _ptab, ...rest } = r;
  if (!pf) return rest;
  const value = pf.kind === 'PAGE' ? nums.page : pf.kind === 'NUMPAGES' ? nums.total : nums.sectionPages;
  return { ...rest, t: formatPageNumber(value, pf, nums.sectFmt) };
}

function displayList(blocks: PreBlock[], nums: PageNumbers): FlowBlock<FlowDisplayRun>[] {
  return blocks.map((b): FlowBlock<FlowDisplayRun> => {
    if (b.type === 'img') return b;
    if (b.type === 'p') return { ...b, runs: b.runs.map((r) => displayRun(r, nums)).filter((r) => r.t.length > 0) };
    if (b.type === 'box') return { ...b, blocks: displayList(b.blocks, nums) };
    return {
      ...b,
      rows: b.rows.map((row) => ({ ...row, cells: row.cells.map((c) => ({ ...c, blocks: displayList(c.blocks, nums) })) })),
    };
  });
}

/**
 * 머리말/꼬리말의 위치 탭(w:ptab, 가운데나 오른쪽 정렬)이 든 문단 → 테두리 없는 한 행 표. 탭 앞 글자는 문단 정렬,
 * 탭 뒤 글자는 그 탭의 정렬로 칸마다 그린다. Word 는 꼬리말의 쪽 번호를 이 탭으로 오른쪽 여백에 붙이는데(실물 docx
 * 88개 중 83개, PDF 짝 7개 모두), 화면 기본 탭 간격으로는 제목 바로 뒤에 붙었다. 표시 전용이라 정본 글자와 무관하고,
 * 탭 글자 자체는 그리지 않는다.
 */
function ptabTables(blocks: PreBlock[]): PreBlock[] {
  return blocks.map((b): PreBlock => {
    if (b.type === 'box') return { ...b, blocks: ptabTables(b.blocks) };
    if (b.type === 'table') {
      return { ...b, rows: b.rows.map((row) => ({ ...row, cells: row.cells.map((c) => ({ ...c, blocks: ptabTables(c.blocks) })) })) };
    }
    if (b.type !== 'p' || !b.runs.some((r) => r.ptab)) return b;
    const { runs, type: _type, ...props } = b;
    const segs: { align: FlowPara['align']; runs: PreRun[] }[] = [{ align: props.align, runs: [] }];
    for (const r of runs) {
      if (r.ptab) segs.push({ align: r.ptab, runs: [] });
      else segs[segs.length - 1]!.runs.push(r);
    }
    const cells = segs.map((sg, i): FlowTableCell<PreRun> => {
      const para: FlowPara<PreRun> = { type: 'p', ...props, runs: sg.runs };
      if (sg.align) para.align = sg.align;
      else delete para.align;
      // 왼쪽 들여쓰기는 첫 칸에만, 오른쪽 들여쓰기는 끝 칸에만 (위치 탭은 여백 기준이다)
      if (i > 0) {
        delete para.marginLeft;
        delete para.indent;
      }
      if (i < segs.length - 1) delete para.marginRight;
      return { blocks: [para], border: false, pad: [0, 0, 0, 0] };
    });
    return { type: 'table', rows: [{ cells }] };
  });
}

/** 머리말/꼬리말 한 부분: 쪽 번호가 없으면 한 번 만든 것을 그대로 쓴다 */
export class HeaderPart {
  private readonly pre: PreBlock[];
  private readonly fixed: FlowBlock<FlowDisplayRun>[] | null;
  /** 쪽 번호가 없는 부분의 JSON 바이트 수 (한 번만 잰다) */
  private readonly fixedBytes: number;
  private readonly blank: boolean;

  constructor(blocks: PreBlock[]) {
    this.pre = ptabTables(blocks);
    this.fixed = hasPageField(this.pre) ? null : displayList(this.pre, { page: 1, total: 1, sectionPages: 1 });
    this.fixedBytes = this.fixed ? jsonBytes(this.fixed) : 0;
    // 빈 부분인가는 나누기 전 블록으로 본다(위치 탭만 있는 빈 문단이 빈 표가 되어 보이는 내용으로 세지 않게)
    this.blank = blocks.length === 0 || !blocks.some(preVisible);
  }

  empty(): boolean {
    return this.blank;
  }

  /** 이 쪽에 실을 블록과 그 JSON 바이트 수 (머리말/꼬리말 JSON 합 상한에 쓴다) */
  renderSized(nums: PageNumbers): { blocks: FlowBlock<FlowDisplayRun>[]; bytes: number } {
    if (this.fixed) return { blocks: this.fixed, bytes: this.fixedBytes };
    const blocks = displayList(this.pre, nums);
    return { blocks, bytes: jsonBytes(blocks) };
  }
}

function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

function preVisible(b: PreBlock): boolean {
  if (b.type === 'img') return true;
  if (b.type === 'p') return b.runs.some((r) => r.pf !== undefined || /\S/.test(r.t));
  if (b.type === 'box') return b.blocks.some(preVisible);
  return b.rows.length > 0;
}

// ─────────────────────────────── 각주 ───────────────────────────────

/** 블록 안 각주/미주 참조 열쇠 (문서 순서, 중복 제거) */
export function noteKeys(blocks: IRBlock[], out: string[] = [], seen = new Set<string>()): string[] {
  for (const b of blocks) {
    if (b.k === 'p') {
      for (const it of b.items) {
        if (it.k === 'note' && !seen.has(it.key)) {
          seen.add(it.key);
          out.push(it.key);
        } else if (it.k === 'box') {
          noteKeys(it.blocks, out, seen);
        }
      }
    } else {
      for (const row of b.rows) for (const c of row.cells) noteKeys(c.blocks, out, seen);
    }
  }
  return out;
}

const NOTE_RULE: Border = { w: 1, style: 'solid', color: '#000000' };

/** 쪽 끝 각주 묶음: 첫 문단 위에 구분선(표시 전용 테두리)을 둔다 */
export function noteBlocks(keys: string[], notes: Map<string, IRBlock[]>): PreBlock[] {
  const out: PreBlock[] = [];
  for (const k of keys) {
    const blocks = notes.get(k);
    if (!blocks) continue;
    for (const b of expandList(blocks)) out.push(b);
  }
  const first = out.find((b) => b.type === 'p');
  if (first && first.type === 'p') {
    if (!first.bt) first.bt = NOTE_RULE;
    if (first.spaceBefore === undefined) first.spaceBefore = 8;
  }
  return out;
}
