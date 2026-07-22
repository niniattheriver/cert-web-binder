/**
 * 파일 업로드 공용 유틸 (v1.5 Phase 2 — 문항 첨부·지침서 원본파일 공용)
 * - MIME은 클라이언트 신고값을 버리고 확장자에서 서버가 재판정한다.
 * - inline 미리보기는 pdf/png/jpg 화이트리스트만 (HTML/SVG 저장형 XSS 차단 — A-7).
 * - sha256은 스트림으로 계산(메모리 버퍼 금지).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 확장자 → MIME 재판정. 미등록 확장자는 octet-stream(항상 attachment 다운로드). */
export const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  hwp: 'application/x-hwp',
  hwpx: 'application/x-hwpx',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
};

/** inline 미리보기 허용 MIME — 지시서 화이트리스트(pdf/png/jpg) */
export const INLINE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export function mimeFromName(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** multer(busboy)는 파일명을 latin1로 디코드한다 — 한글 파일명 UTF-8 복원 */
export function decodeFileName(raw: string): string {
  try {
    return Buffer.from(raw, 'latin1').toString('utf8');
  } catch {
    return raw;
  }
}

/** 파일을 스트림으로 읽어 sha256 계산 (메모리 버퍼 없음) */
export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Content-Disposition 값 (RFC5987 — ASCII 폴백 + UTF-8 파일명) */
export function dispositionFor(kind: 'inline' | 'attachment', origName: string): string {
  const asciiName = origName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'file';
  return `${kind}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(origName)}`;
}

/**
 * files/tmp 고아 파일 스윕 — 업로드 도중 프로세스가 죽으면(크래시·강제 종료) multer의
 * 요청 단위 정리가 실행되지 못해 임시 파일이 영구 잔존한다. 기동 시 24시간 지난 것만 삭제
 * (동시 실행 중인 다른 프로세스의 진행 중 업로드와 경합 방지). 임시 파일이므로
 * 하드삭제 금지 가드레일 대상 아님.
 */
export function sweepTmpDir(filesDir: string, maxAgeMs = 24 * 60 * 60 * 1000): number {
  const tmpDir = path.join(filesDir, 'tmp');
  if (!fs.existsSync(tmpDir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of fs.readdirSync(tmpDir)) {
    const p = path.join(tmpDir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      /* 스윕 실패는 치명적이지 않음 — 다음 기동에서 재시도 */
    }
  }
  return removed;
}
