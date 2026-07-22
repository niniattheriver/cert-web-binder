/**
 * v1.5 Phase 1 API 계약 — 결과 요약(/summary)·기관 정보(/org)·검수 큐 집계(/review)
 * api.ts 는 뷰어 담당 소유라 수정하지 않고 여기 신설 (선례: api-day2-extra.ts, api-rich.ts).
 * fetch 래퍼는 api.ts 규약과 동일: 401 → /login 리다이렉트, 409 → ConflictError.
 */
import {
  ApiError,
  ConflictError,
  type ActiveCycle,
  type AnswerChoice,
  type ApiErrorBody,
  type AppSettings,
  type QuestionType,
} from './api';

// ── 결과 요약 ────────────────────────────────────────────────────────────────

export interface SummaryItem {
  id: number;
  questionNo: string;
  body: string;
  maxScore: number | null;
  answerChoice: AnswerChoice | null;
  score: number | null;
  findingsText: string | null;
  questionType: QuestionType | null;
  gradeSymbol: string | null;
  deducted: boolean;
  hasFindings: boolean;
  /** 예→만점 자동 채움 후 미확인 (Phase 2) */
  autofilled: boolean;
}

export interface SummaryCategory {
  id: number;
  code: string;
  name: string;
  items: SummaryItem[];
}

export interface SummaryResponse {
  activeCycle: ActiveCycle | null;
  totals: { total: number; deducted: number; findings: number; autofilled: number };
  categories: SummaryCategory[];
}

export function fetchSummary(): Promise<SummaryResponse> {
  return request<SummaryResponse>('/api/summary');
}

// ── 기관 정보 ────────────────────────────────────────────────────────────────

export type MetricValueType = 'number' | 'integer' | 'text';

export interface OrgMetric {
  id: number;
  metricKey: string;
  label: string;
  value: string | null; // NULL = '입력값 없음' (0 아님)
  unit: string | null;
  valueType: MetricValueType;
  rowVersion: number;
  updatedAt: string;
  updatedByName: string | null;
}

export interface OrgResponse {
  settings: AppSettings;
  activeCycle: ActiveCycle | null;
  metrics: OrgMetric[];
}

export function fetchOrg(): Promise<OrgResponse> {
  return request<OrgResponse>('/api/org');
}

export function patchOrgSettings(input: {
  orgName?: string;
  systemName?: string;
}): Promise<{ settings: AppSettings }> {
  return request<{ settings: AppSettings }>('/api/org/settings', {
    method: 'PATCH',
    jsonBody: input,
  });
}

export interface CreateMetricInput {
  metricKey: string;
  label: string;
  unit?: string | null;
  valueType?: MetricValueType;
  value?: string | null;
}

export function createOrgMetric(input: CreateMetricInput): Promise<OrgMetric> {
  return request<OrgMetric>('/api/org/metrics', { method: 'POST', jsonBody: input });
}

export function patchOrgMetric(
  id: number,
  input: { rowVersion: number; label?: string; unit?: string | null; value?: string | null },
): Promise<OrgMetric> {
  return request<OrgMetric>(`/api/org/metrics/${id}`, { method: 'PATCH', jsonBody: input });
}

export function deleteOrgMetric(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/org/metrics/${id}`, { method: 'DELETE' });
}

// ── 검수 큐 집계 ─────────────────────────────────────────────────────────────

export interface ReviewDocSummary {
  documentId: number;
  code: string | null;
  title: string;
  versionId: number;
  versionLabel: string;
  needsReview: number;
}

/** 자동배점 stale 항목 — 지표/구간 변경 후 미확정 (Phase 3a. newScore null = 입력값 없음) */
export interface ReviewAutoStaleItem {
  questionId: number;
  questionNo: string;
  categoryId: number;
  currentScore: number | null;
  newScore: number | null;
  metricKey: string | null;
  metricLabel: string | null;
  metricValue: string | null;
}

/** 재확인(needs_recheck) 문항 — 개정·재인입·배점/유형 편차 (Phase 3b) */
export interface ReviewRecheckItem {
  questionId: number;
  questionNo: string;
  categoryId: number;
  categoryCode: string;
  revisionNote: string | null;
  score: number | null;
  maxScore: number | null;
}

export interface ReviewSummaryResponse {
  total: number;
  docs: ReviewDocSummary[];
  autoStale: ReviewAutoStaleItem[];
  recheck: ReviewRecheckItem[];
}

/** 재확인 해소 — 명시적 사용자 액션 (인입은 켜기만 함) */
export function resolveRecheck(questionId: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/questions/${questionId}/recheck-resolve`, {
    method: 'POST',
  });
}

export function fetchReviewSummary(): Promise<ReviewSummaryResponse> {
  return request<ReviewSummaryResponse>('/api/review/summary');
}

// ── 근거 추천 (v1.5 Phase 5 — C-1) ──────────────────────────────────────────

export interface EvidenceSuggestHit {
  documentId: number;
  versionId: number;
  docTitle: string;
  pageNo: number;
  snippet: string;
  /** 동시에 일치한 검색 키워드 수 (높을수록 상위) */
  matched: number;
}

export interface EvidenceSuggestResponse {
  keywords: string[];
  hits: EvidenceSuggestHit[];
}

export function suggestEvidence(questionId: number): Promise<EvidenceSuggestResponse> {
  return request<EvidenceSuggestResponse>(`/api/questions/${questionId}/evidence-suggest`);
}

// ── 사용자 계정 관리 (v1.5 — admin 전용) ────────────────────────────────────

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface ManagedUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  expiresAt: string | null;
  isSelf: boolean;
}

export function fetchUsers(): Promise<{ users: ManagedUser[] }> {
  return request<{ users: ManagedUser[] }>('/api/admin/users');
}

export function createUser(input: {
  username: string;
  displayName: string;
  role: UserRole;
  password?: string;
  expiresAt?: string;
}): Promise<{ user: ManagedUser; password: string; generated: boolean }> {
  return request('/api/admin/users', { method: 'POST', jsonBody: input });
}

export function patchUser(
  id: number,
  input: { displayName?: string; role?: UserRole; active?: boolean; expiresAt?: string | null },
): Promise<{ user: ManagedUser }> {
  return request(`/api/admin/users/${id}`, { method: 'PATCH', jsonBody: input });
}

export function resetUserPassword(
  id: number,
  password?: string,
): Promise<{ password: string; generated: boolean }> {
  return request(`/api/admin/users/${id}/reset-password`, {
    method: 'POST',
    jsonBody: password ? { password } : {},
  });
}

export function changeMyPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request('/api/auth/change-password', {
    method: 'POST',
    jsonBody: { currentPassword, newPassword },
  });
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
  // details: 서버 자작 문자열 또는 zod issues 배열 — 배열이면 첫 issue의 한국어 message를 사용
  const d = errBody?.details;
  const firstIssueMsg =
    Array.isArray(d) && typeof (d[0] as { message?: unknown } | undefined)?.message === 'string'
      ? (d[0] as { message: string }).message
      : null;
  const detail = typeof d === 'string' ? d : firstIssueMsg;
  throw new ApiError(res.status, errBody, detail ?? `요청에 실패했습니다. (HTTP ${res.status})`);
}
