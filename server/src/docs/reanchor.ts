/**
 * 재앵커링 v1 — 분류 계획(순수 로직) (설계서 §3.4, §10 백로그 "v1 최소 구현")
 *
 * 원칙(가드레일 5): 정확 일치가 "정확히 1건"일 때만 자동(resolved_auto),
 * 그 외(0건·여러 건·박스 앵커)는 전부 needs_review — 조용한 오앵커 경로를 만들지 않는다.
 * 퍼지 매칭·후보 점수화는 v2. 여기서는 DB를 만지지 않는다(서비스가 계획을 적용).
 */

export interface OldAnchorInput {
  anchorId: number;
  passageId: number;
  quoteExact: string;
  /** 박스 앵커(표/이상 읽기순서) — 개정 시 무조건 검수행 (§3.2) */
  geometryPrimary: boolean;
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

export function planOne(anchor: OldAnchorInput, newFullText: string): ReanchorDecision {
  if (anchor.geometryPrimary) {
    // geometry는 판본 간 자동 이관 금지 (§3.2 표/박스 앵커)
    return { kind: 'needs_review', reason: 'geometry_primary', occurrences: 0 };
  }
  const hits = findAllOccurrences(newFullText, anchor.quoteExact);
  if (hits.length === 1) {
    const start = hits[0]!;
    return { kind: 'auto', startOffset: start, endOffset: start + anchor.quoteExact.length };
  }
  if (hits.length === 0) return { kind: 'needs_review', reason: 'not_found', occurrences: 0 };
  return { kind: 'needs_review', reason: 'ambiguous', occurrences: hits.length };
}

export function planReanchor(anchors: OldAnchorInput[], newFullText: string): ReanchorPlanItem[] {
  return anchors.map((anchor) => ({ anchor, decision: planOne(anchor, newFullText) }));
}
