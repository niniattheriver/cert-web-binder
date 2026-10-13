/**
 * 재앵커링 v1 — 분류 계획(순수 로직) (설계서 §3.4, §10 백로그 "v1 최소 구현")
 *
 * 원칙(가드레일 5): 정확 일치가 "정확히 1건"일 때만 자동(resolved_auto),
 * 그 외(0건·여러 건·박스 앵커)는 전부 needs_review — 조용한 오앵커 경로를 만들지 않는다.
 * 퍼지 매칭·후보 점수화는 v2. 여기서는 DB를 만지지 않는다(서비스가 계획을 적용).
 *
 * 정확 일치는 설계서 §3.4 1단계대로 정규화 그림자(공백, 개행, 제로폭 문자를 뺀 글자)에서 센다.
 * 화면(PDF 뷰어, Office 뷰어)은 판본 글자를 쪽 구분자('\n') 없이 이어 붙인 문자열에서 인용을 잘라 보내므로
 * 쪽 경계를 걸친 앵커의 quote_exact 에는 구분자가 없다. 원문 그대로 찾으면 글자가 하나도 바뀌지 않은 개정에서도
 * 이런 앵커가 전부 needs_review 로 떨어졌다. PDF 의 줄바꿈이 Word 문단 안 띄어쓰기가 되는 형식 전환 개정도 같다.
 * 그림자에서도 1건일 때만 자동이고, 돌려주는 오프셋은 그림자 위치를 원문 위치로 되돌린 값(첫 글자부터 끝 글자까지)이다.
 *
 * 표 칸 경계: 그림자가 공백을 지우면 칸 경계도 사라져 'QC\t1\t23' 과 'QC\t12\t3' 이 같아지고, 칸 하나였던 128450 이
 * 새 판본의 1284500 안에 들어맞는다. 숫자가 바뀐 근거가 검토 없이 자동 확정되는 길이다. 그래서
 * - 그림자에서 탭(Office, 텍스트 정본의 칸 구분자)은 지우지 않고, 시트(xlsx, xls, csv, tsv)는 줄바꿈(행)도 남긴다.
 * - 옛 인용이 칸과 어떻게 놓였는지(cells.ts QuoteCells: 칸 시작에 닿음, 칸 끝에 닿음, 칸 하나 안)를 서비스가 옛 판본의
 *   렌더 모델로 구해 넘기고, 새 자리도 새 판본 렌더 모델의 칸(ReanchorOptions.cells)에서 같은 조건을 만족해야 센다.
 * - 칸 구조가 없던 판본(PDF)에서 온 인용은 새 자리가 칸에 걸치면 칸 전체(칸 시작부터 칸 끝까지)일 때만 센다.
 * - 칸 관계를 알 수 없는 인용('unknown')은 자동으로 정하지 않는다.
 */
import { inOneCell, touchesCell, type CellIndex, type QuoteCells } from './cells.js';

export interface OldAnchorInput {
  anchorId: number;
  passageId: number;
  quoteExact: string;
  /** 박스 앵커(표/이상 읽기순서) — 개정 시 무조건 검수행 (§3.2) */
  geometryPrimary: boolean;
  /**
   * 옛 인용과 칸의 관계. QuoteCells: 칸 구조가 있는 판본(렌더 모델)에서 구한 값. 'none'(또는 없음): 칸 구조가 없던
   * 판본(PDF)의 인용. 'unknown': 구할 수 없었다(자동으로 정하지 않는다).
   */
  cells?: QuoteCells | 'none' | 'unknown';
}

export interface ReanchorOptions {
  /** 새 판본이 시트(xlsx, xls, csv, tsv)인가: 그림자에 줄바꿈(행 경계)도 남긴다 */
  sheet?: boolean;
  /** 새 판본의 칸 색인(렌더 모델). PDF, 텍스트처럼 칸이 없는 판본은 null */
  cells?: CellIndex | null;
}

export type ReanchorDecision =
  | { kind: 'auto'; startOffset: number; endOffset: number }
  | { kind: 'needs_review'; reason: 'geometry_primary' | 'not_found' | 'ambiguous'; occurrences: number };

export interface ReanchorPlanItem {
  anchor: OldAnchorInput;
  decision: ReanchorDecision;
}

/** 전건 탐색 상한 — 이 이상이면 어차피 ambiguous 확정이므로 조기 중단 */
const MAX_OCCURRENCES = 50;

/**
 * 그림자에서 빼는 글자: 공백(개행 포함)과 제로폭 문자. 단 탭(표 칸 구분자)은 남기고, 시트에서는 줄바꿈(행 구분자)도
 * 남긴다(ignorable). 앵커를 만들 때의 인용 검증(anchors/service.ts shadowOf, web pdf/pageText.ts)은 같은 판본 글자에서
 * 자른 두 문자열을 견주는 일이라 모든 공백을 뺀다.
 */
const IGNORABLE_RE = /[\s​-‍﻿]/;
const IGNORABLE_ALL_RE = /[\s​-‍﻿]/g;

/** 그림자에서 뺄 글자인가 */
function ignorable(ch: string, sheet: boolean): boolean {
  if (ch === '\t' || (sheet && ch === '\n')) return false;
  return IGNORABLE_RE.test(ch);
}

/** 원문의 정규화 그림자와 그림자 글자마다의 원문 위치 */
export interface ShadowText {
  shadow: string;
  /** map[i] = shadow 의 i 번째 글자(UTF-16 단위)가 원문에서 놓인 오프셋 */
  map: Int32Array;
  /** content[i] = shadow 의 앞 i 글자 가운데 탭, 줄바꿈이 아닌 내용 글자 수 (칸 경계 자리를 셀 때 쓴다, cells.ts innerBounds) */
  content: Int32Array;
  /** 시트 규칙(줄바꿈을 남김)으로 만들었는가 */
  sheet: boolean;
}

/**
 * 판본 전문 → 그림자. 전문은 추출기가 이미 NFC 로 정규화한 정본이라 다시 정규화하지 않는다
 * (정규화로 길이가 바뀌면 위치 표가 원문과 어긋난다).
 */
export function buildShadow(text: string, sheet = false): ShadowText {
  const map = new Int32Array(text.length);
  const parts: string[] = [];
  let n = 0;
  let runStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (ignorable(text.charAt(i), sheet)) {
      if (runStart >= 0) {
        parts.push(text.slice(runStart, i));
        runStart = -1;
      }
      continue;
    }
    if (runStart < 0) runStart = i;
    map[n] = i;
    n += 1;
  }
  if (runStart >= 0) parts.push(text.slice(runStart));
  const shadow = parts.join('');
  const content = new Int32Array(shadow.length + 1);
  for (let i = 0; i < shadow.length; i += 1) {
    const ch = shadow.charAt(i);
    content[i + 1] = content[i]! + (ch === '\t' || ch === '\n' ? 0 : 1);
  }
  return { shadow, map: map.subarray(0, n), content, sheet };
}

/** 인용문의 그림자(buildShadow 와 같은 규칙) */
export function quoteShadow(quote: string, sheet = false): string {
  return quote.normalize('NFC').replace(IGNORABLE_ALL_RE, (ch) => (ignorable(ch, sheet) ? '' : ch));
}

/** needle의 모든 출현 위치(겹침 포함 — "전건 탐색"의 보수적 해석) */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && out.length < MAX_OCCURRENCES) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

/** 새 자리 안쪽의 칸 경계 자리(cells.ts innerBounds 와 같은 잣대: 자리 앞에서부터 센 내용 글자 수) */
function newInner(cells: CellIndex, text: ShadowText, si: number, s: number, e: number): number[] {
  const out: number[] = [];
  for (const b of cells.bounds) {
    if (b <= s) continue;
    if (b >= e) break;
    // b 이상인 첫 그림자 글자 = 경계 앞까지의 그림자 글자 수
    let lo = si;
    let hi = text.map.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (text.map[mid]! < b) lo = mid + 1;
      else hi = mid;
    }
    const count = text.content[lo]! - text.content[si]!;
    if (out[out.length - 1] !== count) out.push(count);
  }
  return out;
}

const sameList = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** 새 자리(그림자 si 부터 len 글자, 원문 [s, e))가 옛 인용의 칸 조건을 만족하는가 */
function fitsCells(
  old: QuoteCells | 'none',
  si: number,
  s: number,
  e: number,
  text: ShadowText,
  cells: CellIndex | null | undefined,
): boolean {
  if (old === 'none') {
    // 칸 구조가 없던 판본의 인용: 새 자리가 칸에 걸치면 칸 하나 전체일 때만
    if (!cells || !touchesCell(cells, s, e)) return true;
    return cells.starts.has(s) && cells.ends.has(e) && newInner(cells, text, si, s, e).length === 0;
  }
  const prose = !old.start && !old.end && !old.single && old.inner.length === 0;
  if (!cells) return prose; // 칸을 확인할 수 없는 새 판본(PDF, 텍스트): 칸 조건이 있으면 자동으로 정하지 않는다
  return (
    (!old.start || cells.starts.has(s)) &&
    (!old.end || cells.ends.has(e)) &&
    (!old.single || inOneCell(cells, s, e)) &&
    // 안쪽 칸 경계의 수와 자리가 같아야 한다: 행이 갈라지거나(128450 → 128 / 450) 칸이 합쳐진 개정을 막는다
    sameList(old.inner, newInner(cells, text, si, s, e))
  );
}

/** newFullText 는 신판 전문 또는 그 그림자(planReanchor 가 한 번만 만들어 넘긴다) */
export function planOne(
  anchor: OldAnchorInput,
  newFullText: string | ShadowText,
  opts: ReanchorOptions = {},
): ReanchorDecision {
  if (anchor.geometryPrimary) {
    // geometry는 판본 간 자동 이관 금지 (§3.2 표/박스 앵커)
    return { kind: 'needs_review', reason: 'geometry_primary', occurrences: 0 };
  }
  const text = typeof newFullText === 'string' ? buildShadow(newFullText, opts.sheet === true) : newFullText;
  const needle = quoteShadow(anchor.quoteExact, text.sheet);
  const hits = findAllOccurrences(text.shadow, needle);
  const old = anchor.cells ?? 'none';
  if (old === 'unknown') {
    return { kind: 'needs_review', reason: hits.length > 0 ? 'ambiguous' : 'not_found', occurrences: hits.length };
  }
  const constrained = old === 'none' ? !!opts.cells : old.start || old.end || old.single || old.inner.length > 0 || !!opts.cells;
  let found = hits;
  if (constrained) {
    // 상한에서 멈춘 목록을 거르면 남은 수를 믿을 수 없다
    if (hits.length >= MAX_OCCURRENCES) return { kind: 'needs_review', reason: 'ambiguous', occurrences: hits.length };
    found = hits.filter((s) => fitsCells(old, s, text.map[s]!, text.map[s + needle.length - 1]! + 1, text, opts.cells));
  }
  if (found.length === 1) {
    const s = found[0]!;
    // 그림자 위치 → 원문 위치: 인용 첫 글자부터 끝 글자까지(앞뒤 공백은 범위에 넣지 않는다)
    return { kind: 'auto', startOffset: text.map[s]!, endOffset: text.map[s + needle.length - 1]! + 1 };
  }
  if (found.length === 0) return { kind: 'needs_review', reason: 'not_found', occurrences: 0 };
  return { kind: 'needs_review', reason: 'ambiguous', occurrences: found.length };
}

export function planReanchor(
  anchors: OldAnchorInput[],
  newFullText: string,
  opts: ReanchorOptions = {},
): ReanchorPlanItem[] {
  const text = buildShadow(newFullText, opts.sheet === true); // 전문 그림자는 판본마다 한 번만 만든다
  return anchors.map((anchor) => ({ anchor, decision: planOne(anchor, text, opts) }));
}
