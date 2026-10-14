/**
 * 근거자료 뷰어 위쪽 확대/축소 줄: [−] [125%] [+] | [폭 맞춤]
 *
 * 크롬 PDF 뷰어의 위쪽 막대처럼 뷰어 맨 위에 한 줄로 놓인다(뷰어마다 .pvp-root 안 맨 위). 퍼센트를 누르면 원래 크기(100%)로,
 * [폭 맞춤]을 누르면 칸 폭에 맞추고 한 번 더 누르면 뷰어 기본 크기로 돌아간다. Ctrl+휠, Ctrl+드래그는 viewerZoom.ts.
 */
import { ZOOM_MAX, ZOOM_MIN, type ZoomMode } from './viewerZoom';
import './zoombar.css';

export interface ZoomBarProps {
  /** 지금 보이는 배율(퍼센트). 아직 모르면 null */
  percent: number | null;
  mode: ZoomMode;
  onStep(dir: 1 | -1): void;
  /** 원래 크기(100%) */
  onReset(): void;
  /** 폭 맞춤 켜기와 끄기 */
  onToggleFit(): void;
}

export default function ZoomBar({ percent, mode, onStep, onReset, onToggleFit }: ZoomBarProps) {
  const fit = mode === 'width';
  return (
    <div className="vzb" role="toolbar" aria-label="확대와 축소" data-zoom-mode={String(mode)}>
      <button
        type="button"
        className="vzb-btn"
        onClick={() => onStep(-1)}
        disabled={percent != null && percent <= Math.round(ZOOM_MIN * 100)}
        aria-label="축소"
        title="축소 (Ctrl+휠을 아래로, 또는 Ctrl+드래그를 아래로)"
      >
        −
      </button>
      <button
        type="button"
        className="vzb-pct"
        onClick={onReset}
        title="원래 크기(100%)로"
        aria-label={percent == null ? '배율' : `배율 ${percent}%, 누르면 원래 크기`}
      >
        {percent == null ? '…' : `${percent}%`}
      </button>
      <button
        type="button"
        className="vzb-btn"
        onClick={() => onStep(1)}
        disabled={percent != null && percent >= Math.round(ZOOM_MAX * 100)}
        aria-label="확대"
        title="확대 (Ctrl+휠을 위로, 또는 Ctrl+드래그를 위로)"
      >
        +
      </button>
      <span className="vzb-sep" aria-hidden="true" />
      <button
        type="button"
        className={'vzb-btn vzb-fit' + (fit ? ' is-on' : '')}
        onClick={onToggleFit}
        aria-pressed={fit}
        title={fit ? '폭 맞춤을 끄고 기본 크기로' : '칸 폭에 맞춥니다'}
      >
        폭 맞춤
      </button>
    </div>
  );
}
