/**
 * 2단계: IR → 쪽. 목표는 Word 가 마지막으로 저장할 때의 쪽 나눔이다.
 *
 * 쪽 경계
 * (a) 본문 흐름의 w:lastRenderedPageBreak(lrpb, 표 칸 안, 깊이 무관). Word 는 새 쪽의 첫 줄에 적는다.
 *     표 안에서는 '열마다' 새 쪽의 첫 줄에 적는다(실물 docx/PDF 짝에서 확인). 그래서 행 R 이 쪽에서 갈라지면,
 *     R 의 새 쪽 부분에 내용이 없던 열은 다음 행 칸의 맨 앞에 lrpb 를 받는다. 이런 lrpb 는 새 경계가 아니라
 *     같은 경계로 본다(아래 '빈 열' 규칙).
 * (b) w:br type="page": 최상위 문단, 그리고 표 칸 안(Word 는 그 행 앞에서 새 쪽을 시작한다. 실물 68건 모두
 *     칸 내용 맨 앞이었다).
 * (c) 최상위 문단의 pageBreakBefore (스타일을 거쳐 해석)
 * (d) 구역 끝(sectPr 문단): 다음 구역의 w:type 이 nextPage(기본), evenPage, oddPage, nextColumn 이거나
 *     용지 크기/방향이 바뀌면. continuous 는 경계가 아니다.
 * 경계 사이에 보이는 내용이 없으면 하나로 합친다(명시적 쪽 나눔 바로 뒤의 lrpb 는 같은 경계).
 * 처음 보이는 내용 앞의 경계는 버린다.
 *
 * 나누기
 * - 최상위 문단: 경계 자리에서 글자 조각을 가른다. 뒷부분은 이어지는 문단(번호 없음, 첫 줄 들여쓰기 0,
 *   앞 간격 0)이고 앞부분은 뒤 간격 0. 경계가 여럿이면 여러 조각.
 * - 표: 행 R 의 모든 경계 표지가 칸 내용의 맨 앞(앞에 보이는 내용 없음)이면 R 앞에서 표를 가른다. 아니면 R 을
 *   R_a(각 칸의 표지 앞 내용, 표지 없는 칸은 전부)와 R_b(표지 뒤 내용, 나머지 칸은 빈 칸)로 가른다.
 *   R 에 세로 병합 칸이 있으면 R 앞에서 가른다. 갈라진 뒷부분마다 표 머리의 머리글 행(tblHeader)을 되풀이한다.
 * - 빈 열 규칙: 표 안 경계 뒤, 새 쪽에서 아직 첫 줄이 나오지 않은 열(격자 열)의 칸 맨 앞 lrpb 는 그 경계의
 *   것으로 보고 새 경계를 만들지 않는다. 명시적 쪽 나눔(pb)은 언제나 경계다. 첫 줄이 없는 열은 행을 가른 R_b 의
 *   빈 칸 열(내용이 모두 앞 쪽에 있다)과 세로 병합으로 이어지는 칸의 열이다. 그냥 빈 칸은 빈 문단 한 줄이 새 쪽
 *   첫 줄이므로(글자 조각이 없어 lrpb 를 적지 못할 뿐) 그 열의 뒤 lrpb 는 새 경계다. 실물에서 이 규칙이 lrpb 를
 *   버린 8건은 모두 바로 다음 행이었고, 행 앞에서 가른 뒤의 2건은 세로 병합 열이었다(PDF 짝: 쪽 가운데).
 * - 쪽 = 경계 사이의 연속 블록.
 *
 * 쪽 정보가 없는 문서(lrpb 가 하나도 없음, Word 가 저장하지 않은 docx): (b)-(d)만 쓰고, 정본 글자가
 * 6000자를 넘는 쪽은 최상위 블록 경계(표는 행 사이, 머리글 행 되풀이)에서 약 4500자씩 가른다.
 */
import { FALLBACK_SPLIT_OVER, FALLBACK_TARGET } from './limits.js';
import { blockVisible, itemVisible, type IRBlock, type IRCell, type IRItem, type IRPara, type IRRow, type IRTable, type SectInfo } from './ir.js';

export interface PageIR {
  blocks: IRBlock[];
  /** 쪽 첫 블록의 구역 */
  sect: number;
  /** 이 쪽이 시작된 까닭: 문서 처음, lrpb, 명시적 경계(쪽 나눔, pageBreakBefore, 구역), 추정 */
  start: 'first' | 'lrpb' | 'explicit' | 'estimated';
}

/**
 * 나눈 결과: lead = 첫 조각 앞에 경계(보이는 내용보다 먼저 나온 경계), leadExplicit = 그 경계에 명시적 쪽
 * 나눔(pb)이 있었다, trail = 마지막 조각 뒤에 경계
 */
export interface Split<T> {
  lead: boolean;
  leadExplicit: boolean;
  parts: T[];
  trail: boolean;
  /** 조각 사이 경계마다 명시적 쪽 나눔이 있었는가 (길이 parts.length - 1, 없으면 모두 lrpb) */
  explicit?: boolean[];
  trailExplicit?: boolean;
}

function isMark(it: IRItem): boolean {
  return it.k === 'lrpb' || it.k === 'pb';
}

/** 블록 안(깊이 무관)에 쪽 경계 표지가 있는가 */
export function hasMarks(b: IRBlock): boolean {
  if (b.k === 'p') return b.items.some(isMark);
  for (const row of b.rows) for (const c of row.cells) if (c.blocks.some(hasMarks)) return true;
  return false;
}

/** 문단을 경계 표지에서 가른다 */
export function splitPara(p: IRPara): Split<IRPara> {
  if (!p.items.some(isMark)) return { lead: false, leadExplicit: false, parts: [p], trail: false };
  const groups: IRItem[][] = [];
  let cur: IRItem[] = [];
  let curVisible = false; // 번호 이름표를 뺀 보이는 내용
  let lead = false;
  let leadExplicit = false;
  let pending = false;
  let pendingExplicit = false;
  const explicit: boolean[] = [];
  for (const it of p.items) {
    if (isMark(it)) {
      if (curVisible) {
        pending = true;
        if (it.k === 'pb') pendingExplicit = true;
      } else if (groups.length === 0) {
        // 앞에 보이는 내용 없음: 문단 앞 경계
        lead = true;
        if (it.k === 'pb') leadExplicit = true;
      }
      continue; // 보이는 내용 없는 경계끼리는 합친다
    }
    if (pending) {
      groups.push(cur);
      explicit.push(pendingExplicit);
      cur = [];
      curVisible = false;
      pending = false;
      pendingExplicit = false;
    }
    cur.push(it);
    if (itemVisible(it, false)) curVisible = true;
  }
  groups.push(cur);
  const parts = groups.map((items, i): IRPara => {
    const q: IRPara = { ...p, items, props: { ...p.props }, src: p.src ?? p };
    if (i > 0) {
      q.cont = true;
      delete q.props.indent;
      delete q.props.spaceBefore;
      delete q.pbb;
    }
    if (i < groups.length - 1) {
      delete q.props.spaceAfter;
      delete q.sectEnd;
    }
    return q;
  });
  return { lead, leadExplicit, parts, trail: pending, explicit, trailExplicit: pendingExplicit };
}

/** 표 머리의 연속 머리글 행 수 */
export function leadingHeaders(rows: IRRow[]): number {
  let n = 0;
  while (n < rows.length && rows[n]!.header) n += 1;
  return n;
}

/** 블록 목록(칸 내용)을 경계에서 가른다 */
export function splitBlockList(blocks: IRBlock[]): Split<IRBlock[]> {
  const parts: IRBlock[][] = [[]];
  let lead = false;
  let leadExplicit = false;
  let curVisible = false;
  let pending = false;
  const boundary = (explicit: boolean): void => {
    if (curVisible) pending = true;
    else if (parts.length === 1) {
      lead = true;
      if (explicit) leadExplicit = true;
    }
  };
  const add = (b: IRBlock): void => {
    if (pending) {
      parts.push([]);
      pending = false;
      curVisible = false;
    }
    parts[parts.length - 1]!.push(b);
    if (blockVisible(b)) curVisible = true;
  };
  for (const b of blocks) {
    const sp = b.k === 'p' ? splitPara(b) : splitTable(b);
    if (sp.lead) boundary(sp.leadExplicit);
    sp.parts.forEach((part, j) => {
      if (j > 0) boundary(false);
      add(part);
    });
    if (sp.trail) boundary(false);
  }
  return { lead, leadExplicit, parts, trail: pending };
}

interface RowSplit {
  /** 이 행 앞에 경계 */
  before: boolean;
  parts: IRRow[];
}

function rowPart(row: IRRow, cellBlocks: (i: number) => IRBlock[], first: boolean): IRRow {
  const out: IRRow = { ...row, cells: row.cells.map((c, i) => ({ ...c, blocks: cellBlocks(i) })), src: row.src ?? row };
  if (!first) {
    delete out.h;
    delete out.hRule;
  }
  return out;
}

type CellSplit = Split<IRBlock[]> | null;

/** 칸마다 나눈 결과로 행을 가른다 (빈 열 규칙은 부르는 쪽이 미리 적용) */
function decideRow(row: IRRow, splits: CellSplit[]): RowSplit {
  const marked = splits.filter((s): s is Split<IRBlock[]> => s !== null && (s.lead || s.parts.length > 1));
  if (marked.length === 0) return { before: false, parts: [row] };
  const hasVM = row.cells.some((c) => c.vm !== undefined);
  const allLead = marked.every((s) => s.lead);
  if (allLead) {
    const K = Math.max(...splits.map((s) => (s ? s.parts.length : 1)));
    if (K === 1 || hasVM) return { before: true, parts: [row] };
    const parts: IRRow[] = [];
    for (let j = 0; j < K; j += 1) {
      parts.push(
        rowPart(
          row,
          (i) => {
            const s = splits[i];
            if (!s) return j === 0 ? row.cells[i]!.blocks : [];
            return s.parts[j] ?? [];
          },
          j === 0,
        ),
      );
    }
    return { before: true, parts };
  }
  if (hasVM) return { before: true, parts: [row] };
  const K = Math.max(...splits.map((s) => (s ? s.parts.length + (s.lead ? 1 : 0) : 1)));
  const parts: IRRow[] = [];
  for (let j = 0; j < K; j += 1) {
    parts.push(
      rowPart(
        row,
        (i) => {
          const s = splits[i];
          if (!s) return j === 0 ? row.cells[i]!.blocks : [];
          const k = j - (s.lead ? 1 : 0);
          return k >= 0 ? (s.parts[k] ?? []) : [];
        },
        j === 0,
      ),
    );
  }
  return { before: false, parts };
}

export function splitRow(row: IRRow): RowSplit {
  return decideRow(
    row,
    row.cells.map((c) => (c.blocks.some(hasMarks) ? splitBlockList(c.blocks) : null)),
  );
}

/** 칸이 덮는 격자 열 */
function cols(c: IRCell): number[] {
  const out: number[] = [];
  for (let k = 0; k < c.span; k += 1) out.push(c.col + k);
  return out;
}

/** 이 행 조각에서 보이는 내용이 없는 칸의 격자 열 (새 쪽에서 아직 첫 줄이 없는 열) */
function emptyCols(row: IRRow): Set<number> {
  const out = new Set<number>();
  for (const c of row.cells) if (!c.filler && !c.blocks.some(blockVisible)) for (const k of cols(c)) out.add(k);
  return out;
}

/**
 * 행 앞에서 가른 행(R 전체가 새 쪽)에서 새 쪽에 아직 첫 줄이 없는 열: 세로 병합으로 이어지는 빈 칸의 열뿐이다.
 * 이어지는 칸은 위 시작 칸에 합쳐져 따로 줄을 갖지 않으므로 그 열의 다음 내용 칸이 lrpb 를 받는다. 그냥 빈 칸은
 * 빈 문단 한 줄이 새 쪽 첫 줄이다(글자 조각이 없어 Word 가 lrpb 를 적지 못할 뿐): 그 열의 뒤 lrpb 는 새 쪽이다.
 */
function mergedCols(row: IRRow): Set<number> {
  const out = new Set<number>();
  for (const c of row.cells) if (c.vm === 'continue' && !c.blocks.some(blockVisible)) for (const k of cols(c)) out.add(k);
  return out;
}

/** 머리글 행 되풀이: 갈라진 자리가 머리글 행 뒤일 때만 */
export function withHeaders(t: IRTable, rows: IRRow[], firstIdx: number, H: number): IRRow[] {
  if (H === 0 || firstIdx < H) return rows;
  return [...t.rows.slice(0, H).map((r): IRRow => ({ ...r, header: true, copy: true })), ...rows];
}

export function splitTable(t: IRTable): Split<IRTable> {
  if (!hasMarks(t)) return { lead: false, leadExplicit: false, parts: [t], trail: false };
  const H = leadingHeaders(t.rows);
  const groups: { rows: IRRow[]; firstIdx: number }[] = [{ rows: [], firstIdx: 0 }];
  let lead = false;
  let leadExplicit = false;
  /** 표 안 마지막 경계 뒤 아직 첫 줄이 없는 열. null = 이 표 안에 아직 경계가 없음 */
  let fresh: Set<number> | null = null;
  t.rows.forEach((row, r) => {
    const splits: CellSplit[] = row.cells.map((c) => (c.blocks.some(hasMarks) ? splitBlockList(c.blocks) : null));
    let explicit = false;
    splits.forEach((s, i) => {
      if (!s || !s.lead) return;
      if (s.leadExplicit) {
        explicit = true;
        return;
      }
      const cell = row.cells[i]!;
      if (fresh && cols(cell).every((k) => fresh!.has(k))) {
        // 빈 열 규칙: 앞 경계의 lrpb
        splits[i] = s.parts.length > 1 ? { ...s, lead: false } : null;
      }
    });
    const rs = decideRow(row, splits);
    if (rs.before) {
      const cur = groups[groups.length - 1]!;
      if (cur.rows.length === 0) {
        if (groups.length === 1) {
          lead = true;
          if (explicit) leadExplicit = true;
        }
      } else {
        groups.push({ rows: [], firstIdx: r });
      }
      fresh = mergedCols(rs.parts[0]!);
    }
    rs.parts.forEach((rp, j) => {
      if (j > 0) {
        groups.push({ rows: [], firstIdx: r });
        fresh = emptyCols(rp);
      }
      groups[groups.length - 1]!.rows.push(rp);
    });
    if (fresh && !rs.before && rs.parts.length === 1) {
      // 경계 없이 이어진 행: 이 행에서 자기 줄을 가진 칸(내용 칸, 그냥 빈 칸)의 열은 새 쪽 첫 줄이 나왔다.
      // 세로 병합으로 이어지는 칸의 열만 계속 비어 있다
      const merged = mergedCols(rs.parts[0]!);
      for (const k of [...fresh]) if (!merged.has(k)) fresh.delete(k);
    }
  });
  const parts = groups
    .filter((g) => g.rows.length > 0)
    .map((g, i): IRTable => ({ ...t, rows: i === 0 ? g.rows : withHeaders(t, g.rows, g.firstIdx, H), src: t.src ?? t }));
  return { lead, leadExplicit, parts, trail: false };
}

/** 구역 끝 다음에 새 쪽이 시작되는가 */
function sectionBreaks(cur: SectInfo | undefined, next: SectInfo | undefined): boolean {
  if (!next) return false;
  if (next.type !== 'continuous') return true;
  return cur !== undefined && (cur.w !== next.w || cur.h !== next.h);
}

/** 최상위 블록 → 쪽 */
export function paginate(blocks: IRBlock[], sections: SectInfo[]): PageIR[] {
  const pages: PageIR[] = [];
  let cur: PageIR = { blocks: [], sect: -1, start: 'first' };
  let curVisible = false;
  let pending = false;
  let pendingExplicit = false;
  const boundary = (explicit: boolean): void => {
    // 보이는 내용이 없으면(문서 처음 포함) 경계를 합친다
    if (!curVisible) return;
    pending = true;
    if (explicit) pendingExplicit = true;
  };
  const add = (b: IRBlock): void => {
    if (pending) {
      pages.push(cur);
      cur = { blocks: [], sect: -1, start: pendingExplicit ? 'explicit' : 'lrpb' };
      curVisible = false;
      pending = false;
      pendingExplicit = false;
    }
    if (cur.sect < 0) cur.sect = b.sect;
    cur.blocks.push(b);
    if (blockVisible(b)) curVisible = true;
  };
  for (const b of blocks) {
    if (b.k === 'p' && b.pbb) boundary(true);
    const sp = b.k === 'p' ? splitPara(b) : splitTable(b);
    if (sp.lead) boundary(sp.leadExplicit);
    sp.parts.forEach((part, j) => {
      if (j > 0) boundary(sp.explicit?.[j - 1] ?? false);
      add(part);
    });
    if (sp.trail) boundary(sp.trailExplicit ?? false);
    if (b.k === 'p' && b.sectEnd && sectionBreaks(sections[b.sect], sections[b.sect + 1])) boundary(true);
  }
  if (cur.blocks.length > 0 || pages.length === 0) {
    if (cur.sect < 0) cur.sect = 0;
    pages.push(cur);
  }
  return pages;
}

// ─────────────────────────────── 글자 수 (대체 쪽 나눔, 추정용) ───────────────────────────────

/** 블록의 정본 글자 수 (emit 의 잇기 규칙과 같다: 글자 있는 것만 구분자로 잇는다) */
export function blockTextLen(b: IRBlock): number {
  if (b.k === 'p') {
    if (b.hidden) return 0;
    let n = 0;
    for (const it of b.items) {
      if (it.k === 't') n += it.t.length;
      else if (it.k === 'box') {
        const m = listTextLen(it.blocks);
        if (m > 0) n += m + 1;
      }
    }
    return n;
  }
  let n = 0;
  for (const row of b.rows) {
    const m = rowTextLen(row);
    if (m > 0) n += (n > 0 ? 1 : 0) + m;
  }
  return n;
}

export function rowTextLen(row: IRRow): number {
  let n = 0;
  for (const c of row.cells) {
    const m = listTextLen(c.blocks);
    if (m > 0) n += (n > 0 ? 1 : 0) + m;
  }
  return n;
}

export function listTextLen(blocks: IRBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    const m = blockTextLen(b);
    if (m > 0) n += (n > 0 ? 1 : 0) + m;
  }
  return n;
}

/** 쪽 정보가 없는 문서: 6000자를 넘는 쪽을 약 4500자씩 가른다 */
export function splitBySize(page: PageIR): PageIR[] {
  if (listTextLen(page.blocks) <= FALLBACK_SPLIT_OVER) return [page];
  const out: PageIR[] = [];
  let cur: IRBlock[] = [];
  let acc = 0;
  const flush = (): void => {
    if (cur.length > 0) out.push({ blocks: cur, sect: page.sect, start: out.length === 0 ? page.start : 'estimated' });
    cur = [];
    acc = 0;
  };
  for (const b of page.blocks) {
    const len = blockTextLen(b);
    if (b.k === 'tbl' && acc + len > FALLBACK_TARGET && b.rows.length > 1) {
      const H = leadingHeaders(b.rows);
      let rows: IRRow[] = [];
      let base = 0; // rows 앞의 되풀이 머리글 행 수
      let racc = 0;
      b.rows.forEach((row, r) => {
        const rl = rowTextLen(row) + 1;
        // 표 시작 전(앞 블록이 있을 때) 또는 이 조각에 머리글이 아닌 행이 하나 이상 있을 때만 가른다
        const startOfTable = rows.length === 0;
        const bodyRows = rows.length - (base > 0 ? base : Math.min(r, H));
        if (((startOfTable && cur.length > 0) || (r >= H && bodyRows > 0)) && acc + racc + rl > FALLBACK_TARGET) {
          if (!startOfTable) cur.push({ ...b, rows, src: b.src ?? b });
          flush();
          rows = startOfTable ? [] : withHeaders(b, [], r, H);
          base = rows.length;
          racc = rows.reduce((s, x) => s + rowTextLen(x) + 1, 0);
        }
        rows.push(row);
        racc += rl;
      });
      if (rows.length > 0) {
        cur.push({ ...b, rows, src: b.src ?? b });
        acc += racc;
      }
      continue;
    }
    if (acc > 0 && acc + len > FALLBACK_TARGET) flush();
    cur.push(b);
    acc += len + 1;
  }
  flush();
  return out.length > 0 ? out : [page];
}
