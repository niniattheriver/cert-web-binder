/**
 * 결과 요약 (v1.5 Phase 1·2 — 설계서 §4 #13)
 * - GET /api/summary → 분야별 감점(아니오 또는 예&취득점<배점)·지적/권장사항 입력·
 *   자동입력 미확정(Phase 2) 문항.
 * - 필터 칩: 전체 / 감점만 / 지적만 / 자동입력 미확정. 행 클릭 → /q/:id.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSummary, type SummaryItem, type SummaryResponse } from '../api-phase1';
import { categoryLabel } from '../api';
import { errorMessage, fixBullets, fmtNum } from '../util';

type FilterKey = 'all' | 'deducted' | 'findings' | 'autofilled';

const FILTERS: { key: FilterKey; label: string; desc: string }[] = [
  { key: 'all', label: '전체', desc: '채점된 모든 문항을 표시합니다.' },
  { key: 'deducted', label: '감점만', desc: '만점을 받지 못한(감점된) 문항만 표시합니다.' },
  { key: 'findings', label: '지적만', desc: '지적/권장사항이 입력된 문항만 표시합니다.' },
  {
    key: 'autofilled',
    label: '자동입력 미확정',
    desc: '"예"를 고르면 배점 만점이 자동 입력됩니다. 그중 아직 사람이 점수를 확정하지 않은 문항만 표시합니다.',
  },
];

function matches(item: SummaryItem, f: FilterKey): boolean {
  if (f === 'deducted') return item.deducted;
  if (f === 'findings') return item.hasFindings;
  if (f === 'autofilled') return item.autofilled;
  return true;
}

function scoreText(item: SummaryItem): string {
  const max = item.maxScore != null ? fmtNum(item.maxScore) : '—';
  if (item.answerChoice === 'no') return `0 / ${max}`;
  if (item.score != null) return `${fmtNum(item.score)} / ${max}`;
  return `— / ${max}`;
}

export default function Summary() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ?f= 딥링크 (준비도 진단 등 — 진입 시 1회만 반영)
  const [filter, setFilter] = useState<FilterKey>(() => {
    const f = searchParams.get('f');
    return f === 'deducted' || f === 'findings' || f === 'autofilled' ? f : 'all';
  });

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSummary()
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.categories
      .map((c) => ({ ...c, items: c.items.filter((i) => matches(i, filter)) }))
      .filter((c) => c.items.length > 0);
  }, [data, filter]);

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

  return (
    <div className="page">
      <div className="page-head">
        <h1>결과 요약</h1>
        {data.activeCycle && <span className="cycle-chip">주기: {data.activeCycle.name}</span>}
        <span className="head-note">
          감점 {data.totals.deducted} · 지적 {data.totals.findings} · 자동입력 미확정{' '}
          {data.totals.autofilled}
        </span>
      </div>
      <p className="page-desc">
        <strong>감점된 문항</strong>과 <strong>지적/권장사항이 입력된 문항</strong>만 모아 한
        번에 보는 화면입니다. 행을 클릭하면 해당 문항으로 이동합니다.
      </p>

      <div className="chip-row">
        {FILTERS.map((f) => (
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
                ? data.totals.total
                : f.key === 'deducted'
                  ? data.totals.deducted
                  : f.key === 'findings'
                    ? data.totals.findings
                    : data.totals.autofilled}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">해당하는 문항이 없습니다.</p>
          <p>감점이나 지적/권장사항이 입력된 문항이 여기에 모입니다.</p>
        </div>
      ) : (
        filtered.map((cat) => (
          <section key={cat.id} className="summary-section">
            <h2 className="summary-cat-head">
              {categoryLabel(cat)} <span className="dim">({cat.items.length})</span>
            </h2>
            <div className="simple-table-wrap">
              <table className="simple-table summary-table">
                <thead>
                  <tr>
                    <th className="col-no">번호</th>
                    <th>문항</th>
                    <th className="col-right">점수</th>
                    <th className="col-center">구분</th>
                    <th>지적/권장사항</th>
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((item) => (
                    <tr
                      key={item.id}
                      className="row-link"
                      onClick={() => navigate(`/q/${item.id}`)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') navigate(`/q/${item.id}`);
                      }}
                    >
                      <td className="col-no mono">{item.questionNo}</td>
                      <td className="cell-ellipsis" title={fixBullets(item.body)}>
                        {fixBullets(item.body)}
                      </td>
                      <td className="col-right mono">{scoreText(item)}</td>
                      <td className="col-center">
                        {item.deducted && (
                          <span className="badge badge-deducted" title="만점을 받지 못한(감점된) 문항입니다.">
                            감점
                          </span>
                        )}
                        {item.hasFindings && (
                          <span className="badge badge-findings" title="지적/권장사항이 입력된 문항입니다.">
                            지적
                          </span>
                        )}
                        {item.autofilled && (
                          <span className="badge badge-autofilled" title="예 선택 시 만점이 자동 입력된 뒤 아직 확인되지 않았습니다">
                            자동
                          </span>
                        )}
                      </td>
                      <td className="cell-ellipsis dim" title={item.findingsText ?? ''}>
                        {item.findingsText}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
