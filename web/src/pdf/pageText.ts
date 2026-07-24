/**
 * 판본 페이지 텍스트 캐시 + 선택문→오프셋 매칭 (설계서 §3.1/§3.2)
 *
 * - /api/docs/versions/:vid/page-text 를 판본당 1회만 로드해 모듈 캐시에 보관.
 * - 선택 텍스트(브라우저 DOM 기반)와 서버 저장 텍스트는 공백/개행이 다를 수 있으므로
 *   매칭은 "공백·제로폭 제거 그림자 문자열 + 원본 오프셋 맵"으로 수행한다
 *   (설계서 §3.1 '정규화 그림자' 원칙의 클라이언트판).
 * - 서버 오프셋(전역)은 page.startOffset + 지역 인덱스로 환산한다.
 */
import { fetchVersionPageText, type PageTextEntry } from '../api';

export interface PageTextData {
  /** pageNo 오름차순 정렬본 */
  pages: PageTextEntry[];
  /** 로컬 연결 문자열(joined)에서 각 페이지의 시작 인덱스 */
  cum: number[];
  /** 전 페이지 텍스트 연결 */
  joined: string;
}

const cache = new Map<number, Promise<PageTextData>>();
const CACHE_MAX = 6;

export function loadPageText(versionId: number): Promise<PageTextData> {
  const hit = cache.get(versionId);
  if (hit) return hit;
  const p = fetchVersionPageText(versionId).then((res) => {
    const pages = [...(res.pages ?? [])].sort((a, b) => a.pageNo - b.pageNo);
    const cum: number[] = [];
    const parts: string[] = [];
    let acc = 0;
    for (const pg of pages) {
      cum.push(acc);
      acc += pg.text.length;
      parts.push(pg.text);
    }
    return { pages, cum, joined: parts.join('') };
  });
  cache.set(versionId, p);
  // 실패 시 캐시에서 제거해 재시도 가능하게 유지
  p.catch(() => {
    if (cache.get(versionId) === p) cache.delete(versionId);
  });
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined && first !== versionId) cache.delete(first);
  }
  return p;
}

/** 공백(개행 포함)·제로폭 문자(U+200B~D, U+FEFF) 여부 */
const IGNORABLE_RE = /[\s\u200B-\u200D\uFEFF]/;
function isIgnorable(ch: string): boolean {
  return IGNORABLE_RE.test(ch);
}

interface Shadow {
  shadow: string;
  /** shadow[i] 의 원본 인덱스 */
  map: number[];
}

function buildShadow(s: string): Shadow {
  const map: number[] = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (isIgnorable(ch)) continue;
    out += ch;
    map.push(i);
  }
  return { shadow: out, map };
}

export interface QuoteMatch {
  /** joined 기준 시작(포함) */
  startLocal: number;
  /** joined 기준 끝(제외) */
  endLocal: number;
  /** 검색 구간 내 총 일치 수 */
  matches: number;
}

/**
 * 선택 텍스트를 페이지 범위 내에서 탐색.
 * 여러 건이면 expectedLocal(선택 rect 의 세로 위치로 추정한 문자 위치)에 가장 가까운 건 선택.
 */
export function findQuoteInPages(
  data: PageTextData,
  selText: string,
  pageFrom: number,
  pageTo: number,
  expectedLocal: number,
): QuoteMatch | null {
  const n = data.pages.length;
  if (n === 0) return null;
  const idxFrom = Math.min(Math.max(pageFrom - 1, 0), n - 1);
  const idxTo = Math.min(Math.max(pageTo - 1, idxFrom), n - 1);
  const segStart = data.cum[idxFrom] ?? 0;
  const segEnd = idxTo + 1 < n ? (data.cum[idxTo + 1] ?? data.joined.length) : data.joined.length;

  const needle = buildShadow(selText.normalize('NFC'));
  if (needle.shadow.length === 0) return null;
  const seg = data.joined.slice(segStart, segEnd);
  const hay = buildShadow(seg);

  const starts: number[] = [];
  let from = 0;
  while (starts.length < 200) {
    const at = hay.shadow.indexOf(needle.shadow, from);
    if (at === -1) break;
    starts.push(at);
    from = at + 1;
  }
  if (starts.length === 0) return null;

  let best = starts[0]!; // starts.length > 0 보장
  if (starts.length > 1) {
    let bestDist = Infinity;
    for (const s of starts) {
      const local = segStart + (hay.map[s] ?? 0);
      const d = Math.abs(local - expectedLocal);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
  }
  const startLocal = segStart + (hay.map[best] ?? 0);
  const endLocal = segStart + (hay.map[best + needle.shadow.length - 1] ?? 0) + 1;
  return { startLocal, endLocal, matches: starts.length };
}

/** joined 로컬 인덱스 → 페이지 배열 인덱스 (인덱스 위치를 포함하는 페이지) */
export function pageIndexAt(data: PageTextData, local: number): number {
  const { cum, pages } = data;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cum[mid] ?? Infinity) <= local) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** joined 로컬 오프셋 → 서버 전역 오프셋 (page.startOffset 기준) */
export function toGlobalOffset(data: PageTextData, local: number): number {
  const i = pageIndexAt(data, Math.max(0, Math.min(local, data.joined.length - 1)));
  return (data.pages[i]?.startOffset ?? 0) + (local - (data.cum[i] ?? 0));
}
