/**
 * 화면 DOM 위치 ↔ 정본(page_text) 오프셋 변환: Office 뷰어용 순수 DOM 도우미
 *
 * 렌더러(FlowView, SheetView, SlidesView, PlainView)의 불변식에 기댄다.
 * - 정본 글자 조각마다 data-o={o} 요소가 하나 있고, 그 요소의 글자 길이는 조각 글자 길이와 같다.
 *   o 는 그 쪽 page_text 안 시작 오프셋이다.
 * - 쪽 뿌리 요소에 data-page={pageNo} 가 있다.
 * - 머리말, 캡션, 글머리 기호 같은 표시 전용 글자에는 data-o 가 없다.
 *
 * 이 파일은 React 와 앱 상태를 모른다. 선택(Range)과 쪽 요소만 받아 계산하므로 브라우저에서 그대로
 * 시험할 수 있다(예: playwright evaluate 로 부른다).
 */

/** 한 쪽 안의 정본 범위: start 포함, end 제외 (쪽 지역 오프셋) */
export interface LocalRange {
  pageNo: number;
  start: number;
  end: number;
}

/** 쪽 안의 글자 조각 하나 */
export interface PieceInfo {
  el: Element;
  /** 쪽 page_text 안 시작 오프셋 */
  o: number;
  /** 글자 길이 */
  len: number;
}

const ELEMENT_NODE = 1;

function asElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function intAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 조각 요소의 글자 길이 (자식 글자 노드 길이의 합) */
function pieceLength(el: Element): number {
  return el.textContent?.length ?? 0;
}

/** node 를 품은 글자 조각 요소 (root 안에서만) */
function pieceAt(node: Node, root: Element): Element | null {
  const el = asElement(node);
  const piece = el?.closest('[data-o]') ?? null;
  return piece && root.contains(piece) ? piece : null;
}

/** 조각 요소가 놓인 쪽 번호 (root 안의 data-page 조상) */
function pageNoOf(el: Element, root: Element): number | null {
  const pageEl = el.closest('[data-page]');
  return pageEl && root.contains(pageEl) ? intAttr(pageEl, 'data-page') : null;
}

/** 조각 안 경계점(container, offset)의 글자 위치: 조각 시작부터 그 점까지의 글자 수 */
function charOffsetInPiece(piece: Element, container: Node, offset: number): number {
  const doc = piece.ownerDocument;
  const r = doc.createRange();
  try {
    r.setStart(piece, 0);
    r.setEnd(container, offset);
  } catch {
    return 0;
  }
  return Math.min(r.toString().length, pieceLength(piece));
}

/**
 * 선택 범위 → 쪽별 정본 지역 범위 (pageNo 오름차순).
 * - 경계가 글자 노드 안이면 그 글자 위치를 그대로 쓴다.
 * - 경계가 글자 노드가 아니거나 조각 밖이면(표시 전용 글자, 빈칸 사이) 문서 순서로 가장 가까운 조각에
 *   붙는다: 시작은 뒤쪽 첫 조각의 처음, 끝은 앞쪽 마지막 조각의 끝 (Range 와 겹치는 조각만 센다).
 * - 조각 밖 글자는 무시한다. 조각을 하나도 건드리지 않으면 빈 배열.
 * - 한 쪽 안에서는 겹친 조각들의 (o + 지역 위치) 최솟값과 최댓값으로 범위를 만든다.
 */
export function rangeToLocal(range: Range, root: Element): LocalRange[] {
  if (range.collapsed) return [];
  const cacEl = asElement(range.commonAncestorContainer);
  if (!cacEl) return [];

  let candidates: Element[];
  if (root.contains(cacEl)) {
    const own = cacEl.closest('[data-o]');
    candidates = own && root.contains(own) ? [own] : Array.from(cacEl.querySelectorAll('[data-o]'));
  } else if (cacEl.contains(root)) {
    candidates = Array.from(root.querySelectorAll('[data-o]'));
  } else {
    return [];
  }

  const startPiece = pieceAt(range.startContainer, root);
  const endPiece = pieceAt(range.endContainer, root);
  const byPage = new Map<number, { start: number; end: number }>();

  for (const el of candidates) {
    if (!range.intersectsNode(el)) continue;
    const o = intAttr(el, 'data-o');
    const pageNo = pageNoOf(el, root);
    if (o === null || pageNo === null) continue;
    const len = pieceLength(el);
    let s = el === startPiece ? charOffsetInPiece(el, range.startContainer, range.startOffset) : 0;
    let e = el === endPiece ? charOffsetInPiece(el, range.endContainer, range.endOffset) : len;
    s = Math.max(0, Math.min(s, len));
    e = Math.max(0, Math.min(e, len));
    if (e <= s) continue;
    const cur = byPage.get(pageNo);
    if (cur) {
      cur.start = Math.min(cur.start, o + s);
      cur.end = Math.max(cur.end, o + e);
    } else {
      byPage.set(pageNo, { start: o + s, end: o + e });
    }
  }

  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNo, r]) => ({ pageNo, start: r.start, end: r.end }));
}

/** 쪽 안 정본 위치 하나 */
export interface LocalPoint {
  pageNo: number;
  offset: number;
}

/** 선택 경계점 하나의 정본 위치: 범위의 시작으로 쓸 때(fwd)와 끝으로 쓸 때(back) */
export interface PointLocal {
  /** 조각 안이면 그 글자 위치, 아니면 문서 순서로 다음 조각의 처음 (없으면 null) */
  fwd: LocalPoint | null;
  /** 조각 안이면 그 글자 위치, 아니면 문서 순서로 앞 조각의 끝 (없으면 null) */
  back: LocalPoint | null;
}

/**
 * 경계점(node, offset) → 정본 위치. 경계 규칙은 rangeToLocal 과 같다: 글자 조각 안이면 그 글자 위치,
 * 조각 밖(표시 전용 글자, 빈칸 사이)이면 시작으로 쓸 때 문서 순서로 뒤쪽 첫 조각의 처음, 끝으로 쓸 때 앞쪽
 * 마지막 조각의 끝. root 밖의 점이면 null.
 * 선택의 한쪽 끝을 정본 값으로 붙잡아 둘 때 쓴다(가상화된 시트에서 그 행이 DOM 에서 빠져도 값은 남는다).
 */
export function pointToLocal(node: Node, offset: number, root: Element): PointLocal | null {
  if (node !== root && !root.contains(node)) return null;
  const piece = pieceAt(node, root);
  if (piece) {
    const o = intAttr(piece, 'data-o');
    const pageNo = pageNoOf(piece, root);
    if (o !== null && pageNo !== null) {
      const at: LocalPoint = { pageNo, offset: o + charOffsetInPiece(piece, node, offset) };
      return { fwd: at, back: at };
    }
  }
  const probe = root.ownerDocument.createRange();
  try {
    probe.setStart(node, offset);
  } catch {
    return null;
  }
  probe.collapse(true);
  const pieces: { el: Element; o: number; len: number; pageNo: number }[] = [];
  for (const el of Array.from(root.querySelectorAll('[data-o]'))) {
    const o = intAttr(el, 'data-o');
    const pageNo = pageNoOf(el, root);
    const len = pieceLength(el);
    if (o === null || pageNo === null || len === 0) continue;
    pieces.push({ el, o, len, pageNo });
  }
  // 문서 순서 목록에서 점 뒤에서 시작하는 첫 조각 (점은 어느 조각 안에도 없으므로 앞뒤가 갈린다)
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (probe.comparePoint(pieces[mid]!.el, 0) > 0) hi = mid;
    else lo = mid + 1;
  }
  const next = pieces[lo];
  const prev = pieces[lo - 1];
  return {
    fwd: next ? { pageNo: next.pageNo, offset: next.o } : null,
    back: prev ? { pageNo: prev.pageNo, offset: prev.o + prev.len } : null,
  };
}

/** 쪽 요소의 글자 조각 목록: o 오름차순 (DOM 순서가 이미 오름차순이면 그대로) */
export function pieceIndex(pageEl: Element): PieceInfo[] {
  const out: PieceInfo[] = [];
  let sorted = true;
  let last = -1;
  for (const el of Array.from(pageEl.querySelectorAll('[data-o]'))) {
    const o = intAttr(el, 'data-o');
    if (o === null) continue;
    const len = pieceLength(el);
    if (len === 0) continue;
    if (o < last) sorted = false;
    last = o;
    out.push({ el, o, len });
  }
  if (!sorted) out.sort((a, b) => a.o - b.o);
  return out;
}

/** 조각 안 글자 위치 → (글자 노드, 노드 안 위치) */
function textPoint(piece: Element, char: number): { node: Text; offset: number } | null {
  const doc = piece.ownerDocument;
  const walker = doc.createTreeWalker(piece, 4 /* NodeFilter.SHOW_TEXT */);
  let acc = 0;
  let lastText: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const len = t.data.length;
    if (char <= acc + len) return { node: t, offset: Math.max(0, char - acc) };
    acc += len;
    lastText = t;
  }
  return lastText ? { node: lastText, offset: lastText.data.length } : null;
}

/** o + len > start 인 첫 조각 위치 (index 는 o 오름차순, 조각끼리 겹치지 않음) */
function firstPieceEndingAfter(index: readonly PieceInfo[], start: number): number {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = index[mid]!;
    if (p.o + p.len > start) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 조각 하나와 그 조각 안 범위의 화면 사각형 */
export interface PieceRects {
  piece: PieceInfo;
  rects: DOMRect[];
}

/**
 * 쪽 지역 정본 범위 [start, end) → 조각별 화면 사각형 (뷰포트 좌표, 조각 o 순서).
 * 범위와 겹치는 조각마다 그 글자 노드 위에 Range 를 만들어 getClientRects 를 모은다(조각 경계로 자른다).
 * 폭이나 높이가 거의 없는 사각형(줄 끝 줄바꿈 글자, display: none 조각)은 버린다. index 를 주면 다시 찾지 않는다.
 */
export function localToPieceRects(
  pageEl: Element,
  start: number,
  end: number,
  index?: readonly PieceInfo[],
): PieceRects[] {
  if (!(end > start)) return [];
  const pieces = index ?? pieceIndex(pageEl);
  const doc = pageEl.ownerDocument;
  const out: PieceRects[] = [];
  for (let i = firstPieceEndingAfter(pieces, start); i < pieces.length; i += 1) {
    const p = pieces[i]!;
    if (p.o >= end) break;
    const s = Math.max(start, p.o) - p.o;
    const e = Math.min(end, p.o + p.len) - p.o;
    if (e <= s) continue;
    const a = textPoint(p.el, s);
    const b = textPoint(p.el, e);
    if (!a || !b) continue;
    const r = doc.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      continue;
    }
    const rects = Array.from(r.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
    if (rects.length > 0) out.push({ piece: p, rects });
  }
  return out;
}

/**
 * 쪽 지역 정본 범위 [start, end) → 화면 사각형 목록 (뷰포트 좌표).
 * localToPieceRects 의 사각형을 조각 순서대로 이어 붙인 것이다.
 */
export function localToClientRects(
  pageEl: Element,
  start: number,
  end: number,
  index?: readonly PieceInfo[],
): DOMRect[] {
  const out: DOMRect[] = [];
  for (const pr of localToPieceRects(pageEl, start, end, index)) out.push(...pr.rects);
  return out;
}

/** 위치, 크기만 담은 사각형 (DOMRect 대신 계산용) */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 같은 줄의 이웃한 사각형을 하나로 합친다(조각마다 끊긴 하이라이트와 겹친 곳의 이중 칠을 없앤다).
 * 같은 줄 = 세로로 작은 쪽 높이의 절반 넘게 겹침, 이웃 = 가로 틈이 gap px 이하.
 */
export function mergeLineBoxes(rects: readonly Box[], gap = 2): Box[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: Box[] = [];
  for (const r of sorted) {
    let merged = false;
    for (let i = out.length - 1; i >= 0 && i >= out.length - 8; i -= 1) {
      const m = out[i]!;
      const overlap = Math.min(m.bottom, r.bottom) - Math.max(m.top, r.top);
      const minH = Math.min(m.bottom - m.top, r.bottom - r.top);
      if (minH <= 0 || overlap < minH * 0.5) continue;
      if (r.left > m.right + gap || r.right < m.left - gap) continue;
      m.left = Math.min(m.left, r.left);
      m.top = Math.min(m.top, r.top);
      m.right = Math.max(m.right, r.right);
      m.bottom = Math.max(m.bottom, r.bottom);
      merged = true;
      break;
    }
    if (!merged) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}
