/**
 * 내용주소(content-addressed) 파일 저장소 — API 계약(POST /api/docs)
 * data/files/sha256/<앞2자>/<나머지62자>.<확장자> — 동일 내용은 물리 파일 1개만 존재.
 * 확장자는 판본 형식(document_version.file_kind)에서 온다: pdf 는 .pdf, Office 는 원래 확장자,
 * 텍스트는 .txt. 기본값이 pdf 라서 형식을 넘기지 않는 기존 호출은 그대로 동작한다.
 * 쓰기는 임시파일 + rename(원자적) — 중단돼도 반쪽 파일이 정식 경로에 남지 않는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Hex(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const KIND_EXT: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  hwpx: 'hwpx',
  text: 'txt',
};

/** 판본 형식 → 저장 파일 확장자 (모르는 값은 pdf: 008 이전 행과 같은 규칙) */
export function extForKind(fileKind: string | null | undefined): string {
  return (fileKind && KIND_EXT[fileKind]) || 'pdf';
}

/** filesDir(= data/files) 기준 상대 경로 */
export function contentRelPath(sha256: string, ext = 'pdf'): string {
  return path.join('sha256', sha256.slice(0, 2), sha256.slice(2) + '.' + ext);
}

/** 절대 경로 */
export function contentPath(filesDir: string, sha256: string, ext = 'pdf'): string {
  return path.join(filesDir, contentRelPath(sha256, ext));
}

/** 없으면 저장, 있으면 무동작(내용주소라 재작성 불필요). 절대 경로 반환. */
export function saveContentAddressed(
  filesDir: string,
  sha256: string,
  buf: Uint8Array,
  ext = 'pdf',
): string {
  const target = contentPath(filesDir, sha256, ext);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return target;
}
