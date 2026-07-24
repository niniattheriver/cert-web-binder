/**
 * API 클라이언트 — 서버 계약(오케스트레이터 공지) 기준으로 작성.
 * - 모든 요청에 세션 쿠키 동봉.
 * - 401: 로그인 화면으로 리다이렉트(로그인·세션복원 요청은 예외).
 * - 409: ConflictError 로 서버본 전체를 전달(낙관적 잠금 — 설계서 §5).
 * - 응답은 전부 JSON.
 */

// ── 계약 타입 ────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'editor' | 'viewer';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

export interface AppSettings {
  orgName: string;
  systemName: string;
  /** 서버에 초기 관리자 비밀번호 파일이 남아 있음 — 로그인 화면 최초 설치 안내용 */
  hasInitialAdminPassword?: boolean;
}

export interface MeResponse {
  user: User | null;
  settings: AppSettings;
}

export interface ActiveCycle {
  id: number;
  name: string;
  status: string;
  /** 주기 연도 (마이그레이션 이전 이름 비정형 주기는 null) */
  year?: number | null;
}

/** 연도(주기) 요약 — 홈 연도 리스트 (bootstrap.cycles) */
export interface CycleSummary {
  id: number;
  name: string;
  status: string;
  year: number | null;
  questionCount: number;
  answeredCount: number;
}

export interface CategorySummary {
  id: number;
  code: string;
  name: string;
  sort: number;
  questionCount: number;
  /** answer_choice 가 설정된 문항 수 */
  answeredCount: number;
  /** na 제외 취득점 합 */
  scoreSum: number;
  /** na 선택 문항 제외 배점 합 */
  maxSum: number;
}

export interface BootstrapResponse {
  user: User;
  settings: AppSettings;
  /** 계약상 존재하나 초기 DB 방어를 위해 null 허용 */
  activeCycle: ActiveCycle | null;
  /** 이번 응답의 분야 카드가 속한 주기 — ?cycle= 미지정이면 activeCycle과 동일 */
  cycle?: ActiveCycle | null;
  /** 연도(주기) 리스트 — 홈 연도별 진입 (새 주기 생성 시 자동 추가, 연도 내림차순) */
  cycles?: CycleSummary[];
  categories: CategorySummary[];
}

export type AnswerChoice = 'yes' | 'no' | 'na';
export type RevisionStatus = 'same' | 'modified' | 'new';
/** 문항 유형: 핵심(C) / 필요(R) / 기본(B) — 실물 서식 계약 */
export type QuestionType = 'core' | 'required' | 'basic';
/** SQLite 정수 불리언(0/1) 또는 boolean */
export type BoolLike = boolean | 0 | 1;

export interface CategoryRef {
  id: number;
  code: string;
  name: string;
}

/**
 * 분야 표시명 — code(파일명 유래)와 name(표지 유래)이 사실상 같은 이름의 변형이면
 * name만 표시한다. 실측: '수혈의학'/'수혈의학[공통]', '임상화학_요경검학'/'임상화학[요경검학]'
 * 처럼 구두점·부제만 다른 쌍을 이어 붙이면 "수혈의학 수혈의학[공통]"으로 중복 표기된다.
 */
/**
 * code가 name과 사실상 같은 명칭이라 별도 표시가 군더더기인지 여부.
 * 공백·밑줄·괄호를 지운 뒤 같거나 한쪽이 다른 쪽의 접두이면 redundant.
 * 예: code '수혈의학' vs name '수혈의학[공통]', '임상화학_요경검학' vs '임상화학[요경검학]'.
 * 반면 code '50' vs name '개인정보보호'는 서로 정보가 달라 redundant 아님(코드 병기).
 */
export function isCategoryCodeRedundant(cat: { code: string; name: string }): boolean {
  const norm = (s: string): string => s.replace(/[\s_\-[\]()（）]/g, '');
  const c = norm(cat.code);
  const n = norm(cat.name);
  return c === n || n.startsWith(c) || c.startsWith(n);
}

export function categoryLabel(cat: { code: string; name: string }): string {
  return isCategoryCodeRedundant(cat) ? cat.name : `${cat.code} ${cat.name}`;
}

export interface QuestionListItem {
  id: number;
  questionNo: string;
  body: string;
  maxScore: number | null;
  allowNa: BoolLike;
  answerChoice: AnswerChoice | null;
  score: number | null;
  /** 채점 방식 (v1.5 Phase 3a) — composite/auto 는 answer_choice 없이 score 가 유효 총점 */
  scoringMode?: 'simple' | 'composite' | 'auto';
  /** 예→만점 자동 채움 후 미확인 (v1.5 Phase 2) */
  scoreAutofilled?: BoolLike;
  /** 챕터(목차 대·중분류 제목 — v1.5 Phase 3b). null 이면 문항번호 접두 그룹핑 폴백 */
  chapterMajor?: string | null;
  chapterMinor?: string | null;
  /** 자동배점인데 지표 미바인딩/값 미입력 (v1.5 Phase 3b — 준비도 ④ 딥링크) */
  metricMissing?: BoolLike;
  /** 문항 유형(핵심/필요/기본) — 미분류 문항은 null */
  questionType?: QuestionType | null;
  /** 원문 유형기호 C/R/B — 미분류 문항은 null */
  gradeSymbol?: string | null;
  reviewed: BoolLike;
  revisionStatus: RevisionStatus | null;
  needsRecheck: BoolLike;
  /** 자동배점 후보 — 본문에 지표→점수 구간표가 감지된 문항 */
  autoCandidate?: boolean;
  hasAnswer: BoolLike;
  evidencePassages: number;
  evidenceRichdocs: number;
  /** 첨부파일·링크 수 — '근거 없음' 판단에 포함 (첨부/링크만 있어도 근거 있음) */
  attachmentCount?: number;
  linkCount?: number;
  findingsText: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

export interface CategoryQuestionsResponse {
  category: CategoryRef;
  /** 분야가 속한 주기 — 목록 헤더 '개정(연도)' 표기·breadcrumb 연도 링크용 */
  cycle?: { id: number; name: string; year?: number | null } | null;
  questions: QuestionListItem[];
}

/** GET /api/questions/:id — 문항 전 필드 + category + rowVersion */
export interface QuestionFull {
  id: number;
  categoryId?: number;
  questionNo: string;
  sortKey?: number;
  body: string;
  answerJson: string | null;
  answerPlain: string | null;
  maxScore: number | null;
  allowNa: BoolLike;
  answerChoice: AnswerChoice | null;
  score: number | null;
  /** 예→만점 자동 채움 후 미확인 (v1.5 Phase 2) */
  scoreAutofilled?: boolean;
  /** 채점 방식 — simple/composite/auto (v1.5 Phase 3a) */
  scoringMode?: 'simple' | 'composite' | 'auto';
  /** 자동 점수 수기 override 여부 (v1.5 Phase 3a) */
  scoreOverridden?: boolean;
  /** 챕터(목차 대·중분류 — v1.5 Phase 3b) */
  chapterMajor?: string | null;
  chapterMinor?: string | null;
  findingsText: string | null;
  /** 문항 유형(핵심/필요/기본) — 미분류 문항은 null */
  questionType?: QuestionType | null;
  /** 원문 유형기호 C/R/B — 미분류 문항은 null */
  gradeSymbol?: string | null;
  revisionStatus: RevisionStatus | null;
  revisionNote?: string | null;
  needsRecheck: BoolLike;
  /** 자동배점 후보 — 본문에 지표→점수 구간표가 감지된 문항 */
  autoCandidate?: boolean;
  carriedFromId?: number | null;
  /** 전년도(이월 원본) 문항의 연도 — '전년도 문항 보기' 라벨용 */
  carriedFromYear?: number | null;
  /** 이 문항을 물려받은 이후 연도 문항(최신 1건) — 되돌아가기 링크용 */
  carriedToId?: number | null;
  carriedToYear?: number | null;
  reviewed: BoolLike;
  rowVersion: number;
  updatedAt: string;
  updatedBy?: number | null;
  updatedByName?: string | null;
  category: CategoryRef;
  /** 문항이 속한 주기 — breadcrumb 연도 링크용 (v1.5.4) */
  cycle?: { id: number; name: string; year: number | null } | null;
}

/** PATCH /api/questions/:id 요청 본문 (rowVersion 필수) */
export interface QuestionPatch {
  rowVersion: number;
  answerChoice?: AnswerChoice | null;
  score?: number | null;
  /** 예→만점 자동 채움 미확인 비트 (v1.5 Phase 2 — UI 액션에서만 true) */
  scoreAutofilled?: boolean;
  findingsText?: string | null;
  answerJson?: string | null;
  answerPlain?: string | null;
  reviewed?: boolean;
}

export interface SearchFastpath {
  questionId: number;
  questionNo: string;
}

export interface SearchQuestionHit {
  id: number;
  questionNo: string;
  categoryId: number;
  categoryCode: string;
  snippet: string;
}

/** 통합 검색 — 문서 그룹 (Day 2) */
export interface SearchDocHit {
  id: number;
  title: string;
  /** 현재 판본의 연도 태그 (④ 연도 탭) — 이전 데이터는 null */
  year?: number | null;
}

/** 통합 검색 — 지침서 본문 그룹 (⑤ — 현재 판본 PDF 본문 페이지) */
export interface SearchPageHit {
  documentId: number;
  versionId: number;
  docTitle: string;
  pageNo: number;
  year: number | null;
  snippet: string;
}

/** 통합 검색 — 발췌 그룹 (Day 2) */
export interface SearchPassageHit {
  passageId: number;
  /** 스니펫(FTS snippet) */
  quote: string;
  docTitle: string;
  questionNos: string[];
}

export interface SearchResponse {
  fastpath: SearchFastpath | null;
  questions: SearchQuestionHit[];
  docs: SearchDocHit[];
  passages: SearchPassageHit[];
  /** 지침서 본문 페이지 그룹 (⑤) */
  pages: SearchPageHit[];
}

export interface ImportPreviewQuestion {
  questionNo: string;
  body: string;
  maxScore: number | null;
  allowNa: BoolLike;
}

/** 재인입 보호 필드 차이 (v1.5 A-1 — 덮어쓰지 않고 needs_recheck) */
export interface ImportProtectedDiff {
  questionNo: string;
  field: 'maxScore' | 'allowNa' | 'questionType' | 'gradeSymbol';
  current: unknown;
  parsed: unknown;
}

/** 드라이런 DB 대조 diff 리포트 (v1.5 A-1) */
export interface ImportDryRunDiff {
  create: number;
  update: number;
  unchanged: number;
  missingInPdf: string[];
  fieldChanges: Record<string, number>;
  protectedDiffs: ImportProtectedDiff[];
  criteriaEligible: number;
  criteriaManual: string[];
  criteriaViolations: Array<{ questionNo: string; reason: string }>;
  autoCandidates: string[];
  chapterMissing: number;
}

export interface ImportFilePreview {
  fileName: string;
  categoryCode: string;
  categoryName: string;
  questionCount: number;
  revisionRows: number;
  warnings: string[];
  questions: ImportPreviewQuestion[];
  diff: ImportDryRunDiff;
  // ── 전년도 이월 미리보기 (연도 지정 + 이월 켬일 때만 0 초과) ──
  /** 업로드 문항 중 (분야코드, 문항번호)로 전년도 문항과 매칭된 수 */
  carryMatched?: number;
  /** 매칭 중 전년도에 답변이 있는 문항 수 */
  carryWithAnswer?: number;
  /** 매칭 중 전년도에 근거 연결(발췌·자유문서·첨부·링크)이 있는 문항 수 */
  carryWithEvidence?: number;
}

export interface ImportDryRunResponse {
  batchId: number;
  files: ImportFilePreview[];
  /** 가져오기 대상 연도 (미지정이면 null = 활성 주기 인입) */
  targetYear?: number | null;
  /** 전년도 이월 여부 (연도 미지정이면 의미 없음) */
  carry?: boolean;
  /** 이월 원본 주기 id — 대상 연도보다 작은 최신 연도 주기 (없으면 null) */
  carrySourceCycleId?: number | null;
  /** 전 파일 합계 (파일별 carry* 필드의 합) */
  carryMatched?: number;
  carryWithAnswer?: number;
  carryWithEvidence?: number;
}

export type ImportMode = 'overwrite' | 'keep_existing' | 'reingest';

export interface ImportCommitResponse {
  created: number;
  updated: number;
  unchanged: number;
  categoriesCreated: number;
  protectedDiffs: Array<ImportProtectedDiff & { fileName: string }>;
  criteriaApplied: number;
  criteriaManual: Array<{ fileName: string; questionNo: string }>;
  criteriaViolations: Array<{ fileName: string; questionNo: string; reason: string }>;
  autoCandidates: Array<{ fileName: string; questionNo: string; rows: string[] }>;
  // ── 전년도 이월 (연도 지정 + 이월 켬 커밋에서만 0 초과) ──
  /** 답변·근거 연결을 전년도에서 복사한 신규 문항 수 */
  carriedQuestions?: number;
  /** 그중 답변이 복사된 문항 수 */
  carriedAnswers?: number;
  /** 복사된 근거 연결 행 수 합계 (발췌 + 자유문서 + 첨부 + 링크) */
  carriedEvidence?: number;
}

// ── 오류 타입 ────────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: string;
  details?: unknown;
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 409 낙관적 잠금 충돌 — server 에 서버본 전체가 담긴다 */
export class ConflictError extends ApiError {
  constructor(
    body: ApiErrorBody | null,
    public readonly server: unknown,
  ) {
    super(409, body, '다른 사용자가 먼저 저장했습니다. 최신 내용을 확인하세요.');
    this.name = 'ConflictError';
  }
}

function messageFor(status: number, body: ApiErrorBody | null): string {
  if (body?.error === 'invalid_credentials') return '아이디 또는 비밀번호가 올바르지 않습니다.';
  if (status === 429) {
    return typeof body?.details === 'string'
      ? body.details
      : '시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
  }
  if (status === 413) {
    return typeof body?.details === 'string' ? body.details : '업로드 용량이 허용치를 초과했습니다.';
  }
  if (status === 401) return '로그인이 필요합니다.';
  if (status === 403) return '권한이 없습니다. 관리자에게 문의하세요.';
  if (status === 400) {
    return body?.error ? `요청이 올바르지 않습니다. (${body.error})` : '요청이 올바르지 않습니다.';
  }
  if (status === 404) return '요청한 자료를 찾을 수 없습니다.';
  if (status >= 500) return '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.';
  return `요청에 실패했습니다. (HTTP ${status})`;
}

// ── fetch 래퍼 ───────────────────────────────────────────────────────────────

interface RequestOptions {
  method?: string;
  jsonBody?: unknown;
  formBody?: FormData;
  /** true 면 401 이어도 로그인 화면으로 리다이렉트하지 않음 (/api/me, /api/auth/*) */
  noAuthRedirect?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
  };
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
      parsed = null; // JSON 이 아닌 응답(프록시 오류 등)
    }
  }

  if (res.ok) return parsed as T;

  const errBody = parsed && typeof parsed === 'object' ? (parsed as ApiErrorBody) : null;

  if (res.status === 401 && !opts.noAuthRedirect) {
    // 세션 만료 — 로그인 화면으로 (이미 로그인 화면이면 그대로)
    if (!window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    throw new ApiError(401, errBody, '로그인이 필요합니다.');
  }
  if (res.status === 409) {
    throw new ConflictError(errBody, errBody?.server ?? null);
  }
  throw new ApiError(res.status, errBody, messageFor(res.status, errBody));
}

// ── 엔드포인트 ───────────────────────────────────────────────────────────────

export function fetchMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/me', { noAuthRedirect: true });
}

export function apiLogin(username: string, password: string): Promise<{ user: User }> {
  return request<{ user: User }>('/api/auth/login', {
    method: 'POST',
    jsonBody: { username, password },
    noAuthRedirect: true,
  });
}

export function apiLogout(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/auth/logout', { method: 'POST', noAuthRedirect: true });
}

export function fetchBootstrap(cycleId?: number): Promise<BootstrapResponse> {
  const qs = cycleId != null ? `?cycle=${cycleId}` : '';
  return request<BootstrapResponse>(`/api/bootstrap${qs}`);
}

export function fetchCategoryQuestions(
  categoryId: number | string,
): Promise<CategoryQuestionsResponse> {
  return request<CategoryQuestionsResponse>(`/api/categories/${categoryId}/questions`);
}

export function fetchQuestion(questionId: number | string): Promise<QuestionFull> {
  return request<QuestionFull>(`/api/questions/${questionId}`);
}

/** Day 1 화면은 읽기 전용이지만 계약 전체를 제공 (Day 2 편집에서 사용) */
export function patchQuestion(
  questionId: number | string,
  patch: QuestionPatch,
): Promise<QuestionFull> {
  return request<QuestionFull>(`/api/questions/${questionId}`, {
    method: 'PATCH',
    jsonBody: patch,
  });
}

export function searchAll(q: string): Promise<SearchResponse> {
  return request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

export function importQuestionPdfsDryRun(
  files: File[],
  opts?: { year?: number; carry?: boolean },
): Promise<ImportDryRunResponse> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  // 연도·이월은 미리보기(드라이런)에서 확정된다 — 커밋 본문은 {mode}만
  if (opts?.year != null) fd.append('year', String(opts.year));
  if (opts?.carry != null) fd.append('carry', opts.carry ? '1' : '0');
  return request<ImportDryRunResponse>('/api/import/question-pdfs', {
    method: 'POST',
    formBody: fd,
  });
}

export function commitQuestionPdfImport(
  batchId: number,
  mode: ImportMode,
): Promise<ImportCommitResponse> {
  return request<ImportCommitResponse>(`/api/import/question-pdfs/${batchId}/commit`, {
    method: 'POST',
    jsonBody: { mode },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Day 2 — 지침서(문서)·앵커·근거 계약 (오케스트레이터 Day 2 API 계약 기준)
// 이 파일은 뷰어 담당 소유 — 상세화면 담당은 수정하지 말고 사용만.
// ════════════════════════════════════════════════════════════════════════════

// ── 문서/판본 타입 ───────────────────────────────────────────────────────────

export interface DocCurrentVersion {
  id: number;
  versionLabel: string;
  pageCount: number;
  uploadedAt: string;
  /** 저밀도 페이지 경고(스캔 혼입 의심) — 0/1 또는 경고 문자열 */
  textWarning?: BoolLike | string | null;
  /** 판본 연도 태그 (④ 연도 탭) — 이전 데이터는 null */
  year?: number | null;
}

/** GET /api/docs?year=N — 문서별 '그 연도의 최신 판본' */
export interface DocYearVersion {
  id: number;
  versionLabel: string;
  year: number | null;
  uploadedAt: string;
  pageCount: number;
}

export interface DocSummary {
  id: number;
  code: string | null;
  title: string;
  kind: string;
  currentVersion: DocCurrentVersion | null;
  /** ?year= 필터 응답에서만 존재 — 그 연도의 최신 판본 */
  yearVersion?: DocYearVersion;
  passageCount: number;
  mappedQuestionCount: number;
}

export interface DocsResponse {
  docs: DocSummary[];
}

/** GET /api/docs/:id 의 versions[] 항목 — 서버 구현과 병렬 작업이므로 방어적으로 선택 필드 처리 */
export interface DocVersionInfo {
  id: number;
  versionLabel: string;
  pageCount?: number;
  status?: string;
  isCurrent?: BoolLike;
  uploadedAt?: string;
  textWarning?: BoolLike | string | null;
  /** 판본 연도 태그 (④ 연도 탭) — 이전 데이터는 null */
  year?: number | null;
  /** 원본 파일(hwp/docx 등 — v1.5 Phase 2 B-2). 없으면 null */
  sourceName?: string | null;
  sourceSize?: number | null;
}

export interface DocDetailResponse {
  doc: {
    id: number;
    code: string | null;
    title: string;
    kind: string;
    currentVersionId?: number;
  };
  versions: DocVersionInfo[];
  needsReviewCount: number;
}

export interface UploadDocResponse {
  documentId: number;
  versionId: number;
  pageCount: number;
  textWarning?: BoolLike | string | null;
  /** 동일 (documentId, sha256) 재업로드 — versionId 는 기존 판본 */
  duplicate?: boolean;
  /** 새 판본 업로드 시 재앵커링 v1 이관 요약 (서버 응답 필드명 reanchor — docs.ts) */
  reanchor?: { auto: number; needsReview: number };
}

// ── 앵커/발췌 타입 ───────────────────────────────────────────────────────────

/** 페이지별 정규화(0..1) 사각형 묶음 — [x0, y0, x1, y1] */
export type AnchorRectTuple = [number, number, number, number];
export interface AnchorPageRects {
  page: number;
  rects: AnchorRectTuple[];
}

export interface AnchorQuestionRef {
  id: number;
  questionNo: string;
  /** ≤60자 */
  bodyPreview: string;
  /** answer_plain ≤60자 */
  answerPreview: string | null;
}

export interface AnchorInfo {
  anchorId: number;
  passageId: number;
  /** resolved | resolved_auto | resolved_fuzzy | needs_review | unresolved | historical … */
  status: string;
  method: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** 파싱된 JSON — needs_review 행은 null */
  rects: AnchorPageRects[] | null;
  quote: string | null;
  label: string | null;
  color: string | null;
  geometryPrimary: BoolLike;
  questions: AnchorQuestionRef[];
}

export interface AnchorsResponse {
  anchors: AnchorInfo[];
}

export interface PageTextEntry {
  pageNo: number;
  startOffset: number;
  text: string;
}

export interface PageTextResponse {
  pages: PageTextEntry[];
}

export interface CreateAnchorRequest {
  documentVersionId: number;
  questionIds: number[];
  quoteExact: string;
  quotePrefix?: string;
  quoteSuffix?: string;
  startOffset: number;
  endOffset: number;
  pageStart: number;
  pageEnd: number;
  rects: AnchorPageRects[];
  label?: string;
  color?: string;
  geometryPrimary?: BoolLike;
  force?: boolean;
}

export interface AnchorOverlapInfo {
  passageId: number;
  anchorId: number;
  quote: string;
  questions: AnchorQuestionRef[];
}

/** 201 생성 또는 200 겹침 제안(아무것도 생성 안 됨) */
export type CreateAnchorResponse =
  | { passageId: number; anchorId: number; nudge?: string }
  | { overlap: AnchorOverlapInfo };

// ── 근거(문항 측) 타입 ───────────────────────────────────────────────────────

export interface EvidencePassageItem {
  type: 'passage';
  passageId: number;
  anchorId: number;
  documentId: number;
  versionId: number;
  sort: number;
  note: string | null;
  quote: string | null;
  label: string | null;
  color: string | null;
  docTitle: string;
  versionLabel: string;
  pageStart: number | null;
  status: string;
}

/** 자유형식 문서 근거 */
export interface EvidenceRichdocItem {
  type: 'richdoc';
  sort: number;
  note?: string | null;
  /** 본문 앞부분 발췌(1~2줄 미리보기) */
  excerpt?: string | null;
  [k: string]: unknown;
}

export type EvidenceItem = EvidencePassageItem | EvidenceRichdocItem;

export interface EvidenceResponse {
  items: EvidenceItem[];
}

export interface EvidencePatchItem {
  type: 'passage' | 'richdoc';
  passageId?: number;
  sort: number;
  note?: string | null;
}

// ── 지침서 전문 검색 ─────────────────────────────────────────────────────────

export interface DocSearchHit {
  versionId: number;
  docTitle: string;
  pageNo: number;
  /** 판본 연도 태그 (④ 연도 탭) — 이전 데이터는 null */
  year: number | null;
  snippet: string;
}

export interface DocSearchResponse {
  hits: DocSearchHit[];
}

// ── Day 2 엔드포인트 ─────────────────────────────────────────────────────────

export function fetchDocs(year?: number): Promise<DocsResponse> {
  const qs = year != null ? `?year=${year}` : '';
  return request<DocsResponse>(`/api/docs${qs}`);
}

export function fetchDoc(documentId: number | string): Promise<DocDetailResponse> {
  return request<DocDetailResponse>(`/api/docs/${documentId}`);
}

export interface UploadDocParams {
  file: File;
  title: string;
  versionLabel: string;
  code?: string;
  /** 지정 시 해당 문서의 새 판본으로 업로드(직전 판본 superseded + 재앵커링 v1) */
  documentId?: number;
  /** 판본 연도 태그 (④ 연도 탭) — 미지정 시 서버가 업로드한 해로 기록 */
  year?: number;
}

export function uploadDoc(params: UploadDocParams): Promise<UploadDocResponse> {
  const fd = new FormData();
  fd.append('file', params.file, params.file.name);
  fd.append('title', params.title);
  fd.append('versionLabel', params.versionLabel);
  if (params.code) fd.append('code', params.code);
  if (params.documentId != null) fd.append('documentId', String(params.documentId));
  if (params.year != null) fd.append('year', String(params.year));
  return request<UploadDocResponse>('/api/docs', { method: 'POST', formBody: fd });
}

/** 일괄 업로드용 자동 인입 응답 (v1.5 — 제목=파일명, 같은 제목이면 새 판본) */
export interface UploadDocAutoResponse {
  duplicate?: boolean;
  documentId: number;
  versionId: number;
  pageCount?: number;
  title: string;
  newVersion?: boolean;
  textWarning?: string;
  reanchor?: { auto: number; needsReview: number };
}

export function uploadDocAuto(file: File, year?: number): Promise<UploadDocAutoResponse> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  if (year != null) fd.append('year', String(year));
  return request<UploadDocAutoResponse>('/api/docs/auto', { method: 'POST', formBody: fd });
}

/** PDF 스트림 URL (pdf.js DocumentInitParameters.url 로 사용) */
export function versionFileUrl(versionId: number | string): string {
  return `/api/docs/versions/${versionId}/file`;
}

export function fetchVersionAnchors(versionId: number | string): Promise<AnchorsResponse> {
  return request<AnchorsResponse>(`/api/docs/versions/${versionId}/anchors`);
}

export function fetchVersionPageText(versionId: number | string): Promise<PageTextResponse> {
  return request<PageTextResponse>(`/api/docs/versions/${versionId}/page-text`);
}

export function createAnchor(body: CreateAnchorRequest): Promise<CreateAnchorResponse> {
  return request<CreateAnchorResponse>('/api/anchors', { method: 'POST', jsonBody: body });
}

/** 기존 발췌(passage)에 문항 추가 연결 — 중복은 서버가 무시 */
export function addPassageLink(
  passageId: number,
  questionId: number,
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(`/api/passages/${passageId}/links`, {
    method: 'POST',
    jsonBody: { questionId },
  });
}

/**
 * 문항-발췌 연결 해제.
 * 마지막 연결이면 409 {error:'last_link', requiresConfirm:true} 로 ConflictError 가 던져진다 —
 * 호출측에서 확인 후 confirm=true 로 재호출하면 링크 해제 + passage soft-delete.
 */
export function removePassageLink(
  passageId: number,
  questionId: number,
  confirm = false,
): Promise<{ ok?: boolean }> {
  const qs = confirm ? '?confirm=1' : '';
  return request<{ ok?: boolean }>(`/api/passages/${passageId}/links/${questionId}${qs}`, {
    method: 'DELETE',
  });
}

export function fetchQuestionEvidence(questionId: number | string): Promise<EvidenceResponse> {
  return request<EvidenceResponse>(`/api/questions/${questionId}/evidence`);
}

export function patchQuestionEvidence(
  questionId: number | string,
  items: EvidencePatchItem[],
): Promise<EvidenceResponse> {
  return request<EvidenceResponse>(`/api/questions/${questionId}/evidence`, {
    method: 'PATCH',
    jsonBody: { items },
  });
}

/** 통합 지침서 전문 검색 (FTS kind='page_text', 3자 미만 LIKE 폴백) — year 지정 시 그 연도 판본만 */
export function searchDocsFulltext(q: string, year?: number): Promise<DocSearchResponse> {
  const qs = year != null ? `&year=${year}` : '';
  return request<DocSearchResponse>(`/api/docs/search?q=${encodeURIComponent(q)}${qs}`);
}

// ── 엑셀 내보내기 (Day 3 — 설계서 §6.3, §6.1) ─────────────────────────────────
// 바이너리 다운로드는 request() 래퍼(JSON 전용)를 쓰지 않고 별도 헬퍼로 처리한다.

/** Content-Disposition 에서 RFC5987 filename*(우선) 또는 filename= 을 추출 */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fallthrough */
    }
  }
  const plain = /filename="?([^"]+)"?/i.exec(disposition);
  return plain?.[1] ?? null;
}

/** 브라우저 저장 트리거 (Blob → 임시 URL → 앵커 클릭) */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * xlsx 등 바이너리 GET 다운로드.
 * - 세션 쿠키 동봉, 오류(401/403/…)는 request() 와 동일한 한국어 메시지로 throw.
 * - 파일명은 서버 Content-Disposition 을 우선, 없으면 fallbackName.
 */
async function downloadBinary(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, null, '서버에 연결할 수 없습니다. 서버 상태를 확인하세요.');
  }
  if (!res.ok) {
    let errBody: ApiErrorBody | null = null;
    try {
      const t = await res.text();
      errBody = t ? (JSON.parse(t) as ApiErrorBody) : null;
    } catch {
      errBody = null;
    }
    if (res.status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    throw new ApiError(res.status, errBody, messageFor(res.status, errBody));
  }
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackName;
  saveBlob(blob, name);
}

/** 분야별 엑셀 내보내기 (editor↑) */
export function downloadCategoryExcel(
  categoryId: number | string,
  fallbackName = '분야_문항내보내기.xlsx',
): Promise<void> {
  return downloadBinary(`/api/export/category/${categoryId}.xlsx`, fallbackName);
}

/** 전체 엑셀 내보내기 (editor↑) — cycleId 지정 시 그 연도(주기) 기준 */
export function downloadAllExcel(cycleId?: number): Promise<void> {
  const qs = cycleId != null ? `?cycle=${cycleId}` : '';
  return downloadBinary(`/api/export/all.xlsx${qs}`, '전체_문항내보내기.xlsx');
}

/** §6.1 가져오기 양식 다운로드 (editor↑) */
export function downloadTemplateExcel(): Promise<void> {
  return downloadBinary('/api/export/template.xlsx', '문항_가져오기_양식.xlsx');
}

// ── 운영 점검 (admin — 백업·무결성·상태) ─────────────────────────────────────

export interface AdminStatus {
  disk: { totalBytes: number; freeBytes: number; usedPct: number } | null;
  backups: { count: number; latest: string | null; latestBytes: number | null; latestAt: string | null };
  integrity: { ok: boolean; checkedAt: string } | null;
  config: { port: number; dataDir: string; maxPdfMB: number };
}

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  offenderCount: number;
  offenders: unknown[];
}

export interface IntegrityResult {
  checkedAt: string;
  ok: boolean;
  checks: IntegrityCheck[];
}

export interface BackupBundleResult {
  ok: true;
  zipFile: string;
  zipPath: string;
  zipBytes: number;
  snapshotBytes: number;
  manifest: { fileCount: number; totalBytes: number; missingCount: number };
  createdAt: string;
}

export function fetchAdminStatus(): Promise<AdminStatus> {
  return request<AdminStatus>('/api/admin/status');
}

export function runAdminBackup(): Promise<BackupBundleResult> {
  return request<BackupBundleResult>('/api/admin/backup', { method: 'POST' });
}

/** 전체 백업(PDF 포함) 결과 — 빠른 백업 결과에 파일 수·누락 수가 더해진다 */
export interface FullBackupResult extends BackupBundleResult {
  /** ZIP에 담긴 원본 파일 수(DB 스냅샷·목록 제외) */
  fileCount: number;
  /** 원본이 없어 담지 못한 파일 수 */
  missingCount: number;
}

export function runAdminFullBackup(): Promise<FullBackupResult> {
  return request<FullBackupResult>('/api/admin/backup/full', { method: 'POST' });
}

export function fetchIntegrity(): Promise<IntegrityResult> {
  return request<IntegrityResult>('/api/admin/integrity');
}

export function runIntegrity(): Promise<IntegrityResult> {
  return request<IntegrityResult>('/api/admin/integrity/run', { method: 'POST' });
}
