/**
 * 단축키 전도 오버레이 (설계서 §4 — `?` 로 열림, 임무 D 소유)
 */
interface Row {
  keys: string;
  desc: string;
}

const ROWS: Row[] = [
  { keys: 'Ctrl+K · /', desc: '옴니박스 검색 (번호 패스트패스)' },
  { keys: 'j / k', desc: '다음 / 이전 문항 (문항 레일)' },
  { keys: '1–9', desc: '근거 칩 열기 (뷰어 교체 + 펄스)' },
  { keys: 'H', desc: '문서 선택 → 매핑 모드' },
  { keys: 'M', desc: '문서 뷰어에서 매핑 모드 토글' },
  { keys: 'Backspace', desc: '배지 점프 복귀 (문항 교체 이력)' },
  { keys: 'Enter', desc: '연결 확정 (매핑 선택 시)' },
  { keys: 'Esc', desc: '만능 탈출 (선택·팝오버·모드 종료)' },
  { keys: 'Ctrl+P', desc: '인쇄' },
  { keys: '?', desc: '이 도움말' },
];

interface Props {
  onClose: () => void;
}

export default function ShortcutOverlay({ onClose }: Props) {
  return (
    <div
      className="shortcut-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="단축키 안내"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shortcut-panel">
        <div className="shortcut-head">
          <h2>단축키</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            닫기 (Esc)
          </button>
        </div>
        <table className="shortcut-table">
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.keys}>
                <td className="shortcut-keys">{r.keys}</td>
                <td>{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dim shortcut-note">입력칸에 포커스가 있을 때는 단축키가 비활성화됩니다.</p>
      </div>
    </div>
  );
}
