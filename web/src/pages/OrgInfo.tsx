/**
 * 기관 정보 (v1.5 Phase 1 — 설계서 §4 #14)
 * - 기관 설정(기관명·시스템 표시명 — app_setting) 편집.
 * - 기관 지표(org_metric — 활성 주기 스코프): 추가·값 입력·soft delete.
 *   지표 미입력(값 없음)은 '입력값 없음' — 0이 아니다. 자동배점(Phase 3a)의 입력원.
 * - editor 이상 편집, viewer 는 열람 전용. 충돌(409) 시 최신 값으로 갱신 안내.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createOrgMetric,
  deleteOrgMetric,
  fetchOrg,
  patchOrgMetric,
  patchOrgSettings,
  type MetricValueType,
  type OrgMetric,
  type OrgResponse,
} from '../api-phase1';
import { ConflictError } from '../api';
import { useAuth } from '../auth';
import { errorMessage, fmtDate } from '../util';

const TYPE_LABEL: Record<MetricValueType, string> = {
  number: '숫자',
  integer: '정수',
  text: '텍스트',
};

/** 지표 한 행 — 값 인라인 편집 (Enter/블러 저장) */
function MetricRow({
  metric,
  canEdit,
  onSaved,
  onError,
  onConflict,
  onDelete,
}: {
  metric: OrgMetric;
  canEdit: boolean;
  onSaved: (m: OrgMetric) => void;
  onError: (msg: string) => void;
  onConflict: () => void;
  onDelete: (m: OrgMetric) => void;
}) {
  const [draft, setDraft] = useState(metric.value ?? '');
  const [saving, setSaving] = useState(false);

  // 서버본 갱신(저장/충돌 리로드) 시 드래프트 동기화
  useEffect(() => {
    setDraft(metric.value ?? '');
  }, [metric.value, metric.rowVersion]);

  const save = () => {
    const next = draft.trim();
    if (next === (metric.value ?? '')) return;
    setSaving(true);
    patchOrgMetric(metric.id, { rowVersion: metric.rowVersion, value: next === '' ? null : next })
      .then((m) => {
        onSaved(m);
        setDraft(m.value ?? ''); // 서버 정규화("5.0"→"5")가 무변경 멱등으로 끝나도 입력창을 영속값에 수렴
      })
      .catch((e) => {
        if (e instanceof ConflictError) onConflict();
        else onError(errorMessage(e));
        setDraft(metric.value ?? '');
      })
      .finally(() => setSaving(false));
  };

  return (
    <tr>
      <td>{metric.label}</td>
      <td className="mono dim">{metric.metricKey}</td>
      <td>
        {canEdit ? (
          <span className="metric-value-cell">
            <input
              className="metric-input"
              value={draft}
              placeholder="입력값 없음"
              disabled={saving}
              inputMode={metric.valueType === 'text' ? 'text' : 'decimal'}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              aria-label={`${metric.label} 값`}
            />
            {metric.unit && <span className="dim">{metric.unit}</span>}
          </span>
        ) : (
          <span>
            {metric.value ?? <span className="dim">입력값 없음</span>}
            {metric.value != null && metric.unit ? ` ${metric.unit}` : ''}
          </span>
        )}
      </td>
      <td className="col-center dim">{TYPE_LABEL[metric.valueType]}</td>
      <td className="dim">
        {fmtDate(metric.updatedAt)}
        {metric.updatedByName ? ` · ${metric.updatedByName}` : ''}
      </td>
      {canEdit && (
        <td className="col-center">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onDelete(metric)}
            title="지표 삭제 (기록은 보존됩니다)"
          >
            삭제
          </button>
        </td>
      )}
    </tr>
  );
}

export default function OrgInfo() {
  const { user } = useAuth();
  const canEdit = user?.role === 'editor' || user?.role === 'admin';

  const [data, setData] = useState<OrgResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 기관 설정 폼
  const [orgName, setOrgName] = useState('');
  const [systemName, setSystemName] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  // 지표 추가 폼
  const [addOpen, setAddOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newUnit, setNewUnit] = useState('');
  const [newType, setNewType] = useState<MetricValueType>('number');
  const [newValue, setNewValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOrg()
      .then((r) => {
        setData(r);
        setOrgName(r.settings.orgName ?? '');
        setSystemName(r.settings.systemName ?? '');
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const saveSettings = () => {
    if (!data) return;
    setSavingSettings(true);
    setNotice(null);
    patchOrgSettings({ orgName: orgName.trim(), systemName: systemName.trim() })
      .then((r) => {
        // 함수형 갱신 — 동시에 도착한 지표 저장 결과를 스테일 클로저로 덮어쓰지 않는다
        setData((d) => (d ? { ...d, settings: r.settings } : d));
        setNotice('기관 설정을 저장했습니다. 상단 표시명은 새로고침 후 반영됩니다.');
      })
      .catch((e) => setNotice(errorMessage(e)))
      .finally(() => setSavingSettings(false));
  };

  const replaceMetric = (m: OrgMetric) => {
    setData((d) =>
      d ? { ...d, metrics: d.metrics.map((x) => (x.id === m.id ? m : x)) } : d,
    );
  };

  const onConflict = () => {
    setNotice('다른 사용자가 먼저 수정했습니다. 최신 값으로 갱신했습니다.');
    load();
  };

  const removeMetric = (m: OrgMetric) => {
    if (!window.confirm(`지표 '${m.label}'을(를) 삭제할까요? (기록은 보존됩니다)`)) return;
    deleteOrgMetric(m.id)
      .then(() => setData((d) => (d ? { ...d, metrics: d.metrics.filter((x) => x.id !== m.id) } : d)))
      .catch((e) => setNotice(errorMessage(e)));
  };

  const addMetric = () => {
    setAddError(null);
    setAdding(true);
    createOrgMetric({
      metricKey: newKey.trim(),
      label: newLabel.trim(),
      unit: newUnit.trim() === '' ? null : newUnit.trim(),
      valueType: newType,
      value: newValue.trim() === '' ? null : newValue.trim(),
    })
      .then((m) => {
        setData((d) => (d ? { ...d, metrics: [...d.metrics, m] } : d));
        setAddOpen(false);
        setNewLabel('');
        setNewKey('');
        setNewUnit('');
        setNewType('number');
        setNewValue('');
      })
      .catch((e) => setAddError(errorMessage(e)))
      .finally(() => setAdding(false));
  };

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

  // 저장된 값과 다를 때만 저장 버튼 활성 — 저장 성공 시 setData 가 settings 를 갱신해 자동 복귀
  const settingsDirty =
    orgName.trim() !== (data.settings.orgName ?? '') ||
    systemName.trim() !== (data.settings.systemName ?? '');

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>기관 정보</h1>
        {data.activeCycle && <span className="cycle-chip">주기: {data.activeCycle.name}</span>}
      </div>
      {notice && <div className="notice-inline">{notice}</div>}

      <section className="org-section">
        <h2>기관 설정</h2>
        <div className="org-settings-grid">
          <label className="field">
            <span className="field-label">기관명</span>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              disabled={!canEdit || savingSettings}
            />
          </label>
          <label className="field">
            <span className="field-label">시스템 표시명 (상단바)</span>
            <input
              value={systemName}
              onChange={(e) => setSystemName(e.target.value)}
              disabled={!canEdit || savingSettings}
            />
          </label>
        </div>
        {canEdit && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={saveSettings}
            disabled={savingSettings || !settingsDirty || orgName.trim() === '' || systemName.trim() === ''}
            title={settingsDirty ? '' : '변경된 내용이 없습니다.'}
          >
            {savingSettings ? '저장 중…' : '설정 저장'}
          </button>
        )}
      </section>

      <section className="org-section">
        <div className="org-section-head">
          <h2>기관 지표</h2>
          <span className="head-note">
            공통문항 입력값 (전년도 검사 건수 등) — 자동배점의 입력원. 활성 주기에만 적용됩니다.
          </span>
        </div>
        {data.metrics.length === 0 && !addOpen ? (
          <div className="empty-state">
            <p className="empty-title">등록된 지표가 없습니다.</p>
            {canEdit && <p>지표를 추가하면 자동배점 문항(Phase 3a)에 연결할 수 있습니다.</p>}
          </div>
        ) : (
          <div className="simple-table-wrap">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>표시명</th>
                  <th>키</th>
                  <th>값</th>
                  <th className="col-center">형</th>
                  <th>수정</th>
                  {canEdit && <th className="col-center" aria-label="동작" />}
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => (
                  <MetricRow
                    key={m.id}
                    metric={m}
                    canEdit={canEdit}
                    onSaved={replaceMetric}
                    onError={setNotice}
                    onConflict={onConflict}
                    onDelete={removeMetric}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && !addOpen && (
          <button type="button" className="btn" onClick={() => setAddOpen(true)}>
            + 지표 추가
          </button>
        )}
        {canEdit && addOpen && (
          <div className="org-add-form">
            <div className="org-add-grid">
              <label className="field">
                <span className="field-label">표시명 *</span>
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="전년도 검사 건수"
                />
              </label>
              <label className="field">
                <span className="field-label">키 * (영소문자·숫자·밑줄)</span>
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="annual_test_count"
                />
              </label>
              <label className="field">
                <span className="field-label">단위</span>
                <input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="건" />
              </label>
              <label className="field">
                <span className="field-label">형</span>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as MetricValueType)}
                >
                  <option value="number">숫자</option>
                  <option value="integer">정수</option>
                  <option value="text">텍스트</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">초기값</span>
                <input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="비워두면 '입력값 없음'"
                />
              </label>
            </div>
            {addError && <div className="error-inline">{addError}</div>}
            <div className="org-add-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={addMetric}
                disabled={adding || newLabel.trim() === '' || newKey.trim() === ''}
              >
                {adding ? '추가 중…' : '추가'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>
                취소
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
