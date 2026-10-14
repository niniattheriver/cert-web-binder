/**
 * 렌더 모델 그림 바이트 꺼내기: 원본 형식에 맞춰 ZIP 항목(docx, pptx, hwpx) 또는 복합 문서 스트림(hwp)
 *
 * 경로는 모델의 media[].path 다(요청에서 받지 않는다). 그림 판정(형식 확인)은 부르는 쪽이 image-sniff 로 한다.
 */
import { readZipFile } from '../files/unzip.js';
import { isCfb } from './legacy/cfb.js';
import { readHwpBinData } from './legacy/hwpbin.js';

export function readModelMedia(buf: Buffer, path: string, maxBytes: number): Buffer | null {
  if (isCfb(buf)) return readHwpBinData(buf, path, maxBytes);
  return readZipFile(buf, path, maxBytes);
}
