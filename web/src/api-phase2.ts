/**
 * v1.5 Phase 2 API 계약 — 문항 첨부·하이퍼링크, 지침서 원본파일
 * (api.ts 는 뷰어 담당 소유 — 신설 계약은 별도 파일 관례: api-phase1.ts 참조)
 */
import { ApiError, ConflictError, type ApiErrorBody } from './api';

// ── 문항 첨부·링크 ───────────────────────────────────────────────────────────

export interface QuestionAttachment {
  id: number;
  origName: string;
  mime: string;
  size: number;
  sort: number;
  /** pdf/png/jpg — 브라우저에서 바로 열림. 나머지는 다운로드 */
  inlinePreview: boolean;
  uploadedAt: string;
  uploadedByName: string | null;
}

export interface QuestionLink {
  id: number;
  url: string;
  label: string | null;
  sort: number;
  createdAt: string;
}

export interface QuestionFilesResponse {
  attachments: QuestionAttachment[];
  links: QuestionLink[];
}

export function fetchQuestionFiles(questionId: number): Promise<QuestionFilesResponse> {
  return request<QuestionFilesResponse>(`/api/questions/${questionId}/files`);
}

export function uploadQuestionAttachment(
  questionId: number,
  file: File,
): Promise<QuestionAttachment> {
  const fd = new FormData();
  fd.append('file', file);
  return request<QuestionAttachment>(`/api/questions/${questionId}/attachments`, {
    method: 'POST',
    formBody: fd,
  });
}

export function deleteQuestionAttachment(attachmentId: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/questions/attachments/${attachmentId}`, {
    method: 'DELETE',
  });
}

export function attachmentFileUrl(attachmentId: number): string {
  return `/api/questions/attachments/${attachmentId}/file`;
}

export function createQuestionLink(
  questionId: number,
  input: { url: string; label?: string | null },
): Promise<QuestionLink> {
  return request<QuestionLink>(`/api/questions/${questionId}/links`, {
    method: 'POST',
    jsonBody: input,
  });
}

export function deleteQuestionLink(linkId: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/questions/links/${linkId}`, { method: 'DELETE' });
}

// ── 지침서 원본파일 (B-2) ────────────────────────────────────────────────────

export function uploadDocSourceFile(
  versionId: number,
  file: File,
): Promise<{ versionId: number; sourceName: string; sourceSize: number }> {
  const fd = new FormData();
  fd.append('file', file);
  return request(`/api/docs/versions/${versionId}/source-file`, {
    method: 'POST',
    formBody: fd,
  });
}

export function docSourceFileUrl(versionId: number): string {
  return `/api/docs/versions/${versionId}/source-file`;
}

// ── fetch 래퍼 (api.ts 규약과 동일: 401 리다이렉트·409 ConflictError·issues 사유 추출) ──

interface Opts {
  method?: string;
  jsonBody?: unknown;
  formBody?: FormData;
}

async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? 'GET', credentials: 'same-origin' };
  if (opts.jsonBody !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.jsonBody);
  } else if (opts.formBody) {
    init.body = opts.formBody; // multipart 경계는 브라우저가 설정
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
