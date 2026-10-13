/**
 * 그림 잘라 내기 값 읽기 (모델 ImageCrop)
 *
 * Word 와 PowerPoint 의 그림은 원본을 잘라 낸 뒤 틀 크기로 그린다. 잘라 낸 값을 버리면 원본 전체가 틀에 눌려
 * 들어간다(실물 docx 88개 중 64개, 그림 166개). 정본 글자와 쪽 나눔에는 영향이 없다(틀 크기는 그대로).
 *
 * - DrawingML a:srcRect: l, t, r, b 는 1/1000 퍼센트(100000 = 100%). 음수는 바깥 여백(원본보다 큰 틀)인데
 *   지원하지 않고 0 으로 본다.
 * - VML v:imagedata: cropleft, croptop, cropright, cropbottom 은 소수(0.1)이거나 65536 분의 값('6554f').
 * - 한글(hwpx)의 hp:imgClip 은 아직 읽지 않는다: 실물로 뜻을 확인하지 못했다.
 */
import type { ImageCrop } from './model.js';
import { attr, type XElement } from './xml.js';

/** 남는 부분이 이보다 작으면(거의 다 잘라 냄) 잘못된 값으로 보고 잘라 내지 않는다 */
const MIN_KEEP = 0.01;

function finish(l: number, t: number, r: number, b: number): ImageCrop | undefined {
  if (!(l > 0 || t > 0 || r > 0 || b > 0)) return undefined;
  if (1 - l - r < MIN_KEEP || 1 - t - b < MIN_KEEP) return undefined;
  const q = (v: number): number => Math.round(v * 1e5) / 1e5;
  return { l: q(l), t: q(t), r: q(r), b: q(b) };
}

/** DrawingML a:srcRect → 잘라 내기. 없거나 모두 0 이면 undefined */
export function cropFromSrcRect(el: XElement | undefined): ImageCrop | undefined {
  if (!el) return undefined;
  const v = (k: string): number => {
    const n = Number(attr(el, k) ?? 0);
    return Number.isFinite(n) && n > 0 ? n / 100000 : 0;
  };
  return finish(v('l'), v('t'), v('r'), v('b'));
}

/** VML v:imagedata 의 crop 속성 → 잘라 내기. 없거나 모두 0 이면 undefined */
export function cropFromVml(el: XElement | undefined): ImageCrop | undefined {
  if (!el) return undefined;
  const v = (k: string): number => {
    const s = (attr(el, k) ?? '').trim();
    if (s === '') return 0;
    const n = /f$/i.test(s) ? Number(s.slice(0, -1)) / 65536 : Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return finish(v('cropleft'), v('croptop'), v('cropright'), v('cropbottom'));
}
