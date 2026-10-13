/**
 * 단축키 전도 오버레이 (설계서 §4 — `?` 로 열림, 임무 D 소유)
 */
interface Row {
  keys: string;
  desc: string;
}

const ROWS: Row[] = [
  { keys: 'Ctrl+K 또는 /', desc: '검색(문항 번호를 넣으면 바로 이동)' },
  { keys: 'j / k', desc: '다음 문항, 이전 문항' },
  { keys: '1–9', desc: '근거자료를 번호 순서대로 열기' },
  { keys: 'H', desc: '근거자료 연결 창 열기' },
  { keys: 'M', desc: '문서 뷰어에서 근거 연결 모드 켜기, 끄기' },
  { keys: 'Backspace', desc: '앞서 보던 문항으로 돌아가기' },
  { keys: 'Enter', desc: '고른 부분을 근거로 연결(연결 모드에서)' },
  { keys: 'Esc', desc: '선택 취소, 창 닫기, 모드 끝내기' },
  { keys: 'Ctrl+P', desc: '인쇄' },
  { keys: '?', desc: '이 안내 열기' },
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
            닫기(Esc)
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
        <p className="dim shortcut-note">글을 입력하는 중에는 단축키가 동작하지 않습니다.</p>
      </div>
    </div>
  );
}
