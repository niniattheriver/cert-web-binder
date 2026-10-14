/**
 * 근거자료 라이브러리 /docs (설계서 §4 #6)
 * - 연도 고르기(④): 드롭다운(전체, 2025~2099년과 자료에 쓰인 연도). 고른 연도가 목록, 검색, 업로드에 모두 쓰이고
 *   localStorage 'docs-year' 로 남는다. 연도로 거른 목록은 문서별 '이 연도 판본'을 함께 보인다.
 * - 자료 목록: 기본은 탐색기의 '자세히' 보기 같은 표다(이름, 업로드 날짜, 유형, 크기, 버전, 분량,
 *   하이라이트, 연결 문항, [미리보기] [버전 비교] [새 버전 업로드]). 열 머리를 누르면 그 열로 정렬하고, 위의 [카드]를
 *   누르면 카드 보기(제목, 현재 판본, 쪽 수, 발췌와 연결 문항 수, [미리보기], [뷰어 열기])로 바뀐다. 고른 보기는
 *   localStorage 'docs-view' 로 남는다(연도 화면의 'dash-view' 와 같은 방식).
 * - 끌어다 놓기 칸의 [내 PC에서 선택] 하나로 올린다: 파일을 여러 개 고르거나 그 칸에 놓으면 확장자를 뗀 파일 이름이
 *   제목이 되어 차례로 등록된다.
 *   같은 이름, 같은 형식은 새 판본으로 이어지고 내용이 같은 파일은 건너뛴다. 진행과 결과는 결과 카드에 남긴다.
 *   판본 라벨이나 PDF 의 편집용 원본을 직접 정하려면 [새 버전 업로드] 폼을 쓴다.
 * - 통합 전문 검색(/api/docs/search): 결과를 누르면 뷰어의 그 쪽으로 간다.
 * - 형식: PDF, Word(docx, doc), Excel(xlsx, xls), PowerPoint(pptx), 한글(hwpx, hwp), 텍스트(txt, md, csv, tsv).
 *   카드에 형식 칩과 형식별 쪽 단위(쪽, 시트, 슬라이드, 구간)를 둔다. 받지 못하는 파일(구형 ppt 등)은 보내지 않고
 *   결과 카드에 이름과 이유를 하나씩 남긴다(조용히 빠뜨리지 않는다).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchDoc,
  fetchDocs,
  searchDocsFulltext,
  uploadDoc,
  uploadDocAuto,
  ApiError,
  type BoolLike,
  type DocCurrentVersion,
  type DocSearchHit,
  type DocSummary,
  type DocYearVersion,
  type FileKind,
  type UploadDocResponse,
} from '../api';
import { uploadDocSourceFile } from '../api-phase2';
import { useAuth } from '../auth';
import Icon from '../components/Icon';
import FilePreviewModal from '../office/FilePreviewModal';
import {
  DOC_UPLOAD_ACCEPT,
  DOC_UPLOAD_EXT_RE,
  FILE_KIND_LABEL,
  pageRefLabel,
  pageUnit,
} from '../office/pageLabel';
import '../office/library.css';
import { errorMessage, fixBullets, fmtDate, fmtFileSize, truthy } from '../util';

/** 받을 수 있는 형식 목록 (머리말 안내, 지원하지 않는 형식 안내에 함께 쓴다) */
const ACCEPTED_FORMATS =
  'PDF, Word (docx, doc), Excel (xlsx, xls), PowerPoint (pptx), 한글(hwpx, hwp), 텍스트(txt, csv, tsv, md), 그림(png, jpg, gif, webp, bmp)';

/** 파일 이름의 끝 확장자(소문자, 점 없음). 없으면 '' */
function fileExt(name: string): string {
  return /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

/**
 * 파일 이름으로 짐작한 판본 형식 (업로드 전 화면 안내용). 실제 형식은 서버가 내용으로 다시 판별한다.
 * 받을 수 없는 확장자면 null.
 */
function kindFromFileName(name: string): FileKind | null {
  switch (fileExt(name)) {
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'doc':
      return 'docx';
    case 'xlsx':
    case 'xls':
      return 'xlsx';
    case 'pptx':
      return 'pptx';
    case 'hwpx':
    case 'hwp':
      return 'hwpx';
    case 'txt':
    case 'md':
    case 'csv':
    case 'tsv':
      return 'text';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
      return 'image';
    default:
      return null;
  }
}

/** 받을 수 없는 파일의 이유. 구형 PowerPoint, 받지 않는 그림은 바꾸는 방법까지 알려 준다 (서버 detect.ts 문구와 같은 뜻) */
function unsupportedFileReason(name: string): string {
  switch (fileExt(name)) {
    case 'ppt':
      return '구형 PowerPoint (ppt) 파일은 올릴 수 없습니다. PowerPoint에서 pptx 또는 PDF로 저장해 올려 주세요.';
    case 'heic':
    case 'heif':
      return 'HEIC 사진(아이폰 기본 저장 형식)은 브라우저가 그리지 못해 올릴 수 없습니다. JPG로 바꿔 올려 주세요.';
    case 'tif':
    case 'tiff':
      return 'TIFF 그림은 브라우저가 그리지 못해 올릴 수 없습니다. PNG나 JPG로 저장해 올려 주세요.';
    case 'avif':
      return 'AVIF 그림은 올릴 수 없습니다. PNG나 JPG로 저장해 올려 주세요.';
    case 'svg':
    case 'svgz':
      return 'SVG 그림은 올릴 수 없습니다(그림 안에 스크립트가 들어갈 수 있습니다). PNG나 JPG로 저장해 올려 주세요.';
    default:
      return `지원하지 않는 형식입니다. ${ACCEPTED_FORMATS} 파일을 올릴 수 있습니다.`;
  }
}

/** 판본 텍스트 경고 표시 여부 (0/1, boolean, 경고 문자열 모두 받는다) */
function hasTextWarning(w: BoolLike | string | null | undefined): boolean {
  return typeof w === 'string' ? w.trim() !== '' : truthy(w);
}

/**
 * 업로드 결과의 텍스트 경고 문구. PDF 는 스캔 혼입 의심 안내(저밀도 페이지 규칙은 PDF 전용),
 * 그 밖의 형식은 서버 문구(일부만 색인, 글자 없음 등)를 그대로 보여 준다.
 */
function textWarningNote(kind: FileKind, w: BoolLike | string | null | undefined): string | null {
  if (!hasTextWarning(w)) return null;
  if (kind === 'pdf') return '글자가 거의 없는 쪽이 있습니다. 스캔한 쪽이 섞였을 수 있습니다.';
  return typeof w === 'string' ? w.trim() : null;
}

function uploadErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.body?.error === 'encrypted_pdf') {
    return '암호(열람 제한)가 걸린 PDF입니다. 암호를 푼 PDF로 다시 올려 주세요.';
  }
  if (e instanceof ApiError && e.body?.error === 'invalid_pdf') {
    return 'PDF 파일이 손상되었거나 읽을 수 없습니다.';
  }
  // PDF 외 형식: 서버가 원인과 해결책을 한국어 문장(details)으로 준다 (구형, 암호 Office, 손상된 문서 등)
  if (
    e instanceof ApiError &&
    (e.body?.error === 'unsupported_format' || e.body?.error === 'invalid_office')
  ) {
    const details = e.body.details;
    if (typeof details === 'string' && details.trim() !== '') return details.trim();
    return e.body.error === 'unsupported_format'
      ? `지원하지 않는 형식입니다. ${ACCEPTED_FORMATS} 파일을 올릴 수 있습니다.`
      : '문서 내용을 읽을 수 없습니다. 원래 프로그램에서 다시 저장해 올려 주세요.';
  }
  // 409는 request()가 낙관적 잠금용 ConflictError('다른 사용자가 먼저 저장…')로 바꾸므로
  // 판본 라벨 충돌은 여기서 원인·해결책을 정확히 안내한다
  if (e instanceof ApiError && e.body?.error === 'duplicate_version_label') {
    return '같은 버전 이름이 이미 있습니다. 그 자료의 [새 버전 업로드]에서 다른 이름으로 올리세요.';
  }
  // 같은 자료에 다른 버전이 잇달아 들어와 저장하지 못했다: 서버 문장(잠시 뒤 다시 올려 달라는 안내)을 그대로
  if (e instanceof ApiError && e.body?.error === 'concurrent_revision') {
    const details = e.body.details;
    if (typeof details === 'string' && details.trim() !== '') return details.trim();
  }
  return errorMessage(e);
}

function uploadResultMessage(res: UploadDocResponse): string {
  if (res.duplicate) return '동일한 파일이 이미 등록되어 있어 기존 버전을 사용합니다.';
  const kind: FileKind = res.fileKind ?? 'pdf';
  // 형식마다 쪽을 세는 단위가 다르다: 12쪽, 3시트, 8슬라이드, 5구간
  let msg = `업로드 완료: ${res.pageCount}${pageUnit(kind, res.firstPageLabel)} 처리.`;
  if (res.reanchor) {
    msg += ` 근거 위치 옮김: 자동 ${res.reanchor.auto}건, 확인 필요 ${res.reanchor.needsReview}건.`;
    if (kind === 'image' && res.reanchor.needsReview > 0) {
      msg += ' 그림은 글자로 비교할 수 없어 근거를 모두 확인 필요로 넘겼습니다. 뷰어에서 [이 그림으로 확인]을 누르세요.';
    }
  }
  const warn = textWarningNote(kind, res.textWarning);
  if (warn) msg += ` ${warn}`;
  return msg;
}

/** 목록, 카드의 [새 버전 업로드] 폼 (새 자료는 끌어다 놓기 칸의 [내 PC에서 선택]으로 올린다) */
interface UploadFormState {
  documentId: number;
  title: string;
  versionLabel: string;
  /** 그 문서의 현재 판본 형식 (형식이 바뀌는지 안내하려고 둔다). 판본이 없으면 null */
  currentKind: FileKind | null;
}

/** 빠른 보기 창에 넘길 판본 */
interface PreviewTarget {
  versionId: number;
  fileKind?: FileKind;
  title: string;
  documentId: number;
}

/** 일괄 업로드에서 건너뛰거나 실패한 파일 하나 */
interface BulkFileNote {
  name: string;
  reason: string;
}

// ── 연도 (④) ─────────────────────────────────────────────────────────────────
/** 드롭다운에 늘 보이는 연도: 2025..2099 (자료에 쓰인 다른 연도는 더해서 보인다) */
const YEAR_OPTIONS: number[] = Array.from({ length: 2099 - 2025 + 1 }, (_, i) => 2025 + i);
const YEAR_STORE_KEY = 'docs-year';

function initialYear(): number | null {
  const raw = localStorage.getItem(YEAR_STORE_KEY);
  if (raw === 'all') return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 2000 && n <= 2100) return n;
  return new Date().getFullYear();
}

/** 목록에서 실제로 쓰인 연도: 드롭다운 범위 밖 연도의 자료도 고를 수 있게 더한다 */
function collectYears(list: DocSummary[]): number[] {
  const s = new Set<number>();
  for (const d of list) {
    const y = d.currentVersion?.year;
    if (y != null) s.add(y);
  }
  return [...s];
}

/** 업로드가 등록될 연도: 고른 연도, '전체'면 올해 */
function uploadYear(year: number | null): number {
  return year ?? new Date().getFullYear();
}

/** 업로드 안내: '전체'를 고른 동안에는 올해로 등록됨을 정확히 알린다 */
function yearUploadNote(year: number | null): string {
  const head = year == null ? `연도가 '전체'라서 올해(${uploadYear(null)}년)로 등록됩니다.` : `${year}년 버전으로 등록됩니다.`;
  return `${head} 같은 제목, 같은 형식의 파일을 다음 연도에 올리면 같은 자료의 새 버전으로 이어져 근거 연결이 자동으로 옮겨집니다.`;
}

/** 끌어다 놓는 것이 파일인가 (글자, 링크를 끌 때는 반응하지 않는다) */
function dragHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

// ── 보기 방식과 목록 정렬 ─────────────────────────────────────────
type ViewMode = 'list' | 'card';
/** 이 PC 브라우저에 남기는 보기 방식 (연도 화면의 'dash-view' 와 같은 방식). 처음에는 목록 */
const VIEW_STORE_KEY = 'docs-view';

function initialView(): ViewMode {
  return localStorage.getItem(VIEW_STORE_KEY) === 'card' ? 'card' : 'list';
}

/** 목록 정렬 기준: 탐색기의 '자세히' 보기처럼 열 머리를 눌러 바꾼다 */
type SortKey = 'name' | 'uploaded' | 'type' | 'size' | 'version' | 'amount' | 'highlights' | 'linked';
interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}
/** 처음 정렬: 최근에 올린 것부터 (서버가 주는 목록 순서와 같다) */
const DEFAULT_SORT: SortState = { key: 'uploaded', dir: 'desc' };
/** 열 머리를 처음 눌렀을 때의 방향: 글자 열은 가나다순, 날짜와 수 열은 큰 것부터 */
const FIRST_DIR: Record<SortKey, 'asc' | 'desc'> = {
  name: 'asc',
  type: 'asc',
  version: 'asc',
  uploaded: 'desc',
  size: 'desc',
  amount: 'desc',
  highlights: 'desc',
  linked: 'desc',
};

type ShownVersion = DocCurrentVersion | DocYearVersion;

/** 목록 한 줄에 보이는 버전: 연도를 고르면 그 연도의 최신 버전, 전체면 현재 버전 ([미리보기]가 여는 버전과 같다) */
function shownVersion(d: DocSummary, year: number | null): ShownVersion | null {
  return year != null && d.yearVersion ? d.yearVersion : d.currentVersion;
}

/** 뷰어 주소: 목록이 보이는 버전이 현재 버전이 아니면 ?v= 로 그 버전을 연다([미리보기]와 같은 버전) */
function viewerPath(d: DocSummary, shownId: number | null | undefined): string {
  return shownId != null && shownId !== d.currentVersion?.id ? `/docs/${d.id}?v=${shownId}` : `/docs/${d.id}`;
}

/** 유형 열: 올린 파일의 확장자(docx, hwp, csv 처럼 원래 이름 그대로). 이름에 확장자가 없으면 형식 이름 */
function typeLabel(v: ShownVersion): string {
  return (v.fileName ? fileExt(v.fileName) : '') || FILE_KIND_LABEL[v.fileKind ?? 'pdf'];
}

function sortValue(d: DocSummary, v: ShownVersion | null, key: SortKey): string | number | null {
  switch (key) {
    case 'name':
      return d.title;
    case 'uploaded': {
      const t = v ? Date.parse(v.uploadedAt) : NaN;
      return Number.isNaN(t) ? null : t;
    }
    case 'type':
      return v ? typeLabel(v) : null;
    case 'size':
      return v?.fileSize ?? null;
    case 'version':
      return v?.versionLabel ?? null;
    case 'amount':
      return v?.pageCount ?? null;
    case 'highlights':
      return d.passageCount;
    case 'linked':
      return d.mappedQuestionCount;
  }
}

/** 정렬 비교: 값이 없는 줄(버전 없는 자료)은 방향과 상관없이 맨 뒤, 같으면 이름순 */
function compareDocs(a: DocSummary, b: DocSummary, sort: SortState, year: number | null): number {
  const byName = a.title.localeCompare(b.title, 'ko', { numeric: true });
  const va = sortValue(a, shownVersion(a, year), sort.key);
  const vb = sortValue(b, shownVersion(b, year), sort.key);
  if (va == null || vb == null) return va == null && vb == null ? byName : va == null ? 1 : -1;
  const c =
    typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), 'ko', { numeric: true });
  if (c !== 0) return sort.dir === 'asc' ? c : -c;
  return byName;
}

export default function DocLibrary() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';

  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 연도 (④): null = 전체
  const [year, setYear] = useState<number | null>(initialYear);
  const [dataYears, setDataYears] = useState<number[]>([]);
  const yearOptions = useMemo(() => {
    const s = new Set<number>(YEAR_OPTIONS);
    for (const y of dataYears) s.add(y);
    if (year != null) s.add(year);
    return [...s].sort((a, b) => a - b);
  }, [dataYears, year]);

  const [form, setForm] = useState<UploadFormState | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null); // 원본(hwp/docx 등 — B-2, 선택)
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const versionLabelRef = useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocSearchHit[] | null>(null);
  /** 지금 보이는 검색 결과를 만든 검색어 (결과를 열 때 뷰어에 &q= 로 넘긴다) */
  const [hitQuery, setHitQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // 빠른 보기 창 (목록, 카드의 [미리보기])
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  // 보기 방식(목록이 기본)과 목록 정렬
  const [view, setView] = useState<ViewMode>(initialView);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const setViewMode = (v: ViewMode) => {
    setView(v);
    localStorage.setItem(VIEW_STORE_KEY, v);
  };
  /** 같은 열을 다시 누르면 방향만 바꾸고, 다른 열은 그 열의 첫 방향으로 */
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: FIRST_DIR[key] }));

  // 근거자료 파일 업로드 (파일 이름이 곧 제목, 같은 제목은 새 판본, 같은 내용은 건너뜀)
  // 건너뛴 파일(지원하지 않는 형식, 중복)과 실패한 파일은 이름과 이유를 하나씩 남긴다
  const bulkInputRef = useRef<HTMLInputElement | null>(null);
  /** 끌어다 놓기 영역 위에 파일이 있는가 (안쪽 요소를 지날 때 깜빡이지 않게 들어오고 나간 횟수를 센다) */
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [bulk, setBulk] = useState<{
    running: boolean;
    done: number;
    total: number;
    current: string;
    created: number;
    newVersion: number;
    skipped: BulkFileNote[];
    failed: BulkFileNote[];
  } | null>(null);

  // 연도 탭을 빠르게 바꿀 때 늦게 도착한 이전 연도 응답이 화면을 덮지 않도록,
  // 요청마다 번호를 매기고 최신 번호가 아닌 응답은 버린다 (목록·전문 검색 공통)
  const listSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const reload = useCallback(() => {
    setLoadError(null);
    const seq = ++listSeqRef.current;
    fetchDocs(year ?? undefined)
      .then((r) => {
        if (listSeqRef.current !== seq) return; // 이미 다른 연도로 이동함
        setDocs(r.docs ?? []);
        if (year == null) setDataYears(collectYears(r.docs ?? []));
      })
      .catch((e) => {
        if (listSeqRef.current === seq) setLoadError(errorMessage(e));
      });
    // 연도 필터 중에도 전체 목록에서 연도 집합을 갱신 — 고정 탭 밖 연도 숨김 방지
    if (year != null) {
      fetchDocs()
        .then((r) => {
          if (listSeqRef.current === seq) setDataYears(collectYears(r.docs ?? []));
        })
        .catch(() => {
          /* 탭 보강 실패는 무시 — 고정 탭은 항상 표시 */
        });
    }
  }, [year]);

  // 빠른 보기 창 안(하이라이트 팝오버)에서 발췌 연결을 더하거나 풀면 카드의 발췌, 매핑 문항 수가 바뀐다.
  // 창이 열린 동안은 표시만 해 두고, 닫을 때 목록을 한 번 다시 받는다
  const previewLinkedRef = useRef(false);
  const markPreviewLinked = useCallback(() => {
    previewLinkedRef.current = true;
  }, []);
  const closePreview = useCallback(() => {
    setPreview(null);
    if (previewLinkedRef.current) {
      previewLinkedRef.current = false;
      reload();
    }
  }, [reload]);

  const selectYear = useCallback(
    (y: number | null) => {
      if (y === year) return;
      setYear(y);
      localStorage.setItem(YEAR_STORE_KEY, y == null ? 'all' : String(y));
      // 다른 연도의 검색 결과가 남지 않게 초기화 + 진행 중이던 검색 응답도 무효화
      searchSeqRef.current += 1;
      setHits(null);
      setSearchError(null);
      setSearching(false);
    },
    [year],
  );

  // 일괄 업로드 진행 중 탭 닫기/새로고침 확인 — 진행상황 유실·중복 실행 방지
  useEffect(() => {
    if (!bulk?.running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [bulk?.running]);

  useEffect(() => {
    setDocs(null); // 연도 전환 시 로딩 표시
    reload();
  }, [reload]);

  // [새 버전 업로드] 폼은 목록 위에 열린다: 아래쪽 줄에서 눌러도 폼이 보이도록 버전 이름 칸으로 포커스를 옮긴다
  // (포커스를 받으면 브라우저가 그 칸이 보이게 스크롤한다)
  const formDocId = form?.documentId;
  useEffect(() => {
    if (formDocId != null) versionLabelRef.current?.focus();
  }, [formDocId]);

  const sortedDocs = useMemo(
    () => (docs ? [...docs].sort((a, b) => compareDocs(a, b, sort, year)) : null),
    [docs, sort, year],
  );

  const openNewVersionForm = (doc: DocSummary) => {
    setForm({
      documentId: doc.id,
      title: doc.title,
      versionLabel: '',
      // 판본이 없는 문서는 형식을 알 수 없으니 비교하지 않는다
      currentKind: doc.currentVersion ? (doc.currentVersion.fileKind ?? 'pdf') : null,
    });
    setFile(null);
    setSourceFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (sourceInputRef.current) sourceInputRef.current.value = '';
    setUploadError(null);
    setUploadNotice(null);
  };

  /** 새 판본 파일 선택: 받을 수 없는 형식은 그 자리에서 이유(구형 ppt 는 변환 방법)를 알린다 */
  const pickMainFile = (picked: File | null) => {
    setUploadError(null);
    if (picked && !DOC_UPLOAD_EXT_RE.test(picked.name)) {
      setFile(null);
      setSourceFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploadError(`'${picked.name}': ${unsupportedFileReason(picked.name)}`);
      return;
    }
    setFile(picked);
    // 원본 파일 칸(B-2)은 PDF 판본에만 쓴다: PDF 가 아니면 골라 둔 원본을 비운다
    if (!picked || kindFromFileName(picked.name) !== 'pdf') setSourceFile(null);
  };

  const submitUpload = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!form || uploading) return;
    if (!file) {
      setUploadError('올릴 파일을 선택하세요.');
      return;
    }
    if (!DOC_UPLOAD_EXT_RE.test(file.name)) {
      setUploadError(`'${file.name}': ${unsupportedFileReason(file.name)}`);
      return;
    }
    if (!form.versionLabel.trim()) {
      setUploadError('버전 이름을 입력하세요.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const res = await uploadDoc({
        file,
        title: form.title.trim(),
        versionLabel: form.versionLabel.trim(),
        documentId: form.documentId,
        year: year ?? undefined, // 고른 연도로 등록 (④)
      });
      let notice = uploadResultMessage(res);
      // 원본 파일(선택): PDF 판본에 이어서 첨부 (B-2: 매핑은 PDF, 편집과 내려받기는 원본).
      // Word, Excel 등은 그 파일 자체가 판본이라 원본 칸을 쓰지 않는다(서버도 거절한다)
      const isPdfVersion = (res.fileKind ?? kindFromFileName(file.name)) === 'pdf';
      if (sourceFile && isPdfVersion && res.versionId != null) {
        try {
          await uploadDocSourceFile(res.versionId, sourceFile);
          notice += ` 원본 '${sourceFile.name}' 첨부됨.`;
        } catch (e) {
          notice += ` 원본 첨부 실패: ${errorMessage(e)}`;
        }
      }
      setUploadNotice(notice);
      setForm(null);
      setFile(null);
      setSourceFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (sourceInputRef.current) sourceInputRef.current.value = '';
      reload();
    } catch (e) {
      setUploadError(uploadErrorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  /**
   * 여러 파일을 차례로 올린다(단추로 고른 파일, 끌어다 놓은 파일 공통): 파일별 실패는 기록하고 계속한다.
   * 받을 수 없는 형식은 보내지 않고, 중복과 함께 '건너뜀' 목록에 이름과 이유를 남긴다.
   */
  const runBulkUpload = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0 || bulk?.running) return;
    setUploadNotice(null);
    const all = Array.from(files);
    const list = all.filter((f) => DOC_UPLOAD_EXT_RE.test(f.name));
    const skipped: BulkFileNote[] = all
      .filter((f) => !DOC_UPLOAD_EXT_RE.test(f.name))
      .map((f) => ({ name: f.name, reason: unsupportedFileReason(f.name) }));
    const state = {
      running: true,
      done: 0,
      total: list.length,
      current: '',
      created: 0,
      newVersion: 0,
      skipped,
      failed: [] as BulkFileNote[],
    };
    setBulk({ ...state, skipped: [...state.skipped] });
    for (const f of list) {
      state.current = f.name;
      setBulk({ ...state, skipped: [...state.skipped], failed: [...state.failed] });
      try {
        const res = await uploadDocAuto(f, year ?? undefined); // 고른 연도로 등록 (④)
        if (res.duplicate) {
          state.skipped.push({
            name: f.name,
            reason: '같은 내용의 파일이 이미 같은 연도로 등록되어 있습니다(중복).',
          });
        } else if (res.newVersion) state.newVersion += 1;
        else state.created += 1;
      } catch (e) {
        state.failed.push({ name: f.name, reason: uploadErrorMessage(e) });
      }
      state.done += 1;
      setBulk({ ...state, skipped: [...state.skipped], failed: [...state.failed] });
    }
    state.running = false;
    state.current = '';
    setBulk({ ...state, skipped: [...state.skipped], failed: [...state.failed] });
    if (bulkInputRef.current) bulkInputRef.current.value = ''; // 같은 파일 다시 고르기 허용
    reload();
  };

  // 끌어다 놓기: 영역 밖에 떨어뜨린 파일을 브라우저가 열어 화면을 떠나지 않게 이 화면에서는 기본 동작을 막는다
  useEffect(() => {
    if (!canEdit) return;
    const stop = (e: DragEvent) => {
      if (dragHasFiles(e)) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, [canEdit]);

  const onDropZoneEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDropZoneOver = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = bulk?.running ? 'none' : 'copy';
  };
  const onDropZoneLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDropZoneDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (bulk?.running) return;
    void runBulkUpload(Array.from(e.dataTransfer.files));
  };

  const runSearch = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const seq = ++searchSeqRef.current;
    try {
      const res = await searchDocsFulltext(q, year ?? undefined);
      if (searchSeqRef.current !== seq) return; // 그 사이 연도 전환/재검색 — 늦은 응답 버림
      setHits(res.hits ?? []);
      setHitQuery(q);
    } catch (e) {
      if (searchSeqRef.current !== seq) return;
      setHits(null);
      setSearchError(errorMessage(e));
    } finally {
      if (searchSeqRef.current === seq) setSearching(false);
    }
  };

  /**
   * 검색 히트(판본 id) → 소유 문서 찾기: 현재판본 우선, 없으면 문서 상세를 순회 조회.
   * 검색어(&q=)를 함께 넘겨 뷰어가 그 쪽에서 검색어 위치를 찾아 보여 주게 한다.
   */
  const openHit = async (hit: DocSearchHit) => {
    const list = docs ?? [];
    const target = (docId: number) =>
      `/docs/${docId}?v=${hit.versionId}&page=${hit.pageNo}` +
      (hitQuery ? `&q=${encodeURIComponent(hitQuery)}` : '');
    const byCurrent = list.find(
      (d) => d.currentVersion?.id === hit.versionId || d.yearVersion?.id === hit.versionId,
    );
    if (byCurrent) {
      navigate(target(byCurrent.id));
      return;
    }
    for (const d of list) {
      try {
        const det = await fetchDoc(d.id);
        if (det.versions.some((v) => v.id === hit.versionId)) {
          navigate(target(d.id));
          return;
        }
      } catch {
        /* 다음 문서 계속 */
      }
    }
    setSearchError('해당 버전이 속한 문서를 찾지 못했습니다.');
  };

  // 고른 새 판본 파일의 형식(확장자 기준 짐작)과, 현재 판본과 형식이 달라지는지
  const fileKind: FileKind | null = file ? kindFromFileName(file.name) : null;
  const kindChanges = form != null && form.currentKind != null && fileKind != null && fileKind !== form.currentKind;
  const uploadTitle =
    '파일을 여러 개 고를 수 있습니다. 확장자를 뺀 파일 이름이 제목이 되고, 같은 이름, 같은 형식의 파일은 그 자료의 새 버전으로 이어집니다. 내용이 같은 파일은 건너뜁니다.';

  /** 정렬되는 열 머리: 누르면 그 열로 정렬한다. 지금 기준인 열은 화살표와 aria-sort 로 방향을 알린다 */
  const sortHeader = (key: SortKey, label: string, className: string) => {
    const on = sort.key === key;
    return (
      <th className={className} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className={'doclib-sort' + (on ? ' is-on' : '')}
          onClick={() => toggleSort(key)}
          title={`${label} 기준으로 정렬합니다. 한 번 더 누르면 반대 순서입니다.`}
        >
          {label}
          <span className="doclib-sort-mark" aria-hidden="true">
            {on ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className="page doclib-page">
      {/* 머리: 제목과 설명 (글자 크기 단계는 library.css 머리 주석). 올리기는 아래 끌어다 놓기 칸 하나로 모았다 */}
      <div className="doclib-head">
        <div className="doclib-head-text">
          <h1>근거자료 라이브러리</h1>
          <p className="doclib-lead">
            인증 문항의 근거가 되는 기관 문서를 올리고, 버전을 관리하고, 본문을 검색합니다. 검사지침서, 장비 매뉴얼,
            SOP, 운영 규정처럼 부르는 이름이 달라도 모두 여기에 등록해 문항과 연결합니다.
          </p>
          <p className="doclib-formats">
            올릴 수 있는 형식: {ACCEPTED_FORMATS}. 그림은 글자를 읽지 않으므로 본문 검색에 걸리지 않고, 그림 전체를
            근거로 연결합니다.
          </p>
        </div>
      </div>

      {/* 연도(④)와 전문 검색: 고른 연도가 목록, 검색, 업로드에 모두 쓰인다 */}
      <div className="doclib-toolbar">
        <label className="doclib-year" title="고른 연도의 버전이 있는 자료만 보고, 올리는 파일도 그 연도로 등록합니다.">
          <span className="doclib-year-label">연도</span>
          <select
            value={year == null ? 'all' : String(year)}
            onChange={(e) => selectYear(e.target.value === 'all' ? null : Number(e.target.value))}
            disabled={bulk?.running}
            aria-label="근거자료 연도"
          >
            <option value="all">전체</option>
            {yearOptions.map((y) => (
              <option key={y} value={String(y)}>
                {y}년
              </option>
            ))}
          </select>
        </label>
        <form className="doclib-search" role="search" onSubmit={(e) => void runSearch(e)}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="본문에서 찾기(예: 파기 절차)"
            aria-label="근거자료 본문 검색"
          />
          <button type="submit" className="btn" disabled={searching}>
            {searching ? '검색 중…' : '본문 검색'}
          </button>
        </form>
      </div>

      {/* 끌어다 놓기 영역: 내 PC 탐색기에서 파일을 바로 놓거나 [내 PC에서 선택]으로 고른다 (둘 다 같은 일괄 업로드) */}
      {canEdit && (
        <div
          className={'doclib-drop' + (dragOver ? ' is-over' : '') + (bulk?.running ? ' is-busy' : '')}
          onDragEnter={onDropZoneEnter}
          onDragOver={onDropZoneOver}
          onDragLeave={onDropZoneLeave}
          onDrop={onDropZoneDrop}
          aria-label="근거자료 파일 끌어다 놓기"
          role="region"
        >
          <p className="doclib-drop-title">
            {bulk?.running
              ? `업로드 중입니다(${bulk.done}/${bulk.total}). 끝나면 다시 놓을 수 있습니다.`
              : dragOver
                ? '놓으면 바로 올라갑니다'
                : '여기에 파일을 끌어다 놓으세요'}
          </p>
          <p className="doclib-drop-sub">
            {year == null ? `올해(${uploadYear(null)}년)` : `${year}년`} 버전으로 등록됩니다. 여러 파일을 한 번에 놓을 수
            있고, 확장자를 뺀 파일 이름이 제목이 됩니다.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => bulkInputRef.current?.click()}
            disabled={bulk?.running}
            title={uploadTitle}
          >
            내 PC에서 선택
          </button>
          <input
            ref={bulkInputRef}
            type="file"
            accept={DOC_UPLOAD_ACCEPT}
            multiple
            hidden
            onChange={(e) => void runBulkUpload(e.target.files)}
          />
        </div>
      )}

      {bulk && (
        <div className="card doclib-bulk" role="status">
          {bulk.running && <p className="dim doclib-year-note">{yearUploadNote(year)}</p>}
          {bulk.running ? (
            <p>
              업로드 중: {bulk.done}/{bulk.total}
              {bulk.current ? `, ${bulk.current}` : ''} (창을 닫지 마세요)
            </p>
          ) : (
            <p>
              업로드 완료: 새 자료 <b>{bulk.created}</b>, 새 버전 <b>{bulk.newVersion}</b>, 건너뜀(중복, 지원하지 않는
              형식) <b>{bulk.skipped.length}</b>, 실패 <b>{bulk.failed.length}</b>
            </p>
          )}
          {bulk.skipped.length > 0 && (
            // 건너뛴 파일도 하나씩 이름과 이유를 남긴다(폴더째 다시 올려 중복이 많으면 접어 둔다)
            <details className="doclib-bulk-list" open={bulk.skipped.length <= 10}>
              <summary>건너뛴 파일 {bulk.skipped.length}개</summary>
              <ul className="doclib-bulk-skipped">
                {bulk.skipped.map((f, i) => (
                  <li key={`${i}-${f.name}`}>
                    <b>{f.name}</b>: {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {bulk.failed.length > 0 && (
            <ul className="doclib-bulk-failed">
              {bulk.failed.map((f, i) => (
                <li key={`${i}-${f.name}`}>
                  <b>{f.name}</b>: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 전문 검색 결과: 결과가 있을 때만 결과 카드를 연다 */}
      {searchError && <div className="form-error">{searchError}</div>}
      {hits !== null && !searchError && (
        <div className="card doclib-hits">
          {hits.length === 0 ? (
            <p className="dim">일치하는 내용이 없습니다.</p>
          ) : (
            <ul className="doclib-hit-list">
              {hits.map((h, i) => (
                <li key={`${h.versionId}-${h.pageNo}-${i}`}>
                  <button type="button" onClick={() => void openHit(h)}>
                    <span className="doclib-hit-meta">
                      <span className="doclib-hit-title">{h.docTitle}</span>
                      {h.year != null && <span className="year-chip">{h.year}</span>}
                      {h.fileKind && h.fileKind !== 'pdf' && (
                        <span className="kind-chip">{FILE_KIND_LABEL[h.fileKind]}</span>
                      )}
                      {/* 쪽 표기는 형식별: p.N, 시트 이름, 슬라이드 N, 구간 N */}
                      <span className="doclib-hit-loc">
                        {pageRefLabel(h.fileKind ?? 'pdf', h.pageNo, h.pageLabel)}
                      </span>
                    </span>
                    {/* 스니펫은 평문 렌더(문서 내용 XSS 방지: Day 1 옴니박스와 같은 원칙) */}
                    <span className="doclib-hit-snippet">{fixBullets(h.snippet)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {uploadNotice && (
        <div className="card doclib-notice" role="status">
          {uploadNotice}
        </div>
      )}

      {/* 카드의 [새 판본 업로드] 폼: 판본 라벨과 (PDF 면) 편집용 원본을 직접 정한다 */}
      {form && canEdit && (
        <form className="card doclib-upload" onSubmit={(e) => void submitUpload(e)}>
          <h2 className="card-title">
            새 버전 업로드: {form.title}
            <span className="year-chip">{uploadYear(year)}</span>
          </h2>
          <p className="dim doclib-year-note">{yearUploadNote(year)}</p>
          <label className="field">
            <span className="field-label">버전 이름</span>
            <input
              ref={versionLabelRef}
              value={form.versionLabel}
              onChange={(e) => setForm({ ...form, versionLabel: e.target.value })}
              placeholder="예: v2026-1"
            />
          </label>
          <div className="field">
            <span className="field-label">새 버전 파일</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={DOC_UPLOAD_ACCEPT}
              onChange={(e) => pickMainFile(e.target.files?.[0] ?? null)}
              hidden
            />
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                파일 선택
              </button>
              <span className="dim">{file ? file.name : '선택한 파일 없음'}</span>
              {fileKind && <span className="kind-chip">{FILE_KIND_LABEL[fileKind]}</span>}
            </div>
            <span className="dim doclib-source-hint">{ACCEPTED_FORMATS} 파일을 올릴 수 있습니다.</span>
          </div>
          {fileKind === 'pdf' && (
            // 원본 파일 칸(B-2)은 PDF 판본에만: Word, Excel 등은 위 칸에 바로 올리면 그 파일이 판본이 된다
            <div className="field">
              <span className="field-label">원본 파일(선택: hwp, docx, xlsx 등)</span>
              <input
                ref={sourceInputRef}
                type="file"
                accept=".hwp,.hwpx,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
                hidden
              />
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => sourceInputRef.current?.click()}>
                  파일 선택
                </button>
                <span className="dim">{sourceFile ? sourceFile.name : '선택한 파일 없음'}</span>
                {sourceFile && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setSourceFile(null);
                      if (sourceInputRef.current) sourceInputRef.current.value = '';
                    }}
                  >
                    지우기
                  </button>
                )}
              </div>
              <span className="dim doclib-source-hint">
                Word, Excel, PowerPoint, 한글은 위 칸에 바로 올리면 미리보기와 근거 연결이 됩니다. 이 칸은 PDF로
                변환해 올릴 때 편집용 원본을 함께 보관하는 곳입니다.
              </span>
            </div>
          )}
          {kindChanges && form.currentKind && fileKind && (
            <p className="notice-inline doclib-kind-note" role="note">
              현재 버전은 {FILE_KIND_LABEL[form.currentKind]}, 고른 파일은{' '}
              {FILE_KIND_LABEL[fileKind]}입니다. 형식이 바뀌면(예: PDF에서 Word로) 근거 위치 대부분이
              확인 필요로 남을 수 있습니다.
            </p>
          )}
          {form.currentKind === 'image' || fileKind === 'image' ? (
            <p className="dim">
              그림 버전은 글자로 비교할 수 없어 새 버전을 올리면 근거를 모두 '확인 필요'로 넘깁니다. 새 그림을 열어
              [이 그림으로 확인]을 누르면 같은 근거로 이어집니다.
            </p>
          ) : (
            <p className="dim">
              새 버전을 올리면 직전 버전의 하이라이트 중 글자가 그대로인 것만 자동으로 옮기고 나머지는 '확인 필요' 목록에
              남깁니다.
            </p>
          )}
          {uploadError && <div className="form-error">{uploadError}</div>}
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={uploading}>
              {uploading ? '업로드 중… (추출, 색인)' : '업로드'}
            </button>
            <button type="button" className="btn" onClick={() => setForm(null)} disabled={uploading}>
              취소
            </button>
          </div>
        </form>
      )}

      {/* 문서 카드 목록 */}
      {loadError ? (
        <div className="error-card">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={reload}>
            다시 시도
          </button>
        </div>
      ) : docs === null ? (
        <div className="page-status">자료 목록 불러오는 중…</div>
      ) : docs.length === 0 ? (
        year != null ? (
          <div className="empty-state">
            <p className="empty-title">이 연도에 등록된 자료가 없습니다</p>
            <p className="dim">위에서 파일을 올리면 {year}년 버전으로 등록됩니다.</p>
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty-title">등록된 자료가 없습니다</p>
            <p className="dim">
              위 칸에 끌어다 놓거나 [내 PC에서 선택]으로 근거로 연결할 파일({ACCEPTED_FORMATS})을 올리세요.
            </p>
          </div>
        )
      ) : (
        <>
          {/* 목록 위 줄: 자료 수(왼쪽)와 보기 방식(오른쪽). 전환 단추는 연도 화면의 [카드] [목록]과 같은 모양이다 */}
          <div className="doclib-listbar">
            <p className="doclib-count">
              {year == null ? '전체' : `${year}년`} 자료 <b>{docs.length}</b>개
            </p>
            <div className="view-toggle" role="group" aria-label="보기 방식">
              <button
                type="button"
                className={'view-toggle-btn' + (view === 'card' ? ' is-on' : '')}
                aria-pressed={view === 'card'}
                onClick={() => setViewMode('card')}
              >
                카드
              </button>
              <button
                type="button"
                className={'view-toggle-btn' + (view === 'list' ? ' is-on' : '')}
                aria-pressed={view === 'list'}
                onClick={() => setViewMode('list')}
              >
                목록
              </button>
            </div>
          </div>
          {view === 'list' ? (
            // 목록 보기: 한 자료가 한 줄(탐색기의 '자세히' 보기). 이름을 누르거나 줄을 두 번 누르면 뷰어로 간다
            <div className="simple-table-wrap doclib-table-wrap">
              <table className="simple-table doclib-table">
                <thead>
                  <tr>
                    {sortHeader('name', '이름', 'doclib-col-name')}
                    {sortHeader('uploaded', '업로드 날짜', 'doclib-col-date')}
                    {sortHeader('type', '유형', 'doclib-col-type')}
                    {sortHeader('size', '크기', 'col-right doclib-col-size')}
                    {sortHeader('version', '버전', 'doclib-col-ver')}
                    {sortHeader('amount', '분량', 'col-right doclib-col-amount')}
                    {sortHeader('highlights', '하이라이트', 'col-right doclib-col-hl')}
                    {sortHeader('linked', '연결 문항', 'col-right doclib-col-linked')}
                    <th className="doclib-col-actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {(sortedDocs ?? docs).map((d) => {
                    const cv = d.currentVersion;
                    // 이 줄의 버전: 연도를 고르면 그 연도의 최신 버전([미리보기]가 여는 버전과 같다)
                    const v = shownVersion(d, year);
                    const vKind: FileKind = v?.fileKind ?? 'pdf';
                    // 스캔 의심(저밀도 쪽) 표시는 현재 버전 정보에만 있고 PDF 전용 규칙이다. 연도를 고르면 v 는 같은
                    // 버전이어도 다른 객체(yearVersion)라 id 로 견준다
                    const scanWarn =
                      cv != null && v != null && v.id === cv.id && vKind === 'pdf' && hasTextWarning(cv.textWarning);
                    // 제목, 두 번 누르기 모두 이 줄이 보이는 버전을 연다
                    const viewerTo = viewerPath(d, v?.id);
                    return (
                      <tr
                        key={d.id}
                        className="doclib-row"
                        onDoubleClick={(e) => {
                          // 단추와 링크는 제 할 일을 한다
                          if ((e.target as HTMLElement).closest('a, button')) return;
                          navigate(viewerTo);
                        }}
                      >
                        <td className="doclib-col-name">
                          <div className="doclib-name">
                            <Icon name="file" size={16} className="doclib-file-icon" />
                            {d.code && (
                              <span className="doclib-code" title="분류 코드">
                                {d.code}
                              </span>
                            )}
                            <Link to={viewerTo} className="doclib-row-title" title="뷰어에서 열기">
                              {d.title}
                            </Link>
                            {scanWarn && <span className="badge badge-mod doclib-warn">스캔으로 추정되는 페이지 있음</span>}
                          </div>
                        </td>
                        <td className="doclib-col-date">{v ? fmtDate(v.uploadedAt) : ''}</td>
                        <td className="doclib-col-type" title={v ? `${FILE_KIND_LABEL[vKind]} 파일` : undefined}>
                          {v ? typeLabel(v) : ''}
                        </td>
                        <td className="col-right doclib-col-size">{v ? fmtFileSize(v.fileSize) : ''}</td>
                        <td className="doclib-col-ver">
                          {v ? (
                            <>
                              {v.versionLabel}
                              {year == null && v.year != null && <span className="year-chip">{v.year}</span>}
                              {cv != null && v.id !== cv.id && (
                                <span className="doclib-row-sub">현재 버전 {cv.versionLabel}</span>
                              )}
                            </>
                          ) : (
                            '버전 없음'
                          )}
                        </td>
                        <td className="col-right doclib-col-amount">
                          {v ? `${v.pageCount}${pageUnit(vKind, v.firstPageLabel)}` : ''}
                        </td>
                        <td className="col-right doclib-col-hl">{d.passageCount}</td>
                        <td className="col-right doclib-col-linked">{d.mappedQuestionCount}</td>
                        <td className="doclib-col-actions">
                          <div className="doclib-row-actions">
                            {v && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() =>
                                  setPreview({ versionId: v.id, fileKind: v.fileKind, title: d.title, documentId: d.id })
                                }
                                title="창을 띄워 내용을 바로 봅니다. 근거 연결은 뷰어에서 합니다."
                              >
                                미리보기
                              </button>
                            )}
                            <Link
                              className="btn btn-sm"
                              to={`/docs/${d.id}/compare`}
                              title="이 문서의 두 버전을 나란히 비교해 달라진 부분을 표시합니다."
                            >
                              버전 비교
                            </Link>
                            {canEdit && (
                              <button type="button" className="btn btn-sm" onClick={() => openNewVersionForm(d)}>
                                새 버전 업로드
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card-grid">
              {docs.map((d) => {
                const cv = d.currentVersion;
                const cvKind: FileKind = cv?.fileKind ?? 'pdf';
                // [미리보기] 대상: 연도 탭이 켜져 있으면 그 연도 판본, 아니면 현재 판본
                const pv =
                  year != null && d.yearVersion
                    ? { id: d.yearVersion.id, fileKind: d.yearVersion.fileKind }
                    : cv
                      ? { id: cv.id, fileKind: cv.fileKind }
                      : null;
                // 제목과 [뷰어 열기]도 [미리보기]와 같은 버전을 연다
                const viewerTo = viewerPath(d, pv?.id);
                return (
                  <div key={d.id} className="cat-card doclib-card">
                    {/* 제목이 맨 위(카드마다 같은 높이에서 시작). 분류 코드는 칩 줄 맨 앞 */}
                    <Link to={viewerTo} className="cat-name doclib-title" title={d.title}>
                      {d.title}
                    </Link>
                    {cv ? (
                      <>
                        <div className="doclib-tags">
                          {d.code && (
                            <span className="doclib-code" title="분류 코드">
                              {d.code}
                            </span>
                          )}
                          {cv.year != null && <span className="year-chip">{cv.year}</span>}
                          <span className="kind-chip" title={`원본 형식: ${FILE_KIND_LABEL[cvKind]}`}>
                            {FILE_KIND_LABEL[cvKind]}
                          </span>
                          {/* 저밀도(스캔 혼입 의심) 판정은 PDF 전용 규칙이다 */}
                          {cvKind === 'pdf' && hasTextWarning(cv.textWarning) && (
                            <span className="badge badge-mod doclib-warn">스캔으로 추정되는 페이지 있음</span>
                          )}
                        </div>
                        {/* 항목마다 줄바꿈을 막아 '3슬/라이드'처럼 낱말 가운데서 끊기지 않게 한다 */}
                        <p className="doclib-meta">
                          버전 <span className="doclib-nowrap">{cv.versionLabel}</span>,{' '}
                          <span className="doclib-nowrap">
                            {cv.pageCount}
                            {pageUnit(cvKind, cv.firstPageLabel)}
                          </span>
                        </p>
                        <p className="doclib-meta">
                          업로드 <span className="doclib-nowrap">{fmtDate(cv.uploadedAt)}</span>
                        </p>
                      </>
                    ) : (
                      <>
                        {d.code && (
                          <div className="doclib-tags">
                            <span className="doclib-code" title="분류 코드">
                              {d.code}
                            </span>
                          </div>
                        )}
                        <p className="doclib-meta">버전 없음</p>
                      </>
                    )}
                    {d.yearVersion && d.yearVersion.id !== cv?.id && (
                      <p className="doclib-meta doclib-yearver">
                        이 연도 버전: {d.yearVersion.versionLabel}
                        {(d.yearVersion.fileKind ?? 'pdf') !== cvKind &&
                          ` (${FILE_KIND_LABEL[d.yearVersion.fileKind ?? 'pdf']})`}
                      </p>
                    )}
                    <p className="doclib-stats">
                      하이라이트 <b>{d.passageCount}</b>건, 연결 문항 <b>{d.mappedQuestionCount}</b>개
                    </p>
                    {/* 자주 쓰는 두 가지(미리보기, 뷰어)는 단추로, 판본 관리는 아래 작은 글자 단추로 (흔한
                        길을 먼저 보이고 나머지는 한 단계 아래). 단추 이름은 그대로라 키보드, e2e 이름도 같다 */}
                    <div className="doclib-card-actions">
                      <div className="doclib-actions-main">
                        {pv && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              setPreview({
                                versionId: pv.id,
                                fileKind: pv.fileKind,
                                title: d.title,
                                documentId: d.id,
                              })
                            }
                            title="창을 띄워 내용을 바로 봅니다. 근거 연결은 뷰어에서 합니다."
                          >
                            미리보기
                          </button>
                        )}
                        <Link className="btn" to={viewerTo}>
                          뷰어 열기
                        </Link>
                      </div>
                      <div className="doclib-actions-more">
                        <Link
                          className="btn btn-ghost btn-sm"
                          to={`/docs/${d.id}/compare`}
                          title="이 문서의 두 버전을 나란히 비교해 달라진 부분을 표시합니다."
                        >
                          버전 비교
                        </Link>
                        {canEdit && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => openNewVersionForm(d)}
                          >
                            새 버전 업로드
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* 한컴 HWP 공개 문서 이용 조건: 제품 화면, 설명서, 도움말, 소스 코드에 출처 문구를 둔다 */}
      <p className="doclib-credit">본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.</p>

      {preview && (
        <FilePreviewModal
          versionId={preview.versionId}
          fileKind={preview.fileKind}
          title={preview.title}
          documentId={preview.documentId}
          onLinked={markPreviewLinked}
          onClose={closePreview}
        />
      )}
    </div>
  );
}
