/**
 * 그림 바이트의 앞머리(서명)로 래스터 형식을 판정한다.
 *
 * 렌더 모델의 그림은 png, jpeg, gif, webp, bmp 만 내보낸다(설계서 §3.5 '그림은 래스터만'). docx, hwpx 추출기는
 * 관계 대상의 확장자로 형식을 적으므로, 그림을 내주는 경로(판본 그림, 첨부 미리보기 그림)는 실제 바이트를 이 함수로
 * 다시 판정해 래스터가 아니면 내주지 않고, 내줄 때는 판정한 형식을 Content-Type 으로 쓴다.
 */
import type { MediaRef } from './model.js';

/** 앞머리 32바이트 정도면 충분하다. 알 수 없으면 null */
export function sniffImage(head: Buffer): MediaRef['mime'] | null {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6) {
    const sig = head.toString('latin1', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (head.length >= 18 && head[0] === 0x42 && head[1] === 0x4d && [12, 40, 52, 56, 64, 108, 124].includes(head.readUInt32LE(14))) {
    return 'image/bmp';
  }
  return null;
}
