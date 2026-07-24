/**
 * 사용자 계정 관리 /users (v1.5 — admin 전용)
 * 목록 + 생성(초기 비밀번호 1회 표시) + 역할/활성 변경 + 비밀번호 재설정.
 * 하드삭제 없음(비활성화로 이력 보존). 서버가 자기 잠금·마지막 admin 보호를 강제한다.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import {
  createUser,
  fetchUsers,
  patchUser,
  resetUserPassword,
  type ManagedUser,
  type UserRole,
} from '../api-phase1';
import { useAuth } from '../auth';
import { errorMessage, fmtDate } from '../util';

const ROLE_LABEL: Record<UserRole, string> = {
  admin: '관리자',
  editor: '편집자',
  viewer: '열람자',
};

/** 서버 자작 오류 메시지(409 포함)를 우선 노출 */
function apiMessage(e: unknown): string {
  if (e instanceof ApiError && typeof e.body?.details === 'string') return e.body.details;
  return errorMessage(e);
}

/** 날짜 입력값(YYYY-MM-DD) → 그 날 23:59:59(로컬)의 ISO 문자열 — "만료일 당일까지 사용 가능" */
function dateToEndOfDayIso(d: string): string | undefined {
  if (!d) return undefined;
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return undefined;
  return new Date(y, m - 1, day, 23, 59, 59).toISOString();
}

/** 저장된 만료 ISO → 날짜 입력값(YYYY-MM-DD, 로컬) — 인라인 수정 프리필용 */
function isoToDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isExpired(iso: string | null): boolean {
  return iso != null && Date.parse(iso) < Date.now();
}

/** 내일(로컬) YYYY-MM-DD — 만료일 입력의 최소값(과거 날짜로 즉시 잠기는 실수 방지) */
function tomorrowDateInput(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // 새 계정/재설정 시 1회 표시되는 비밀번호
  const [issued, setIssued] = useState<{ username: string; password: string; kind: 'created' | 'reset' } | null>(null);

  // 생성 폼
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', role: 'editor' as UserRole, password: '', expiresAt: '' });
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 만료일 인라인 수정 (행 단위)
  const [editingExpiryId, setEditingExpiryId] = useState<number | null>(null);
  const [expiryInput, setExpiryInput] = useState('');

  const load = useCallback(() => {
    setError(null);
    fetchUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(apiMessage(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (creating) return;
    setFormError(null);
    setCreating(true);
    try {
      const res = await createUser({
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        role: form.role,
        password: form.password.trim() || undefined,
        expiresAt: dateToEndOfDayIso(form.expiresAt),
      });
      setIssued({ username: res.user.username, password: res.password, kind: 'created' });
      setShowForm(false);
      setForm({ username: '', displayName: '', role: 'editor', password: '', expiresAt: '' });
      load();
    } catch (e) {
      setFormError(apiMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const doPatch = async (
    u: ManagedUser,
    patch: { role?: UserRole; active?: boolean; expiresAt?: string | null },
  ): Promise<boolean> => {
    setBusyId(u.id);
    setRowError(null);
    try {
      await patchUser(u.id, patch);
      load();
      return true;
    } catch (e) {
      setRowError(apiMessage(e));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveExpiry = async (u: ManagedUser): Promise<void> => {
    const iso = dateToEndOfDayIso(expiryInput);
    if (!iso) {
      setRowError('만료일을 선택하세요.');
      return;
    }
    // 실패하면 편집을 닫지 않는다 — 입력값 유지 + 오류 표시
    if (await doPatch(u, { expiresAt: iso })) setEditingExpiryId(null);
  };

  const doReset = async (u: ManagedUser): Promise<void> => {
    setBusyId(u.id);
    setRowError(null);
    try {
      const res = await resetUserPassword(u.id);
      setIssued({ username: u.username, password: res.password, kind: 'reset' });
    } catch (e) {
      setRowError(apiMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  if (me?.role !== 'admin') {
    return <div className="page-status">이 화면은 관리자만 볼 수 있습니다.</div>;
  }

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>사용자 계정 관리</h1>
        <span className="head-note">계정 생성·역할 지정·비밀번호 재설정·비활성화 (관리자 전용)</span>
        <div className="head-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? '취소' : '+ 계정 생성'}
          </button>
        </div>
      </div>

      {error && <div className="error-inline">{error}</div>}

      {issued && (
        <div className="card issued-pw">
          <p>
            <b>{issued.username}</b> 계정의 {issued.kind === 'created' ? '초기' : '새'} 비밀번호입니다.{' '}
            <b>이 화면을 벗어나면 다시 볼 수 없습니다</b> — 본인에게 안전한 방법으로 전달하세요.
          </p>
          <div className="issued-pw-row">
            <code>{issued.password}</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void navigator.clipboard?.writeText(issued.password)}
            >
              복사
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setIssued(null)}>
              확인(닫기)
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <form className="card user-form" onSubmit={(e) => void submitCreate(e)}>
          <div className="user-form-grid">
            <label>
              아이디
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="영문·숫자 3자 이상"
                autoComplete="off"
              />
            </label>
            <label>
              이름
              <input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="홍길동"
              />
            </label>
            <label>
              역할
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              >
                <option value="editor">편집자 (답변·채점·근거)</option>
                <option value="viewer">열람자 (보기 전용)</option>
                <option value="admin">관리자 (계정·설정)</option>
              </select>
            </label>
            <label>
              초기 비밀번호(선택)
              <input
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="비우면 자동 생성"
                autoComplete="new-password"
              />
            </label>
            <label>
              만료일(선택)
              <input
                type="date"
                min={tomorrowDateInput()}
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                title="심사위원 등 임시 계정용 — 이 날까지만 로그인할 수 있습니다. 비우면 만료 없음."
              />
            </label>
          </div>
          <p className="dim">
            만료일은 심사위원 등 임시 계정용입니다 — 그 날까지만 로그인할 수 있고, 비우면 만료가
            없습니다.
          </p>
          {formError && <div className="form-error">{formError}</div>}
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? '생성 중…' : '계정 생성'}
            </button>
          </div>
        </form>
      )}

      {rowError && <div className="error-inline">{rowError}</div>}

      {users === null ? (
        <div className="page-status">불러오는 중…</div>
      ) : (
        <table className="simple-table">
          <thead>
            <tr>
              <th>아이디</th>
              <th>이름</th>
              <th>역할</th>
              <th>상태</th>
              <th>만료</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'row-inactive'}>
                <td className="mono">
                  {u.username}
                  {u.isSelf && <span className="dim"> (나)</span>}
                </td>
                <td>{u.displayName}</td>
                <td>
                  <select
                    value={u.role}
                    disabled={busyId === u.id || u.isSelf}
                    title={u.isSelf ? '자기 역할은 스스로 변경할 수 없습니다.' : ''}
                    onChange={(e) => void doPatch(u, { role: e.target.value as UserRole })}
                  >
                    {(['admin', 'editor', 'viewer'] as UserRole[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{u.active ? '활성' : <span className="dim">비활성</span>}</td>
                <td className="user-expiry">
                  {editingExpiryId === u.id ? (
                    <span className="user-expiry-edit">
                      <input
                        type="date"
                        min={tomorrowDateInput()}
                        value={expiryInput}
                        onChange={(e) => setExpiryInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyId === u.id}
                        onClick={() => void saveExpiry(u)}
                      >
                        저장
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditingExpiryId(null)}
                      >
                        취소
                      </button>
                    </span>
                  ) : (
                    <>
                      {u.expiresAt ? (
                        isExpired(u.expiresAt) ? (
                          <span className="user-expired" title="만료일이 지나 로그인할 수 없습니다.">
                            만료됨 {fmtDate(u.expiresAt)}
                          </span>
                        ) : (
                          <span className="dim">{fmtDate(u.expiresAt)}</span>
                        )
                      ) : (
                        <span className="dim">—</span>
                      )}{' '}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyId === u.id || u.isSelf}
                        title={u.isSelf ? '자기 계정의 만료일은 스스로 변경할 수 없습니다.' : ''}
                        onClick={() => {
                          setEditingExpiryId(u.id);
                          setExpiryInput(u.expiresAt ? isoToDateInput(u.expiresAt) : '');
                        }}
                      >
                        변경
                      </button>
                      {u.expiresAt && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyId === u.id}
                          title="만료일을 없애 계속 사용할 수 있게 합니다."
                          onClick={() => void doPatch(u, { expiresAt: null })}
                        >
                          해제
                        </button>
                      )}
                    </>
                  )}
                </td>
                <td className="user-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === u.id}
                    onClick={() => void doReset(u)}
                  >
                    비번 재설정
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === u.id || u.isSelf}
                    title={u.isSelf ? '자기 계정은 비활성화할 수 없습니다.' : ''}
                    onClick={() => void doPatch(u, { active: !u.active })}
                  >
                    {u.active ? '비활성화' : '활성화'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
