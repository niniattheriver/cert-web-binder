/**
 * 지침서 문서/판본/검색 라우트 — Day 2 API 계약 (설계서 §3.1, §4 #6·#7)
 * - POST /api/docs                          업로드 파이프라인 (editor 이상)
 * - GET  /api/docs                          라이브러리 목록 (?year=N 연도 필터 → yearVersion 포함)
 * - GET  /api/docs/search?q=                통합 지침서 전문 검색 (FTS page_text, 3자 미만 LIKE 폴백, ?year=)
 * - GET  /api/docs/:id                      문서 + 판본 목록 + needsReviewCount
 * - GET  /api/docs/versions/:vid/file       PDF 스트림
 * (판본 앵커 목록 GET /api/docs/versions/:vid/anchors 은 routes/anchors.ts 가 단독 소유)
 * - GET  /api/docs/versions/:vid/page-text  페이지 텍스트+start_offset (뷰어 검색·오프셋 계산용)
 * GET류 = 로그인 필수(viewer 가능), 변경 = editor 이상. 오류 형식은 Day 1과 동일.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { config, dataDir } from '../config.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { capContentLength } from '../middleware/body-cap.js';
import { EncryptedPdfError, InvalidPdfError } from '../pdf/extract.js';
import {
  DocumentNotFoundError,
  DuplicateCodeError,
  DuplicateVersionLabelError,
  uploadGuideline,
  versionFilePath,
} from '../docs/service.js';
import crypto from 'node:crypto';
import { logChange } from '../db/change-log.js';
import { dispositionFor, mimeFromName, sha256OfFile } from '../files/upload-util.js';
import { attachmentPath } from '../richdocs/service.js';

const FILES_DIR = path.join(dataDir, 'files');
const LIMIT = 20;
const SNIPPET_RADIUS = 40;

/** multer(busboy)는 파일명을 latin1로 디코드한다 — 한글 파일명 UTF-8 복원 */
function decodeFileName(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** LIKE 폴백용 스니펫: 첫 일치 주변을 잘라 반환 */
function makeSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, SNIPPET_RADIUS * 2) + (text.length > SNIPPET_RADIUS * 2 ? '…' : '');
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + q.length + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\n/g, ' ') + (end < text.length ? '…' : '');
}

const yearSchema = z.coerce.number().int().min(2000).max(2100).optional();

const uploadFieldsSchema = z.object({
  title: z.string().trim().max(300).optional(),
  versionLabel: z.string().trim().min(1, '판 라벨(versionLabel)은 필수입니다.').max(100),
  code: z.string().trim().max(100).optional(),
  documentId: z.coerce.number().int().positive().optional(),
  kind: z.enum(['manual', 'question_source']).optional(),
  year: yearSchema, // 판본 연도 태그(④) — 미지정 시 업로드한 해
});

export function createDocsRouter(
  db: Database.Database,
  opts?: { filesDir?: string }, // 테스트 주입용 — 기본 data/files
): Router {
  const router = Router();
  const filesDir = opts?.filesDir ?? FILES_DIR;
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxPdfMB * 1024 * 1024, files: 1 },
  });
  // 요청 전체 크기 선검사(파일 + 폼 필드 여유 32MB) — 과대 요청을 메모리 적재 전에 거절
  const uploadCap = capContentLength((config.maxPdfMB + 32) * 1024 * 1024);

  // ---------- POST /api/docs — 업로드 파이프라인 ----------
  router.post('/', editor, uploadCap, (req, res) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'file_too_large',
            details: `PDF 최대 크기 ${config.maxPdfMB}MB를 초과했습니다.`,
          });
          return;
        }
        res.status(400).json({
          error: 'upload_error',
          details: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      void handleUpload(req, res);
    });
  });

  async function handleUpload(req: Request, res: Response): Promise<void> {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'validation', details: 'file 필드에 PDF를 첨부하세요.' });
        return;
      }
      const parsed = uploadFieldsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'validation', details: parsed.error.issues });
        return;
      }
      const fields = parsed.data;
      if (fields.documentId == null && !fields.title) {
        res.status(400).json({
          error: 'validation',
          details: '새 문서 업로드에는 title이 필수입니다 (기존 문서 새 판본은 documentId 지정).',
        });
        return;
      }
      const result = await uploadGuideline(db, {
        buffer: file.buffer,
        fileName: decodeFileName(file.originalname),
        title: fields.title ?? null,
        versionLabel: fields.versionLabel,
        code: fields.code ?? null,
        documentId: fields.documentId ?? null,
        kind: fields.kind,
        year: fields.year ?? null,
        userId: req.user?.id ?? null,
        filesDir,
      });
      if (result.duplicate) {
        res.json({ duplicate: true, documentId: result.documentId, versionId: result.versionId });
        return;
      }
      res.status(201).json({
        documentId: result.documentId,
        versionId: result.versionId,
        pageCount: result.pageCount,
        ...(result.textWarning ? { textWarning: result.textWarning } : {}),
        ...(result.reanchor ? { reanchor: result.reanchor } : {}),
      });
    } catch (err) {
      if (err instanceof EncryptedPdfError) {
        res.status(400).json({ error: 'encrypted_pdf', details: err.message });
        return;
      }
      if (err instanceof InvalidPdfError) {
        res.status(400).json({ error: 'invalid_pdf', details: err.message });
        return;
      }
      if (err instanceof DocumentNotFoundError) {
        res.status(404).json({ error: 'not_found', details: err.message });
        return;
      }
      if (err instanceof DuplicateVersionLabelError) {
        res.status(409).json({ error: 'duplicate_version_label', details: err.message });
        return;
      }
      if (err instanceof DuplicateCodeError) {
        res.status(409).json({ error: 'duplicate_code', details: err.message });
        return;
      }
      console.error('[docs] 업로드 실패:', err);
      res.status(500).json({ error: 'internal' });
    }
  }

  // ---------- POST /api/docs/auto — 일괄 업로드용 자동 인입 (v1.5) ----------
  // 제목·판본라벨 입력 없이 파일명만으로 인입한다: 제목 = 파일명 stem(NFC),
  // 같은 제목의 문서가 이미 있으면 그 문서의 "새 판본"으로 업로드(동일 sha256+동일 연도
  // 재업로드는 duplicate 무동작 — 폴더째 재업로드가 멱등. 같은 파일도 다른 연도로 올리면
  // 그 연도의 새 판본이 된다). 클라이언트가 다중 선택 후 파일별로 순차
  // 호출한다(한 요청 다중 파일은 메모리·타임아웃 위험 + 파일별 실패 보고 불가).
  router.post('/auto', editor, uploadCap, (req, res) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'file_too_large',
            details: `PDF 최대 크기 ${config.maxPdfMB}MB를 초과했습니다.`,
          });
          return;
        }
        res.status(400).json({
          error: 'upload_error',
          details: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      void handleAutoUpload(req, res);
    });
  });

  async function handleAutoUpload(req: Request, res: Response): Promise<void> {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'validation', details: 'file 필드에 PDF를 첨부하세요.' });
        return;
      }
      const fileName = decodeFileName(file.originalname).normalize('NFC');
      const title = fileName.replace(/\.pdf$/i, '').trim().slice(0, 300);
      if (!title) {
        res.status(400).json({ error: 'validation', details: '파일명에서 제목을 만들 수 없습니다.' });
        return;
      }
      const rawLabel = typeof req.body?.versionLabel === 'string' ? req.body.versionLabel.trim() : '';
      const yearParsed = yearSchema.safeParse(
        typeof req.body?.year === 'string' && req.body.year.trim() !== '' ? req.body.year : undefined,
      );
      if (!yearParsed.success) {
        res.status(400).json({ error: 'validation', details: '연도(year)가 올바르지 않습니다.' });
        return;
      }
      // 같은 제목의 살아있는 문서 → 새 판본으로. (제목 중복 문서 양산 방지)
      const existing = db
        .prepare(`SELECT id FROM document WHERE title = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`)
        .get(title) as { id: number } | undefined;
      // 기본 판본라벨 = 로컬 오늘 날짜. 클라이언트가 라벨을 명시하지 않은 경우에 한해,
      // 같은 날 수정본 재업로드(내용 상이 → 라벨 충돌)가 409로 죽지 않도록 '-2','-3' 접미사로
      // 자동 회피한다(새 판본 생성 사실은 응답 newVersion으로 명시 — 조용한 자동화 아님).
      // 명시 라벨의 충돌은 기존대로 409(duplicate_version_label).
      let versionLabel: string;
      if (rawLabel !== '') {
        versionLabel = rawLabel.slice(0, 100);
      } else {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        versionLabel = today;
        if (existing) {
          const taken = new Set(
            (db
              .prepare(`SELECT version_label FROM document_version WHERE document_id = ?`)
              .all(existing.id) as Array<{ version_label: string }>).map((r) => r.version_label),
          );
          for (let n = 2; taken.has(versionLabel); n++) versionLabel = `${today}-${n}`;
        }
      }
      const result = await uploadGuideline(db, {
        buffer: file.buffer,
        fileName,
        title: existing ? null : title,
        versionLabel,
        code: null,
        documentId: existing?.id ?? null,
        year: yearParsed.data ?? null,
        userId: req.user?.id ?? null,
        filesDir,
      });
      if (result.duplicate) {
        res.json({ duplicate: true, documentId: result.documentId, versionId: result.versionId, title });
        return;
      }
      res.status(201).json({
        documentId: result.documentId,
        versionId: result.versionId,
        pageCount: result.pageCount,
        year: result.year,
        title,
        newVersion: existing != null,
        ...(result.textWarning ? { textWarning: result.textWarning } : {}),
        ...(result.reanchor ? { reanchor: result.reanchor } : {}),
      });
    } catch (err) {
      if (err instanceof EncryptedPdfError) {
        res.status(400).json({ error: 'encrypted_pdf', details: err.message });
        return;
      }
      if (err instanceof InvalidPdfError) {
        res.status(400).json({ error: 'invalid_pdf', details: err.message });
        return;
      }
      if (err instanceof DuplicateVersionLabelError) {
        res.status(409).json({ error: 'duplicate_version_label', details: err.message });
        return;
      }
      console.error('[docs] 자동 업로드 실패:', err);
      res.status(500).json({ error: 'internal' });
    }
  }

  // ---------- GET /api/docs — 라이브러리 목록 (?year=N 연도 필터 ④) ----------
  router.get('/', auth, (req, res) => {
    const yearRaw = String(req.query.year ?? '').trim();
    const yearFilter = yearRaw === '' ? null : Number(yearRaw);
    if (yearFilter != null && !Number.isInteger(yearFilter)) {
      res.status(400).json({ error: 'validation', details: '연도(year)가 올바르지 않습니다.' });
      return;
    }
    const commonCols = `d.id, d.code, d.title, d.kind,
                dv.id AS version_id, dv.version_label, dv.page_count, dv.uploaded_at, dv.text_warning, dv.year,
                (SELECT COUNT(*) FROM passage p
                  WHERE p.document_id = d.id AND p.deleted_at IS NULL)             AS passage_count,
                (SELECT COUNT(DISTINCT qp.question_id)
                   FROM question_passage qp
                   JOIN passage p2 ON p2.id = qp.passage_id
                        AND p2.document_id = d.id AND p2.deleted_at IS NULL
                   JOIN question q ON q.id = qp.question_id AND q.deleted_at IS NULL) AS mapped_question_count`;
    const rows = (
      yearFilter == null
        ? db.prepare(
            `SELECT ${commonCols}
             FROM document d
             LEFT JOIN document_version dv ON dv.document_id = d.id AND dv.is_current = 1
             WHERE d.deleted_at IS NULL
             ORDER BY (dv.uploaded_at IS NULL), dv.uploaded_at DESC, d.id DESC`,
          ).all()
        : // 해당 연도의 실패 아닌 판본이 1개 이상인 문서만 + 그중 최신 판본(yv)
          db.prepare(
            `SELECT ${commonCols},
                    yv.id AS yv_id, yv.version_label AS yv_label, yv.year AS yv_year,
                    yv.uploaded_at AS yv_uploaded_at, yv.page_count AS yv_page_count
             FROM document d
             LEFT JOIN document_version dv ON dv.document_id = d.id AND dv.is_current = 1
             JOIN document_version yv ON yv.id = (
               SELECT v2.id FROM document_version v2
               WHERE v2.document_id = d.id AND v2.year = ? AND v2.status <> 'failed'
               ORDER BY v2.id DESC LIMIT 1)
             WHERE d.deleted_at IS NULL
             ORDER BY (dv.uploaded_at IS NULL), dv.uploaded_at DESC, d.id DESC`,
          ).all(yearFilter)
    ) as Record<string, unknown>[];
    res.json({
      docs: rows.map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        kind: r.kind,
        currentVersion:
          r.version_id == null
            ? null
            : {
                id: r.version_id,
                versionLabel: r.version_label,
                pageCount: r.page_count,
                uploadedAt: r.uploaded_at,
                textWarning: r.text_warning,
                year: r.year,
              },
        ...(yearFilter == null
          ? {}
          : {
              yearVersion: {
                id: r.yv_id,
                versionLabel: r.yv_label,
                year: r.yv_year,
                uploadedAt: r.yv_uploaded_at,
                pageCount: r.yv_page_count,
              },
            }),
        passageCount: r.passage_count,
        mappedQuestionCount: r.mapped_question_count,
      })),
    });
  });

  // ---------- GET /api/docs/search — 통합 지침서 전문 검색 ----------
  // 주의: '/:id' 보다 먼저 등록해야 한다.
  router.get('/search', auth, (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length === 0) {
      res.json({ hits: [] });
      return;
    }
    const yearRaw = String(req.query.year ?? '').trim();
    const yearFilter = yearRaw === '' ? null : Number(yearRaw);
    if (yearFilter != null && !Number.isInteger(yearFilter)) {
      res.status(400).json({ error: 'validation', details: '연도(year)가 올바르지 않습니다.' });
      return;
    }
    // 연도 필터: 그 연도의 최신(실패 아님) 판본을 문서별로 검색한다 — 라이브러리 목록의
    // yearVersion 과 동일한 판본. is_current 조인을 함께 걸면 문서에 이후 연도 판본이
    // 올라온 순간 그 연도의 페이지가 검색에서 통째로 사라진다(연도 탭과 모순).
    // 연도 미지정 검색은 종전대로 현재 판본(is_current)만 대상.
    const versionCond =
      yearFilter == null
        ? 'dv.is_current = 1'
        : `dv.id = (SELECT v2.id FROM document_version v2
                    WHERE v2.document_id = dv.document_id AND v2.year = ? AND v2.status <> 'failed'
                    ORDER BY v2.id DESC LIMIT 1)`;
    interface HitRow {
      versionId: number;
      docTitle: string;
      pageNo: number;
      year: number | null;
      snippet?: string;
      text?: string;
    }
    let hits: HitRow[];
    if (q.length >= 3) {
      // 구문 인용(FTS 연산자 무력화) + content 컬럼 한정('page' 등 질의가 kind 값과 오매치 방지)
      const match = 'content:"' + q.replaceAll('"', '""') + '"';
      hits = db
        .prepare(
          `SELECT pt.document_version_id AS versionId, d.title AS docTitle, pt.page_no AS pageNo,
                  dv.year AS year, snippet(fts, 2, '', '', '…', 16) AS snippet
           FROM fts
           JOIN page_text pt ON pt.rowid = fts.ref_id
           JOIN document_version dv ON dv.id = pt.document_version_id AND ${versionCond}
           JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
           WHERE fts.kind = 'page_text' AND fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...(yearFilter == null ? [match, LIMIT] : [yearFilter, match, LIMIT])) as HitRow[];
      hits = hits.map((h) => ({ ...h, snippet: (h.snippet ?? '').replace(/\n/g, ' ') }));
    } else {
      const like = `%${escapeLike(q)}%`;
      const rows = db
        .prepare(
          `SELECT pt.document_version_id AS versionId, d.title AS docTitle, pt.page_no AS pageNo,
                  dv.year AS year, pt.text
           FROM page_text pt
           JOIN document_version dv ON dv.id = pt.document_version_id AND ${versionCond}
           JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
           WHERE pt.text LIKE ? ESCAPE '\\'
           ORDER BY d.id, pt.page_no
           LIMIT ?`,
        )
        .all(...(yearFilter == null ? [like, LIMIT] : [yearFilter, like, LIMIT])) as HitRow[];
      hits = rows.map((r) => ({
        versionId: r.versionId,
        docTitle: r.docTitle,
        pageNo: r.pageNo,
        year: r.year,
        snippet: makeSnippet(r.text ?? '', q),
      }));
    }
    res.json({
      hits: hits.map((h) => ({
        versionId: h.versionId,
        docTitle: h.docTitle,
        pageNo: h.pageNo,
        year: h.year,
        snippet: h.snippet,
      })),
    });
  });

  // ---------- GET /api/docs/versions/:vid/file — PDF 스트림 ----------
  router.get('/versions/:vid/file', auth, (req, res) => {
    const vid = Number(req.params.vid);
    if (!Number.isInteger(vid)) {
      res.status(400).json({ error: 'validation', details: '판본 ID가 올바르지 않습니다.' });
      return;
    }
    const row = db
      .prepare(
        `SELECT dv.file_sha256, dv.file_name, dv.file_size
         FROM document_version dv
         JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
         WHERE dv.id = ?`,
      )
      .get(vid) as { file_sha256: string; file_name: string; file_size: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const filePath = versionFilePath(filesDir, row.file_sha256);
    if (!filePath) {
      res.status(404).json({ error: 'file_missing', details: '저장된 PDF 파일을 찾을 수 없습니다.' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(row.file_size));
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    );
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[docs] 파일 스트림 오류:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  // ---------- POST /api/docs/versions/:vid/source-file — 원본 파일 첨부/교체 (B-2) ----------
  // 매핑(하이라이트)은 PDF 사본에, 편집·다운로드는 원본으로. 판본당 0..1개.
  // 디스크 스트리밍(임시파일 → 스트림 해시 → 내용주소 rename) — memoryStorage 금지 (A-7).
  const sourceTmpDir = path.join(filesDir, 'tmp');
  const sourceStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(sourceTmpDir, { recursive: true });
      cb(null, sourceTmpDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `src-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    },
  });
  const SOURCE_EXT = new Set(['hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

  router.post('/versions/:vid/source-file', editor, (req, res) => {
    const vid = Number(req.params.vid);
    if (!Number.isInteger(vid)) {
      res.status(400).json({ error: 'validation', details: '판본 ID가 올바르지 않습니다.' });
      return;
    }
    const sourceUpload = multer({
      storage: sourceStorage,
      limits: { fileSize: config.maxPdfMB * 1024 * 1024, files: 1 },
    }).single('file');
    sourceUpload(req, res, (err: unknown) => {
      const tmpFile = req.file?.path;
      const cleanup = (): void => {
        if (tmpFile) fs.rm(tmpFile, { force: true }, () => {});
      };
      if (err) {
        cleanup();
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'file_too_large',
            details: `원본 파일 최대 크기 ${config.maxPdfMB}MB를 초과했습니다.`,
          });
          return;
        }
        res.status(400).json({ error: 'upload_error', details: '업로드에 실패했습니다.' });
        return;
      }
      if (!req.file || !tmpFile) {
        res.status(400).json({ error: 'validation', details: 'file 필드에 원본 파일을 첨부하세요.' });
        return;
      }
      const origName = decodeFileName(req.file.originalname);
      const ext = path.extname(origName).slice(1).toLowerCase();
      if (!SOURCE_EXT.has(ext)) {
        cleanup();
        res.status(400).json({
          error: 'validation',
          details: '원본 파일은 hwp/hwpx/doc/docx/xls/xlsx/ppt/pptx 형식만 첨부할 수 있습니다.',
        });
        return;
      }
      const version = db
        .prepare(
          `SELECT dv.id, dv.source_sha256, dv.source_name
           FROM document_version dv
           JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
           WHERE dv.id = ?`,
        )
        .get(vid) as { id: number; source_sha256: string | null; source_name: string | null } | undefined;
      if (!version) {
        cleanup();
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const mime = mimeFromName(origName);
      const size = req.file.size;
      void sha256OfFile(tmpFile)
        .then((sha256) => {
          const target = attachmentPath(filesDir, sha256);
          if (!fs.existsSync(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(tmpFile, target);
          } else {
            cleanup(); // 동일 내용 이미 존재 — 중복 제거 (구 원본 파일도 내용주소라 삭제하지 않음)
          }
          db.transaction(() => {
            db.prepare(
              `UPDATE document_version
               SET source_sha256 = ?, source_name = ?, source_mime = ?, source_size = ?
               WHERE id = ?`,
            ).run(sha256, origName, mime, size, vid);
            logChange(db, {
              actorId: req.user!.id,
              entity: 'document_version',
              entityId: vid,
              action: version.source_sha256 ? 'source_replace' : 'source_attach',
              before: version.source_sha256
                ? { sourceSha256: version.source_sha256, sourceName: version.source_name }
                : undefined,
              after: { sourceSha256: sha256, sourceName: origName, sourceMime: mime, sourceSize: size },
            });
          })();
          res.status(201).json({ versionId: vid, sourceName: origName, sourceSize: size });
        })
        .catch(() => {
          cleanup();
          res.status(500).json({ error: 'internal', details: '파일 저장에 실패했습니다.' });
        });
    });
  });

  // ---------- GET /api/docs/versions/:vid/source-file — 원본 다운로드 (항상 attachment) ----------
  router.get('/versions/:vid/source-file', auth, (req, res) => {
    const vid = Number(req.params.vid);
    if (!Number.isInteger(vid)) {
      res.status(400).json({ error: 'validation', details: '판본 ID가 올바르지 않습니다.' });
      return;
    }
    const row = db
      .prepare(
        `SELECT dv.source_sha256, dv.source_name, dv.source_mime, dv.source_size
         FROM document_version dv
         JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
         WHERE dv.id = ?`,
      )
      .get(vid) as
      | { source_sha256: string | null; source_name: string | null; source_mime: string | null; source_size: number | null }
      | undefined;
    if (!row || !row.source_sha256 || !row.source_name) {
      res.status(404).json({ error: 'not_found', details: '이 판본에는 원본 파일이 없습니다.' });
      return;
    }
    const filePath = attachmentPath(filesDir, row.source_sha256);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'file_missing', details: '저장 파일이 없습니다.' });
      return;
    }
    // 원본(hwp/docx 등)은 브라우저 렌더 대상이 아님 — 항상 attachment + nosniff
    res.setHeader('Content-Type', row.source_mime ?? 'application/octet-stream');
    if (row.source_size != null) res.setHeader('Content-Length', String(row.source_size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', dispositionFor('attachment', row.source_name));
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[docs] 원본 스트림 오류:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  // ---------- GET /api/docs/versions/:vid/page-text ----------
  router.get('/versions/:vid/page-text', auth, (req, res) => {
    const vid = Number(req.params.vid);
    if (!Number.isInteger(vid)) {
      res.status(400).json({ error: 'validation', details: '판본 ID가 올바르지 않습니다.' });
      return;
    }
    const version = db
      .prepare('SELECT id FROM document_version WHERE id = ?')
      .get(vid) as { id: number } | undefined;
    if (!version) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const pages = db
      .prepare(
        `SELECT page_no AS pageNo, start_offset AS startOffset, text
         FROM page_text WHERE document_version_id = ? ORDER BY page_no`,
      )
      .all(vid) as { pageNo: number; startOffset: number; text: string }[];
    res.json({ pages });
  });

  // ---------- GET /api/docs/:id — 문서 상세 (판본 목록 + needsReviewCount) ----------
  router.get('/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문서 ID가 올바르지 않습니다.' });
      return;
    }
    const doc = db
      .prepare('SELECT id, code, title, kind FROM document WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { id: number; code: string | null; title: string; kind: string } | undefined;
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const versions = db
      .prepare(
        `SELECT id, version_label, page_count, status, is_current, text_warning,
                file_name, file_size, uploaded_at, year, source_name, source_size
         FROM document_version WHERE document_id = ? ORDER BY id DESC`,
      )
      .all(id) as Record<string, unknown>[];
    const current = versions.find((v) => v.is_current === 1);
    const needsReviewCount = current
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS n
               FROM passage_anchor pa
               JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL
               WHERE pa.document_version_id = ? AND pa.status IN ('needs_review','unresolved')`,
            )
            .get(current.id) as { n: number }
        ).n
      : 0;
    res.json({
      doc,
      versions: versions.map((v) => ({
        id: v.id,
        versionLabel: v.version_label,
        pageCount: v.page_count,
        status: v.status,
        isCurrent: v.is_current === 1,
        textWarning: v.text_warning,
        fileName: v.file_name,
        fileSize: v.file_size,
        uploadedAt: v.uploaded_at,
        year: v.year,
        sourceName: v.source_name, // 원본 파일(B-2) — 없으면 null
        sourceSize: v.source_size,
      })),
      needsReviewCount,
    });
  });

  return router;
}
