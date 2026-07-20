/**
 * 문항·분야 라우트 (API 계약)
 * - GET  /api/bootstrap                 → user·settings·activeCycle·분야 카드 집계
 * - GET  /api/categories/:id/questions  → 분야 문항 목록 (sort_key 순)
 * - GET  /api/questions/:id             → 문항 전 필드 + category + rowVersion
 * - PATCH /api/questions/:id            → 낙관적 잠금(409) + 채점 검증 + change_log
 * - GET  /api/questions/:id/evidence    → 근거 칩 통합 목록 (passage ∪ richdoc, sort 정렬)
 * - PATCH /api/questions/:id/evidence   → 근거 칩 순서/메모 갱신
 * GET류는 viewer 가능, PATCH는 editor 이상.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import { getEvidenceItems, updateEvidence } from '../anchors/evidence.js';
import { logChange } from '../db/change-log.js';
import { getActiveCycle, type ActiveCycle } from '../db/cycles.js';
import { getSettings } from '../db/settings.js';
import { validateScoring } from '../domain/scoring.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';

// ---------- 공용 조회 ----------

// 현재 주기 해석은 db/cycles.ts 가 단일 원천 — 기존 import 경로 호환을 위해 재수출한다.
export { getActiveCycle, type ActiveCycle } from '../db/cycles.js';

/**
 * ?cycle= 파라미터 해석 — 미지정이면 현재 주기, 지정 시 존재하는 주기 id만 허용.
 * ok=false 는 라우트가 400 {error:'잘못된 주기입니다.'} 로 응답한다.
 */
export function resolveCycleParam(
  db: Database.Database,
  raw: unknown,
): { ok: true; cycle: ActiveCycle | null } | { ok: false } {
  if (raw === undefined) return { ok: true, cycle: getActiveCycle(db) };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { ok: false };
  const cycle = db
    .prepare('SELECT id, name, status, year FROM cycle WHERE id = ?')
    .get(id) as ActiveCycle | undefined;
  if (!cycle) return { ok: false };
  return { ok: true, cycle };
}

interface QuestionRow {
  id: number;
  category_id: number;
  question_no: string;
  sort_key: number;
  body: string;
  answer_json: string | null;
  answer_plain: string | null;
  max_score: number | null;
  allow_na: number;
  answer_choice: 'yes' | 'no' | 'na' | null;
  score: number | null;
  score_autofilled: number;
  scoring_mode: 'simple' | 'composite' | 'auto';
  score_overridden: number;
  chapter_major: string | null;
  chapter_minor: string | null;
  findings_text: string | null;
  question_type: 'core' | 'required' | 'basic' | null;
  grade_symbol: string | null;
  revision_status: string | null;
  revision_note: string | null;
  needs_recheck: number;
  auto_candidate: number;
  carried_from_id: number | null;
  reviewed: number;
  row_version: number;
  updated_at: string;
  updated_by: number | null;
  deleted_at: string | null;
}

interface CategoryRow {
  id: number;
  code: string;
  name: string;
}

/** 문항 상세 페이로드 (GET·PATCH 갱신본·409 server 공용) */
function fullQuestionPayload(db: Database.Database, id: number): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT * FROM question WHERE id = ? AND deleted_at IS NULL')
    .get(id) as QuestionRow | undefined;
  if (!row) return null;
  const cat = db
    .prepare('SELECT id, code, name FROM category WHERE id = ?')
    .get(row.category_id) as CategoryRow;
  const updatedByName = row.updated_by
    ? ((db.prepare('SELECT display_name FROM user WHERE id = ?').get(row.updated_by) as
        | { display_name: string }
        | undefined)?.display_name ?? null)
    : null;
  // 연차 이월 왕복 링크: 전년도 문항(carried_from)과, 이 문항을 물려받은 이후 연도 문항(최신 1건)
  const carriedFrom = row.carried_from_id
    ? ((db
        .prepare(
          `SELECT cy.year FROM question q2
           JOIN category c2 ON c2.id = q2.category_id
           JOIN cycle cy ON cy.id = c2.cycle_id
           WHERE q2.id = ?`,
        )
        .get(row.carried_from_id) as { year: number | null } | undefined) ?? null)
    : null;
  const carriedTo =
    (db
      .prepare(
        `SELECT q2.id, cy.year FROM question q2
         JOIN category c2 ON c2.id = q2.category_id
         JOIN cycle cy ON cy.id = c2.cycle_id
         WHERE q2.carried_from_id = ? AND q2.deleted_at IS NULL
         ORDER BY cy.year DESC, q2.id DESC LIMIT 1`,
      )
      .get(row.id) as { id: number; year: number | null } | undefined) ?? null;
  return {
    id: row.id,
    questionNo: row.question_no,
    sortKey: row.sort_key,
    body: row.body,
    answerJson: row.answer_json,
    answerPlain: row.answer_plain,
    maxScore: row.max_score,
    allowNa: row.allow_na === 1,
    answerChoice: row.answer_choice,
    score: row.score,
    scoreAutofilled: row.score_autofilled === 1,
    scoringMode: row.scoring_mode,
    scoreOverridden: row.score_overridden === 1,
    chapterMajor: row.chapter_major,
    chapterMinor: row.chapter_minor,
    findingsText: row.findings_text,
    questionType: row.question_type,
    gradeSymbol: row.grade_symbol,
    revisionStatus: row.revision_status,
    revisionNote: row.revision_note,
    needsRecheck: row.needs_recheck === 1,
    autoCandidate: row.auto_candidate === 1,
    carriedFromId: row.carried_from_id,
    carriedFromYear: carriedFrom?.year ?? null,
    carriedToId: carriedTo?.id ?? null,
    carriedToYear: carriedTo?.year ?? null,
    reviewed: row.reviewed === 1,
    rowVersion: row.row_version,
    updatedAt: row.updated_at,
    updatedByName,
    category: { id: cat.id, code: cat.code, name: cat.name },
  };
}

// ---------- PATCH 입력 ----------

const patchSchema = z.object({
  rowVersion: z.number().int().min(1),
  answerChoice: z.enum(['yes', 'no', 'na']).nullable().optional(),
  score: z.number().nullable().optional(),
  scoreAutofilled: z.boolean().optional(), // 예→만점 자동 채움 후 미확인 (Phase 2 — UI 액션 전용)
  findingsText: z.string().nullable().optional(),
  answerJson: z.unknown().optional(),
  answerPlain: z.string().nullable().optional(),
  reviewed: z.boolean().optional(),
});

const evidencePatchSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(['passage', 'richdoc']),
        passageId: z.number().int().positive().optional(),
        richDocId: z.number().int().positive().optional(),
        sort: z.number().int(),
        note: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

/** answerJson은 문자열(이미 직렬화) 또는 JSON 객체 모두 허용 → TEXT 저장값으로 정규화 */
function normalizeAnswerJson(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** 근거 추천용 불용어 — 질문문 관용구·형식어(검색 변별력 없음) */
const SUGGEST_STOPWORDS = new Set([
  '있는가', '있는지', '하는가', '하는지', '되는가', '적절한가', '수행하는가', '시행하는가',
  '관리하는가', '문서화되어', '문서화하고', '있으며', '있고', '위한', '대한', '대해', '관한',
  '관련', '여부', '경우', '해당', '모든', '각각', '통해', '따라', '기준으로', '이를', '이에',
  '또는', '그리고', '등을', '등이', '등의', '수립하고', '유지하는가', '기록하는가',
]);

/**
 * 문항 주제/본문 → 검색 키워드 추출 (형태소 분석기 없이 보수적 휴리스틱):
 * 특수문자 제거 → 공백 분리 → 불용어·2자 이하 제외(trigram 은 3자부터 매치) →
 * 끝 조사 1자 제거(4자 이상일 때만 — 어근 손상 방지) → 등장 순 상위 5개.
 */
export function extractKeywords(text: string): string[] {
  const tokens = text
    .slice(0, 400)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !SUGGEST_STOPWORDS.has(t));
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.length >= 4 && /[을를이가은는의에로]$/.test(raw) ? raw.slice(0, -1) : raw;
    if (t.length < 3 || SUGGEST_STOPWORDS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

export function createQuestionsRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  // ---------- GET /api/bootstrap ----------
  // ?cycle=<id> 로 다른 연도(주기)의 분야 카드를 조회할 수 있다. 미지정이면 현재 주기.
  router.get('/bootstrap', auth, (req, res) => {
    const resolved = resolveCycleParam(db, req.query.cycle);
    if (!resolved.ok) {
      res.status(400).json({ error: '잘못된 주기입니다.' });
      return;
    }
    const scopeCycle = resolved.cycle;
    const activeCycle = getActiveCycle(db);
    const categories = scopeCycle
      ? (db
          .prepare(
            `SELECT c.id, c.code, c.name, c.sort,
                    COUNT(q.id)                                                        AS questionCount,
                    COALESCE(SUM(CASE WHEN q.answer_choice IS NOT NULL
                                        OR (q.scoring_mode <> 'simple' AND q.score IS NOT NULL)
                                      THEN 1 ELSE 0 END), 0) AS answeredCount,
                    COALESCE(SUM(CASE WHEN q.answer_choice IN ('yes','no') OR q.scoring_mode <> 'simple'
                                      THEN COALESCE(q.score, 0) ELSE 0 END), 0) AS scoreSum,
                    COALESCE(SUM(CASE WHEN q.answer_choice = 'na' THEN 0 ELSE COALESCE(q.max_score, 0) END), 0)      AS maxSum
             FROM category c
             LEFT JOIN question q ON q.category_id = c.id AND q.deleted_at IS NULL
             WHERE c.cycle_id = ? AND c.deleted_at IS NULL
             GROUP BY c.id
             ORDER BY c.sort, c.code`,
          )
          .all(scopeCycle.id) as Record<string, unknown>[])
      : [];
    // 연도(주기) 리스트 — 홈 연도별 진입 버튼용.
    // 새해 문항 업로드로 새 주기가 생기면 자동으로 리스트에 추가된다.
    // answered 정의는 위 분야 카드 집계와 동일(선택 있음 또는 합산/자동 점수 있음).
    const cycles = db
      .prepare(
        `SELECT cy.id, cy.name, cy.status, cy.year,
                COUNT(q.id) AS questionCount,
                COALESCE(SUM(CASE WHEN q.answer_choice IS NOT NULL
                                    OR (q.scoring_mode <> 'simple' AND q.score IS NOT NULL)
                                  THEN 1 ELSE 0 END), 0) AS answeredCount
         FROM cycle cy
         LEFT JOIN category c ON c.cycle_id = cy.id AND c.deleted_at IS NULL
         LEFT JOIN question q ON q.category_id = c.id AND q.deleted_at IS NULL
         GROUP BY cy.id
         ORDER BY cy.year DESC NULLS LAST, cy.id DESC`,
      )
      .all() as Record<string, unknown>[];
    res.json({
      user: req.user,
      settings: getSettings(db),
      activeCycle,
      cycle: scopeCycle, // 이번 응답의 분야 카드가 속한 주기 (?cycle= 미지정이면 activeCycle과 동일)
      cycles,
      categories,
    });
  });

  // ---------- GET /api/categories/:id/questions ----------
  router.get('/categories/:id/questions', auth, (req, res) => {
    const categoryId = Number(req.params.id);
    if (!Number.isInteger(categoryId)) {
      res.status(400).json({ error: 'validation', details: '분야 ID가 올바르지 않습니다.' });
      return;
    }
    const category = db
      .prepare('SELECT id, code, name, cycle_id FROM category WHERE id = ? AND deleted_at IS NULL')
      .get(categoryId) as (CategoryRow & { cycle_id: number }) | undefined;
    if (!category) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const rows = db
      .prepare(
        `SELECT q.id, q.question_no, q.body, q.max_score, q.allow_na, q.answer_choice, q.score,
                q.scoring_mode, q.score_autofilled,
                q.chapter_major, q.chapter_minor,
                CASE WHEN q.scoring_mode = 'auto' AND (
                    NOT EXISTS (SELECT 1 FROM auto_rule ar
                                WHERE ar.question_id = q.id AND ar.source_metric_key IS NOT NULL)
                    OR NOT EXISTS (
                      SELECT 1 FROM auto_rule ar2
                        JOIN org_metric om ON om.metric_key = ar2.source_metric_key
                          AND om.cycle_id = ? AND om.deleted_at IS NULL AND om.value IS NOT NULL
                      WHERE ar2.question_id = q.id)
                  ) THEN 1 ELSE 0 END AS metric_missing,
                q.question_type, q.grade_symbol,
                q.reviewed, q.revision_status, q.needs_recheck, q.auto_candidate, q.findings_text, q.updated_at,
                CASE WHEN (q.answer_plain IS NOT NULL AND TRIM(q.answer_plain) <> '')
                       OR q.answer_json IS NOT NULL THEN 1 ELSE 0 END AS has_answer,
                (SELECT COUNT(*) FROM question_passage qp
                   JOIN passage p ON p.id = qp.passage_id AND p.deleted_at IS NULL
                 WHERE qp.question_id = q.id) AS evidence_passages,
                (SELECT COUNT(*) FROM question_richdoc qr
                   JOIN rich_doc r ON r.id = qr.rich_doc_id AND r.deleted_at IS NULL
                 WHERE qr.question_id = q.id) AS evidence_richdocs,
                (SELECT COUNT(*) FROM question_attachment qa
                 WHERE qa.question_id = q.id AND qa.deleted_at IS NULL) AS attachment_count,
                (SELECT COUNT(*) FROM question_link ql
                 WHERE ql.question_id = q.id AND ql.deleted_at IS NULL) AS link_count,
                u.display_name AS updated_by_name
         FROM question q
         LEFT JOIN user u ON u.id = q.updated_by
         WHERE q.category_id = ? AND q.deleted_at IS NULL
         ORDER BY q.sort_key, q.question_no`,
      )
      .all(category.cycle_id, categoryId) as Record<string, unknown>[];
    // 분야가 속한 주기 — 목록 헤더 '개정(연도)' 표기용 (연도 하드코딩 금지)
    const cycle =
      (db.prepare('SELECT id, name FROM cycle WHERE id = ?').get(category.cycle_id) as
        | { id: number; name: string }
        | undefined) ?? null;
    res.json({
      category,
      cycle,
      questions: rows.map((r) => ({
        id: r.id,
        questionNo: r.question_no,
        body: r.body,
        maxScore: r.max_score,
        allowNa: r.allow_na === 1,
        answerChoice: r.answer_choice,
        score: r.score,
        scoringMode: r.scoring_mode,
        scoreAutofilled: r.score_autofilled === 1,
        chapterMajor: r.chapter_major,
        chapterMinor: r.chapter_minor,
        metricMissing: r.metric_missing === 1,
        questionType: r.question_type,
        gradeSymbol: r.grade_symbol,
        reviewed: r.reviewed === 1,
        revisionStatus: r.revision_status,
        needsRecheck: r.needs_recheck === 1,
        autoCandidate: r.auto_candidate === 1,
        hasAnswer: r.has_answer === 1,
        evidencePassages: r.evidence_passages,
        evidenceRichdocs: r.evidence_richdocs,
        attachmentCount: r.attachment_count,
        linkCount: r.link_count,
        findingsText: r.findings_text,
        updatedAt: r.updated_at,
        updatedByName: r.updated_by_name,
      })),
    });
  });

  // ---------- GET /api/questions/:id ----------
  router.get('/questions/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    const payload = fullQuestionPayload(db, id);
    if (!payload) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(payload);
  });

  // ---------- GET /api/questions/:id/evidence-suggest — 근거 추천 (v1.5 Phase 5 C-1) ----------
  // 문항의 주제/본문에서 키워드를 추출해 현재판본 지침서 페이지를 FTS(trigram)로 검색,
  // 여러 키워드에 동시에 걸리는 페이지를 상위로 추천한다. 연결은 사람이 뷰어에서 직접
  // 수행한다(자동 매핑 아님 — 조용한 자동화 금지 원칙).
  router.get('/questions/:id/evidence-suggest', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    const q = db
      .prepare(`SELECT topic, body FROM question WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as { topic: string | null; body: string } | undefined;
    if (!q) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const keywords = extractKeywords(q.topic ?? q.body);
    if (keywords.length === 0) {
      res.json({ keywords: [], hits: [] });
      return;
    }
    interface SuggestRow {
      documentId: number;
      versionId: number;
      docTitle: string;
      pageNo: number;
      snippet: string;
      rank: number;
    }
    const stmt = db.prepare(
      `SELECT d.id AS documentId, pt.document_version_id AS versionId, d.title AS docTitle,
              pt.page_no AS pageNo, snippet(fts, 2, '', '', '…', 16) AS snippet, rank
       FROM fts
       JOIN page_text pt ON pt.rowid = fts.ref_id
       JOIN document_version dv ON dv.id = pt.document_version_id AND dv.is_current = 1
       JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
       WHERE fts.kind = 'page_text' AND fts MATCH ?
       ORDER BY rank
       LIMIT 30`,
    );
    // 키워드별 구문 검색 → (versionId,pageNo) 단위로 매치 키워드 수 집계
    const byPage = new Map<string, SuggestRow & { matched: number }>();
    for (const kw of keywords) {
      // content 컬럼 한정 — 비한정 MATCH는 색인된 kind 컬럼('page_text')과도 trigram 매치해
      // 'PAGE'·'age' 류 키워드가 전체 페이지를 가짜 히트시킨다 (리뷰 확정 결함, 실측 재현)
      const match = 'content:"' + kw.replaceAll('"', '""') + '"';
      let rows: SuggestRow[];
      try {
        rows = stmt.all(match) as SuggestRow[];
      } catch {
        continue; // FTS 질의 오류(특수문자 등)는 그 키워드만 건너뜀
      }
      for (const r of rows) {
        const key = `${r.versionId}:${r.pageNo}`;
        const prev = byPage.get(key);
        if (prev) {
          prev.matched += 1;
          prev.rank = Math.min(prev.rank, r.rank);
        } else {
          byPage.set(key, { ...r, snippet: (r.snippet ?? '').replace(/\n/g, ' '), matched: 1 });
        }
      }
    }
    const hits = [...byPage.values()]
      .sort((a, b) => b.matched - a.matched || a.rank - b.rank)
      .slice(0, 8)
      .map((h) => ({
        documentId: h.documentId,
        versionId: h.versionId,
        docTitle: h.docTitle,
        pageNo: h.pageNo,
        snippet: h.snippet,
        matched: h.matched,
      }));
    res.json({ keywords, hits });
  });

  // ---------- GET /api/questions/:id/evidence ----------
  router.get('/questions/:id/evidence', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    const exists = db
      .prepare('SELECT id FROM question WHERE id = ? AND deleted_at IS NULL')
      .get(id);
    if (!exists) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ items: getEvidenceItems(db, id) });
  });

  // ---------- PATCH /api/questions/:id/evidence ----------
  router.patch('/questions/:id/evidence', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = evidencePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const items = parsed.data.items.map((it) => ({
      type: it.type,
      passageId: it.passageId,
      richDocId: it.richDocId,
      sort: it.sort,
      note: it.note,
      noteProvided: 'note' in it, // zod는 미전송 optional 키를 결과에 넣지 않음 — 미전송이면 기존 값 유지
    }));
    const outcome = updateEvidence(db, id, items, req.user!.id);
    switch (outcome.kind) {
      case 'question_not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'invalid':
        res.status(400).json({ error: 'validation', details: outcome.message });
        return;
      case 'ok':
        res.json({ items: outcome.items });
        return;
    }
  });

  // ---------- PATCH /api/questions/:id ----------
  router.patch('/questions/:id', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const userId = req.user!.id;

    type Outcome =
      | { kind: 'not_found' }
      | { kind: 'conflict'; server: Record<string, unknown> }
      | { kind: 'invalid'; message: string }
      | { kind: 'ok'; payload: Record<string, unknown> };

    const run = db.transaction((): Outcome => {
      const row = db
        .prepare('SELECT * FROM question WHERE id = ? AND deleted_at IS NULL')
        .get(id) as QuestionRow | undefined;
      if (!row) return { kind: 'not_found' };

      // 낙관적 잠금: 불일치 → 지는 쪽(클라이언트) 페이로드도 change_log에 보존 (조용한 유실 금지)
      if (body.rowVersion !== row.row_version) {
        logChange(db, {
          actorId: userId,
          entity: 'question',
          entityId: id,
          action: 'conflict_lost',
          before: { rowVersion: row.row_version, note: '서버 최신본 유지' },
          after: { submitted: req.body as unknown, note: '409로 거부된 클라이언트 제출본' },
        });
        return { kind: 'conflict', server: fullQuestionPayload(db, id)! };
      }

      // 합산/자동 모드의 점수·선택은 서버 파생값 — 이 경로로는 쓸 수 없다 (A-4. 세부항목/자동계산/override 전용)
      if (
        row.scoring_mode !== 'simple' &&
        ('answerChoice' in body || 'score' in body || 'scoreAutofilled' in body)
      ) {
        return {
          kind: 'invalid',
          message:
            '합산/자동 채점 문항의 점수는 세부항목 입력 또는 자동 계산으로만 변경할 수 있습니다.',
        };
      }

      // 변경 병합 (미전송 필드는 기존 값 유지)
      const next = {
        answerChoice: 'answerChoice' in body ? (body.answerChoice ?? null) : row.answer_choice,
        score: 'score' in body ? (body.score ?? null) : row.score,
        scoreAutofilled:
          'scoreAutofilled' in body ? (body.scoreAutofilled ? 1 : 0) : row.score_autofilled,
        findingsText: 'findingsText' in body ? (body.findingsText ?? null) : row.findings_text,
        answerJson: 'answerJson' in body ? normalizeAnswerJson(body.answerJson) : row.answer_json,
        answerPlain: 'answerPlain' in body ? (body.answerPlain ?? null) : row.answer_plain,
        reviewed: 'reviewed' in body ? (body.reviewed ? 1 : 0) : row.reviewed,
      };

      // 서버 채점 검증 (§2 무결성 — simple 모드 전용. 합산/자동의 score 는 서버 파생값이라
      // 이 정규화(선택 없음→NULL 강제 등)를 태우면 지적사항만 저장해도 총점이 지워진다)
      if (row.scoring_mode === 'simple') {
        const scoring = validateScoring({
          answerChoice: next.answerChoice,
          score: next.score,
          maxScore: row.max_score,
          allowNa: row.allow_na === 1,
        });
        if (!scoring.ok) return { kind: 'invalid', message: scoring.message };
        next.score = scoring.score;
        // 자동 채움 비트는 '예'에서만 유의미 — 아니오/해당없음/미선택으로 바뀌면 소거
        if (next.answerChoice !== 'yes') next.scoreAutofilled = 0;
      }

      const before = {
        answerChoice: row.answer_choice,
        score: row.score,
        scoreAutofilled: row.score_autofilled,
        findingsText: row.findings_text,
        answerJson: row.answer_json,
        answerPlain: row.answer_plain,
        reviewed: row.reviewed,
        rowVersion: row.row_version,
      };
      const after = { ...next, rowVersion: row.row_version + 1 };

      const changed =
        before.answerChoice !== next.answerChoice ||
        before.score !== next.score ||
        before.scoreAutofilled !== next.scoreAutofilled ||
        before.findingsText !== next.findingsText ||
        before.answerJson !== next.answerJson ||
        before.answerPlain !== next.answerPlain ||
        before.reviewed !== next.reviewed;
      if (!changed) {
        // 실변경 없음 — 버전 증가·로그 없이 현재본 반환 (멱등)
        return { kind: 'ok', payload: fullQuestionPayload(db, id)! };
      }

      db.prepare(
        `UPDATE question
         SET answer_choice = ?, score = ?, score_autofilled = ?, findings_text = ?,
             answer_json = ?, answer_plain = ?,
             reviewed = ?, row_version = row_version + 1, updated_at = ?, updated_by = ?
         WHERE id = ?`,
      ).run(
        next.answerChoice,
        next.score,
        next.scoreAutofilled,
        next.findingsText,
        next.answerJson,
        next.answerPlain,
        next.reviewed,
        new Date().toISOString(),
        userId,
        id,
      );

      logChange(db, {
        actorId: userId,
        entity: 'question',
        entityId: id,
        action: 'update',
        before,
        after,
      });

      return { kind: 'ok', payload: fullQuestionPayload(db, id)! };
    });

    const outcome = run();
    switch (outcome.kind) {
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'conflict':
        res.status(409).json({ error: 'conflict', server: outcome.server });
        return;
      case 'invalid':
        res.status(400).json({ error: 'validation', details: outcome.message });
        return;
      case 'ok':
        res.json(outcome.payload);
        return;
    }
  });

  return router;
}
