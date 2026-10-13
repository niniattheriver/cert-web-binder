/**
 * 연도별 홈 — 로그인 첫 화면 (설계서 §4)
 * 연도(2026~2036) 리스트를 보여주고, 연도를 클릭하면 그 해의 대시보드(/y/:year)로 이동한다.
 * 아직 문항이 없는 연도도 이동 가능 — 연도 대시보드가 문항 PDF 업로드 경로를 안내한다.
 * 데이터 범위 밖 연도에 주기가 있으면(과거 연도 등) 리스트에 합쳐 숨기지 않는다.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBootstrap, type BootstrapResponse, type CycleSummary } from '../api';
import ChangePasswordModal from '../components/ChangePasswordModal';
import { errorMessage } from '../util';

const YEAR_FROM = 2026;
const YEAR_TO = 2036;

/** 처음 설정 안내 카드 닫음 표시 (이 PC 브라우저에 저장) */
const SETUP_CARD_KEY = 'setup-card-dismissed';

const SETUP_STEPS: { label: string; to?: string; desc: string }[] = [
  { label: '관리자 비밀번호 바꾸기', desc: '처음 받은 비밀번호 대신 새 비밀번호를 정합니다.' },
  { label: '기관 정보 입력', to: '/org', desc: '기관 이름을 넣으면 화면과 출력물에 표시됩니다.' },
  { label: '문항 PDF 가져오기', to: '/import', desc: '올해 인증심사 문항 PDF를 올립니다. 미리보기 후 반영됩니다.' },
  {
    label: '근거자료 올리기',
    to: '/docs',
    desc: '기관 문서 파일(PDF, Word, Excel, PowerPoint, 한글, 텍스트)을 올려 두면 문항과 연결할 수 있습니다.',
  },
  { label: '직원 계정 만들기', to: '/users', desc: '함께 준비할 직원의 계정을 만듭니다.' },
  { label: '백업 확인', to: '/admin', desc: '운영 점검 화면에서 백업이 만들어지는지 확인합니다.' },
];

export default function Home() {
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(
    () => localStorage.getItem(SETUP_CARD_KEY) === '1',
  );
  const [pwOpen, setPwOpen] = useState(false);

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

  // 처음 설정 안내 카드 — 관리자이면서 아직 문항이 하나도 없을 때만(문항이 생기면 자동 소멸)
  const totalQuestions = (data.cycles ?? []).reduce((s, c) => s + c.questionCount, 0);
  const showSetupCard = data.user.role === 'admin' && totalQuestions === 0 && !setupDismissed;

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
              title="새해 개정 문항 PDF를 올립니다. 분야별로 하나씩 올려도 되고 여러 파일을 한 번에 올려도 됩니다. 미리보기에서 변경, 신규 문항을 확인한 뒤 반영합니다. 새 연도는 지난 연도의 서술 답변과 근거 연결을 물려받고, 예/아니오 선택과 점수는 새로 시작합니다."
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

      {showSetupCard && (
        <div className="card setup-card">
          <div className="setup-card-head">
            <h2 className="card-title">처음 설정 순서</h2>
            <button
              type="button"
              className="btn btn-sm"
              title="이 안내를 닫습니다. 문항을 등록하면 자동으로 사라집니다."
              onClick={() => {
                localStorage.setItem(SETUP_CARD_KEY, '1');
                setSetupDismissed(true);
              }}
            >
              닫기
            </button>
          </div>
          <p className="dim">
            처음 설치했다면 아래 순서대로 진행하세요. 문항을 등록하면 이 안내는 자동으로
            사라집니다.
          </p>
          <ol className="setup-steps">
            {SETUP_STEPS.map((s, i) => (
              <li key={s.label}>
                {s.to ? (
                  <Link to={s.to} className="setup-step-link">
                    {i + 1}. {s.label}
                  </Link>
                ) : (
                  <button type="button" className="setup-step-link" onClick={() => setPwOpen(true)}>
                    {i + 1}. {s.label}
                  </button>
                )}
                <span className="dim">: {s.desc}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}

      {/* 문항이 있는 연도 = 큰 카드(그리드), 아직 비어 있는 연도 = 한 카드 안의 연도 칩.
          모든 연도가 여전히 링크다(설계서 §4 — 빈 연도도 이동 가능, 대시보드가 업로드 경로를 안내). */}
      <div className="year-grid">
        {yearList
          .filter((y) => byYear.has(y))
          .map((y) => {
            const cy = byYear.get(y)!;
            const isCurrent = data.activeCycle != null && cy.id === data.activeCycle.id;
            const pct =
              cy.questionCount > 0
                ? Math.round((cy.answeredCount / cy.questionCount) * 100)
                : 0;
            return (
              <Link
                key={y}
                to={`/y/${y}`}
                className={'year-card' + (isCurrent ? ' is-current' : '')}
              >
                <div className="year-card-head">
                  <span className="year-row-title">{y}년 심사</span>
                  {isCurrent && <span className="year-now">현재</span>}
                </div>
                <div className="year-card-n">
                  {cy.questionCount.toLocaleString()}
                  <span className="year-card-unit">문항</span>
                </div>
                <div className="year-card-sub">
                  채점 {cy.answeredCount.toLocaleString()}/{cy.questionCount.toLocaleString()} ({pct}%)
                </div>
                <div
                  className="progress year-progress"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="year-card-go">심사 준비 화면 →</span>
              </Link>
            );
          })}
      </div>
      {yearList.some((y) => !byYear.has(y)) && (
        <div className="card year-empty-card">
          <div className="card-title">아직 문항이 없는 연도</div>
          <p className="year-empty-desc">
            연도를 누르면 그 해의 준비 화면이 열리고 거기서 개정 문항 PDF를 올려 새 연도를 시작합니다.
          </p>
          <div className="year-chips">
            {yearList
              .filter((y) => !byYear.has(y))
              .map((y) => (
                <Link key={y} to={`/y/${y}`} className="chip">
                  {y}년
                </Link>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
