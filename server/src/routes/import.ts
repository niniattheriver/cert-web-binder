/**
 * 문항 PDF 인입 라우트 — API 계약:
 *   POST /api/import/question-pdfs               (multipart files[]) → 드라이런
 *   POST /api/import/question-pdfs/:batchId/commit {mode}            → 커밋
 *
 * 마운트: index.ts(다른 담당)가 이 라우터를 requireEditor 아래 /api/import 에 마운트한다.
 * 여기서는 세션 유무만 확인하는 자체 가드 1줄(이중 안전망) — 권한(403)은 마운트 측 책임.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import { db } from '../db/index.js';
import { dataDir } from '../config.js';
import { capContentLength } from '../middleware/body-cap.js';
import { EncryptedPdfError, InvalidPdfError } from '../pdf/extract.js';
import {
  BatchNotFoundError,
  commitBatch,
  dryRunFromFiles,
} from '../import/question-pdf-service.js';

const router = Router();

/** 세션 사용자 id — 인증 미들웨어(다른 담당)와의 타입 결합 없이 안전하게 읽는다. */
function sessionUserId(req: Request): number | null {
  const s = (req as Request & { session?: { userId?: unknown } }).session;
  return typeof s?.userId === 'number' ? s.userId : null;
}

// 미인증 401 가드 (계약: 미인증 401 {error:'unauthorized'})
router.use((req, res, next) => {
  if (sessionUserId(req) === null) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

// multer: 메모리 저장, 파일당 32MB·최대 16파일(실물 분야 PDF는 0.7~1.5MB×연 14부 — 여유 20배).
// 파일당×파일수 최악 합(512MB)이 곧 메모리 상한이 되도록 잡았고, Content-Length 선검사는
// 그 이전에 과대 요청을 거절하는 1차 방어선이다(Content-Length 없는 청크 전송도 multer 한도로 상한).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024, files: 16 },
});
const IMPORT_REQUEST_CAP = 512 * 1024 * 1024;

/** multer(busboy)는 파일명을 latin1로 디코드한다 — 한글 파일명 UTF-8 복원 */
function decodeFileName(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function isPdf(f: Express.Multer.File): boolean {
  return (
    f.mimetype === 'application/pdf' ||
    decodeFileName(f.originalname).toLowerCase().endsWith('.pdf')
  );
}

// -- 드라이런 ---------------------------------------------------------------
router.post('/question-pdfs', capContentLength(IMPORT_REQUEST_CAP), (req, res) => {
  upload.array('files', 16)(req, res, (err?: unknown) => {
    if (err) {
      res.status(400).json({
        error: 'upload_error',
        details: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    void handleDryRun(req, res);
  });
});

// multipart 텍스트 필드: year(대상 연도, 선택) + carry(전년도 이월 여부, 기본 켬)
const dryRunFieldsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  carry: z.enum(['1', '0']).default('1'),
});

async function handleDryRun(req: Request, res: Response): Promise<void> {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'validation', details: 'files[]에 PDF 파일을 1개 이상 첨부하세요.' });
      return;
    }
    const notPdf = files.filter((f) => !isPdf(f));
    if (notPdf.length > 0) {
      res.status(400).json({
        error: 'invalid_file_type',
        details: `PDF가 아닌 파일: ${notPdf.map((f) => decodeFileName(f.originalname)).join(', ')}`,
      });
      return;
    }
    const fields = dryRunFieldsSchema.safeParse(req.body ?? {});
    if (!fields.success) {
      res.status(400).json({
        error: 'validation',
        details: 'year는 2000~2100 사이 연도, carry는 1 또는 0이어야 합니다.',
      });
      return;
    }
    const result = await dryRunFromFiles(
      db,
      files.map((f) => ({ name: decodeFileName(f.originalname), buffer: f.buffer })),
      sessionUserId(req),
      { year: fields.data.year, carry: fields.data.carry === '1' },
    );
    res.json(result);
  } catch (err) {
    if (err instanceof EncryptedPdfError || err instanceof InvalidPdfError) {
      res.status(400).json({ error: 'invalid_pdf', details: err.message });
      return;
    }
    console.error('[import] 드라이런 실패:', err);
    res.status(500).json({ error: 'internal' });
  }
}

// -- 커밋 -------------------------------------------------------------------
const commitBodySchema = z.object({
  mode: z.enum(['overwrite', 'keep_existing', 'reingest']),
});

router.post('/question-pdfs/:batchId/commit', async (req, res) => {
  try {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) {
      res.status(400).json({ error: 'validation', details: 'batchId가 올바르지 않습니다.' });
      return;
    }
    const parsed = commitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'validation',
        details: "mode는 'overwrite' / 'keep_existing' / 'reingest' 중 하나여야 합니다.",
      });
      return;
    }
    const result = await commitBatch(db, batchId, parsed.data.mode, sessionUserId(req), {
      backupDir: path.join(dataDir, 'backups'),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof BatchNotFoundError) {
      res.status(400).json({ error: 'batch_not_found', details: err.message });
      return;
    }
    console.error('[import] 커밋 실패:', err);
    res.status(500).json({ error: 'internal' });
  }
});

export default router;
