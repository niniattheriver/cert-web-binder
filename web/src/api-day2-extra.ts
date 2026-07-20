/**
 * Day 2 — 상세화면 담당 보조 API (api.ts 는 뷰어 담당 소유라 수정하지 않고 여기 신설)
 * - resolvePassageTarget: 옴니박스 발췌 히트(passageId·docTitle만 옴) → /docs/:id?hl= 딥링크 좌표 해석
 * - patchQuestionEvidenceItems: richdoc 항목(richDocId)까지 보낼 수 있는 근거 PATCH
 */
import {
  ApiError,
  fetchDocs,
  fetchVersionAnchors,
  type EvidenceResponse,
} from './api';

// ── 옴니박스 발췌 → 문서 뷰어 딥링크 해석 ───────────────────────────────────

export interface PassageTarget {
  documentId: number;
  versionId: number | null;
  anchorId: number | null;
}

/**
 * 검색 응답의 발췌 히트에는 passageId·docTitle 만 있으므로, 문서 목록에서 제목이
 * 일치하는 문서(우선)부터 현재 판본 앵커를 조회해 anchorId 를 찾는다.
 * 못 찾으면 제목 일치 문서만이라도(앵커 딥링크 없이) 반환, 그마저 없으면 null.
 */
export async function resolvePassageTarget(
  passageId: number,
  docTitle?: string,
): Promise<PassageTarget | null> {
  const { docs } = await fetchDocs();
  const preferred = docTitle ? docs.filter((d) => d.title === docTitle) : [];
  const rest = docs.filter((d) => !preferred.includes(d));
  for (const d of [...preferred, ...rest]) {
    const vid = d.currentVersion?.id;
    if (vid == null) continue;
    try {
      const { anchors } = await fetchVersionAnchors(vid);
      const hit = anchors.find((a) => a.passageId === passageId);
      if (hit) return { documentId: d.id, versionId: vid, anchorId: hit.anchorId };
    } catch {
      // 개별 판본 조회 실패는 건너뜀 — 다음 문서에서 계속 탐색
    }
  }
  const byTitle = preferred[0];
  if (byTitle) {
    return {
      documentId: byTitle.id,
      versionId: byTitle.currentVersion?.id ?? null,
      anchorId: null,
    };
  }
  return null;
}

// ── 근거 순서/메모 PATCH (richdoc 포함 전체 항목 전송) ──────────────────────

export interface EvidencePatchItemFull {
  type: 'passage' | 'richdoc';
  passageId?: number;
  richDocId?: number;
  sort: number;
  /** 키가 있으면 갱신(null=비움), 없으면 기존 값 유지 — 서버 계약 */
  note?: string | null;
}

export async function patchQuestionEvidenceItems(
  questionId: number | string,
  items: EvidencePatchItemFull[],
): Promise<EvidenceResponse> {
  const res = await fetch(`/api/questions/${questionId}/evidence`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (res.ok) return parsed as EvidenceResponse;
  const body = parsed && typeof parsed === 'object' ? (parsed as { error: string }) : null;
  if (res.status === 401 && !window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
  throw new ApiError(
    res.status,
    body,
    typeof (body as { details?: unknown } | null)?.details === 'string'
      ? String((body as { details?: unknown }).details)
      : `근거 목록 저장에 실패했습니다. (HTTP ${res.status})`,
  );
}
