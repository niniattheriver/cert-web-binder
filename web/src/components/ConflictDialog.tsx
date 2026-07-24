/**
 * 동시편집 409 충돌 다이얼로그 (설계서 §5 — 임무 D 소유)
 * - 내 텍스트 / 서버 텍스트 좌우 비교.
 * - [최신 불러오기(권장)] / [내 내용으로 덮어쓰기(명시적)] / [내 내용 복사해두기].
 * - 지는 쪽 텍스트는 서버가 이미 change_log 에 보존 — 여기서는 사용자 선택만 받는다.
 */
import { useState } from 'react';

export interface ConflictInfo {
  /** '답변' | '지적/권장사항' 등 */
  fieldLabel: string;
  mine: string;
  server: string;
  /** "김담당 · 2026-07-13 10:32" 등 귀속 표시 */
  serverMeta?: string | null;
}

interface Props {
  info: ConflictInfo;
  busy?: boolean;
  onLoadServer: () => void;
  onOverwrite: () => void;
  onClose: () => void;
}

export default function ConflictDialog({ info, busy, onLoadServer, onOverwrite, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const copyMine = async () => {
    try {
      await navigator.clipboard.writeText(info.mine);
      setCopied(true);
    } catch {
      // 클립보드 API 실패(권한 등) — 임시 textarea 폴백
      const ta = document.createElement('textarea');
      ta.value = info.mine;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  return (
    <div className="conflict-overlay" role="dialog" aria-modal="true" aria-label="저장 충돌">
      <div className="conflict-panel">
        <h2 className="conflict-title">다른 사용자가 먼저 저장했습니다 — {info.fieldLabel}</h2>
        <p className="conflict-sub">
          {info.serverMeta
            ? `서버 최신본: ${info.serverMeta}`
            : '서버에 더 최신 내용이 있습니다.'}{' '}
          아래에서 비교 후 선택하세요. 어느 쪽을 선택해도 반대쪽 내용은 변경 이력에 보존됩니다.
        </p>
        <div className="conflict-cols">
          <div className="conflict-col">
            <div className="conflict-col-head">내 내용 (저장 안 됨)</div>
            <div className="conflict-text">{info.mine || <span className="dim">(비어 있음)</span>}</div>
          </div>
          <div className="conflict-col">
            <div className="conflict-col-head conflict-col-server">서버 최신본</div>
            <div className="conflict-text">
              {info.server || <span className="dim">(비어 있음)</span>}
            </div>
          </div>
        </div>
        <div className="conflict-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onLoadServer}>
            최신 불러오기 (권장)
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onOverwrite}>
            내 내용으로 덮어쓰기
          </button>
          <button type="button" className="btn" onClick={() => void copyMine()}>
            {copied ? '복사됨 ✓' : '내 내용 복사'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
