/**
 * 자유양식 근거문서(rich_doc) + 첨부(attachment) 라우트 (설계서 §2, §4 #8)
 * - POST   /api/richdocs                       생성 (editor) {title, contentJson?, contentPlain?, questionId?}
 * - GET    /api/richdocs                        목록 (auth, 피커용)
 * - GET    /api/richdocs/:id                     상세 + 연결 문항 (auth)
 * - PATCH  /api/richdocs/:id                     수정 (editor) — rowVersion 낙관적 잠금(409)
 * - DELETE /api/richdocs/:id                     soft delete (editor)
 * - POST   /api/richdocs/:id/links               문항 링크 추가 (editor) {questionId}
 * - DELETE /api/richdocs/:id/links/:questionId   문항 링크 해제 (editor)
 * - POST   /api/attachments                      이미지 업로드(내용주소) → {sha256,url,mime,size} (editor)
 * - GET    /api/attachments/:sha256              첨부 스트림 (auth)
 * GET류는 viewer 가능, 변경류는 editor 이상. 오류 형식은 기존과 동일. index.ts 마운트 1줄.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { dataDir } from '../config.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import {
  ALLOWED_ATTACHMENT_MIME,
  attachmentPath,
  createRichDoc,
  deleteRichDoc,
  fullRichDocPayload,
  getAttachment,
  linkRichDocToQuestion,
  listRichDocs,
  storeAttachment,
  unlinkRichDocFromQuestion,
  updateRichDoc,
} from '../richdocs/service.js';

const FILES_DIR = path.join(dataDir, 'files');
const MAX_ATTACHMENT_MB = 20;

/** multer(busboy)는 파일명을 latin1로 디코드 — 한글 파일명 UTF-8 복원 */
function decodeFileName(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

const createSchema = z.object({
  title: z.string().trim().min(1, '제목은 필수입니다.').max(300),
  contentJson: z.unknown().optional(),
  contentPlain: z.string().nullable().optional(),
  questionId: z.coerce.number().int().positive().optional(),
});

const updateSchema = z
  .object({
    rowVersion: z.number().int().min(1),
    title: z.string().trim().min(1, '제목은 필수입니다.').max(300).optional(),
    contentJson: z.unknown().optional(),
    contentPlain: z.string().nullable().optional(),
  })
  .refine(
    (v) => 'title' in v || 'contentJson' in v || 'contentPlain' in v,
    { message: '수정할 필드가 없습니다.' },
  );

const linkSchema = z.object({ questionId: z.number().int().positive() });

export function createRichDocsRouter(
  db: Database.Database,
  opts?: { filesDir?: string }, // 테스트 주입용 — 기본 data/files
): Router {
  const router = Router();
  const filesDir = opts?.filesDir ?? FILES_DIR;
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_MB * 1024 * 1024, files: 1 },
  });

  // ---------- POST /api/richdocs ----------
  router.post('/richdocs', editor, (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const result = createRichDoc(
      db,
      {
        title: parsed.data.title,
        contentJson: parsed.data.contentJson,
        contentPlain: parsed.data.contentPlain ?? null,
        questionId: parsed.data.questionId ?? null,
      },
      req.user!.id,
    );
    if (result.kind === 'question_not_found') {
      res.status(400).json({ error: 'validation', details: '연결할 문항이 존재하지 않습니다.' });
      return;
    }
    res.status(201).json(result.doc);
  });

  // ---------- GET /api/richdocs (목록) ----------
  router.get('/richdocs', auth, (_req, res) => {
    res.json({ docs: listRichDocs(db) });
  });

  // ---------- GET /api/richdocs/:id ----------
  router.get('/richdocs/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문서 ID가 올바르지 않습니다.' });
      return;
    }
    const doc = fullRichDocPayload(db, id);
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(doc);
  });

  // ---------- PATCH /api/richdocs/:id ----------
  router.patch('/richdocs/:id', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문서 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const result = updateRichDoc(db, id, parsed.data, req.user!.id);
    switch (result.kind) {
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'conflict':
        res.status(409).json({ error: 'conflict', server: result.server });
        return;
      case 'ok':
        res.json(result.doc);
        return;
    }
  });

  // ---------- DELETE /api/richdocs/:id ----------
  router.delete('/richdocs/:id', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문서 ID가 올바르지 않습니다.' });
      return;
    }
    const result = deleteRichDoc(db, id, req.user!.id);
    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- POST /api/richdocs/:id/links ----------
  router.post('/richdocs/:id/links', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문서 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const result = linkRichDocToQuestion(db, id, parsed.data.questionId, req.user!.id);
    switch (result.kind) {
      case 'rich_doc_not_found':
        res.status(404).json({ error: 'not_found', details: '문서가 존재하지 않습니다.' });
        return;
      case 'question_not_found':
        res.status(400).json({ error: 'validation', details: '문항이 존재하지 않습니다.' });
        return;
      case 'duplicate':
        res.status(200).json({ ok: true, duplicate: true });
        return;
      case 'linked':
        res.status(201).json({ ok: true, sort: result.sort });
        return;
    }
  });

  // ---------- DELETE /api/richdocs/:id/links/:questionId ----------
  router.delete('/richdocs/:id/links/:questionId', editor, (req, res) => {
    const id = Number(req.params.id);
    const questionId = Number(req.params.questionId);
    if (!Number.isInteger(id) || !Number.isInteger(questionId)) {
      res.status(400).json({ error: 'validation', details: 'ID가 올바르지 않습니다.' });
      return;
    }
    const result = unlinkRichDocFromQuestion(db, id, questionId, req.user!.id);
    if (result.kind === 'link_not_found') {
      res.status(404).json({ error: 'not_found', details: '연결이 존재하지 않습니다.' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- POST /api/attachments (내용주소 이미지 업로드) ----------
  router.post('/attachments', editor, (req, res) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'file_too_large',
            details: `첨부 최대 크기 ${MAX_ATTACHMENT_MB}MB를 초과했습니다.`,
          });
          return;
        }
        res.status(400).json({
          error: 'upload_error',
          details: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      handleAttachment(req, res);
    });
  });

  function handleAttachment(req: Request, res: Response): void {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'validation', details: 'file 필드에 이미지를 첨부하세요.' });
      return;
    }
    const mime = file.mimetype;
    if (!ALLOWED_ATTACHMENT_MIME.has(mime)) {
      res.status(400).json({
        error: 'unsupported_media_type',
        details: 'PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있습니다.',
      });
      return;
    }
    try {
      const info = storeAttachment(
        db,
        filesDir,
        file.buffer,
        mime,
        decodeFileName(file.originalname),
      );
      res.status(201).json(info);
    } catch (err) {
      console.error('[richdocs] 첨부 저장 실패:', err);
      res.status(500).json({ error: 'internal' });
    }
  }

  // ---------- GET /api/attachments/:sha256 ----------
  router.get('/attachments/:sha256', auth, (req, res) => {
    const sha256 = String(req.params.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      res.status(400).json({ error: 'validation', details: '첨부 주소가 올바르지 않습니다.' });
      return;
    }
    const row = getAttachment(db, sha256);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const filePath = attachmentPath(filesDir, sha256);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'file_missing', details: '저장된 첨부 파일을 찾을 수 없습니다.' });
      return;
    }
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // 내용주소 = 불변
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[richdocs] 첨부 스트림 오류:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  return router;
}
