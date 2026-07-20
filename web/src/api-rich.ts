/**
 * 자유양식 근거문서(rich_doc) API 클라이언트 (설계서 §2, §4 #8 — 임무 A 소유)
 * api.ts(뷰어 담당 소유)를 건드리지 않기 위해 별도 파일. 오류 타입만 api.ts 에서 재사용.
 * - 409: ConflictError(server=서버 최신본) — 자동저장 충돌 처리에 사용.
 * - 이미지는 내용주소 첨부 업로드(POST /api/attachments) → {sha256,url}. base64 금지.
 */
import { ApiError, ConflictError, type ApiErrorBody } from './api';

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface RichDocLinkedQuestion {
  questionId: number;
  questionNo: string;
  categoryId: number;
  categoryCode: string;
  sort: number;
  note: string | null;
}

export interface RichDocFull {
  id: number;
  title: string;
  /** ProseMirror JSON 원본 문자열(TEXT) — 편집기 로드 시 JSON.parse */
  contentJson: string;
  contentPlain: string | null;
  rowVersion: number;
  updatedAt: string;
  updatedByName: string | null;
  questions: RichDocLinkedQuestion[];
}

export interface RichDocListItem {
  id: number;
  title: string;
  updatedAt: string;
  updatedByName: string | null;
  plainPreview: string;
  questionCount: number;
}

export interface RichDocListResponse {
  docs: RichDocListItem[];
}

export interface AttachmentInfo {
  sha256: string;
  mime: string;
  size: number;
  url: string;
}

export interface CreateRichDocInput {
  title: string;
  /** ProseMirror JSON 객체 또는 문자열 — 서버가 정규화 */
  contentJson?: unknown;
  contentPlain?: string | null;
  questionId?: number;
}

export interface UpdateRichDocInput {
  rowVersion: number;
  title?: string;
  contentJson?: unknown;
  contentPlain?: string | null;
}

// ── fetch 래퍼 (api.ts 규약과 동일: 401 리다이렉트·409 ConflictError) ──────────

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
  const detail = typeof errBody?.details === 'string' ? errBody.details : null;
  throw new ApiError(res.status, errBody, detail ?? `요청에 실패했습니다. (HTTP ${res.status})`);
}

// ── 엔드포인트 ───────────────────────────────────────────────────────────────

export function listRichDocs(): Promise<RichDocListResponse> {
  return request<RichDocListResponse>('/api/richdocs');
}

export function fetchRichDoc(id: number | string): Promise<RichDocFull> {
  return request<RichDocFull>(`/api/richdocs/${id}`);
}

export function createRichDoc(input: CreateRichDocInput): Promise<RichDocFull> {
  return request<RichDocFull>('/api/richdocs', { method: 'POST', jsonBody: input });
}

export function updateRichDoc(id: number | string, input: UpdateRichDocInput): Promise<RichDocFull> {
  return request<RichDocFull>(`/api/richdocs/${id}`, { method: 'PATCH', jsonBody: input });
}

export function deleteRichDoc(id: number | string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/richdocs/${id}`, { method: 'DELETE' });
}

export function linkRichDoc(id: number | string, questionId: number): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(`/api/richdocs/${id}/links`, {
    method: 'POST',
    jsonBody: { questionId },
  });
}

export function unlinkRichDoc(
  id: number | string,
  questionId: number,
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(`/api/richdocs/${id}/links/${questionId}`, { method: 'DELETE' });
}

export function uploadAttachment(file: File): Promise<AttachmentInfo> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return request<AttachmentInfo>('/api/attachments', { method: 'POST', formBody: fd });
}
