/**
 * 앵커/매핑 라우트 (Day 2 API 계약, 설계서 §3.2·§3.3)
 * - POST   /api/anchors                          → 하이라이트 생성 (겹침 60% 제안·force·nudge·트랜잭션)
 * - POST   /api/passages/:id/links               → 기존 passage에 문항 추가 (중복 무시)
 * - DELETE /api/passages/:id/links/:questionId   → 연결 해제 (마지막 링크 409 → ?confirm=1 soft-delete)
 * - GET    /api/docs/versions/:vid/anchors       → 판본 앵커 전체 + 연결 문항 (뷰어 오버레이/우측 레일)
 * GET는 viewer 가능, 변경류는 editor 이상. docs 라우트와 독립 — /api에 단독 마운트 가능.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import {
  createAnchorMapping,
  linkQuestionToPassage,
  unlinkQuestionFromPassage,
} from '../anchors/service.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';

const rectTuple = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const rectsSchema = z
  .array(
    z.object({
      page: z.number().int().min(1),
      rects: z.array(rectTuple).min(1),
    }),
  )
  .min(1);

const createAnchorSchema = z
  .object({
    documentVersionId: z.number().int().positive(),
    questionIds: z.array(z.number().int().positive()).min(1),
    quoteExact: z.string().min(1),
    quotePrefix: z.string().nullable().optional(),
    quoteSuffix: z.string().nullable().optional(),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    pageStart: z.number().int().min(1),
    pageEnd: z.number().int().min(1),
    rects: rectsSchema,
    label: z.string().nullable().optional(),
    color: z.string().min(1).optional(),
    geometryPrimary: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
    force: z.boolean().optional(),
  })
  .refine((v) => v.endOffset > v.startOffset, {
    message: 'endOffset은 startOffset보다 커야 합니다.',
  })
  .refine((v) => v.pageEnd >= v.pageStart, {
    message: 'pageEnd는 pageStart 이상이어야 합니다.',
  });

const linkSchema = z.object({ questionId: z.number().int().positive() });

/** ≤maxChars 자 미리보기 (초과 시 말줄임 포함 총 maxChars 자) */
function preview(s: string | null, maxChars: number): string | null {
  if (s === null) return null;
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + '…';
}

interface AnchorListRow {
  anchor_id: number;
  passage_id: number;
  status: string;
  method: string | null;
  page_start: number | null;
  page_end: number | null;
  rects_json: string | null;
  quote_exact: string;
  geometry_primary: number;
  label: string | null;
  color: string;
}

interface AnchorQuestionRow {
  id: number;
  question_no: string;
  body: string;
  answer_plain: string | null;
}

export function createAnchorsRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  // ---------- POST /api/anchors ----------
  router.post('/anchors', editor, (req, res) => {
    const parsed = createAnchorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const result = createAnchorMapping(db, parsed.data, req.user!.id);
    switch (result.kind) {
      case 'version_not_found':
        res.status(404).json({ error: 'not_found', details: '지침서 판본이 존재하지 않습니다.' });
        return;
      case 'questions_not_found':
        res.status(400).json({
          error: 'validation',
          details: `존재하지 않는 문항입니다: ${result.missing.join(', ')}`,
        });
        return;
      case 'overlap':
        // 생성하지 않고 기존 하이라이트 제안 (§3.2 중복 방지 — "기존 하이라이트에 이 문항 추가")
        res.status(200).json({ overlap: result.overlap });
        return;
      case 'created': {
        const body: Record<string, unknown> = {
          passageId: result.passageId,
          anchorId: result.anchorId,
        };
        if (result.nudge) body.nudge = result.nudge;
        res.status(201).json(body);
        return;
      }
    }
  });

  // ---------- POST /api/passages/:id/links ----------
  router.post('/passages/:id/links', editor, (req, res) => {
    const passageId = Number(req.params.id);
    if (!Number.isInteger(passageId)) {
      res.status(400).json({ error: 'validation', details: '발췌 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const result = linkQuestionToPassage(db, passageId, parsed.data.questionId, req.user!.id);
    switch (result.kind) {
      case 'passage_not_found':
        res.status(404).json({ error: 'not_found', details: '발췌가 존재하지 않습니다.' });
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

  // ---------- DELETE /api/passages/:id/links/:questionId ----------
  router.delete('/passages/:id/links/:questionId', editor, (req, res) => {
    const passageId = Number(req.params.id);
    const questionId = Number(req.params.questionId);
    if (!Number.isInteger(passageId) || !Number.isInteger(questionId)) {
      res.status(400).json({ error: 'validation', details: 'ID가 올바르지 않습니다.' });
      return;
    }
    const confirm = req.query.confirm === '1';
    const result = unlinkQuestionFromPassage(db, passageId, questionId, req.user!.id, confirm);
    switch (result.kind) {
      case 'passage_not_found':
        res.status(404).json({ error: 'not_found', details: '발췌가 존재하지 않습니다.' });
        return;
      case 'link_not_found':
        res.status(404).json({ error: 'not_found', details: '연결이 존재하지 않습니다.' });
        return;
      case 'last_link':
        res.status(409).json({ error: 'last_link', requiresConfirm: true });
        return;
      case 'unlinked':
        res.status(200).json({ ok: true, passageDeleted: result.passageDeleted });
        return;
    }
  });

  // ---------- GET /api/docs/versions/:vid/anchors ----------
  router.get('/docs/versions/:vid/anchors', auth, (req, res) => {
    const versionId = Number(req.params.vid);
    if (!Number.isInteger(versionId)) {
      res.status(400).json({ error: 'validation', details: '판본 ID가 올바르지 않습니다.' });
      return;
    }
    const version = db.prepare('SELECT id FROM document_version WHERE id = ?').get(versionId);
    if (!version) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const rows = db
      .prepare(
        `SELECT pa.id AS anchor_id, pa.passage_id, pa.status, pa.method,
                pa.page_start, pa.page_end, pa.rects_json, pa.quote_exact, pa.geometry_primary,
                p.label, p.color
         FROM passage_anchor pa
         JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL
         WHERE pa.document_version_id = ?
         ORDER BY COALESCE(pa.page_start, 1000000), COALESCE(pa.start_offset, 0), pa.id`,
      )
      .all(versionId) as AnchorListRow[];

    const questionsStmt = db.prepare(
      `SELECT q.id, q.question_no, q.body, q.answer_plain
       FROM question_passage qp
       JOIN question q ON q.id = qp.question_id AND q.deleted_at IS NULL
       WHERE qp.passage_id = ?
       ORDER BY qp.sort, q.question_no`,
    );

    res.json({
      anchors: rows.map((r) => ({
        anchorId: r.anchor_id,
        passageId: r.passage_id,
        status: r.status,
        method: r.method,
        pageStart: r.page_start,
        pageEnd: r.page_end,
        rects: r.rects_json ? (JSON.parse(r.rects_json) as unknown) : null,
        quote: r.quote_exact,
        label: r.label,
        color: r.color,
        geometryPrimary: r.geometry_primary === 1,
        questions: (questionsStmt.all(r.passage_id) as AnchorQuestionRow[]).map((q) => ({
          id: q.id,
          questionNo: q.question_no,
          bodyPreview: preview(q.body, 60),
          answerPreview: preview(q.answer_plain, 60),
        })),
      })),
    });
  });

  return router;
}
