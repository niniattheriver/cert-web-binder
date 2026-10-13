/**
 * 연도별 대시보드 `/y/:year` (설계서 §4 #2 — Day 1 + v1.5 Phase 1 리스트뷰 + Phase 3a 준비도 진단 C-2)
 * - 홈(연도 리스트)에서 연도를 골라 들어온다. 그 연도의 주기가 없으면 문항 PDF 업로드 안내.
 * - GET /api/bootstrap(?cycle=) → 분야 카드 그리드: 코드·이름·문항수·답변 진행바.
 *   (점수·달성률 비표시)
 * - GET /api/readiness(?cycle=) → 분야별 근거 연결 전, 자동입력 미확정, 재확인, 지표 미입력.
 *   이 수는 분야 카드와 리스트의 칩으로 보인다(누르면 ?f= 필터 목록).
 *   totals.anchorOpen > 0 이면 상단에 빨간 카드(지침서 개정 재연결 필요, 설계서 §4 #2).
 * - 카드, 리스트 보기 전환 (localStorage 'dash-view' 지속).
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

type ReadinessCategory = ReadinessResponse['categories'][number];

/**
 * 분야에서 손봐야 할 문항 표시.
 * 근거 연결 전, 재확인 필요는 눈에 띄는 칩으로, 자동입력 미확정, 지표 미입력은 있을 때만 작은 글자로.
 * 누르면 그 문항만 걸러진 문항 목록(?f=)으로 간다. 진단을 아직 못 받았으면 아무것도 그리지 않는다.
 */
function CategoryFlags({ r, catId }: { r: ReadinessCategory | undefined; catId: number }) {
  if (!r) return null;
  const minor =
    r.autofilled > 0 || r.metricMissing > 0 ? (
      <span className="dash-flag-minors">
        {r.autofilled > 0 && (
          <Link
            className="dash-flag-minor"
            to={`/c/${catId}?f=autofilled`}
            title='"예"를 골라 만점이 자동으로 들어갔지만 아직 사람이 점수를 확정하지 않은 문항'
          >
            자동 입력 미확정 {r.autofilled}
          </Link>
        )}
        {r.metricMissing > 0 && (
          <Link
            className="dash-flag-minor"
            to={`/c/${catId}?f=metricmissing`}
            title="자동배점 문항인데 계산에 쓸 기관 지표가 아직 없는 문항"
          >
            지표 미입력 {r.metricMissing}
          </Link>
        )}
      </span>
    ) : null;
  if (r.noEvidence === 0 && r.needsRecheck === 0 && !minor) {
    return <div className="dash-flags is-clear">✓ 모든 문항에 근거 연결, 재확인할 문항 없음</div>;
  }
  return (
    <div className="dash-flags">
      {r.noEvidence > 0 && (
        <Link
          className="dash-flag is-noevidence"
          to={`/c/${catId}?f=noevidence`}
          title="근거자료 하이라이트, 자유형식 문서, 첨부파일, 링크가 하나도 없는 문항만 봅니다."
        >
          근거 연결 전 <b>{r.noEvidence}</b>
        </Link>
      )}
      {r.needsRecheck > 0 && (
        <Link
          className="dash-flag is-recheck"
          to={`/c/${catId}?f=recheck`}
          title="문항 개정이나 배점 변경으로 채점을 다시 확인해야 하는 문항만 봅니다."
        >
          재확인 필요 <b>{r.needsRecheck}</b>
        </Link>
      )}
      {minor}
    </div>
  );
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
  /** 분야별 손볼 문항 수 (카드, 리스트의 칩) */
  const readinessByCat = new Map((readiness?.categories ?? []).map((r) => [r.id, r] as const));

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
              목록
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
                {exporting === 'all' ? '내보내는 중…' : '엑셀 내보내기(전체)'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => runExport('template')}
                disabled={exporting !== null}
                title="문항 엑셀 양식을 내려받습니다. 엑셀 가져오기는 아직 지원하지 않습니다(문항은 PDF로 가져옵니다)."
              >
                {exporting === 'template' ? '내려받는 중…' : '엑셀 양식'}
              </button>
              <Link
                to={`/import?year=${year}`}
                className="btn btn-ghost"
                title="새해 개정 문항 PDF를 올립니다. 분야별로 하나씩 올려도 되고 여러 파일을 한 번에 올려도 됩니다. 미리보기에서 변경, 신규 문항을 확인한 뒤 반영합니다. 이미 해 둔 채점과 근거 연결은 그대로 남습니다."
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
            근거자료 개정으로 다시 연결해야 할 근거가 {readiness.totals.anchorOpen}건 있습니다.
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
              // 카드 전체가 문항 목록 링크(겹쳐 깐 링크)이고, 손볼 문항 칩은 그 위의 별도 링크다
              <div key={c.id} className="cat-card dash-card">
                <Link to={`/c/${c.id}`} className="dash-card-link">
                  <span className="cat-card-head">
                    {!isCategoryCodeRedundant(c) && <span className="cat-code">{c.code}</span>}
                    <span className="cat-name">{c.name}</span>
                  </span>
                </Link>
                <div className="cat-meta">
                  문항 {c.questionCount}개, 채점 {c.answeredCount}/{c.questionCount} ({answerPct}%)
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
                <CategoryFlags r={readinessByCat.get(c.id)} catId={c.id} />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="simple-table-wrap">
          <table className="simple-table dash-list">
            <thead>
              <tr>
                <th>분야</th>
                <th className="col-right">문항</th>
                <th className="col-right">채점</th>
                <th className="dash-progress-col">진행</th>
                <th>확인할 문항</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => {
                const { answerPct } = pctOf(c);
                return (
                  <tr
                    key={c.id}
                    className="row-link"
                    onClick={(e) => {
                      // 칩(링크)을 누른 경우는 그 링크가 이동한다
                      if ((e.target as HTMLElement).closest('a')) return;
                      navigate(`/c/${c.id}`);
                    }}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/c/${c.id}`);
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
                    <td className="dash-flags-cell">
                      <CategoryFlags r={readinessByCat.get(c.id)} catId={c.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
