/**
 * v1.5 Phase 3a API 계약 — 합산/자동 채점(/scoring)·준비도 진단(/readiness)
 * (api.ts 는 뷰어 담당 소유 — 신설 계약은 별도 파일 관례)
 */
import { ApiError, ConflictError, type ApiErrorBody } from './api';

// ── 통합 채점 ────────────────────────────────────────────────────────────────

export type ScoringMode = 'simple' | 'composite' | 'auto';

export interface Criterion {
  id: number;
  parentId: number | null;
  sort: number;
  label: string;
  maxScore: number;
  score: number | null;
}

export interface AutoBand {
  lower: number | null;
  upper: number | null;
  score: number;
}

export interface AutoRuleInfo {
  sourceMetricKey: string | null;
  bands: AutoBand[];
  metric: {
    metricKey: string;
    label: string;
    value: string | null;
    unit: string | null;
    valueType: 'number' | 'integer' | 'text';
  } | null;
  state: { computedScore: number | null; stale: boolean; computedAt: string | null } | null;
}

export interface ScoringInfo {
  questionId: number;
  mode: ScoringMode;
  score: number | null;
  maxScore: number | null;
  scoreOverridden: boolean;
  rowVersion: number;
  criteria: Criterion[];
  criteriaTotal: { score: number | null; maxScore: number };
  autoRule: AutoRuleInfo | null;
}

export function fetchScoring(questionId: number): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/${questionId}/scoring`);
}

export function patchScoringMode(questionId: number, mode: ScoringMode): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/${questionId}/scoring-mode`, {
    method: 'PATCH',
    jsonBody: { mode },
  });
}

export function createCriterion(
  questionId: number,
  input: { label: string; maxScore: number; parentId?: number | null },
): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/${questionId}/criteria`, {
    method: 'POST',
    jsonBody: input,
  });
}

export function patchCriterion(
  criterionId: number,
  input: { label?: string; maxScore?: number; score?: number | null },
): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/criteria/${criterionId}`, {
    method: 'PATCH',
    jsonBody: input,
  });
}

export function deleteCriterion(criterionId: number): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/criteria/${criterionId}`, { method: 'DELETE' });
}

export function putAutoRule(
  questionId: number,
  input: { sourceMetricKey: string | null; bands: AutoBand[] },
): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/${questionId}/auto-rule`, {
    method: 'PUT',
    jsonBody: input,
  });
}

export function computeAutoScore(questionId: number): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/${questionId}/auto-rule/compute`, {
    method: 'POST',
  });
}

export function overrideScore(
  questionId: number,
  input: { score: number; reason: string },
): Promise<ScoringInfo> {
  return request<ScoringInfo>(`/api/questions/${questionId}/scoring-override`, {
    method: 'POST',
    jsonBody: input,
  });
}

// ── 준비도 진단 (C-2) ────────────────────────────────────────────────────────

export interface ReadinessCategory {
  id: number;
  code: string;
  name: string;
  questionCount: number;
  noEvidence: number;
  autofilled: number;
  needsRecheck: number;
  metricMissing: number;
}

export interface ReadinessResponse {
  categories: ReadinessCategory[];
  totals: {
    noEvidence: number;
    autofilled: number;
    needsRecheck: number;
    metricMissing: number;
    /** 지침서 개정으로 재연결이 필요한 근거 수 — 대시보드 빨간 카드 (설계서 §4 #2) */
    anchorOpen: number;
    reviewOpen: number;
  };
}

/** cycleId 지정 시 그 연도(주기) 기준 집계. 미지정이면 현재 주기. */
export function fetchReadiness(cycleId?: number): Promise<ReadinessResponse> {
  const qs = cycleId != null ? `?cycle=${cycleId}` : '';
  return request<ReadinessResponse>(`/api/readiness${qs}`);
}

// ── fetch 래퍼 (api.ts 규약과 동일) ──────────────────────────────────────────

interface Opts {
  method?: string;
  jsonBody?: unknown;
}

async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? 'GET', credentials: 'same-origin' };
  if (opts.jsonBody !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.jsonBody);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, null, '서버에 연결할 수 없습니다. 서버 상태를 확인하세요.');
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (res.ok) return parsed as T;

  const errBody = parsed && typeof parsed === 'object' ? (parsed as ApiErrorBody) : null;

  if (res.status === 401) {
    if (!window.location.pathname.startsWith('/login')) window.location.assign('/login');
    throw new ApiError(401, errBody, '로그인이 필요합니다.');
  }
  if (res.status === 409) {
    throw new ConflictError(errBody, errBody?.server ?? null);
  }
  const d = errBody?.details;
  const firstIssueMsg =
    Array.isArray(d) && typeof (d[0] as { message?: unknown } | undefined)?.message === 'string'
      ? (d[0] as { message: string }).message
      : null;
  const detail = typeof d === 'string' ? d : firstIssueMsg;
  throw new ApiError(res.status, errBody, detail ?? `요청에 실패했습니다. (HTTP ${res.status})`);
}
