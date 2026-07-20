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
  const [form, setForm] = useState({ username: '', displayName: '', role: 'editor' as UserRole, password: '' });
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
      });
      setIssued({ username: res.user.username, password: res.password, kind: 'created' });
      setShowForm(false);
      setForm({ username: '', displayName: '', role: 'editor', password: '' });
      load();
    } catch (e) {
      setFormError(apiMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const doPatch = async (
    u: ManagedUser,
    patch: { role?: UserRole; active?: boolean },
  ): Promise<void> => {
    setBusyId(u.id);
    setRowError(null);
    try {
      await patchUser(u.id, patch);
      load();
    } catch (e) {
      setRowError(apiMessage(e));
    } finally {
      setBusyId(null);
    }
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
          </div>
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
                <td className="dim">{u.expiresAt ? fmtDate(u.expiresAt) : '—'}</td>
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
