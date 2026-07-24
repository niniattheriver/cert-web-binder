/**
 * 지침서 라이브러리 /docs (설계서 §4 #6)
 * - 연도 탭(④): 2026~2036 + 전체 — 선택 연도가 목록·검색·업로드에 모두 적용,
 *   localStorage 'docs-year' 로 유지. 연도 필터 목록은 문서별 '이 연도 판본'을 함께 표시.
 * - 전 지침서 카드 목록: 제목·현재 판본·쪽수·발췌/매핑 문항 수·[새 판본 업로드]
 * - [새 지침서 업로드] 폼(제목·판본라벨·분류코드·파일)
 * - [일괄 업로드](v1.5): 다중 PDF 선택 → 파일명=제목으로 순차 자동 인입 + 진행/결과 요약
 * - 통합 지침서 전문 검색(/api/docs/search) — 결과 클릭 시 뷰어 해당 페이지로 이동
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
  type DocSearchHit,
  type DocSummary,
  type UploadDocResponse,
} from '../api';
import { uploadDocSourceFile } from '../api-phase2';
import { useAuth } from '../auth';
import { errorMessage, fmtDate, truthy } from '../util';

function uploadErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.body?.error === 'encrypted_pdf') {
    return '암호화(열람제한)된 PDF입니다. 암호를 해제한 PDF로 다시 업로드하세요.';
  }
  if (e instanceof ApiError && e.body?.error === 'invalid_pdf') {
    return 'PDF 파일이 손상되었거나 읽을 수 없습니다.';
  }
  // 409는 request()가 낙관적 잠금용 ConflictError('다른 사용자가 먼저 저장…')로 바꾸므로
  // 판본 라벨 충돌은 여기서 원인·해결책을 정확히 안내한다 (리뷰 확정 결함)
  if (e instanceof ApiError && e.body?.error === 'duplicate_version_label') {
    return '같은 판본 라벨이 이미 있습니다. 문서 카드의 [새 판본 업로드]에서 다른 라벨로 올리세요.';
  }
  return errorMessage(e);
}

function uploadResultMessage(res: UploadDocResponse): string {
  if (res.duplicate) return '동일한 파일이 이미 등록되어 있어 기존 판본을 사용합니다.';
  let msg = `업로드 완료 — ${res.pageCount}쪽 처리.`;
  if (res.reanchor) {
    msg += ` 근거 위치 옮김: 자동 ${res.reanchor.auto}건 · 확인 필요 ${res.reanchor.needsReview}건.`;
  }
  if (truthy(typeof res.textWarning === 'string' ? 1 : (res.textWarning as 0 | 1 | undefined))) {
    msg += ' 일부 페이지의 텍스트 밀도가 낮습니다(스캔 혼입 의심).';
  }
  return msg;
}

interface UploadFormState {
  /** null = 새 지침서, 숫자 = 해당 문서의 새 판본 */
  documentId: number | null;
  title: string;
  versionLabel: string;
  code: string;
}

// ── 연도 탭 (④) ─────────────────────────────────────────────────────────────
const YEAR_TABS: number[] = Array.from({ length: 11 }, (_, i) => 2026 + i); // 2026..2036
const YEAR_STORE_KEY = 'docs-year';

function initialYear(): number | null {
  const raw = localStorage.getItem(YEAR_STORE_KEY);
  if (raw === 'all') return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 2000 && n <= 2100) return n;
  return new Date().getFullYear();
}

/** 목록에서 실제로 쓰인 연도 수집 — 고정 탭 밖 연도도 탭에 노출해 숨김 방지 */
function collectYears(list: DocSummary[]): number[] {
  const s = new Set<number>();
  for (const d of list) {
    const y = d.currentVersion?.year;
    if (y != null) s.add(y);
  }
  return [...s];
}

/** 업로드 폼·일괄 업로드 안내 — '전체' 탭에서는 올해로 등록됨을 정확히 알린다 */
function yearUploadNote(year: number | null): string {
  const head =
    year == null
      ? `연도 탭을 선택하지 않으면 올해(${new Date().getFullYear()})로 등록됩니다.`
      : '선택한 연도로 등록됩니다.';
  return `${head} 같은 제목을 다음 연도에 올리면 같은 지침서의 새 판본으로 이어져 근거 연결이 자동으로 옮겨집니다.`;
}

export default function DocLibrary() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';

  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 연도 탭 (④) — null = 전체
  const [year, setYear] = useState<number | null>(initialYear);
  const [dataYears, setDataYears] = useState<number[]>([]);
  const tabYears = useMemo(() => {
    const s = new Set<number>(YEAR_TABS);
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

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // 일괄 업로드 (v1.5 — 파일명이 곧 제목, 같은 제목은 새 판본, 동일 내용 재업로드는 건너뜀)
  const bulkInputRef = useRef<HTMLInputElement | null>(null);
  const [bulk, setBulk] = useState<{
    running: boolean;
    done: number;
    total: number;
    current: string;
    created: number;
    newVersion: number;
    skipped: number;
    failed: Array<{ name: string; reason: string }>;
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

  const openNewDocForm = () => {
    setForm({ documentId: null, title: '', versionLabel: '', code: '' });
    setFile(null);
    setSourceFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (sourceInputRef.current) sourceInputRef.current.value = '';
    setUploadError(null);
    setUploadNotice(null);
  };

  const openNewVersionForm = (doc: DocSummary) => {
    setForm({ documentId: doc.id, title: doc.title, versionLabel: '', code: doc.code ?? '' });
    setFile(null);
    setSourceFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (sourceInputRef.current) sourceInputRef.current.value = '';
    setUploadError(null);
    setUploadNotice(null);
  };

  const submitUpload = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!form || uploading) return;
    if (!file) {
      setUploadError('PDF 파일을 선택하세요.');
      return;
    }
    if (!form.title.trim() || !form.versionLabel.trim()) {
      setUploadError('제목과 판본 라벨을 입력하세요.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const res = await uploadDoc({
        file,
        title: form.title.trim(),
        versionLabel: form.versionLabel.trim(),
        code: form.code.trim() || undefined,
        documentId: form.documentId ?? undefined,
        year: year ?? undefined, // 선택한 연도로 등록 (④)
      });
      let notice = uploadResultMessage(res);
      // 원본 파일(선택) — PDF 판본에 이어서 첨부 (B-2: 매핑은 PDF, 편집·다운로드는 원본)
      if (sourceFile && res.versionId != null) {
        try {
          await uploadDocSourceFile(res.versionId, sourceFile);
          notice += ` · 원본 '${sourceFile.name}' 첨부됨`;
        } catch (e) {
          notice += ` · 원본 첨부 실패: ${errorMessage(e)}`;
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

  /** 다중 선택된 PDF를 순차 업로드 — 파일별 실패는 기록하고 계속(전체 중단 없음) */
  const runBulkUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || bulk?.running) return;
    const list = Array.from(files).filter((f) => /\.pdf$/i.test(f.name));
    const skippedNonPdf = files.length - list.length;
    const state = {
      running: true,
      done: 0,
      total: list.length,
      current: '',
      created: 0,
      newVersion: 0,
      skipped: skippedNonPdf,
      failed: [] as Array<{ name: string; reason: string }>,
    };
    setBulk({ ...state });
    for (const f of list) {
      state.current = f.name;
      setBulk({ ...state });
      try {
        const res = await uploadDocAuto(f, year ?? undefined); // 선택한 연도로 등록 (④)
        if (res.duplicate) state.skipped += 1;
        else if (res.newVersion) state.newVersion += 1;
        else state.created += 1;
      } catch (e) {
        state.failed.push({ name: f.name, reason: uploadErrorMessage(e) });
      }
      state.done += 1;
      setBulk({ ...state });
    }
    state.running = false;
    state.current = '';
    setBulk({ ...state });
    if (bulkInputRef.current) bulkInputRef.current.value = ''; // 같은 폴더 재선택 허용
    reload();
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
    } catch (e) {
      if (searchSeqRef.current !== seq) return;
      setHits(null);
      setSearchError(errorMessage(e));
    } finally {
      if (searchSeqRef.current === seq) setSearching(false);
    }
  };

  /** 검색 히트(판본 id) → 소유 문서 찾기: 현재판본 우선, 없으면 문서 상세를 순회 조회 */
  const openHit = async (hit: DocSearchHit) => {
    const list = docs ?? [];
    const byCurrent = list.find((d) => d.currentVersion?.id === hit.versionId);
    if (byCurrent) {
      navigate(`/docs/${byCurrent.id}?v=${hit.versionId}&page=${hit.pageNo}`);
      return;
    }
    for (const d of list) {
      try {
        const det = await fetchDoc(d.id);
        if (det.versions.some((v) => v.id === hit.versionId)) {
          navigate(`/docs/${d.id}?v=${hit.versionId}&page=${hit.pageNo}`);
          return;
        }
      } catch {
        /* 다음 문서 계속 */
      }
    }
    setSearchError('해당 판본이 속한 문서를 찾지 못했습니다.');
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>지침서 라이브러리</h1>
        <span className="head-note">지침서 PDF 전체 확인 · 판본 관리 · 전문 검색 — PDF 파일만 업로드할 수 있습니다</span>
        {canEdit && (
          <div className="head-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => bulkInputRef.current?.click()}
              disabled={bulk?.running}
              title="여러 PDF를 한 번에 선택하면 파일명 그대로 제목이 되어 순서대로 등록됩니다. 같은 파일명은 새 판본으로, 완전히 같은 내용은 건너뜁니다."
            >
              {bulk?.running ? `일괄 업로드 중… (${bulk.done}/${bulk.total})` : '일괄 업로드'}
            </button>
            <input
              ref={bulkInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              onChange={(e) => void runBulkUpload(e.target.files)}
            />
            <button type="button" className="btn" onClick={openNewDocForm}>
              새 지침서 업로드
            </button>
          </div>
        )}
      </div>
      <p className="page-desc">
        기관에서 쓰는 <strong>검사·장비 지침서</strong>를 올리는 곳입니다 — 검사지침서, 장비
        매뉴얼, SOP, 운영 규정 등 <strong>부르는 이름과 관계없이</strong> 인증 문항의 근거가
        되는 문서라면 모두 여기에 등록해 문항과 연결합니다.
      </p>

      {/* 연도 탭 (④) — 목록·검색·업로드에 모두 적용 */}
      <div className="chip-row doclib-years" role="tablist" aria-label="지침서 연도 선택">
        {tabYears.map((y) => (
          <button
            key={y}
            type="button"
            role="tab"
            aria-selected={year === y}
            className={'chip' + (year === y ? ' is-on' : '')}
            onClick={() => selectYear(y)}
            disabled={bulk?.running}
            title={`${y}년 판본이 있는 지침서만 보기 — 업로드도 ${y}년으로 등록됩니다`}
          >
            {y}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={year == null}
          className={'chip' + (year == null ? ' is-on' : '')}
          onClick={() => selectYear(null)}
          disabled={bulk?.running}
          title="연도 구분 없이 전체 지침서 보기"
        >
          전체
        </button>
      </div>

      {bulk && (
        <div className="card doclib-bulk">
          {bulk.running && <p className="dim doclib-year-note">{yearUploadNote(year)}</p>}
          {bulk.running ? (
            <p>
              일괄 업로드 진행 중 — {bulk.done}/{bulk.total}
              {bulk.current ? ` · ${bulk.current}` : ''} (창을 닫지 마세요)
            </p>
          ) : (
            <p>
              일괄 업로드 완료 — 신규 <b>{bulk.created}</b> · 새 판본 <b>{bulk.newVersion}</b> ·
              건너뜀(중복/비PDF) <b>{bulk.skipped}</b> · 실패 <b>{bulk.failed.length}</b>
            </p>
          )}
          {bulk.failed.length > 0 && (
            <ul className="doclib-bulk-failed">
              {bulk.failed.map((f) => (
                <li key={f.name}>
                  <b>{f.name}</b> — {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 통합 전문 검색 */}
      <div className="card">
        <form className="doclib-search" onSubmit={(e) => void runSearch(e)}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="지침서 전문 검색 (예: 파기 절차)"
            aria-label="지침서 전문 검색"
          />
          <button type="submit" className="btn" disabled={searching}>
            {searching ? '검색 중…' : '전문 검색'}
          </button>
        </form>
        {searchError && <div className="form-error">{searchError}</div>}
        {hits !== null && !searchError && (
          <div className="doclib-hits">
            {hits.length === 0 ? (
              <p className="dim">일치하는 내용이 없습니다.</p>
            ) : (
              <ul className="doclib-hit-list">
                {hits.map((h, i) => (
                  <li key={`${h.versionId}-${h.pageNo}-${i}`}>
                    <button type="button" onClick={() => void openHit(h)}>
                      <span className="doclib-hit-meta">
                        {h.docTitle} ·{' '}
                        {h.year != null && <span className="year-chip">{h.year}</span>} p.
                        {h.pageNo}
                      </span>
                      {/* 스니펫은 평문 렌더(문서 내용 XSS 방지 — Day 1 옴니박스와 동일 원칙) */}
                      <span className="doclib-hit-snippet">{h.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {uploadNotice && (
        <div className="card doclib-notice" role="status">
          {uploadNotice}
        </div>
      )}

      {/* 업로드 폼 (새 지침서 / 새 판본 공용) */}
      {form && canEdit && (
        <form className="card doclib-upload" onSubmit={(e) => void submitUpload(e)}>
          <h2 className="card-title">
            {form.documentId == null ? '새 지침서 업로드' : `새 판본 업로드 — ${form.title}`}
            {year != null && <span className="year-chip">{year}</span>}
          </h2>
          <p className="dim doclib-year-note">{yearUploadNote(year)}</p>
          <label className="field">
            <span className="field-label">제목</span>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              disabled={form.documentId != null}
              placeholder="예: 개인정보 보호지침"
            />
          </label>
          <div className="doclib-form-row">
            <label className="field">
              <span className="field-label">판본 라벨</span>
              <input
                value={form.versionLabel}
                onChange={(e) => setForm({ ...form, versionLabel: e.target.value })}
                placeholder="예: v2026-1"
              />
            </label>
            <label className="field">
              <span className="field-label">분류 코드 (선택)</span>
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                disabled={form.documentId != null}
                placeholder="예: GUID-01"
              />
            </label>
          </div>
          <div className="field">
            <span className="field-label">PDF 파일</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              hidden
            />
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                파일 선택
              </button>
              <span className="dim">{file ? file.name : '선택한 파일 없음'}</span>
            </div>
          </div>
          <div className="field">
            <span className="field-label">원본 파일 (선택 — hwp/docx/xlsx 등)</span>
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
              하이라이트 매핑은 PDF에, 편집·내려받기는 원본으로 합니다.
            </span>
          </div>
          {form.documentId != null && (
            <p className="dim">
              새 판본 업로드 시 직전 판본의 하이라이트는 정확 일치만 자동 이관되고, 나머지는
              '확인 필요' 목록에 남습니다. (몰래 옮기지 않음)
            </p>
          )}
          {uploadError && <div className="form-error">{uploadError}</div>}
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={uploading}>
              {uploading ? '업로드 중… (추출·색인)' : '업로드'}
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
        <div className="page-status">지침서 목록 불러오는 중…</div>
      ) : docs.length === 0 ? (
        year != null ? (
          <div className="empty-state">
            <p className="empty-title">이 연도에 등록된 지침서가 없습니다</p>
            <p className="dim">위에서 PDF를 올리면 이 연도로 등록됩니다.</p>
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty-title">등록된 지침서가 없습니다</p>
            <p className="dim">
              [새 지침서 업로드]로 근거 매핑에 사용할 지침서 PDF를 등록하세요.
            </p>
          </div>
        )
      ) : (
        <div className="card-grid">
          {docs.map((d) => (
            <div key={d.id} className="cat-card doclib-card">
              <div className="cat-card-head">
                {d.code && <span className="cat-code">{d.code}</span>}
                <Link to={`/docs/${d.id}`} className="cat-name doclib-title">
                  {d.title}
                </Link>
              </div>
              {d.currentVersion ? (
                <div className="cat-meta">
                  {d.currentVersion.year != null && (
                    <span className="year-chip">{d.currentVersion.year}</span>
                  )}{' '}
                  {d.currentVersion.versionLabel} · {d.currentVersion.pageCount}쪽 ·{' '}
                  {fmtDate(d.currentVersion.uploadedAt)}
                  {truthy(
                    typeof d.currentVersion.textWarning === 'string'
                      ? 1
                      : (d.currentVersion.textWarning as 0 | 1 | undefined),
                  ) && <span className="badge badge-mod doclib-warn">텍스트 저밀도</span>}
                </div>
              ) : (
                <div className="cat-meta">판본 없음</div>
              )}
              {d.yearVersion && d.yearVersion.id !== d.currentVersion?.id && (
                <div className="cat-meta doclib-yearver">
                  이 연도 판본: {d.yearVersion.versionLabel}
                </div>
              )}
              <div className="cat-meta">
                발췌 {d.passageCount}건 · 매핑 문항 {d.mappedQuestionCount}개
              </div>
              <div className="btn-row doclib-card-actions">
                <Link className="btn" to={`/docs/${d.id}`}>
                  뷰어 열기
                </Link>
                <Link
                  className="btn"
                  to={`/docs/${d.id}/compare`}
                  title="이 문서의 두 판본을 나란히 비교해 달라진 부분을 표시합니다."
                >
                  판본 비교
                </Link>
                {canEdit && (
                  <button type="button" className="btn" onClick={() => openNewVersionForm(d)}>
                    새 판본 업로드
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
