/**
 * 결과 요약 라우트 (v1.5 Phase 1 — 설계서 §4 #13)
 * - GET /api/summary → 활성 주기에서 분야별 "확인 대상" 문항 목록.
 *     감점(deducted):   아니오, 또는 예이면서 취득점 < 배점. (예 & score NULL 은 미채점 — 감점 아님.
 *                       해당없음은 분모 제외 의미론 그대로 대상 아님.)
 *     지적(hasFindings): findings_text 에 내용이 있음.
 *     자동채움 미확인(autofilled): 예→만점 자동 채움 후 사용자가 아직 확인하지 않음 (Phase 2 — A-7).
 *   viewer 열람 가능 (읽기 전용 집계).
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveCycleParam } from './questions.js';

interface SummaryRow {
  id: number;
  category_id: number;
  category_code: string;
  category_name: string;
  category_sort: number;
  question_no: string;
  sort_key: number;
  body: string;
  max_score: number | null;
  answer_choice: 'yes' | 'no' | 'na' | null;
  score: number | null;
  findings_text: string | null;
  question_type: 'core' | 'required' | 'basic' | null;
  grade_symbol: string | null;
  deducted: number;
  has_findings: number;
  score_autofilled: number;
}

export function createSummaryRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);

  // ?cycle=<id> 로 다른 연도(주기) 요약 조회 가능. 미지정이면 현재 주기.
  router.get('/summary', auth, (req, res) => {
    const resolved = resolveCycleParam(db, req.query.cycle);
    if (!resolved.ok) {
      res.status(400).json({ error: '잘못된 주기입니다.' });
      return;
    }
    const activeCycle = resolved.cycle;
    const rows = activeCycle
      ? (db
          .prepare(
            `SELECT q.id, q.question_no, q.sort_key, q.body, q.max_score, q.answer_choice, q.score,
                    q.findings_text, q.question_type, q.grade_symbol,
                    c.id AS category_id, c.code AS category_code, c.name AS category_name,
                    c.sort AS category_sort,
                    CASE WHEN q.answer_choice = 'no'
                           OR (q.answer_choice = 'yes' AND q.score IS NOT NULL
                               AND q.score < COALESCE(q.max_score, 0))
                           OR (q.scoring_mode = 'auto' AND q.score IS NOT NULL
                               AND q.score < COALESCE(q.max_score, 0))
                           -- composite: 리프 전부 채점된 경우만 감점 (부분 채점 = 진행 중 ≠ 감점)
                           OR (q.scoring_mode = 'composite' AND q.score IS NOT NULL
                               AND q.score < COALESCE(q.max_score, 0)
                               AND NOT EXISTS (
                                 SELECT 1 FROM question_criterion qc
                                 WHERE qc.question_id = q.id AND qc.deleted_at IS NULL
                                   AND qc.score IS NULL
                                   AND NOT EXISTS (
                                     SELECT 1 FROM question_criterion ch
                                     WHERE ch.parent_id = qc.id AND ch.deleted_at IS NULL)))
                         THEN 1 ELSE 0 END AS deducted,
                    CASE WHEN q.findings_text IS NOT NULL
                           AND TRIM(q.findings_text, ' ' || char(9) || char(10) || char(13)) <> ''
                         THEN 1 ELSE 0 END AS has_findings,
                    q.score_autofilled
             FROM question q
             JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
             WHERE c.cycle_id = ? AND q.deleted_at IS NULL
               AND (q.answer_choice = 'no'
                    OR (q.answer_choice = 'yes' AND q.score IS NOT NULL
                        AND q.score < COALESCE(q.max_score, 0))
                    OR (q.scoring_mode = 'auto' AND q.score IS NOT NULL
                        AND q.score < COALESCE(q.max_score, 0))
                    OR (q.scoring_mode = 'composite' AND q.score IS NOT NULL
                        AND q.score < COALESCE(q.max_score, 0)
                        AND NOT EXISTS (
                          SELECT 1 FROM question_criterion qc
                          WHERE qc.question_id = q.id AND qc.deleted_at IS NULL
                            AND qc.score IS NULL
                            AND NOT EXISTS (
                              SELECT 1 FROM question_criterion ch
                              WHERE ch.parent_id = qc.id AND ch.deleted_at IS NULL)))
                    OR (q.findings_text IS NOT NULL
                        AND TRIM(q.findings_text, ' ' || char(9) || char(10) || char(13)) <> '')
                    OR q.score_autofilled = 1)
             ORDER BY c.sort, c.code, q.sort_key, q.question_no`,
          )
          .all(activeCycle.id) as SummaryRow[])
      : [];

    // 분야별 그룹핑 (SQL 정렬 순서 유지)
    const categories: {
      id: number;
      code: string;
      name: string;
      items: Record<string, unknown>[];
    }[] = [];
    let deductedCount = 0;
    let findingsCount = 0;
    let autofilledCount = 0;
    for (const r of rows) {
      let cat = categories[categories.length - 1];
      if (!cat || cat.id !== r.category_id) {
        cat = { id: r.category_id, code: r.category_code, name: r.category_name, items: [] };
        categories.push(cat);
      }
      if (r.deducted === 1) deductedCount += 1;
      if (r.has_findings === 1) findingsCount += 1;
      if (r.score_autofilled === 1) autofilledCount += 1;
      cat.items.push({
        id: r.id,
        questionNo: r.question_no,
        body: r.body,
        maxScore: r.max_score,
        answerChoice: r.answer_choice,
        score: r.score,
        findingsText: r.findings_text,
        questionType: r.question_type,
        gradeSymbol: r.grade_symbol,
        deducted: r.deducted === 1,
        hasFindings: r.has_findings === 1,
        autofilled: r.score_autofilled === 1,
      });
    }

    res.json({
      activeCycle,
      totals: {
        total: rows.length,
        deducted: deductedCount,
        findings: findingsCount,
        autofilled: autofilledCount,
      },
      categories,
    });
  });

  return router;
}
