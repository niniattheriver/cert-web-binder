/**
 * 구형 한글(hwp) 안 그림 바이트 꺼내기
 *
 * 렌더 모델(legacy/hwp.ts)은 그림을 'BinData/BIN0001.png' 같은 복합 문서 스트림 경로로 가리킨다. 그림 라우트는
 * 모델의 media 목록 색인으로만 경로를 고르므로(요청에서 경로를 받지 않는다) 여기서는 그 꼴만 받는다.
 * hwpx 추출기를 불러오지 않는 작은 모듈로 둔다(그림 라우트가 서버 기동 때 함께 불러오기 때문).
 *
 * 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
 */
import zlib from 'node:zlib';
import { Cfb } from './cfb.js';

/**
 * 렌더 모델이 가리키는 그림 바이트 (그림 경로 요청용). 경로는 모델의 media[].path 이고 'BinData/BIN0001.png' 꼴만
 * 받는다. 날 바이트가 그림이 아니면 raw deflate 를 풀어 본다(문서 압축 여부와 항목 압축 속성을 다 읽지 않아도 된다).
 * 그림 판정(형식 확인)은 부르는 쪽(image-sniff)이 한다.
 */
export function readHwpBinData(buf: Buffer, path: string, maxBytes: number): Buffer | null {
  if (!/^BinData\/BIN[0-9A-F]{4}\.[a-z0-9]{1,5}$/.test(path)) return null;
  let cfb: Cfb | null;
  try {
    cfb = Cfb.open(buf);
  } catch {
    return null;
  }
  if (!cfb) return null;
  const raw = cfb.read(path, maxBytes);
  if (!raw) return null;
  if (looksLikeImage(raw)) return raw;
  try {
    const b = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    return looksLikeImage(b) ? b : null;
  } catch {
    return null;
  }
}

/** PNG, JPEG, GIF, BMP, WebP 서명 */
function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return true;
  if (b[0] === 0x42 && b[1] === 0x4d) return true;
  return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}
