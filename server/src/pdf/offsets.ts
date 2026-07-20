/**
 * 전역 오프셋 ↔ (페이지, 지역 오프셋) 양방향 변환 유틸 — 설계서 §3.1-4
 *
 * 판본 "전문(full text)"의 정의: 페이지 텍스트들을 구분자 '\n' 1자로 이어붙인 문자열.
 * page_text.start_offset 은 이 전문 기준 각 페이지의 시작 오프셋이다.
 * 앵커의 start_offset/end_offset(정규화 전문 기준)이 전부 이 정의 위에서 동작하므로
 * 누적 계산의 정확성이 앵커 체계 전체의 근간이다 — offsets.test.ts에서 왕복 검증.
 */

/** 페이지 사이 구분자 — 전문 오프셋 계산의 고정 상수 (변경 = 기존 앵커 전체 파손) */
export const PAGE_SEPARATOR = '\n';

export interface PageInput {
  pageNo: number; // 1-기준
  text: string;
}

export interface PageOffsetEntry {
  pageNo: number;
  startOffset: number;
  text: string;
}

/** 페이지 목록(pageNo 오름차순 정렬됨) → 시작 오프셋 누적 계산 */
export function buildPageOffsets(pages: PageInput[]): PageOffsetEntry[] {
  const sorted = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  const out: PageOffsetEntry[] = [];
  let offset = 0;
  for (const p of sorted) {
    out.push({ pageNo: p.pageNo, startOffset: offset, text: p.text });
    offset += p.text.length + PAGE_SEPARATOR.length;
  }
  return out;
}

/** 전문 문자열 (페이지 텍스트를 PAGE_SEPARATOR로 연결) */
export function fullTextOf(entries: PageOffsetEntry[]): string {
  return entries.map((e) => e.text).join(PAGE_SEPARATOR);
}

/** 전문 총 길이 (마지막 페이지 끝, exclusive 오프셋 상한) */
export function fullTextLength(entries: PageOffsetEntry[]): number {
  const last = entries[entries.length - 1];
  if (!last) return 0;
  return last.startOffset + last.text.length;
}

export interface LocalPosition {
  pageNo: number;
  offset: number; // 페이지 텍스트 내 0-기준. text.length(= 페이지 끝, exclusive) 허용.
}

/**
 * 전역 오프셋 → (페이지, 지역 오프셋).
 * 페이지 경계 구분자 위치(= 해당 페이지 끝)는 그 페이지의 offset=text.length 로 귀속된다
 * (범위 끝(exclusive) 오프셋이 자연스럽게 동작하도록).
 */
export function globalToLocal(entries: PageOffsetEntry[], globalOffset: number): LocalPosition {
  if (entries.length === 0) throw new RangeError('페이지가 없습니다.');
  if (globalOffset < 0 || globalOffset > fullTextLength(entries)) {
    throw new RangeError(`전역 오프셋 범위 초과: ${globalOffset}`);
  }
  // 이진 탐색: startOffset <= globalOffset 인 마지막 엔트리
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid]!.startOffset <= globalOffset) lo = mid;
    else hi = mid - 1;
  }
  const entry = entries[lo]!;
  const local = Math.min(globalOffset - entry.startOffset, entry.text.length);
  return { pageNo: entry.pageNo, offset: local };
}

/** (페이지, 지역 오프셋) → 전역 오프셋 */
export function localToGlobal(
  entries: PageOffsetEntry[],
  pageNo: number,
  localOffset: number,
): number {
  const entry = entries.find((e) => e.pageNo === pageNo);
  if (!entry) throw new RangeError(`페이지 없음: ${pageNo}`);
  if (localOffset < 0 || localOffset > entry.text.length) {
    throw new RangeError(`지역 오프셋 범위 초과: p${pageNo} ${localOffset}`);
  }
  return entry.startOffset + localOffset;
}

export interface PageRange {
  pageNo: number;
  start: number; // 페이지 지역 오프셋 (inclusive)
  end: number; // 페이지 지역 오프셋 (exclusive)
}

/**
 * 전역 범위 [start, end) → 페이지별 지역 범위 목록 (범위와 교차하는 페이지만).
 * 페이지 경계 구분자만 걸치는 페이지(교집합 길이 0)는 제외한다.
 */
export function rangeToPageRanges(
  entries: PageOffsetEntry[],
  start: number,
  end: number,
): PageRange[] {
  if (end < start) throw new RangeError(`범위 역전: [${start}, ${end})`);
  const out: PageRange[] = [];
  for (const e of entries) {
    const pageStart = e.startOffset;
    const pageEnd = e.startOffset + e.text.length;
    const s = Math.max(start, pageStart);
    const t = Math.min(end, pageEnd);
    if (s < t) out.push({ pageNo: e.pageNo, start: s - pageStart, end: t - pageStart });
  }
  return out;
}
