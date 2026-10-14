/**
 * 근거자료 뷰어 확대/축소 공통 규칙 (PDF, Office, 그림 뷰어가 함께 쓴다)
 *
 * - 배율 상태(ZoomMode): 'auto'(뷰어 기본: 칸보다 크면 줄여서 맞춤), 'width'(폭 맞춤: 칸 폭에 정확히 맞춤, 키우기도 한다),
 *   숫자(직접 고른 배율, 1 = 원래 크기).
 * - 위쪽 단추(+, −)는 크롬 PDF 뷰어처럼 정해진 단계로, Ctrl+휠과 Ctrl+드래그는 연속으로 바꾼다. 범위는 25%~400%.
 * - Ctrl+휠은 브라우저 화면 전체 확대 대신 뷰어만 키우도록 기본 동작을 막는다(passive: false 로 걸어야 막힌다).
 *   노트북 터치패드의 두 손가락 오므리기도 브라우저가 Ctrl+휠로 보낸다.
 * - Ctrl+드래그는 왼쪽 단추를 누른 채 위로 끌면 키우고 아래로 끌면 줄인다. Ctrl 없이 끄는 글자 선택(연결 모드)은 그대로다.
 * - 고른 배율은 뷰어 종류(pdf, office, image)마다 이 브라우저에 기억해 다른 근거를 열 때도 그대로 쓴다(localStorage,
 *   막혀 있으면 기본값). 분리한 근거자료 창도 같은 값을 쓴다.
 */
import { useEffect, useRef, type RefObject } from 'react';

export type ZoomMode = 'auto' | 'width' | number;
export type ZoomFamily = 'pdf' | 'office' | 'image';

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** 단추로 고르는 배율 단계 (크롬 PDF 뷰어와 비슷한 간격) */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function clampZoom(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

/** 지금 배율에서 그 방향의 다음 단계 (dir 1 = 키우기). 단계 사이 값이면 그 방향으로 가장 가까운 단계 */
export function stepZoom(current: number, dir: 1 | -1): number {
  const eps = 0.005;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > current + eps) ?? ZOOM_MAX;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const s = ZOOM_STEPS[i]!;
    if (s < current - eps) return s;
  }
  return ZOOM_MIN;
}

/** 휠 한 번의 배율 비: 마우스 휠 한 칸(약 100px)에 약 18%. 터치패드 오므리기는 작은 값이 여러 번 온다 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const dy = Math.max(-300, Math.min(300, deltaY * unit));
  return Math.exp(-dy * 0.002);
}

/** Ctrl+드래그의 배율 비: 누른 자리에서 위로 100px 끌면 약 1.8배, 아래로 끌면 그만큼 줄인다 */
export function dragZoomFactor(dy: number): number {
  return Math.exp(-dy * 0.006);
}

/** 화면에 적는 퍼센트 */
export function zoomPercent(scale: number): number {
  return Math.round(scale * 100);
}

const storeKey = (f: ZoomFamily): string => `viewer-zoom:${f}`;

/** 기억한 배율 (없거나 읽을 수 없으면 'auto') */
export function loadZoom(f: ZoomFamily): ZoomMode {
  try {
    const raw = localStorage.getItem(storeKey(f));
    if (raw === 'auto' || raw === 'width') return raw;
    const n = Number(raw);
    if (raw != null && raw !== '' && Number.isFinite(n) && n > 0) return clampZoom(n);
  } catch {
    // 저장소를 쓸 수 없는 창(사생활 보호 모드 등): 기본값
  }
  return 'auto';
}

export function saveZoom(f: ZoomFamily, z: ZoomMode): void {
  try {
    localStorage.setItem(storeKey(f), typeof z === 'number' ? String(Math.round(z * 1000) / 1000) : z);
  } catch {
    // 기억하지 못해도 이번 화면에서는 그대로 쓴다
  }
}

export interface ZoomGestureTarget {
  /** 지금 화면에 보이는 실제 배율 */
  getScale(): number;
  /** 배율을 바꾼다. origin(화면 좌표)을 주면 그 자리가 커서 밑에 그대로 남도록 스크롤을 맞춰 달라는 뜻 */
  setScale(scale: number, origin?: { x: number; y: number }): void;
}

/**
 * el 위에서 Ctrl+휠, Ctrl+드래그(왼쪽 단추)로 배율을 바꾼다. Ctrl 없는 휠(스크롤)과 드래그(글자 선택)는 건드리지 않는다.
 * 단추, 링크, 입력칸 위의 Ctrl+누름은 그 요소의 몫이라 두고 넘어간다(Ctrl+클릭으로 새 탭 열기 등).
 */
export function useZoomGestures(ref: RefObject<HTMLElement | null>, target: ZoomGestureTarget): void {
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const t = targetRef.current;
      t.setScale(clampZoom(t.getScale() * wheelZoomFactor(e.deltaY, e.deltaMode)), { x: e.clientX, y: e.clientY });
    };

    let drag: { y: number; scale: number; x0: number; y0: number } | null = null;
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      e.preventDefault();
      targetRef.current.setScale(clampZoom(drag.scale * dragZoomFactor(e.clientY - drag.y)), { x: drag.x0, y: drag.y0 });
    };
    const stop = () => {
      drag = null;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', stop, true);
      el.classList.remove('is-zoom-dragging');
    };
    const onDown = (e: MouseEvent) => {
      if (!e.ctrlKey || e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest('button, a[href], input, select, textarea, .vzb')) return;
      // 글자 선택과 뷰어 안쪽 누름 처리를 막고 배율 끌기로 쓴다
      e.preventDefault();
      e.stopPropagation();
      drag = { y: e.clientY, scale: targetRef.current.getScale(), x0: e.clientX, y0: e.clientY };
      el.classList.add('is-zoom-dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', stop, true);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown, true);
      stop();
    };
  }, [ref]);
}
