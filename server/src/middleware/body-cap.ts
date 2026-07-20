/**
 * 업로드 요청 총량 가드 (외부 검토 P1 반영)
 * multer 의 파일당 제한과 별개로, 요청 전체 크기를 Content-Length 로 선검사해
 * 과대 요청을 메모리에 올리기 전에 413 으로 거절한다.
 * (Content-Length 없는 chunked 요청은 multer 파일당 제한이 최종 방어선)
 */
import type { RequestHandler } from 'express';

export function capContentLength(maxBytes: number): RequestHandler {
  return (req, res, next) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > maxBytes) {
      res.status(413).json({
        error: 'payload_too_large',
        details: `요청 전체 크기가 허용치(${Math.floor(maxBytes / 1024 / 1024)}MB)를 초과했습니다.`,
      });
      return;
    }
    next();
  };
}
