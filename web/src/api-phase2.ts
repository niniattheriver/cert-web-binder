/**
 * v1.5 Phase 2 API 계약 — 문항 첨부·하이퍼링크, 지침서 원본파일
 */
import { ApiError, ConflictError, type ApiErrorBody, type FileKind } from './api';
import type { RenderModel } from './office/model';

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

/** 내려받기 전용 URL — 형식과 무관하게 항상 저장된다(미리보기 창의 [내려받기] 버튼) */
export function attachmentDownloadUrl(attachmentId: number): string {
  return `/api/questions/attachments/${attachmentId}/file?dl=1`;
}

/** 첨부 렌더 모델이 가리키는 그림 (docx, pptx, hwpx 안의 그림. 모델의 media 색인) */
export function attachmentMediaUrl(attachmentId: number, index: number): string {
  return `/api/questions/attachments/${attachmentId}/media/${index}`;
}

/**
 * 첨부 미리보기 payload: 서버가 원본 대신 텍스트, 표, 문단으로 뽑아 준다.
 * docx, xlsx, pptx, hwpx, 텍스트(txt, md, csv, tsv)는 지침서 뷰어와 같은 렌더 모델('model')로 오고,
 * 렌더 모델을 만들지 못한 파일만 예전 꼴('text', 'sheet', 'doc', 'slides')로 온다.
 */
export type AttachmentPreview =
  | { kind: 'pdf' }
  | { kind: 'image' }
  /** 서버 추출기가 만든 렌더 모델 (web/src/office/model.ts). 화면은 지침서 뷰어와 같은 렌더러로 그린다 */
  | { kind: 'model'; fileKind: Exclude<FileKind, 'pdf'>; model: RenderModel }
  | { kind: 'text'; text: string; truncated: boolean }
  | {
      kind: 'sheet';
      sheets: { name: string; rows: string[][]; truncated: boolean }[];
      truncated: boolean;
    }
  | { kind: 'doc'; paragraphs: string[]; truncated: boolean }
  | { kind: 'slides'; slides: { no: number; lines: string[] }[]; truncated: boolean }
  | { kind: 'none'; reason: string };

export interface AttachmentPreviewResponse {
  id: number;
  origName: string;
  size: number;
  mime: string;
  preview: AttachmentPreview;
}

export function fetchAttachmentPreview(attachmentId: number): Promise<AttachmentPreviewResponse> {
  return request<AttachmentPreviewResponse>(
    `/api/questions/attachments/${attachmentId}/preview`,
  );
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
    throw new ApiError(0, null, '서버에 연결할 수 없습니다. 서버 PC가 켜져 있는지, 네트워크가 연결되어 있는지 확인하세요.');
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
