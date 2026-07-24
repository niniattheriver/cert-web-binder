/**
 * 연도별 대시보드 `/y/:year` (설계서 §4 #2 — Day 1 + v1.5 Phase 1 리스트뷰 + Phase 3a 준비도 진단 C-2)
 * - 홈(연도 리스트)에서 연도를 골라 들어온다. 그 연도의 주기가 없으면 문항 PDF 업로드 안내.
 * - GET /api/bootstrap(?cycle=) → 분야 카드 그리드: 코드·이름·문항수·답변 진행바.
 *   (점수·달성률 비표시)
 * - GET /api/readiness(?cycle=) → 분야별 근거0·자동입력 미확정·재확인·지표미입력 + 검수큐 미처리.
 *   totals.anchorOpen > 0 이면 상단에 빨간 카드(지침서 개정 재연결 필요 — 설계서 §4 #2).
 * - 카드↔리스트 뷰 토글 (localStorage 'dash-view' 지속).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  categoryLabel,
  isCategoryCodeRedundant,
  downloadAllExcel,
  downloadTemplateExcel,
  fetchBootstrap,
  type BootstrapResponse,
  type CategorySummary,
  type CycleSummary,
} from '../api';
import { fetchReadiness, type ReadinessResponse } from '../api-phase3';
import { errorMessage } from '../util';

type ViewMode = 'card' | 'list';

const VIEW_KEY = 'dash-view';

function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'card';
}

/** 점수 합계·달성률은 표시하지 않는다 — 자동배점·타 분야 연동 점수를 정확히 산출할 수 없음 */
function pctOf(c: CategorySummary): { answerPct: number } {
  const answerPct = c.questionCount > 0 ? Math.round((c.answeredCount / c.questionCount) * 100) : 0;
  return { answerPct };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { year: yearParam } = useParams<{ year: string }>();
  const year = Number(yearParam);
  const yearValid =
    /^\d{4}$/.test(yearParam ?? '') && Number.isInteger(year) && year >= 2000 && year <= 2100;

  const [data, setData] = useState<BootstrapResponse | null>(null);
  /** 이 화면이 보여주는 연도의 주기 — null 이면 아직 그 연도 문항이 없다 */
  const [cycle, setCycle] = useState<CycleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<null | 'all' | 'template'>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(loadViewMode);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);

  const load = useCallback(() => {
    if (!yearValid) return;
    setLoading(true);
    setError(null);
    setReadiness(null);
    (async () => {
      const base = await fetchBootstrap();
      const cy = (base.cycles ?? []).find((c) => c.year === year) ?? null;
      setCycle(cy);
      if (!cy) {
        // 이 연도의 주기가 아직 없다 — base 의 분야 카드는 현재 주기 것이므로 그리지 않는다
        setData(base);
        return;
      }
      const scoped =
        base.activeCycle && cy.id === base.activeCycle.id ? base : await fetchBootstrap(cy.id);
      setData(scoped);
      fetchReadiness(cy.id)
        .then(setReadiness)
        .catch(() => {}); // 진단 블록은 보조 — 실패해도 대시보드는 뜬다
    })()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [year, yearValid]);

  useEffect(load, [load]);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  const cycleId = cycle?.id;
  const runExport = useCallback(
    (kind: 'all' | 'template') => {
      setExportError(null);
      setExporting(kind);
      const task = kind === 'all' ? downloadAllExcel(cycleId) : downloadTemplateExcel();
      task.catch((e) => setExportError(errorMessage(e))).finally(() => setExporting(null));
    },
    [cycleId],
  );

  if (!yearValid) return <Navigate to="/" replace />;

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

  if (!data) return null;

  const canEdit = data.user.role === 'editor' || data.user.role === 'admin';
  const isCurrent = cycle != null && data.activeCycle != null && cycle.id === data.activeCycle.id;

  // ── 이 연도의 주기가 아직 없음 — 업로드 안내 ──
  if (!cycle) {
    return (
      <div className="page">
        <div className="page-head">
          <Link to="/" className="crumb">
            ← 연도 목록
          </Link>
          <h1>{year}년 심사 준비</h1>
          <span className="cycle-chip">{year}년 심사</span>
        </div>
        <div className="empty-state">
          <p className="empty-title">아직 이 연도의 문항이 없습니다.</p>
          <p>
            인증기관에서 받은 문항 PDF를 올리면 이 연도의 심사 준비가 시작됩니다. 지난 연도가
            있으면 답변과 근거 연결을 물려받을 수 있습니다.
          </p>
          {canEdit && (
            <Link to={`/import?year=${year}`} className="btn btn-primary">
              문항 PDF 가져오기
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <Link to="/" className="crumb">
          ← 연도 목록
        </Link>
        <h1>{year}년 심사 준비</h1>
        <span className="cycle-chip">주기: {cycle.name}</span>
        {isCurrent && <span className="year-now">현재</span>}
        <div className="head-actions">
          <div className="view-toggle" role="group" aria-label="보기 방식">
            <button
              type="button"
              className={'view-toggle-btn' + (view === 'card' ? ' is-on' : '')}
              onClick={() => setViewMode('card')}
            >
              카드
            </button>
            <button
              type="button"
              className={'view-toggle-btn' + (view === 'list' ? ' is-on' : '')}
              onClick={() => setViewMode('list')}
            >
              리스트
            </button>
          </div>
          {canEdit && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => runExport('all')}
                disabled={exporting !== null || data.categories.length === 0}
                title="보고 있는 연도 전체를 엑셀로 내보냅니다."
              >
                {exporting === 'all' ? '내보내는 중…' : '엑셀 내보내기 (전체)'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => runExport('template')}
                disabled={exporting !== null}
                title="문항 가져오기용 엑셀 양식을 내려받습니다."
              >
                {exporting === 'template' ? '내려받는 중…' : '가져오기 양식'}
              </button>
              <Link
                to={`/import?year=${year}`}
                className="btn btn-ghost"
                title="새해(개정) 인증문항 PDF를 분야별 하나 또는 여러 파일 일괄로 업로드합니다. 미리보기(변경·신규 확인) 후 반영되며, 기존 채점·근거 연결은 보존됩니다."
              >
                + 새 문항 PDF 가져오기
              </Link>
            </>
          )}
        </div>
      </div>
      {exportError && <div className="error-inline">{exportError}</div>}

      {/* 지침서 개정으로 재연결이 필요한 근거 — 빨간 카드 (설계서 §4 #2) */}
      {readiness && readiness.totals.anchorOpen > 0 && (
        <div className="alert-card alert-danger">
          <span>
            지침서 개정으로 다시 연결해야 할 근거가 {readiness.totals.anchorOpen}건 있습니다.
          </span>
          <Link to="/review">확인 필요에서 처리 →</Link>
        </div>
      )}

      {data.categories.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">등록된 분야가 없습니다.</p>
          <p>가져오기에서 문항 PDF를 등록하세요.</p>
          <Link to={`/import?year=${year}`} className="btn btn-primary">
            문항 PDF 가져오기
          </Link>
        </div>
      ) : view === 'card' ? (
        <div className="card-grid">
          {data.categories.map((c) => {
            const { answerPct } = pctOf(c);
            return (
              <button
                type="button"
                key={c.id}
                className="cat-card"
                onClick={() => navigate(`/c/${c.id}`)}
              >
                <div className="cat-card-head">
                  {!isCategoryCodeRedundant(c) && <span className="cat-code">{c.code}</span>}
                  <span className="cat-name">{c.name}</span>
                </div>
                <div className="cat-meta">
                  문항 {c.questionCount}개 · 답변 {c.answeredCount}/{c.questionCount} ({answerPct}
                  %)
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuenow={answerPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="progress-fill" style={{ width: `${answerPct}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="simple-table-wrap">
          <table className="simple-table">
            <thead>
              <tr>
                <th>분야</th>
                <th className="col-right">문항</th>
                <th className="col-right">답변</th>
                <th className="dash-progress-col">진행</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => {
                const { answerPct } = pctOf(c);
                return (
                  <tr
                    key={c.id}
                    className="row-link"
                    onClick={() => navigate(`/c/${c.id}`)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/c/${c.id}`);
                    }}
                  >
                    <td>{categoryLabel(c)}</td>
                    <td className="col-right mono">{c.questionCount}</td>
                    <td className="col-right mono">
                      {c.answeredCount}/{c.questionCount} ({answerPct}%)
                    </td>
                    <td className="dash-progress-col">
                      <div
                        className="progress"
                        role="progressbar"
                        aria-valuenow={answerPct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div className="progress-fill" style={{ width: `${answerPct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 준비도 진단 (C-2 — Phase 3a): 숫자 클릭 = 해당 문항만 필터된 할일 큐 */}
      {readiness && readiness.categories.length > 0 && (
        <section className="readiness-block">
          <div className="page-head readiness-head">
            <h2>준비도 진단</h2>
            <span className="head-note">
              심사 전 점검 — 확인 필요 미처리{' '}
              {readiness.totals.reviewOpen > 0 ? (
                <Link to="/review">{readiness.totals.reviewOpen}건</Link>
              ) : (
                '0건'
              )}
            </span>
          </div>
          <div className="simple-table-wrap">
            <table className="simple-table readiness-table">
              <thead>
                <tr>
                  <th>분야</th>
                  <th
                    className="col-right"
                    title="연결된 지침서 발췌·자유형식 문서·첨부·링크가 하나도 없는 문항 수"
                  >
                    근거 연결 전
                  </th>
                  <th
                    className="col-right"
                    title='"예"를 고르면 배점 만점이 자동 입력됩니다. 그중 아직 사람이 점수를 확정하지 않은 문항 수입니다 (점수를 고치거나 배지를 클릭하면 확정).'
                  >
                    자동입력 미확정
                  </th>
                  <th className="col-right" title="문항 개정·배점 변경 등으로 다시 확인해야 하는 문항 수">
                    재확인 필요
                  </th>
                  <th className="col-right" title="자동배점 문항인데 지표가 바인딩되지 않았거나 값이 미입력">
                    지표 미입력
                  </th>
                </tr>
              </thead>
              <tbody>
                {readiness.categories.map((c) => (
                  <tr key={c.id}>
                    <td>{categoryLabel(c)}</td>
                    <td className="col-right">
                      {c.noEvidence > 0 ? (
                        <Link className="readiness-num is-warn" to={`/c/${c.id}?f=noevidence`}>
                          {c.noEvidence}
                        </Link>
                      ) : (
                        <span className="dim">0</span>
                      )}
                    </td>
                    <td className="col-right">
                      {c.autofilled > 0 ? (
                        <Link className="readiness-num is-warn" to={`/c/${c.id}?f=autofilled`}>
                          {c.autofilled}
                        </Link>
                      ) : (
                        <span className="dim">0</span>
                      )}
                    </td>
                    <td className="col-right">
                      {c.needsRecheck > 0 ? (
                        <Link className="readiness-num is-warn" to={`/c/${c.id}?f=recheck`}>
                          {c.needsRecheck}
                        </Link>
                      ) : (
                        <span className="dim">0</span>
                      )}
                    </td>
                    <td className="col-right">
                      {c.metricMissing > 0 ? (
                        <Link className="readiness-num is-warn" to={`/c/${c.id}?f=metricmissing`}>
                          {c.metricMissing}
                        </Link>
                      ) : (
                        <span className="dim">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
