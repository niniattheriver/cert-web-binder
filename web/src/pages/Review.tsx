/**
 * 통합 검수 큐 (v1.5 Phase 1·3a·3b — 설계서 §4 #15)
 * - 유형 필터: 전체 / 지침서 연결(재앵커) / 자동배점(stale diff) / 재확인(개정·재인입·편차).
 * - 자동배점: "현재점 → 새점" diff + [재계산 확정] 원클릭 (A-3).
 * - 재확인: 사유(개정표 원문·편차)와 함께 [확인 완료] 해소 — 해소는 명시적 사용자 액션만.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchReviewSummary, resolveRecheck, type ReviewSummaryResponse } from '../api-phase1';
import { computeAutoScore } from '../api-phase3';
import { useAuth } from '../auth';
import { errorMessage, fmtNum } from '../util';

type ReviewFilter = 'all' | 'anchor' | 'stale' | 'recheck';

const REVIEW_FILTERS: { key: ReviewFilter; label: string; desc: string }[] = [
  { key: 'all', label: '전체', desc: '확인이 필요한 모든 항목을 표시합니다.' },
  {
    key: 'anchor',
    label: '지침서 연결',
    desc: '지침서 개정으로 자동 이관되지 못해 다시 연결해야 하는 근거(발췌)만 표시합니다.',
  },
  {
    key: 'stale',
    label: '자동배점',
    desc: '기관 지표가 바뀌어 점수 재계산 확인이 필요한 자동배점 문항만 표시합니다.',
  },
  {
    key: 'recheck',
    label: '재확인',
    desc: '문항 개정·배점 변경 등으로 채점을 다시 확인해야 하는 문항만 표시합니다.',
  },
];

export default function Review() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role === 'editor' || user?.role === 'admin';

  const [data, setData] = useState<ReviewSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>('all');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchReviewSummary()
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const confirmStale = useCallback(
    (questionId: number) => {
      setBusyId(questionId);
      setRowError(null);
      computeAutoScore(questionId)
        .then(() => {
          load();
          // 상단 검수 배지도 즉시 갱신 — /review에 머무는 동안 pathname이 안 바뀌므로(⑩)
          window.dispatchEvent(new Event('review:changed'));
        })
        .catch((e) => setRowError(errorMessage(e)))
        .finally(() => setBusyId(null));
    },
    [load],
  );

  const confirmRecheck = useCallback(
    (questionId: number) => {
      setBusyId(questionId);
      setRowError(null);
      resolveRecheck(questionId)
        .then(() => {
          load();
          window.dispatchEvent(new Event('review:changed'));
        })
        .catch((e) => setRowError(errorMessage(e)))
        .finally(() => setBusyId(null));
    },
    [load],
  );

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

  const anchorCount = data.docs.reduce((s, d) => s + d.needsReview, 0);
  const empty =
    data.docs.length === 0 && data.autoStale.length === 0 && data.recheck.length === 0;
  const show = (k: Exclude<ReviewFilter, 'all'>): boolean => filter === 'all' || filter === k;
  // 선택한 축만 0건 — 다른 축엔 항목이 있어 전역 empty는 아니지만 하단이 비는 경우(⑨)
  const filterEmpty =
    !empty &&
    ((filter === 'recheck' && data.recheck.length === 0) ||
      (filter === 'stale' && data.autoStale.length === 0) ||
      (filter === 'anchor' && data.docs.length === 0));

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>확인 필요</h1>
        <span className="head-note">미처리 {data.total}건</span>
      </div>
      <p className="page-desc">
        문항 개정·지침서 개정·배점 변경 등으로 <strong>사람이 다시 확인해야 할 항목</strong>이
        자동으로 모이는 화면입니다. 내용을 확인한 뒤 [확인 완료]를 누르면 목록에서 사라집니다.
      </p>
      {rowError && <div className="error-inline">{rowError}</div>}

      <div className="chip-row">
        {REVIEW_FILTERS.map((f) => (
          <button
            type="button"
            key={f.key}
            className={'chip' + (filter === f.key ? ' is-on' : '')}
            onClick={() => setFilter(f.key)}
            title={f.desc}
          >
            {f.label}{' '}
            <span className="chip-count">
              {f.key === 'all'
                ? data.total
                : f.key === 'anchor'
                  ? anchorCount
                  : f.key === 'stale'
                    ? data.autoStale.length
                    : data.recheck.length}
            </span>
          </button>
        ))}
      </div>

      {empty ? (
        <div className="empty-state">
          <p className="empty-title">확인이 필요한 항목이 없습니다.</p>
          <p>
            지침서 개정으로 옮겨지지 못한 연결, 재계산이 필요한 자동배점, 문항 개정 등으로 재확인이
            필요한 문항이 여기에 모입니다.
          </p>
        </div>
      ) : filterEmpty ? (
        <div className="empty-state">
          <p className="empty-title">이 조건에 해당하는 항목이 없습니다.</p>
          <button type="button" className="btn" onClick={() => setFilter('all')}>
            전체 보기
          </button>
        </div>
      ) : (
        <>
          {show('recheck') && data.recheck.length > 0 && (
            <section className="summary-section">
              <h2 className="summary-cat-head">
                재확인 필요 <span className="dim">({data.recheck.length})</span>
              </h2>
              <div className="simple-table-wrap">
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th className="col-no">문항</th>
                      <th>사유</th>
                      <th className="col-right">점수</th>
                      <th className="col-center" aria-label="동작" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.recheck.map((r) => (
                      <tr key={r.questionId}>
                        <td className="col-no">
                          <button
                            type="button"
                            className="linklike mono"
                            onClick={() => navigate(`/q/${r.questionId}`)}
                          >
                            {r.questionNo}
                          </button>
                        </td>
                        <td className="dim cell-ellipsis" title={r.revisionNote ?? ''}>
                          {r.revisionNote ?? '문항 갱신/배점 차이'}
                        </td>
                        <td className="col-right mono">
                          {r.score == null ? '—' : fmtNum(r.score)} /{' '}
                          {r.maxScore == null ? '—' : fmtNum(r.maxScore)}
                        </td>
                        <td className="col-center">
                          {canEdit && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyId === r.questionId}
                              onClick={() => confirmRecheck(r.questionId)}
                              title="점수·답변을 확인했으면 재확인 표시를 해제합니다"
                            >
                              {busyId === r.questionId ? '처리 중…' : '확인 완료'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {show('stale') && data.autoStale.length > 0 && (
            <section className="summary-section">
              <h2 className="summary-cat-head">
                자동배점 재계산 필요 <span className="dim">({data.autoStale.length})</span>
              </h2>
              <div className="simple-table-wrap">
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th className="col-no">문항</th>
                      <th>지표</th>
                      <th className="col-right">현재점 → 새점</th>
                      <th className="col-center" aria-label="동작" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.autoStale.map((s) => (
                      <tr key={s.questionId}>
                        <td className="col-no">
                          <button
                            type="button"
                            className="linklike mono"
                            onClick={() => navigate(`/q/${s.questionId}`)}
                          >
                            {s.questionNo}
                          </button>
                        </td>
                        <td className="dim">
                          {s.metricLabel ?? s.metricKey ?? '—'}
                          {s.metricValue != null ? ` = ${s.metricValue}` : ' (입력값 없음)'}
                        </td>
                        <td className="col-right mono">
                          {s.currentScore == null ? '—' : fmtNum(s.currentScore)} →{' '}
                          <strong>{s.newScore == null ? '입력값 없음' : fmtNum(s.newScore)}</strong>
                        </td>
                        <td className="col-center">
                          {canEdit && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyId === s.questionId}
                              onClick={() => confirmStale(s.questionId)}
                              title="현재 지표값으로 재계산하고 스냅샷을 확정합니다"
                            >
                              {busyId === s.questionId ? '확정 중…' : '재계산 확정'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {show('anchor') && data.docs.length > 0 && (
            <section className="summary-section">
              <h2 className="summary-cat-head">
                지침서 연결 확인 필요 <span className="dim">({anchorCount})</span>
              </h2>
              <div className="simple-table-wrap">
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th>지침서</th>
                      <th>현재 판본</th>
                      <th className="col-right">확인 필요</th>
                      <th className="col-center" aria-label="동작" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.docs.map((d) => (
                      <tr key={d.documentId}>
                        <td>
                          {d.code && <span className="mono dim">{d.code} · </span>}
                          {d.title}
                        </td>
                        <td className="dim">{d.versionLabel}</td>
                        <td className="col-right">
                          <span className="badge badge-recheck">{d.needsReview}건</span>
                        </td>
                        <td className="col-center">
                          <Link className="btn btn-sm" to={`/docs/${d.documentId}`}>
                            뷰어에서 확인
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
