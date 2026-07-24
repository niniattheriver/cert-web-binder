/**
 * 내용주소(content-addressed) 파일 저장소 — API 계약(POST /api/docs)
 * data/files/sha256/<앞2자>/<나머지62자>.pdf — 동일 내용은 물리 파일 1개만 존재.
 * 쓰기는 임시파일 + rename(원자적) — 중단돼도 반쪽 파일이 정식 경로에 남지 않는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Hex(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** filesDir(= data/files) 기준 상대 경로 */
export function contentRelPath(sha256: string): string {
  return path.join('sha256', sha256.slice(0, 2), sha256.slice(2) + '.pdf');
}

/** 절대 경로 */
export function contentPath(filesDir: string, sha256: string): string {
  return path.join(filesDir, contentRelPath(sha256));
}

/** 없으면 저장, 있으면 무동작(내용주소라 재작성 불필요). 절대 경로 반환. */
export function saveContentAddressed(filesDir: string, sha256: string, buf: Uint8Array): string {
  const target = contentPath(filesDir, sha256);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return target;
}
