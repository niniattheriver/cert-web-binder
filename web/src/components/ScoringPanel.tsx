/**
 * 합산/자동 채점 패널 (v1.5 Phase 3a — 설계서 §4 채점 위젯 확장, A-3·A-4)
 * - composite: 세부항목 입력표(항목별 0.5 간격 취득점) + 읽기전용 합계. 총점은 서버 파생값.
 * - auto: 기관 지표 수동 바인딩 + [lower, upper) 구간표 편집 + [계산] 스냅샷 + override(사유 필수).
 *   지표 미입력 = '입력값 없음'(0점/만점 아님). stale 이면 재계산 안내.
 * - 데이터 로드/저장 자체 수행. 채점 변경은 question.rowVersion 을 올리므로 완료 시
 *   onQuestionChanged() 로 부모가 서버본을 재동기화한다.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchOrg, type OrgMetric } from '../api-phase1';
import {
  computeAutoScore,
  createCriterion,
  deleteCriterion,
  fetchScoring,
  overrideScore,
  patchCriterion,
  putAutoRule,
  type AutoBand,
  type ScoringInfo,
} from '../api-phase3';
import { errorMessage, fmtNum } from '../util';

interface Props {
  questionId: number;
  canEdit: boolean;
  /** 채점 변경으로 question(score·rowVersion)이 바뀐 뒤 호출 — 부모 serverRef 재동기화.
   *  최신 rowVersion 을 동기 전달해 대기 중 자동저장의 거짓 409 창을 줄인다 */
  onQuestionChanged: (rowVersion?: number) => void;
}

/** 구간 편집용 문자열 초안 */
interface BandDraft {
  lower: string; // '' = −∞ (첫 구간)
  upper: string; // '' = +∞ (마지막 구간)
  score: string;
}

function bandsToDrafts(bands: AutoBand[]): BandDraft[] {
  if (bands.length === 0) return [{ lower: '', upper: '', score: '' }];
  return bands.map((b) => ({
    lower: b.lower == null ? '' : String(b.lower),
    upper: b.upper == null ? '' : String(b.upper),
    score: String(b.score),
  }));
}

export default function ScoringPanel({ questionId, canEdit, onQuestionChanged }: Props) {
  const [info, setInfo] = useState<ScoringInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // composite 초안
  const [addLabel, setAddLabel] = useState('');
  const [addMax, setAddMax] = useState('');
  const [scoreDrafts, setScoreDrafts] = useState<Record<number, string>>({});

  // auto 초안
  const [metrics, setMetrics] = useState<OrgMetric[] | null>(null);
  const [metricKey, setMetricKey] = useState('');
  const [bandDrafts, setBandDrafts] = useState<BandDraft[]>([]);
  const [ruleDirty, setRuleDirty] = useState(false);
  const [ovOpen, setOvOpen] = useState(false);
  const [ovScore, setOvScore] = useState('');
  const [ovReason, setOvReason] = useState('');

  const editable = canEdit;

  const applyInfo = useCallback((s: ScoringInfo) => {
    setInfo(s);
    setScoreDrafts({});
    setMetricKey(s.autoRule?.sourceMetricKey ?? '');
    setBandDrafts(bandsToDrafts(s.autoRule?.bands ?? []));
    setRuleDirty(false);
  }, []);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    setError(null);
    setOvOpen(false);
    fetchScoring(questionId)
      .then((s) => {
        if (alive) applyInfo(s);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [questionId, applyInfo]);

  useEffect(() => {
    if (!editable || info?.mode !== 'auto' || metrics != null) return;
    fetchOrg()
      .then((r) => setMetrics(r.metrics))
      .catch(() => setMetrics([]));
  }, [editable, info?.mode, metrics]);

  const run = useCallback(
    (task: Promise<ScoringInfo>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      return task
        .then((s) => {
          applyInfo(s);
          onQuestionChanged(s.rowVersion);
          return true;
        })
        .catch((e) => {
          setError(errorMessage(e));
          return false;
        })
        .finally(() => setBusy(false));
    },
    [applyInfo, onQuestionChanged],
  );

  if (error && !info) return <div className="error-inline">{error}</div>;
  if (!info) return <p className="dim">채점 정보 불러오는 중…</p>;

  // ── 합산(composite) ────────────────────────────────────────────────────────
  if (info.mode === 'composite') {
    const maxMismatch =
      info.maxScore != null && Math.abs(info.criteriaTotal.maxScore - info.maxScore) > 1e-9;
    return (
      <div className="scoring-panel">
        {error && <div className="error-inline">{error}</div>}
        {info.criteria.length === 0 ? (
          <p className="dim">세부 평가항목이 없습니다.{editable && ' 아래에서 항목을 추가하세요.'}</p>
        ) : (
          <table className="simple-table criteria-table">
            <thead>
              <tr>
                <th>세부 평가항목</th>
                <th className="col-right">취득점</th>
                <th className="col-right">배점</th>
                {editable && <th className="col-center" aria-label="동작" />}
              </tr>
            </thead>
            <tbody>
              {info.criteria.map((c) => (
                <tr key={c.id} className={c.parentId != null ? 'criteria-child' : undefined}>
                  <td>{c.label}</td>
                  <td className="col-right">
                    {editable ? (
                      <input
                        className="score-input criteria-score"
                        type="number"
                        inputMode="decimal"
                        step={0.5}
                        min={0}
                        max={c.maxScore}
                        value={scoreDrafts[c.id] ?? (c.score == null ? '' : String(c.score))}
                        placeholder="미채점"
                        disabled={busy}
                        onChange={(e) =>
                          setScoreDrafts((d) => ({ ...d, [c.id]: e.target.value }))
                        }
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const next = raw === '' ? null : Number(raw);
                          if (next !== null && !Number.isFinite(next)) return;
                          if (next === c.score || (raw !== '' && String(c.score) === raw)) return;
                          run(patchCriterion(c.id, { score: next }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        aria-label={`${c.label} 취득점`}
                      />
                    ) : (
                      <span className="mono">{c.score == null ? '—' : fmtNum(c.score)}</span>
                    )}
                  </td>
                  <td className="col-right mono">{fmtNum(c.maxScore)}</td>
                  {editable && (
                    <td className="col-center">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`항목 '${c.label}'을(를) 삭제할까요? (기록은 보존됩니다)`))
                            run(deleteCriterion(c.id));
                        }}
                      >
                        삭제
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="criteria-total">
                <td>합계 (총점 — 자동 계산)</td>
                <td className="col-right mono">
                  {info.criteriaTotal.score == null ? '미채점' : fmtNum(info.criteriaTotal.score)}
                </td>
                <td className="col-right mono">{fmtNum(info.criteriaTotal.maxScore)}</td>
                {editable && <td />}
              </tr>
            </tfoot>
          </table>
        )}
        {maxMismatch && (
          <div className="notice-inline scoring-warn">
            세부항목 배점 합({fmtNum(info.criteriaTotal.maxScore)})이 문항 배점(
            {fmtNum(info.maxScore)})과 다릅니다 — 항목 구성을 확인하세요. (무결성 점검 대상)
          </div>
        )}
        {editable && (
          <div className="criteria-add">
            <input
              className="attach-input"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="항목명 (예: 절차 문서화)"
              aria-label="항목명"
            />
            <input
              className="attach-input criteria-max-input"
              type="number"
              inputMode="decimal"
              step={0.5}
              min={0.5}
              value={addMax}
              onChange={(e) => setAddMax(e.target.value)}
              placeholder="배점"
              aria-label="항목 배점"
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || addLabel.trim() === '' || !(Number(addMax) > 0)}
              onClick={() => {
                // 성공 시에만 입력 초기화 — 실패(0.5 간격 위반 등) 시 재입력 보호 (검토 반영)
                void run(
                  createCriterion(questionId, { label: addLabel.trim(), maxScore: Number(addMax) }),
                ).then((ok) => {
                  if (ok) {
                    setAddLabel('');
                    setAddMax('');
                  }
                });
              }}
            >
              + 항목 추가
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── 자동배점(auto) ─────────────────────────────────────────────────────────
  const rule = info.autoRule;
  const bindableMetrics = (metrics ?? []).filter((m) => m.valueType !== 'text');
  const noValue = rule?.metric == null || rule.metric.value == null;
  return (
    <div className="scoring-panel">
      {error && <div className="error-inline">{error}</div>}

      <div className="auto-status">
        점수:{' '}
        <strong className="mono">
          {info.score == null ? (noValue && rule?.state ? '입력값 없음' : '미계산') : fmtNum(info.score)}
        </strong>{' '}
        / {fmtNum(info.maxScore)}
        {info.scoreOverridden && (
          <span className="badge badge-findings" title="자동 계산값을 수기로 수정했습니다(사유 change_log 기록)">
            수기 override
          </span>
        )}
        {rule?.state?.stale && (
          <span className="badge badge-recheck" title="지표 또는 구간표가 바뀌었습니다 — 재계산으로 확정하세요">
            재계산 필요
          </span>
        )}
      </div>
      {rule?.metric ? (
        <p className="dim auto-metric-line">
          지표: {rule.metric.label} ={' '}
          {rule.metric.value == null ? '입력값 없음' : `${rule.metric.value}${rule.metric.unit ?? ''}`}
          {rule.state?.computedAt && ` · 마지막 계산 ${rule.state.computedAt.slice(0, 10)}`}
        </p>
      ) : (
        <p className="dim auto-metric-line">
          기관 지표가 바인딩되지 않았습니다(미활성).{editable && ' 아래에서 지표를 선택하고 구간표를 저장하세요.'}
        </p>
      )}

      {editable && (
        <div className="auto-editor">
          <label className="field auto-metric-field">
            <span className="field-label">기관 지표 (수동 바인딩 — 기관 정보에서 지표 관리)</span>
            <select
              value={metricKey}
              onChange={(e) => {
                setMetricKey(e.target.value);
                setRuleDirty(true);
              }}
            >
              <option value="">(선택 안 함 — 미활성)</option>
              {bindableMetrics.map((m) => (
                <option key={m.metricKey} value={m.metricKey}>
                  {m.label} ({m.metricKey}){m.value != null ? ` = ${m.value}${m.unit ?? ''}` : ' — 입력값 없음'}
                </option>
              ))}
            </select>
          </label>

          <table className="simple-table bands-table">
            <thead>
              <tr>
                <th>하한 (이상)</th>
                <th>상한 (미만)</th>
                <th className="col-right">점수</th>
                <th className="col-center" aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {bandDrafts.map((b, i) => (
                <tr key={i}>
                  <td>
                    <input
                      className="attach-input band-input"
                      value={b.lower}
                      placeholder={i === 0 ? '−∞' : ''}
                      disabled={i === 0}
                      onChange={(e) => {
                        setBandDrafts((d) => {
                          const next = d.map((x, j) => (j === i ? { ...x, lower: e.target.value } : x));
                          // 연속성 유지 — 이전 구간 상한을 자동 동기화 (검토 반영)
                          if (i > 0) next[i - 1] = { ...next[i - 1]!, upper: e.target.value };
                          return next;
                        });
                        setRuleDirty(true);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="attach-input band-input"
                      value={b.upper}
                      placeholder={i === bandDrafts.length - 1 ? '+∞' : ''}
                      disabled={i === bandDrafts.length - 1}
                      onChange={(e) => {
                        setBandDrafts((d) => {
                          const next = d.map((x, j) => (j === i ? { ...x, upper: e.target.value } : x));
                          // 연속성 유지 — 다음 구간 하한을 자동 동기화
                          if (i + 1 < next.length) next[i + 1] = { ...next[i + 1]!, lower: e.target.value };
                          return next;
                        });
                        setRuleDirty(true);
                      }}
                    />
                  </td>
                  <td className="col-right">
                    <input
                      className="attach-input band-input band-score"
                      value={b.score}
                      onChange={(e) => {
                        setBandDrafts((d) => d.map((x, j) => (j === i ? { ...x, score: e.target.value } : x)));
                        setRuleDirty(true);
                      }}
                    />
                  </td>
                  <td className="col-center">
                    {bandDrafts.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setBandDrafts((d) => {
                            const removed = d[i]!;
                            const next = d.filter((_, j) => j !== i);
                            // 이웃 경계 잇기 — 중간 행 삭제로 구멍이 생기지 않게 (검토 반영)
                            if (i < next.length) next[i] = { ...next[i]!, lower: removed.lower };
                            if (next.length > 0) {
                              next[0] = { ...next[0]!, lower: '' };
                              next[next.length - 1] = { ...next[next.length - 1]!, upper: '' };
                            }
                            return next;
                          });
                          setRuleDirty(true);
                        }}
                      >
                        삭제
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="attach-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setBandDrafts((d) => {
                  const last = d[d.length - 1]!;
                  const mid = last.lower === '' ? '' : last.lower;
                  return [...d.slice(0, -1), { ...last, upper: mid }, { lower: mid, upper: '', score: '' }];
                });
                setRuleDirty(true);
              }}
            >
              + 구간 추가
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !ruleDirty}
              onClick={() => {
                // 빈 점수 칸은 Number('')===0 으로 조용히 0점이 되므로 명시 차단 (검토 반영)
                if (bandDrafts.some((b) => b.score.trim() === '')) {
                  setError('모든 구간의 점수를 입력하세요.');
                  return;
                }
                const bands: AutoBand[] = bandDrafts.map((b) => ({
                  lower: b.lower.trim() === '' ? null : Number(b.lower),
                  upper: b.upper.trim() === '' ? null : Number(b.upper),
                  score: Number(b.score),
                }));
                if (bands.some((b) => !Number.isFinite(b.score) || (b.lower !== null && !Number.isFinite(b.lower)) || (b.upper !== null && !Number.isFinite(b.upper)))) {
                  setError('구간표의 값은 숫자여야 합니다.');
                  return;
                }
                void run(putAutoRule(questionId, { sourceMetricKey: metricKey === '' ? null : metricKey, bands }));
              }}
            >
              규칙 저장
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || rule?.sourceMetricKey == null || ruleDirty}
              title={ruleDirty ? '먼저 규칙을 저장하세요' : '현재 지표값으로 계산하고 스냅샷을 동결합니다'}
              onClick={() => run(computeAutoScore(questionId))}
            >
              {rule?.state?.stale ? '재계산 (확정)' : '계산'}
            </button>
            {!ovOpen ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  setOvScore(info.score == null ? '' : String(info.score));
                  setOvReason('');
                  setOvOpen(true);
                }}
              >
                수기 override…
              </button>
            ) : (
              <div className="attach-link-form">
                <input
                  className="attach-input band-input"
                  type="number"
                  step={0.5}
                  min={0}
                  value={ovScore}
                  onChange={(e) => setOvScore(e.target.value)}
                  placeholder="점수"
                  aria-label="override 점수"
                />
                <input
                  className="attach-input"
                  value={ovReason}
                  onChange={(e) => setOvReason(e.target.value)}
                  placeholder="사유 (필수 — change_log 기록)"
                  aria-label="override 사유"
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || ovReason.trim() === '' || ovScore.trim() === ''}
                  onClick={() => {
                    // 성공 시에만 폼 닫기 — 400(0.5 간격·배점 초과) 시 입력 보존 (검토 반영)
                    void run(
                      overrideScore(questionId, { score: Number(ovScore), reason: ovReason.trim() }),
                    ).then((ok) => {
                      if (ok) setOvOpen(false);
                    });
                  }}
                >
                  확정
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOvOpen(false)}>
                  취소
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {!editable && rule && rule.bands.length > 0 && (
        <table className="simple-table bands-table">
          <thead>
            <tr>
              <th>구간</th>
              <th className="col-right">점수</th>
            </tr>
          </thead>
          <tbody>
            {rule.bands.map((b, i) => (
              <tr key={i}>
                <td className="mono">
                  {b.lower == null ? '−∞' : fmtNum(b.lower)} ~ {b.upper == null ? '+∞' : fmtNum(b.upper)}
                </td>
                <td className="col-right mono">{fmtNum(b.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
