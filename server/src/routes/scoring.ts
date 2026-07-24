/**
 * 통합 채점 라우트 (v1.5 Phase 3a — 설계서 §2 채점 정합(composite/auto)·§4 채점 위젯)
 * - GET    /api/questions/:id/scoring            → 모드·세부항목·자동배점 규칙/상태 (viewer 가능)
 * - PATCH  /api/questions/:id/scoring-mode       → simple/composite/auto 전환 (editor)
 * - POST   /api/questions/:id/criteria           → 세부항목 추가 (editor)
 * - PATCH  /api/questions/criteria/:cid          → 항목 배점/취득점/이름 수정 (editor)
 * - DELETE /api/questions/criteria/:cid          → soft delete (editor)
 * - PUT    /api/questions/:id/auto-rule          → 지표 바인딩 + 구간표 교체 (editor — 수동 바인딩만, A-3)
 * - POST   /api/questions/:id/auto-rule/compute  → 자동 계산 + 스냅샷 (editor — stale 검수 '원클릭 확정' 겸용)
 * - POST   /api/questions/:id/scoring-override   → 자동 점수 수기 override (editor, 사유 필수)
 *
 * 원칙 (A-3·A-4):
 * - 합산/자동 모드의 question.score 는 서버만 쓴다 (구체화된 유효 총점 — UI 는 읽기 전용 합계).
 * - 지표 미입력(org_metric.value IS NULL)은 '입력값 없음' — 0점/만점이 아니라 계산 불가.
 * - 지표·구간 변경 시 조용한 재계산 금지: auto_score_state.stale=1 → 검수 큐에서 명시적 확정.
 * - 계산 시 입력(지표값·구간표)을 auto_score_state 에 동결 보관 — "왜 이 점수인지" 즉답.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import { logChange } from '../db/change-log.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';

// ── 행 타입 ──────────────────────────────────────────────────────────────────

interface QuestionRow {
  id: number;
  question_no: string;
  max_score: number | null;
  scoring_mode: 'simple' | 'composite' | 'auto';
  score: number | null;
  answer_choice: 'yes' | 'no' | 'na' | null;
  score_overridden: number;
  row_version: number;
}

interface CriterionRow {
  id: number;
  question_id: number;
  parent_id: number | null;
  sort: number;
  label: string;
  max_score: number;
  score: number | null;
  deleted_at: string | null;
}

interface AutoRuleRow {
  id: number;
  question_id: number;
  source_metric_key: string | null;
}

interface BandRow {
  id: number;
  auto_rule_id: number;
  lower: number | null;
  upper: number | null;
  score: number;
  sort: number;
}

interface StateRow {
  question_id: number;
  metric_snapshot_json: string | null;
  band_snapshot_json: string | null;
  computed_score: number | null;
  stale: number;
  computed_at: string | null;
}

interface MetricRow {
  metric_key: string;
  label: string;
  value: string | null;
  unit: string | null;
  value_type: 'number' | 'integer' | 'text';
}

// ── 검증 스키마 ──────────────────────────────────────────────────────────────

const modeSchema = z.object({ mode: z.enum(['simple', 'composite', 'auto']) });

const criterionCreateSchema = z.object({
  label: z.string().trim().min(1).max(300),
  maxScore: z.number().positive().refine(isHalfStep, '배점은 0.5 간격이어야 합니다.'),
  parentId: z.number().int().positive().nullable().optional(),
});

const criterionPatchSchema = z.object({
  label: z.string().trim().min(1).max(300).optional(),
  maxScore: z.number().positive().refine(isHalfStep, '배점은 0.5 간격이어야 합니다.').optional(),
  score: z.number().nullable().optional(),
});

const bandSchema = z.object({
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  score: z.number().min(0),
});

const autoRuleSchema = z.object({
  sourceMetricKey: z.string().trim().min(1).max(100).nullable(),
  bands: z.array(bandSchema).min(1).max(50),
});

const overrideSchema = z.object({
  score: z.number().min(0),
  reason: z.string().trim().min(1).max(1000),
});

/** 0.5 간격 검증 (simple 채점과 동일 규약 — §2) */
function isHalfStep(v: number): boolean {
  return Number.isInteger(v * 2);
}

/**
 * 구간표 검증 — 겹침·구멍 없이 전 구간(−∞..+∞)을 덮어야 한다 (A-3, 서버 강제).
 * 정렬: lower NULL(−∞) 먼저, 이후 lower 오름차순. 연속성: bands[i].upper === bands[i+1].lower.
 */
function validateBands(bands: { lower: number | null; upper: number | null; score: number }[]):
  | { ok: true; sorted: typeof bands }
  | { ok: false; reason: string } {
  const sorted = [...bands].sort((a, b) => {
    if (a.lower === null) return -1;
    if (b.lower === null) return 1;
    return a.lower - b.lower;
  });
  if (sorted[0]!.lower !== null) return { ok: false, reason: '첫 구간의 하한은 비어 있어야 합니다(−∞).' };
  if (sorted[sorted.length - 1]!.upper !== null)
    return { ok: false, reason: '마지막 구간의 상한은 비어 있어야 합니다(+∞).' };
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (b.lower !== null && b.upper !== null && b.lower >= b.upper)
      return { ok: false, reason: '구간의 하한은 상한보다 작아야 합니다.' };
    if (i < sorted.length - 1) {
      const next = sorted[i + 1]!;
      if (b.upper === null) return { ok: false, reason: '중간 구간의 상한이 비어 있습니다(구멍/겹침).' };
      if (next.lower === null || b.upper !== next.lower)
        return { ok: false, reason: '구간이 연속이어야 합니다(겹침·구멍 금지): 상한 = 다음 구간 하한.' };
    }
  }
  return { ok: true, sorted };
}

/** [lower, upper) 반개구간에서 값이 속한 구간의 점수 (전 구간 커버 전제 — 항상 존재) */
function bandScoreFor(bands: BandRow[] | { lower: number | null; upper: number | null; score: number }[], v: number): number | null {
  for (const b of bands) {
    const geLower = b.lower === null || v >= b.lower;
    const ltUpper = b.upper === null || v < b.upper;
    if (geLower && ltUpper) return b.score;
  }
  return null;
}

export function createScoringRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  const getQuestion = (id: number): QuestionRow | undefined =>
    db
      .prepare(
        `SELECT id, question_no, max_score, scoring_mode, score, answer_choice,
                score_overridden, row_version
         FROM question WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as QuestionRow | undefined;

  const getCriteria = (qid: number): CriterionRow[] =>
    db
      .prepare(
        `SELECT * FROM question_criterion
         WHERE question_id = ? AND deleted_at IS NULL ORDER BY sort, id`,
      )
      .all(qid) as CriterionRow[];

  /** 합산 대상 = 리프 항목(비삭제 자식이 없는 항목) — 2단 계층에서 이중 합산 방지 */
  const leafCriteria = (rows: CriterionRow[]): CriterionRow[] => {
    const parents = new Set(rows.filter((r) => r.parent_id != null).map((r) => r.parent_id));
    return rows.filter((r) => !parents.has(r.id));
  };

  /** 합산 총점: 리프 전부 미채점 → NULL, 일부라도 채점 → 채점분 합계(부분 진행 표시) */
  const compositeTotal = (rows: CriterionRow[]): { score: number | null; maxScore: number } => {
    const leaves = leafCriteria(rows);
    const scored = leaves.filter((l) => l.score != null);
    return {
      score: scored.length === 0 ? null : scored.reduce((s, l) => s + (l.score as number), 0),
      maxScore: leaves.reduce((s, l) => s + l.max_score, 0),
    };
  };

  /** question.score 서버 기록 (합산/자동 — 구체화된 유효 총점. A-4) */
  const writeQuestionScore = (
    q: QuestionRow,
    score: number | null,
    userId: number,
    via: string,
    extra?: Record<string, unknown>,
    force = false,
  ): void => {
    // 실변경 없으면 버전 증가·로그 생략 (override 사유 기록·override 해제는 강제 기록)
    if (!force && q.score === score && via !== 'override') return;
    db.prepare(
      `UPDATE question
       SET score = ?, score_autofilled = 0, row_version = row_version + 1,
           updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(score, new Date().toISOString(), userId, q.id);
    logChange(db, {
      actorId: userId,
      entity: 'question',
      entityId: q.id,
      action: 'update',
      before: { score: q.score, rowVersion: q.row_version },
      after: { score, via, rowVersion: q.row_version + 1, ...extra },
    });
  };

  const getRule = (qid: number): { rule: AutoRuleRow; bands: BandRow[] } | null => {
    const rule = db
      .prepare('SELECT id, question_id, source_metric_key FROM auto_rule WHERE question_id = ?')
      .get(qid) as AutoRuleRow | undefined;
    if (!rule) return null;
    const bands = db
      .prepare('SELECT * FROM auto_rule_band WHERE auto_rule_id = ? ORDER BY sort, id')
      .all(rule.id) as BandRow[];
    return { rule, bands };
  };

  const getState = (qid: number): StateRow | undefined =>
    db.prepare('SELECT * FROM auto_score_state WHERE question_id = ?').get(qid) as
      | StateRow
      | undefined;

  // 지표는 문항이 속한 주기에서 찾는다 — 2027 문항은 2027 지표를 본다 (활성 주기 아님)
  const getMetric = (key: string, questionId: number): MetricRow | undefined => {
    const scope = db
      .prepare(
        `SELECT c.cycle_id AS cycleId FROM question q
         JOIN category c ON c.id = q.category_id WHERE q.id = ?`,
      )
      .get(questionId) as { cycleId: number } | undefined;
    if (!scope) return undefined;
    return db
      .prepare(
        `SELECT metric_key, label, value, unit, value_type FROM org_metric
         WHERE cycle_id = ? AND metric_key = ? AND deleted_at IS NULL`,
      )
      .get(scope.cycleId, key) as MetricRow | undefined;
  };

  /** GET/변경 응답 공용 페이로드 */
  const scoringPayload = (qid: number): Record<string, unknown> | null => {
    const q = getQuestion(qid);
    if (!q) return null;
    const criteria = getCriteria(qid);
    const totals = compositeTotal(criteria);
    const ruleInfo = getRule(qid);
    const state = getState(qid);
    const metric =
      ruleInfo?.rule.source_metric_key != null
        ? getMetric(ruleInfo.rule.source_metric_key, qid)
        : undefined;
    return {
      questionId: q.id,
      mode: q.scoring_mode,
      score: q.score,
      maxScore: q.max_score,
      scoreOverridden: q.score_overridden === 1,
      rowVersion: q.row_version,
      criteria: criteria.map((c) => ({
        id: c.id,
        parentId: c.parent_id,
        sort: c.sort,
        label: c.label,
        maxScore: c.max_score,
        score: c.score,
      })),
      criteriaTotal: totals,
      autoRule: ruleInfo
        ? {
            sourceMetricKey: ruleInfo.rule.source_metric_key,
            bands: ruleInfo.bands.map((b) => ({ lower: b.lower, upper: b.upper, score: b.score })),
            metric: metric
              ? {
                  metricKey: metric.metric_key,
                  label: metric.label,
                  value: metric.value,
                  unit: metric.unit,
                  valueType: metric.value_type,
                }
              : null,
            state: state
              ? {
                  computedScore: state.computed_score,
                  stale: state.stale === 1,
                  computedAt: state.computed_at,
                }
              : null,
          }
        : null,
    };
  };

  const parseQid = (raw: string | undefined, res: import('express').Response): number | null => {
    const id = Number(raw);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return null;
    }
    return id;
  };

  // ---------- GET /api/questions/:id/scoring ----------
  router.get('/questions/:id/scoring', auth, (req, res) => {
    const id = parseQid(req.params.id, res);
    if (id == null) return;
    const payload = scoringPayload(id);
    if (!payload) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(payload);
  });

  // ---------- PATCH /api/questions/:id/scoring-mode ----------
  router.patch('/questions/:id/scoring-mode', editor, (req, res) => {
    const id = parseQid(req.params.id, res);
    if (id == null) return;
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const outcome = db.transaction((): 'not_found' | 'ok' => {
      const q = getQuestion(id);
      if (!q) return 'not_found';
      const mode = parsed.data.mode;
      if (mode === q.scoring_mode) return 'ok'; // 멱등
      // 예/아니오/해당없음 선택은 simple 전용 의미 — 모드 전환 시 초기화(집계 오염 방지, 이전 값은 change_log 보존)
      db.prepare(
        `UPDATE question SET scoring_mode = ?, score_overridden = 0, answer_choice = NULL,
                             score_autofilled = 0, row_version = row_version + 1,
                             updated_at = ?, updated_by = ? WHERE id = ?`,
      ).run(mode, new Date().toISOString(), req.user!.id, id);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question',
        entityId: id,
        action: 'scoring_mode',
        before: { scoringMode: q.scoring_mode, score: q.score, answerChoice: q.answer_choice },
        after: { scoringMode: mode },
      });
      const fresh = getQuestion(id)!;
      if (mode === 'composite') {
        // 총점 = 세부항목 합 (항목 없으면 미채점 NULL — 기존 점수는 change_log 에 보존)
        writeQuestionScore(fresh, compositeTotal(getCriteria(id)).score, req.user!.id, 'mode_switch');
      } else if (mode === 'auto') {
        const st = getState(id);
        writeQuestionScore(fresh, st?.computed_score ?? null, req.user!.id, 'mode_switch');
      } else {
        // simple 복귀: 선택이 초기화됐으므로 점수도 미채점으로 (§2 — 선택 없음 → score NULL)
        writeQuestionScore(fresh, null, req.user!.id, 'mode_switch');
      }
      return 'ok';
    })();
    if (outcome === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(scoringPayload(id));
  });

  // ---------- POST /api/questions/:id/criteria ----------
  router.post('/questions/:id/criteria', editor, (req, res) => {
    const id = parseQid(req.params.id, res);
    if (id == null) return;
    const parsed = criterionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const outcome = db.transaction((): 'not_found' | 'bad_parent' | 'ok' => {
      const q = getQuestion(id);
      if (!q) return 'not_found';
      if (body.parentId != null) {
        const parent = db
          .prepare(
            'SELECT id, parent_id FROM question_criterion WHERE id = ? AND question_id = ? AND deleted_at IS NULL',
          )
          .get(body.parentId, id) as { id: number; parent_id: number | null } | undefined;
        if (!parent) return 'bad_parent';
        // 2단 계층까지만 (§2) — 3단 트리는 삭제 캐스케이드가 고아 리프를 남긴다
        if (parent.parent_id != null) return 'bad_parent';
      }
      const sort =
        (db
          .prepare(
            'SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM question_criterion WHERE question_id = ? AND deleted_at IS NULL',
          )
          .get(id) as { s: number }).s;
      const info = db
        .prepare(
          `INSERT INTO question_criterion (question_id, parent_id, sort, label, max_score)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, body.parentId ?? null, sort, body.label, body.maxScore);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question_criterion',
        entityId: Number(info.lastInsertRowid),
        action: 'create',
        after: { questionId: id, label: body.label, maxScore: body.maxScore, parentId: body.parentId ?? null },
      });
      if (q.scoring_mode === 'composite')
        writeQuestionScore(getQuestion(id)!, compositeTotal(getCriteria(id)).score, req.user!.id, 'criterion');
      return 'ok';
    })();
    if (outcome === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (outcome === 'bad_parent') {
      res.status(400).json({ error: 'validation', details: '상위 항목이 올바르지 않습니다.' });
      return;
    }
    res.status(201).json(scoringPayload(id));
  });

  // ---------- PATCH /api/questions/criteria/:cid ----------
  router.patch('/questions/criteria/:cid', editor, (req, res) => {
    const cid = Number(req.params.cid);
    if (!Number.isInteger(cid)) {
      res.status(400).json({ error: 'validation', details: '항목 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = criterionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    type Outcome = { kind: 'not_found' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; qid: number };
    const outcome = db.transaction((): Outcome => {
      const row = db
        .prepare('SELECT * FROM question_criterion WHERE id = ? AND deleted_at IS NULL')
        .get(cid) as CriterionRow | undefined;
      if (!row) return { kind: 'not_found' };
      const q = getQuestion(row.question_id);
      if (!q) return { kind: 'not_found' };
      const nextLabel = body.label ?? row.label;
      const nextMax = body.maxScore ?? row.max_score;
      const nextScore = 'score' in body ? (body.score ?? null) : row.score;
      if (nextScore != null) {
        if (nextScore < 0 || nextScore > nextMax)
          return { kind: 'invalid', reason: `취득점은 0~${nextMax} 범위여야 합니다.` };
        if (!isHalfStep(nextScore)) return { kind: 'invalid', reason: '취득점은 0.5 간격이어야 합니다.' };
      }
      if (!isHalfStep(nextMax)) return { kind: 'invalid', reason: '배점은 0.5 간격이어야 합니다.' };
      if (nextLabel === row.label && nextMax === row.max_score && nextScore === row.score)
        return { kind: 'ok', qid: row.question_id }; // 멱등
      db.prepare(
        'UPDATE question_criterion SET label = ?, max_score = ?, score = ? WHERE id = ?',
      ).run(nextLabel, nextMax, nextScore, cid);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question_criterion',
        entityId: cid,
        action: 'update',
        before: { label: row.label, maxScore: row.max_score, score: row.score },
        after: { label: nextLabel, maxScore: nextMax, score: nextScore },
      });
      if (q.scoring_mode === 'composite')
        writeQuestionScore(
          getQuestion(q.id)!,
          compositeTotal(getCriteria(q.id)).score,
          req.user!.id,
          'criterion',
        );
      return { kind: 'ok', qid: row.question_id };
    })();
    if (outcome.kind === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (outcome.kind === 'invalid') {
      res.status(400).json({ error: 'validation', details: outcome.reason });
      return;
    }
    res.json(scoringPayload(outcome.qid));
  });

  // ---------- DELETE /api/questions/criteria/:cid ----------
  router.delete('/questions/criteria/:cid', editor, (req, res) => {
    const cid = Number(req.params.cid);
    if (!Number.isInteger(cid)) {
      res.status(400).json({ error: 'validation', details: '항목 ID가 올바르지 않습니다.' });
      return;
    }
    type Outcome = { kind: 'not_found' } | { kind: 'ok'; qid: number };
    const outcome = db.transaction((): Outcome => {
      const row = db
        .prepare('SELECT * FROM question_criterion WHERE id = ? AND deleted_at IS NULL')
        .get(cid) as CriterionRow | undefined;
      if (!row) return { kind: 'not_found' };
      const now = new Date().toISOString();
      // 하위 항목도 함께 soft delete (부모 없는 리프로 승격돼 이중 합산되는 것 방지)
      db.prepare(
        `UPDATE question_criterion SET deleted_at = ?
         WHERE deleted_at IS NULL AND (id = ? OR parent_id = ?)`,
      ).run(now, cid, cid);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question_criterion',
        entityId: cid,
        action: 'delete',
        before: row,
      });
      const q = getQuestion(row.question_id);
      if (q && q.scoring_mode === 'composite')
        writeQuestionScore(q, compositeTotal(getCriteria(q.id)).score, req.user!.id, 'criterion');
      return { kind: 'ok', qid: row.question_id };
    })();
    if (outcome.kind === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(scoringPayload(outcome.qid));
  });

  // ---------- PUT /api/questions/:id/auto-rule ----------
  router.put('/questions/:id/auto-rule', editor, (req, res) => {
    const id = parseQid(req.params.id, res);
    if (id == null) return;
    const parsed = autoRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const valid = validateBands(body.bands);
    if (!valid.ok) {
      res.status(400).json({ error: 'validation', details: valid.reason });
      return;
    }
    type Outcome = { kind: 'not_found' } | { kind: 'invalid'; reason: string } | { kind: 'ok' };
    const outcome = db.transaction((): Outcome => {
      const q = getQuestion(id);
      if (!q) return { kind: 'not_found' };
      if (body.sourceMetricKey != null) {
        const metric = getMetric(body.sourceMetricKey, id);
        if (!metric)
          return { kind: 'invalid', reason: '문항이 속한 주기에 해당 키의 기관 지표가 없습니다.' };
        if (metric.value_type === 'text')
          return { kind: 'invalid', reason: '텍스트형 지표는 자동배점에 바인딩할 수 없습니다.' };
      }
      if (q.max_score != null) {
        const over = valid.sorted.find((b) => b.score > q.max_score!);
        if (over) return { kind: 'invalid', reason: `구간 점수가 배점(${q.max_score})을 초과합니다.` };
      }
      const now = new Date().toISOString();
      const existing = getRule(id);
      let ruleId: number;
      if (existing) {
        db.prepare('UPDATE auto_rule SET source_metric_key = ?, updated_at = ? WHERE id = ?').run(
          body.sourceMetricKey,
          now,
          existing.rule.id,
        );
        db.prepare('DELETE FROM auto_rule_band WHERE auto_rule_id = ?').run(existing.rule.id);
        ruleId = existing.rule.id;
      } else {
        const info = db
          .prepare(
            'INSERT INTO auto_rule (question_id, source_metric_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
          )
          .run(id, body.sourceMetricKey, now, now);
        ruleId = Number(info.lastInsertRowid);
      }
      const insertBand = db.prepare(
        'INSERT INTO auto_rule_band (auto_rule_id, lower, upper, score, sort) VALUES (?, ?, ?, ?, ?)',
      );
      valid.sorted.forEach((b, i) => insertBand.run(ruleId, b.lower, b.upper, b.score, i + 1));
      logChange(db, {
        actorId: req.user!.id,
        entity: 'auto_rule',
        entityId: ruleId,
        action: existing ? 'update' : 'create',
        before: existing
          ? { sourceMetricKey: existing.rule.source_metric_key, bands: existing.bands }
          : undefined,
        after: { questionId: id, sourceMetricKey: body.sourceMetricKey, bands: valid.sorted },
      });
      // 규칙 변경 → 기존 계산 스냅샷은 재검토 대상 (조용한 재계산 금지 — A-3)
      db.prepare('UPDATE auto_score_state SET stale = 1 WHERE question_id = ?').run(id);
      return { kind: 'ok' };
    })();
    if (outcome.kind === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (outcome.kind === 'invalid') {
      res.status(400).json({ error: 'validation', details: outcome.reason });
      return;
    }
    res.json(scoringPayload(id));
  });

  // ---------- POST /api/questions/:id/auto-rule/compute ----------
  // 최초 계산·재계산·stale 검수의 '원클릭 확정' 공용 경로. 스냅샷을 동결 보관한다.
  router.post('/questions/:id/auto-rule/compute', editor, (req, res) => {
    const id = parseQid(req.params.id, res);
    if (id == null) return;
    type Outcome = { kind: 'not_found' } | { kind: 'invalid'; reason: string } | { kind: 'ok' };
    const outcome = db.transaction((): Outcome => {
      const q = getQuestion(id);
      if (!q) return { kind: 'not_found' };
      if (q.scoring_mode !== 'auto')
        return { kind: 'invalid', reason: '자동배점 모드 문항이 아닙니다.' };
      const ruleInfo = getRule(id);
      // 미바인딩(규칙 없음/키 해제)이어도 확정은 가능해야 한다 — 검수 큐의 stale 항목이
      // '입력값 없음'으로 원클릭 확정되지 못하고 영구 잔류하는 것 방지 (검토 반영)
      const bound = ruleInfo != null && ruleInfo.rule.source_metric_key != null;
      const metric = bound ? getMetric(ruleInfo.rule.source_metric_key as string, id) : undefined;
      const now = new Date().toISOString();

      let computed: number | null = null;
      if (bound && metric && metric.value != null) {
        if (ruleInfo.bands.length === 0)
          return { kind: 'invalid', reason: '구간표가 비어 있습니다.' };
        const v = Number(metric.value);
        if (!Number.isFinite(v))
          return { kind: 'invalid', reason: '지표 값이 숫자가 아닙니다.' };
        computed = bandScoreFor(ruleInfo.bands, v);
        if (computed == null)
          return { kind: 'invalid', reason: '구간표가 지표 값을 덮지 않습니다(재저장 필요).' };
      }
      // 미바인딩/지표 없음/값 없음 → computed=NULL = '입력값 없음' (0점·만점 아님 — A-3)

      const metricSnapshot = JSON.stringify({
        metricKey: bound ? ruleInfo.rule.source_metric_key : null,
        label: metric?.label ?? null,
        value: metric?.value ?? null,
        unit: metric?.unit ?? null,
        capturedAt: now,
      });
      const bandSnapshot = JSON.stringify(
        (ruleInfo?.bands ?? []).map((b) => ({ lower: b.lower, upper: b.upper, score: b.score })),
      );
      db.prepare(
        `INSERT INTO auto_score_state
           (question_id, metric_snapshot_json, band_snapshot_json, computed_score, stale, computed_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(question_id) DO UPDATE SET
           metric_snapshot_json = excluded.metric_snapshot_json,
           band_snapshot_json = excluded.band_snapshot_json,
           computed_score = excluded.computed_score,
           stale = 0,
           computed_at = excluded.computed_at`,
      ).run(id, metricSnapshot, bandSnapshot, computed, now);
      // 계산 확정 = override 해제. 해제 자체도 실변경이므로 점수가 같아도 기록(버전·로그) 남김
      const overrideCleared = q.score_overridden === 1;
      if (overrideCleared)
        db.prepare('UPDATE question SET score_overridden = 0 WHERE id = ?').run(id);
      writeQuestionScore(
        getQuestion(id)!,
        computed,
        req.user!.id,
        'auto_compute',
        { metricValue: metric?.value ?? null, ...(overrideCleared ? { overrideCleared: true } : {}) },
        overrideCleared,
      );
      return { kind: 'ok' };
    })();
    if (outcome.kind === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (outcome.kind === 'invalid') {
      res.status(400).json({ error: 'validation', details: outcome.reason });
      return;
    }
    res.json(scoringPayload(id));
  });

  // ---------- POST /api/questions/:id/scoring-override ----------
  // 자동 점수 수기 수정 — 명시적 override, 사유 필수 (A-4)
  router.post('/questions/:id/scoring-override', editor, (req, res) => {
    const id = parseQid(req.params.id, res);
    if (id == null) return;
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    type Outcome = { kind: 'not_found' } | { kind: 'invalid'; reason: string } | { kind: 'ok' };
    const outcome = db.transaction((): Outcome => {
      const q = getQuestion(id);
      if (!q) return { kind: 'not_found' };
      if (q.scoring_mode !== 'auto')
        return { kind: 'invalid', reason: '자동배점 모드 문항만 override 할 수 있습니다.' };
      if (q.max_score != null && body.score > q.max_score)
        return { kind: 'invalid', reason: `점수는 배점(${q.max_score}) 이하여야 합니다.` };
      if (!isHalfStep(body.score))
        return { kind: 'invalid', reason: '점수는 0.5 간격이어야 합니다.' };
      db.prepare('UPDATE question SET score_overridden = 1 WHERE id = ?').run(id);
      writeQuestionScore(getQuestion(id)!, body.score, req.user!.id, 'override', {
        reason: body.reason,
      });
      return { kind: 'ok' };
    })();
    if (outcome.kind === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (outcome.kind === 'invalid') {
      res.status(400).json({ error: 'validation', details: outcome.reason });
      return;
    }
    res.json(scoringPayload(id));
  });

  return router;
}
