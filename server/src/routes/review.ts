/**
 * 검수 큐 라우트 (v1.5 Phase 1·3a·3b — 설계서 §4 #15 통합 검수 큐)
 * - GET /api/review/summary → 확인 필요 항목 전역 집계:
 *     · 문서별 needs_review/unresolved 앵커 건수 (Phase 1 — 재앵커)
 *     · 자동배점 stale 문항 — "현재점→새점" diff (Phase 3a)
 *     · needs_recheck 문항 — 개정/재인입/배점·유형 편차 (Phase 3b — 재인입 축)
 *   상단 네비 미처리 배지 = 세 축의 합. viewer 열람 가능. 유형 필터는 웹이 담당.
 * - POST /api/questions/:id/recheck-resolve → 재확인 해소 (editor, change_log —
 *   전용 엔드포인트: 일반 PATCH 는 simple 채점 검증을 태워 재확인 대상(배점 초과 등)이 400에 막힘)
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { logChange } from '../db/change-log.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { getActiveCycle } from './questions.js';

interface ReviewDocRow {
  document_id: number;
  code: string | null;
  title: string;
  version_id: number;
  version_label: string;
  needs_review: number;
}

interface StaleRow {
  question_id: number;
  question_no: string;
  category_id: number;
  current_score: number | null;
  source_metric_key: string | null;
  metric_value: string | null;
  metric_label: string | null;
  rule_id: number;
}

export function createReviewRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  router.get('/review/summary', auth, (_req, res) => {
    const docs = db
      .prepare(
        `SELECT d.id AS document_id, d.code, d.title,
                dv.id AS version_id, dv.version_label,
                COUNT(pa.id) AS needs_review
         FROM document d
         JOIN document_version dv ON dv.document_id = d.id AND dv.is_current = 1
         JOIN passage_anchor pa ON pa.document_version_id = dv.id
                                AND pa.status IN ('needs_review','unresolved')
         JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL
         WHERE d.deleted_at IS NULL
         GROUP BY d.id
         ORDER BY needs_review DESC, d.title`,
      )
      .all() as ReviewDocRow[];
    const anchorTotal = docs.reduce((sum, r) => sum + r.needs_review, 0);

    // 자동배점 stale — 현재 규칙·현재 지표값으로 '새 점수'를 미리 계산해 diff 로 제시 (확정은 compute 엔드포인트)
    const cycle = getActiveCycle(db);
    const staleRows = cycle
      ? (db
          .prepare(
            `SELECT q.id AS question_id, q.question_no, q.category_id, q.score AS current_score,
                    ar.id AS rule_id, ar.source_metric_key,
                    om.value AS metric_value, om.label AS metric_label
             FROM auto_score_state s
             JOIN question q ON q.id = s.question_id AND q.deleted_at IS NULL
             LEFT JOIN auto_rule ar ON ar.question_id = q.id
             LEFT JOIN org_metric om ON om.cycle_id = ? AND om.metric_key = ar.source_metric_key
                                     AND om.deleted_at IS NULL
             WHERE s.stale = 1 AND q.scoring_mode = 'auto'
             ORDER BY q.question_no`,
          )
          .all(cycle.id) as StaleRow[])
      : [];
    const bandStmt = db.prepare(
      'SELECT lower, upper, score FROM auto_rule_band WHERE auto_rule_id = ? ORDER BY sort, id',
    );
    const autoStale = staleRows.map((r) => {
      let newScore: number | null = null;
      if (r.source_metric_key != null && r.metric_value != null) {
        const v = Number(r.metric_value);
        if (Number.isFinite(v)) {
          const bands = bandStmt.all(r.rule_id) as {
            lower: number | null;
            upper: number | null;
            score: number;
          }[];
          for (const b of bands) {
            if ((b.lower === null || v >= b.lower) && (b.upper === null || v < b.upper)) {
              newScore = b.score;
              break;
            }
          }
        }
      }
      return {
        questionId: r.question_id,
        questionNo: r.question_no,
        categoryId: r.category_id,
        currentScore: r.current_score,
        newScore, // null = 입력값 없음(계산 불가) — 0점·만점 아님
        metricKey: r.source_metric_key,
        metricLabel: r.metric_label,
        metricValue: r.metric_value,
      };
    });

    // 재확인(needs_recheck) 문항 — 개정·재인입·배점/유형 편차 (Phase 3b)
    const recheck = cycle
      ? (db
          .prepare(
            `SELECT q.id AS question_id, q.question_no, q.category_id,
                    c.code AS category_code, q.revision_note, q.score, q.max_score
             FROM question q
             JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
             WHERE q.needs_recheck = 1 AND q.deleted_at IS NULL AND c.cycle_id = ?
             ORDER BY c.sort, c.code, q.question_no`,
          )
          .all(cycle.id) as Array<{
          question_id: number;
          question_no: string;
          category_id: number;
          category_code: string;
          revision_note: string | null;
          score: number | null;
          max_score: number | null;
        }>)
      : [];

    res.json({
      total: anchorTotal + autoStale.length + recheck.length,
      docs: docs.map((r) => ({
        documentId: r.document_id,
        code: r.code,
        title: r.title,
        versionId: r.version_id,
        versionLabel: r.version_label,
        needsReview: r.needs_review,
      })),
      autoStale,
      recheck: recheck.map((r) => ({
        questionId: r.question_id,
        questionNo: r.question_no,
        categoryId: r.category_id,
        categoryCode: r.category_code,
        revisionNote: r.revision_note,
        score: r.score,
        maxScore: r.max_score,
      })),
    });
  });

  // ---------- POST /api/questions/:id/recheck-resolve ----------
  // 재확인 해소는 명시적 사용자 액션만 (인입 경로는 켜기만 하고 절대 끄지 않음 — 조용한 자동화 금지)
  router.post('/questions/:id/recheck-resolve', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '문항 ID가 올바르지 않습니다.' });
      return;
    }
    const outcome = db.transaction((): 'not_found' | 'ok' => {
      const row = db
        .prepare(
          'SELECT id, needs_recheck, row_version FROM question WHERE id = ? AND deleted_at IS NULL',
        )
        .get(id) as { id: number; needs_recheck: number; row_version: number } | undefined;
      if (!row) return 'not_found';
      if (row.needs_recheck === 0) return 'ok'; // 멱등
      db.prepare(
        `UPDATE question SET needs_recheck = 0, row_version = row_version + 1,
                             updated_at = ?, updated_by = ? WHERE id = ?`,
      ).run(new Date().toISOString(), req.user!.id, id);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'question',
        entityId: id,
        action: 'recheck_resolve',
        before: { needsRecheck: 1, rowVersion: row.row_version },
        after: { needsRecheck: 0 },
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
