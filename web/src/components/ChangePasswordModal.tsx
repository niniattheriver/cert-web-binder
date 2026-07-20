/**
 * 내 비밀번호 변경 모달 (v1.5 — 모든 로그인 사용자)
 * 현재 비밀번호 확인 후 새 비밀번호로 교체(세션 유지). 서버가 현재 비밀번호를 검증한다.
 */
import { useState } from 'react';
import { ApiError } from '../api';
import { changeMyPassword } from '../api-phase1';
import { errorMessage } from '../util';

function apiMessage(e: unknown): string {
  if (e instanceof ApiError && typeof e.body?.details === 'string') return e.body.details;
  return errorMessage(e);
}

export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setError(null);
    if (next.length < 8) {
      setError('새 비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    if (next !== confirm) {
      setError('새 비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    try {
      await changeMyPassword(cur, next);
      setDone(true);
    } catch (e) {
      setError(apiMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>비밀번호 변경</h2>
        {done ? (
          <>
            <p>비밀번호가 변경되었습니다.</p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                닫기
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <label className="modal-field">
              현재 비밀번호
              <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
            </label>
            <label className="modal-field">
              새 비밀번호 (8자 이상)
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </label>
            <label className="modal-field">
              새 비밀번호 확인
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? '변경 중…' : '변경'}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                취소
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
