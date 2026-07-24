/**
 * 문항 목록 (설계서 §4 #3 — Day 1 범위)
 * - GET /api/categories/:id/questions → @tanstack/react-virtual 가상화 테이블.
 * - 열: 번호·문항(1줄 말줄임)·배점/점수·상태(SVG 글리프+✓)·개정 배지·수정일.
 * - 필터 칩: 전체 / 미채점 / 검토완료 / 변경·신규문항 (+개수).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  categoryLabel,
  downloadCategoryExcel,
  fetchCategoryQuestions,
  type CategoryRef,
  type QuestionListItem,
  type QuestionType,
} from '../api';
import { useAuth } from '../auth';
import StatusGlyph from '../components/StatusGlyph';
import { errorMessage, fixBullets, fmtDate, fmtNum, truthy } from '../util';

type FilterKey =
  | 'all'
  | 'unanswered'
  | 'reviewed'
  | 'revised'
  | 'noevidence'
  | 'recheck'
  | 'autofilled'
  | 'metricmissing';

/** URL ?f= 값 검증 (준비도 진단 딥링크 — Phase 3a C-2) */
function filterFromParam(v: string | null): FilterKey {
  return v === 'unanswered' ||
    v === 'reviewed' ||
    v === 'revised' ||
    v === 'noevidence' ||
    v === 'recheck' ||
    v === 'autofilled' ||
    v === 'metricmissing'
    ? v
    : 'all';
}

/** 챕터 그룹 라벨 — 챕터(목차 제목) 우선, 없으면 문항번호 접두 그룹핑 폴백 (Phase 3b, UI 항상 동작) */
export function chapterLabel(q: QuestionListItem): string {
  if (q.chapterMajor) {
    return q.chapterMinor ? `${q.chapterMajor}  ›  ${q.chapterMinor}` : q.chapterMajor;
  }
  const parts = q.questionNo.split('.');
  return `문항군 ${parts[0] ?? ''}.${parts[1] ?? ''}`;
}

/** 대분류 라벨(접기 그룹 키). 챕터 없으면 문항번호 접두(aa.bbb) 폴백 */
function majorLabelOf(q: QuestionListItem): string {
  if (q.chapterMajor) return q.chapterMajor;
  const parts = q.questionNo.split('.');
  return `문항군 ${parts[0] ?? ''}.${parts[1] ?? ''}`;
}

/** 가상화 행 = 대분류 헤더(접기) ∪ 소분류 헤더 ∪ 문항 (헤더는 렌더 전용) */
type VirtualRow =
  | { kind: 'major'; key: string; label: string; majorKey: string; count: number }
  | { kind: 'minor'; key: string; label: string }
  | { kind: 'q'; key: string; q: QuestionListItem };

/**
 * 문항 목록을 대분류→소분류→문항 3단으로 펼친다. collapsed 에 든 대분류는 헤더만 남기고
 * 하위(소분류·문항)를 생략한다. 키는 그룹 첫 문항 id 기반 — 라벨 중복에도 유일(가상화 캐시 안정).
 */
function buildRows(questions: QuestionListItem[], collapsed: Set<string>): VirtualRow[] {
  const rows: VirtualRow[] = [];
  const counts = new Map<string, number>();
  for (const q of questions) {
    const mk = majorLabelOf(q);
    counts.set(mk, (counts.get(mk) ?? 0) + 1);
  }
  let curMajor: string | null = null;
  let curMinor: string | null = null;
  for (const q of questions) {
    const mk = majorLabelOf(q);
    if (mk !== curMajor) {
      rows.push({ kind: 'major', key: `M:${q.id}`, label: mk, majorKey: mk, count: counts.get(mk) ?? 0 });
      curMajor = mk;
      curMinor = null;
    }
    if (collapsed.has(mk)) continue; // 접힘 — 소분류·문항 생략
    const minor = q.chapterMinor ?? null;
    if (minor !== curMinor) {
      if (minor != null) rows.push({ kind: 'minor', key: `m:${q.id}`, label: minor });
      curMinor = minor;
    }
    rows.push({ kind: 'q', key: `q:${q.id}`, q });
  }
  return rows;
}

/** 문항 유형 배지 정의 (핵심=빨강 C · 필요=주황 R · 기본=회색 B) */
const TYPE_BADGE: Record<QuestionType, { cls: string; symbol: string; label: string }> = {
  core: { cls: 'badge-core', symbol: 'C', label: '핵심' },
  required: { cls: 'badge-required', symbol: 'R', label: '필요' },
  basic: { cls: 'badge-basic', symbol: 'B', label: '기본' },
};

/** 유형 칩. 미분류(null)면 아무것도 렌더하지 않는다. */
function TypeBadge({
  type,
  symbol,
}: {
  type?: QuestionType | null;
  symbol?: string | null;
}) {
  if (!type) return null;
  const b = TYPE_BADGE[type];
  return (
    <span
      className={`badge badge-type ${b.cls}`}
      title={`${b.label}(${b.symbol}) 문항 — 인증 문항집이 표기한 문항 유형입니다.`}
    >
      {symbol ?? b.symbol}
    </span>
  );
}

const FILTERS: { key: FilterKey; label: string; desc: string }[] = [
  { key: 'all', label: '전체', desc: '이 분야의 모든 문항을 표시합니다.' },
  { key: 'unanswered', label: '미채점', desc: '아직 채점(선택/점수 입력)하지 않은 문항만 표시합니다.' },
  { key: 'reviewed', label: '검토완료', desc: '검토완료(✓) 표시를 해 둔 문항만 표시합니다.' },
  {
    key: 'revised',
    label: '변경·신규문항',
    desc: '전년도 인증 문항 대비 내용이 변경되었거나 올해 신규로 생긴 문항만 표시합니다.',
  },
  {
    key: 'noevidence',
    label: '근거 연결 전',
    desc: '지침서 발췌·자유형식 문서·첨부파일·링크가 하나도 없는 문항만 표시합니다.',
  },
  {
    key: 'recheck',
    label: '재확인',
    desc: '문항 개정·배점 변경 등으로 채점을 다시 확인해야 하는 문항만 표시합니다.',
  },
  {
    key: 'autofilled',
    label: '자동입력',
    desc: '"예"를 골라 배점 만점이 자동 입력되었지만 아직 사람이 점수를 확정하지 않은 문항만 표시합니다.',
  },
  {
    key: 'metricmissing',
    label: '지표 미입력',
    desc: '자동배점 문항인데 계산에 필요한 기관 지표값이 아직 입력되지 않은 문항만 표시합니다.',
  },
];

/** 완성도 파생 (저장 안 함 — 설계서 §2): 채점(answerChoice)·답변(hasAnswer) 기준.
 *  합산/자동 모드는 answer_choice 없이 score 존재가 '채점됨' (Phase 3a — 대시보드 집계와 동일) */
export function isGraded(q: QuestionListItem): boolean {
  if (q.scoringMode && q.scoringMode !== 'simple') return q.score != null;
  return q.answerChoice != null;
}

function deriveStatus(q: QuestionListItem): 'full' | 'partial' | 'none' {
  const graded = isGraded(q);
  const answered = truthy(q.hasAnswer);
  if (graded && answered) return 'full';
  if (graded || answered) return 'partial';
  return 'none';
}

function matchesFilter(q: QuestionListItem, f: FilterKey): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'unanswered':
      return !isGraded(q); // 대시보드 answeredCount 와 동일 기준 (3모드)
    case 'reviewed':
      return truthy(q.reviewed);
    case 'revised':
      return q.revisionStatus === 'new' || q.revisionStatus === 'modified';
    case 'noevidence':
      // 발췌·자유형식·첨부파일·링크가 전부 0건일 때만 '근거 없음' (준비도 진단·요약과 동일 정의)
      return (
        (q.evidencePassages ?? 0) + (q.evidenceRichdocs ?? 0) === 0 &&
        (q.attachmentCount ?? 0) === 0 &&
        (q.linkCount ?? 0) === 0
      );
    case 'recheck':
      return truthy(q.needsRecheck);
    case 'autofilled':
      return truthy(q.scoreAutofilled);
    case 'metricmissing':
      return truthy(q.metricMissing);
  }
}

function scoreText(q: QuestionListItem): string {
  const max = q.maxScore != null ? fmtNum(q.maxScore) : '—';
  if (q.answerChoice === 'na') return `해당없음 / ${max}`;
  if (q.score != null) return `${fmtNum(q.score)} / ${max}`;
  return `— / ${max}`;
}

const STATUS_TITLE = { full: '답변+채점 완료', partial: '일부 작성', none: '미작성' } as const;

export default function CategoryList() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();

  const [category, setCategory] = useState<CategoryRef | null>(null);
  // 개정 연도 (주기 이름에서 파생 — 헤더 '개정(2026)' 표기. 새해 문항 업로드 시 자동 갱신)
  const [cycleYear, setCycleYear] = useState<string | null>(null);
  // 분야가 속한 주기 — breadcrumb 을 그 연도 대시보드(/y/연도)로 잇는다 (v1.5.4)
  const [cycleRef, setCycleRef] = useState<{ name: string; year: number | null } | null>(null);
  const [questions, setQuestions] = useState<QuestionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const canExport = user?.role === 'editor' || user?.role === 'admin';

  const runExport = useCallback(() => {
    if (!id) return;
    setExportError(null);
    setExporting(true);
    const fallback = category ? `${category.code}_${category.name}_문항내보내기.xlsx` : undefined;
    downloadCategoryExcel(id, fallback)
      .catch((e) => setExportError(errorMessage(e)))
      .finally(() => setExporting(false));
  }, [id, category]);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchCategoryQuestions(id)
      .then((r) => {
        setCategory(r.category);
        setCycleYear(
          r.cycle?.year != null ? String(r.cycle.year) : (r.cycle?.name.match(/(20\d{2})/)?.[1] ?? null),
        );
        setCycleRef(r.cycle ? { name: r.cycle.name, year: r.cycle.year ?? null } : null);
        setQuestions(r.questions);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    // ?f= 딥링크(준비도 진단 등)는 진입 시에만 반영 — 이후 칩 클릭이 우선
    setFilter(filterFromParam(searchParams.get('f')));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const counts = useMemo(
    () => ({
      all: questions.length,
      unanswered: questions.filter((q) => matchesFilter(q, 'unanswered')).length,
      reviewed: questions.filter((q) => matchesFilter(q, 'reviewed')).length,
      revised: questions.filter((q) => matchesFilter(q, 'revised')).length,
      noevidence: questions.filter((q) => matchesFilter(q, 'noevidence')).length,
      recheck: questions.filter((q) => matchesFilter(q, 'recheck')).length,
      autofilled: questions.filter((q) => matchesFilter(q, 'autofilled')).length,
      metricmissing: questions.filter((q) => matchesFilter(q, 'metricmissing')).length,
    }),
    [questions],
  );

  const filtered = useMemo(
    () => questions.filter((q) => matchesFilter(q, filter)),
    [questions, filter],
  );

  // 대분류 접기/펼치기 (Phase 3b — 목차 트리). 접힌 대분류 라벨 집합.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleMajor = useCallback((mk: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(mk)) next.delete(mk);
      else next.add(mk);
      return next;
    });
  }, []);
  // 분야가 바뀌면 접힘 상태 초기화
  useEffect(() => {
    setCollapsed(new Set());
  }, [id]);
  const majorKeys = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const q of filtered) {
      const mk = majorLabelOf(q);
      if (!seen.has(mk)) {
        seen.add(mk);
        order.push(mk);
      }
    }
    return order;
  }, [filtered]);
  const allCollapsed = majorKeys.length > 0 && majorKeys.every((k) => collapsed.has(k));
  const toggleAll = useCallback(() => {
    setCollapsed(allCollapsed ? new Set() : new Set(majorKeys));
  }, [allCollapsed, majorKeys]);

  // 가상화 행 = 대분류/소분류 헤더 + 문항 (접힘 반영. counts·"표시 N"은 filtered 기준 유지)
  const vrows = useMemo(() => buildRows(filtered, collapsed), [filtered, collapsed]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: vrows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = vrows[i];
      return r?.kind === 'major' ? 40 : r?.kind === 'minor' ? 32 : 44;
    },
    // 안정 키 — 접힘/필터로 행 구성이 바뀌어도 측정 캐시가 인덱스가 아닌 행 정체성을 따라가
    // 헤더↔문항 높이가 서로 뒤섞이는 스크롤 점프를 막는다.
    getItemKey: (i) => vrows[i]?.key ?? i,
    overscan: 12,
  });

  // 필터 변경 시 목록 맨 위로
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [filter]);

  if (loading) return <div className="page-status">불러오는 중…</div>;

  if (error) {
    return (
      <div className="page">
        <div className="error-card">
          <p>{error}</p>
          <button type="button" className="btn" onClick={load}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-fill">
      <div className="page-head">
        <h1>
          {cycleRef?.year != null ? (
            <Link to={`/y/${cycleRef.year}`} className="crumb">
              {cycleRef.name}
            </Link>
          ) : (
            <Link to="/" className="crumb">
              연도별 인증심사
            </Link>
          )}
          <span className="crumb-sep">›</span>
          {category ? categoryLabel(category) : '분야'}
        </h1>
        <span className="head-note">
          {questions.length}문항 · 표시 {filtered.length}
        </span>
        <div className="head-actions">
          {id && (
            <Link
              to={`/print/${id}`}
              target="_blank"
              rel="noopener"
              className="btn"
              title="이 분야를 종이 바인더 형식으로 보는 화면이 새 탭으로 열립니다 — 인쇄하거나 PDF로 저장할 수 있습니다."
            >
              인쇄
            </Link>
          )}
          {canExport && (
            <button
              type="button"
              className="btn"
              onClick={runExport}
              disabled={exporting}
              title="이 분야의 문항·채점·근거요약을 엑셀로 내보냅니다."
            >
              {exporting ? '내보내는 중…' : '엑셀 내보내기'}
            </button>
          )}
        </div>
      </div>
      {exportError && <div className="error-inline">{exportError}</div>}

      <div className="chip-row">
        {FILTERS.map((f) => (
          <button
            type="button"
            key={f.key}
            className={'chip' + (filter === f.key ? ' is-on' : '')}
            onClick={() => setFilter(f.key)}
            title={f.desc}
          >
            {f.label} <span className="chip-count">{counts[f.key]}</span>
          </button>
        ))}
        {majorKeys.length > 0 && (
          <button
            type="button"
            className="chip chip-toggleall"
            onClick={toggleAll}
            title="대분류(목차)를 모두 접거나 펼칩니다."
          >
            {allCollapsed ? '⊕ 모두 펼치기' : '⊖ 모두 접기'}
          </button>
        )}
        <span className="legend">
          <StatusGlyph kind="full" /> 답변+채점 · <StatusGlyph kind="partial" /> 일부 ·{' '}
          <StatusGlyph kind="none" /> 미작성 · ✓ 검토완료
        </span>
      </div>

      <div className="table-hwrap">
        <div className="table-inner">
          <div className="qrow qrow-head">
            <div>번호</div>
            <div>문항</div>
            <div className="col-right">배점/점수</div>
            <div className="col-center">상태</div>
            <div className="col-center" title="전년도 문항 대비 변경·신규 여부 (괄호는 당해 개정 연도)">
              개정{cycleYear ? `(${cycleYear})` : ''}
            </div>
            <div>수정일</div>
          </div>
          <div className="table-scroll" ref={parentRef}>
            {filtered.length === 0 ? (
              <div className="page-status">조건에 맞는 문항이 없습니다.</div>
            ) : (
              <div
                className="vlist"
                style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = vrows[vi.index];
                  if (!row) return null;
                  const rowStyle = {
                    position: 'absolute' as const,
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                  };
                  if (row.kind === 'major') {
                    // 대분류 헤더 (Phase 3b — "왼쪽 큰 목차 제목") — 클릭하면 접기/펼치기
                    const isCollapsed = collapsed.has(row.majorKey);
                    return (
                      <button
                        key={vi.key}
                        type="button"
                        className={'qrow-major' + (isCollapsed ? ' is-collapsed' : '')}
                        style={rowStyle}
                        onClick={() => toggleMajor(row.majorKey)}
                        aria-expanded={!isCollapsed}
                        title={isCollapsed ? '펼치기' : '접기'}
                      >
                        <span className="qrow-major-caret" aria-hidden="true">
                          {isCollapsed ? '▸' : '▾'}
                        </span>
                        <span className="qrow-major-label">{row.label}</span>
                        <span className="qrow-major-count">{row.count}문항</span>
                      </button>
                    );
                  }
                  if (row.kind === 'minor') {
                    // 소분류 헤더 — 클릭 대상 아님
                    return (
                      <div key={vi.key} className="qrow-minor" style={rowStyle}>
                        {row.label}
                      </div>
                    );
                  }
                  const q = row.q;
                  const st = deriveStatus(q);
                  return (
                    <div
                      key={vi.key}
                      className="qrow qrow-body"
                      style={rowStyle}
                      onClick={() => navigate(`/q/${q.id}`)}
                      role="link"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') navigate(`/q/${q.id}`);
                      }}
                    >
                      <div className="q-no">{q.questionNo}</div>
                      <div className="q-body" title={fixBullets(q.body)}>
                        <TypeBadge type={q.questionType} symbol={q.gradeSymbol} />
                        {q.autoCandidate && (
                          <span
                            className="badge badge-autoscore"
                            title="자동배점 문항 — 기관이 직접 채점하지 않고, 제출 자료나 기관 지표에 따라 점수가 자동으로 정해지는 문항입니다."
                          >
                            자동배점
                          </span>
                        )}
                        {fixBullets(q.body)}
                      </div>
                      <div className="col-right q-score">{scoreText(q)}</div>
                      <div className="col-center">
                        <StatusGlyph kind={st} title={STATUS_TITLE[st]} />
                        {truthy(q.reviewed) && (
                          <span className="status-check" title="검토완료">
                            ✓
                          </span>
                        )}
                      </div>
                      <div className="col-center">
                        {q.revisionStatus === 'new' && (
                          <span className="badge badge-new" title="올해 새로 생긴 문항입니다.">
                            신규
                          </span>
                        )}
                        {q.revisionStatus === 'modified' && (
                          <span className="badge badge-mod" title="전년도 대비 내용이 변경된 문항입니다.">
                            변경
                          </span>
                        )}
                        {truthy(q.needsRecheck) && (
                          <span
                            className="badge badge-recheck"
                            title="문항 개정·배점 변경 등으로 채점을 다시 확인해야 하는 문항입니다. 확인 후 '확인 필요' 메뉴에서 완료 처리하세요."
                          >
                            재확인
                          </span>
                        )}
                      </div>
                      <div className="q-date">{fmtDate(q.updatedAt)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
