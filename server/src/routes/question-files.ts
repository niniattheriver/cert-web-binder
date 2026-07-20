/**
 * 문항 첨부·하이퍼링크 라우트 (v1.5 Phase 2 — 설계서 §4 #4 보조 자료, A-7 안전장치)
 * - GET    /api/questions/:id/files            → { attachments, links } (viewer 가능)
 * - POST   /api/questions/:id/attachments      → 파일 업로드 (editor)
 * - GET    /api/questions/attachments/:aid/file → 다운로드 — inline은 pdf/png/jpg만, 나머지 attachment 강제
 * - DELETE /api/questions/attachments/:aid     → soft delete (editor)
 * - POST   /api/questions/:id/links            → 링크 추가 (editor, http(s)만)
 * - DELETE /api/questions/links/:lid           → soft delete (editor)
 *
 * 안전장치 (지시서 A-7):
 * - 디스크 스트리밍 저장(multer.diskStorage 임시파일 → 스트림 해시 → 내용주소로 rename. 메모리 버퍼 금지)
 * - 파일당 상한은 app_setting 'attachmentMaxMB' (요청 시점 조회 — 재기동 없이 변경 가능)
 * - 저장명은 서버 통제(내용주소 sha256) — 클라이언트 파일명은 표시용 orig_name으로만
 * - MIME은 클라이언트 신고값을 버리고 확장자에서 서버가 재판정
 * - inline 미리보기는 pdf/png/jpg 화이트리스트만, 나머지는 Content-Disposition: attachment
 *   (HTML/SVG 저장형 XSS 차단) + X-Content-Type-Options: nosniff
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { logChange } from '../db/change-log.js';
import {
  INLINE_MIME,
  decodeFileName,
  dispositionFor,
  mimeFromName,
  sha256OfFile,
} from '../files/upload-util.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { attachmentPath } from '../richdocs/service.js';

const DEFAULT_MAX_MB = 200; // 시드 기본값(bootstrap)과 동일 유지 — 설정 행이 없을 때의 폴백

function attachmentMaxBytes(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM app_setting WHERE key = 'attachmentMaxMB'")
    .get() as { value: string } | undefined;
  const mb = row ? Number(row.value) : NaN;
  // 반드시 정수 — multer는 소수 fileSize 상한이면 거부 대신 조용히 잘라 저장한다(실측)
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024);
}

interface AttachmentRow {
  id: number;
  question_id: number;
  sha256: string;
  orig_name: string;
  mime: string;
  size: number;
  sort: number;
  uploaded_by: number | null;
  uploaded_at: string;
  deleted_at: string | null;
}

interface LinkRow {
  id: number;
  question_id: number;
  url: string;
  label: string | null;
  sort: number;
  created_by: number | null;
  created_at: string;
  deleted_at: string | null;
}

const linkSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\/\S+$/i, 'http:// 또는 https:// 로 시작하는 주소만 등록할 수 있습니다.'),
  label: z.string().trim().max(300).nullable().optional(),
});

function attachmentPayload(r: AttachmentRow, uploadedByName: string | null): Record<string, unknown> {
  return {
    id: r.id,
    origName: r.orig_name,
    mime: r.mime,
    size: r.size,
    sort: r.sort,
    inlinePreview: INLINE_MIME.has(r.mime),
    uploadedAt: r.uploaded_at,
    uploadedByName,
  };
}

function linkPayload(r: LinkRow): Record<string, unknown> {
  return { id: r.id, url: r.url, label: r.label, sort: r.sort, createdAt: r.created_at };
}

export function createQuestionFilesRouter(
  db: Database.Database,
  opts: { filesDir: string },
): Router {
  const router = Router();
  const auth = requireAuth(db);
  const editor = requireEditor(db);
  const filesDir = opts.filesDir;
  const tmpDir = path.join(filesDir, 'tmp');

  const userName = (id: number | null): string | null =>
    id
      ? ((db.prepare('SELECT display_name FROM user WHERE id = ?').get(id) as
          | { display_name: string }
          | undefined)?.display_name ?? null)
      : null;

  const questionExists = (id: number): boolean =>
    db.prepare('SELECT 1 FROM question WHERE id = ? AND deleted_at IS NULL').get(id) !== undefined;

  const nextSort = (questionId: number): number => {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM (
           SELECT sort FROM question_attachment WHERE question_id = ? AND deleted_at IS NULL
           UNION ALL
           SELECT sort FROM question_link WHERE question_id = ? AND deleted_at IS NULL
         )`,
      )
      .get(questionId, questionId) as { s: number };
    return row.s;
  };

  // 디스크 스트리밍: 임시 디렉토리에 서버 난수명으로 기록 (A-7 — memoryStorage 금지)
  const diskStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `up-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    },
  });

  // ---------- GET /api/questions/:id/files ----------
  router.get('/questions/:id/files', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    if (!questionExists(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const attachments = db
      .prepare(
        `SELECT * FROM question_attachment
         WHERE question_id = ? AND deleted_at IS NULL ORDER BY sort, id`,
      )
      .all(id) as AttachmentRow[];
    const links = db
      .prepare(
        `SELECT * FROM question_link
         WHERE question_id = ? AND deleted_at IS NULL ORDER BY sort, id`,
      )
      .all(id) as LinkRow[];
    res.json({
      attachments: attachments.map((a) => attachmentPayload(a, userName(a.uploaded_by))),
      links: links.map(linkPayload),
    });
  });

  // ---------- POST /api/questions/:id/attachments ----------
  router.post('/questions/:id/attachments', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    if (!questionExists(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const maxBytes = attachmentMaxBytes(db); // 요청 시점 조회 — 재기동 없이 상한 변경 반영
    const upload = multer({ storage: diskStorage, limits: { fileSize: maxBytes, files: 1 } }).single(
      'file',
    );
    upload(req, res, (err: unknown) => {
      const tmpFile = req.file?.path;
      const cleanup = (): void => {
        if (tmpFile) fs.rm(tmpFile, { force: true }, () => {});
      };
      if (err) {
        cleanup();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'file_too_large',
            details: `파일이 상한 ${Math.round(maxBytes / 1024 / 1024)}MB를 초과했습니다.`,
          });
          return;
        }
        res.status(400).json({ error: 'upload_error', details: '업로드에 실패했습니다.' });
        return;
      }
      if (!req.file || !tmpFile) {
        res.status(400).json({ error: 'validation', details: '파일이 없습니다.' });
        return;
      }
      const origName = decodeFileName(req.file.originalname);
      const mime = mimeFromName(origName); // 클라이언트 신고 mimetype 불신 — 확장자 재판정
      void sha256OfFile(tmpFile)
        .then((sha256) => {
          const target = attachmentPath(filesDir, sha256);
          if (!fs.existsSync(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(tmpFile, target); // 내용주소 저장 — 서버 통제 저장명
          } else {
            cleanup(); // 동일 내용 이미 존재 — 중복 제거
          }
          const now = new Date().toISOString();
          const row = db.transaction((): AttachmentRow => {
            const info = db
              .prepare(
                `INSERT INTO question_attachment
                   (question_id, sha256, orig_name, mime, size, sort, uploaded_by, uploaded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(id, sha256, origName, mime, req.file!.size, nextSort(id), req.user!.id, now);
            const inserted = db
              .prepare('SELECT * FROM question_attachment WHERE id = ?')
              .get(Number(info.lastInsertRowid)) as AttachmentRow;
            logChange(db, {
              actorId: req.user!.id,
              entity: 'question_attachment',
              entityId: inserted.id,
              action: 'create',
              after: { questionId: id, sha256, origName, mime, size: inserted.size },
            });
            return inserted;
          })();
          res.status(201).json(attachmentPayload(row, userName(row.uploaded_by)));
        })
        .catch(() => {
          cleanup();
          res.status(500).json({ error: 'internal', details: '파일 저장에 실패했습니다.' });
        });
    });
  });

  // ---------- GET /api/questions/attachments/:aid/file ----------
  router.get('/questions/attachments/:aid/file', auth, (req, res) => {
    const aid = Number(req.params.aid);
    if (!Number.isInteger(aid)) {
      res.status(400).json({ error: 'validation', details: '첨부 ID가 올바르지 않습니다.' });
      return;
    }
    const row = db
      .prepare('SELECT * FROM question_attachment WHERE id = ? AND deleted_at IS NULL')
      .get(aid) as AttachmentRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const filePath = attachmentPath(filesDir, row.sha256);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'file_missing', details: '저장 파일이 없습니다.' });
      return;
    }
    // inline은 화이트리스트(pdf/png/jpg)만 — HTML/SVG 등 저장형 XSS 차단 (A-7)
    const kind = INLINE_MIME.has(row.mime) ? 'inline' : 'attachment';
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', dispositionFor(kind, row.orig_name));
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  // ---------- DELETE /api/questions/attachments/:aid ----------
  router.delete('/questions/attachments/:aid', editor, (req, res) => {
    const aid = Number(req.params.aid);
    if (!Number.isInteger(aid)) {
      res.status(400).json({ error: 'validation', details: '첨부 ID가 올바르지 않습니다.' });
      return;
    }
    const now = new Date().toISOString();
    const outcome = db.transaction((): 'not_found' | 'ok' => {
      const row = db
        .prepare('SELECT * FROM question_attachment WHERE id = ? AND deleted_at IS NULL')
        .get(aid) as AttachmentRow | undefined;
      if (!row) return 'not_found';
      // soft delete만 — 파일 본문은 내용주소 특성상 유지 (하드삭제 금지 가드레일)
      db.prepare('UPDATE question_attachment SET deleted_at = ? WHERE id = ?').run(now, aid);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question_attachment',
        entityId: aid,
        action: 'delete',
        before: row,
      });
      return 'ok';
    })();
    if (outcome === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- POST /api/questions/:id/links ----------
  router.post('/questions/:id/links', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    if (!questionExists(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const now = new Date().toISOString();
    const row = db.transaction((): LinkRow => {
      const info = db
        .prepare(
          `INSERT INTO question_link (question_id, url, label, sort, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, parsed.data.url, parsed.data.label ?? null, nextSort(id), req.user!.id, now);
      const inserted = db
        .prepare('SELECT * FROM question_link WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as LinkRow;
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question_link',
        entityId: inserted.id,
        action: 'create',
        after: { questionId: id, url: inserted.url, label: inserted.label },
      });
      return inserted;
    })();
    res.status(201).json(linkPayload(row));
  });

  // ---------- DELETE /api/questions/links/:lid ----------
  router.delete('/questions/links/:lid', editor, (req, res) => {
    const lid = Number(req.params.lid);
    if (!Number.isInteger(lid)) {
      res.status(400).json({ error: 'validation', details: '링크 ID가 올바르지 않습니다.' });
      return;
    }
    const now = new Date().toISOString();
    const outcome = db.transaction((): 'not_found' | 'ok' => {
      const row = db
        .prepare('SELECT * FROM question_link WHERE id = ? AND deleted_at IS NULL')
        .get(lid) as LinkRow | undefined;
      if (!row) return 'not_found';
      db.prepare('UPDATE question_link SET deleted_at = ? WHERE id = ?').run(now, lid);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question_link',
        entityId: lid,
        action: 'delete',
        before: row,
      });
      return 'ok';
    })();
    if (outcome === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
