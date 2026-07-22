/**
 * 연도별 홈 — 로그인 첫 화면 (설계서 §4)
 * 연도(2026~2036) 리스트를 보여주고, 연도를 클릭하면 그 해의 대시보드(/y/:year)로 이동한다.
 * 아직 문항이 없는 연도도 이동 가능 — 연도 대시보드가 문항 PDF 업로드 경로를 안내한다.
 * 데이터 범위 밖 연도에 주기가 있으면(과거 연도 등) 리스트에 합쳐 숨기지 않는다.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBootstrap, type BootstrapResponse, type CycleSummary } from '../api';
import { errorMessage } from '../util';

const YEAR_FROM = 2026;
const YEAR_TO = 2036;

export default function Home() {
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchBootstrap()
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

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

  // 연도 → 주기 매핑 (bootstrap.cycles 는 연도 내림차순 — 같은 연도 중복 시 최신 주기 우선)
  const byYear = new Map<number, CycleSummary>();
  for (const cy of data.cycles ?? []) {
    if (cy.year != null && !byYear.has(cy.year)) byYear.set(cy.year, cy);
  }
  const years = new Set<number>();
  for (let y = YEAR_FROM; y <= YEAR_TO; y += 1) years.add(y);
  for (const y of byYear.keys()) years.add(y);
  const yearList = [...years].sort((a, b) => a - b);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>연도별 인증심사</h1>
        <div className="head-actions">
          {canEdit && (
            <Link
              to="/import"
              className="btn"
              title="새해(개정) 인증문항 PDF를 분야별 하나 또는 여러 파일 일괄로 업로드합니다. 미리보기(변경·신규 확인) 후 반영됩니다. 새 연도 문항 PDF를 올리면 지난 연도의 답변·근거 연결은 물려받고, 점수는 새로 시작합니다."
            >
              + 새 문항 PDF 가져오기
            </Link>
          )}
        </div>
      </div>
      <p className="page-desc">
        연도를 선택하면 그 해의 인증심사 준비 화면으로 이동합니다. 해마다 개정된 문항 PDF를 올려
        새 연도를 시작할 수 있습니다.
      </p>

      <div className="year-list">
        {yearList.map((y) => {
          const cy = byYear.get(y) ?? null;
          const isCurrent =
            cy != null && data.activeCycle != null && cy.id === data.activeCycle.id;
          const pct =
            cy && cy.questionCount > 0
              ? Math.round((cy.answeredCount / cy.questionCount) * 100)
              : 0;
          return (
            <Link
              key={y}
              to={`/y/${y}`}
              className={'year-row' + (isCurrent ? ' is-current' : '')}
            >
              <span className="year-row-title">{y}년 심사</span>
              {isCurrent && <span className="year-now">현재</span>}
              {cy ? (
                <>
                  <span className="year-row-meta">
                    문항 {cy.questionCount}개 · 답변 {cy.answeredCount}/{cy.questionCount} ({pct}
                    %)
                  </span>
                  <div
                    className="progress year-progress"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                </>
              ) : (
                <span className="year-row-meta dim">아직 문항이 없습니다</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
