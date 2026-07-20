/**
 * 심사 준비도 자동 진단 (v1.5 Phase 3a — C-2, 설계서 §4 #2 대시보드 확장)
 * - GET /api/readiness → 활성 주기 분야별 자동 집계 (읽기 전용):
 *     ① noEvidence      근거(발췌∪자유문서∪첨부파일∪링크) 0건 문항 — 근거 자료 카드에
 *                       보이는 네 종류 모두 없는 문항만 '근거 없음'
 *     ② autofilled      예→만점 자동 채움 후 미확인 문항
 *     ③ needsRecheck    개정·재인입·배점 변경 재확인 문항
 *     ④ metricMissing   자동배점인데 지표 미바인딩 또는 지표 값 미입력('입력값 없음')
 *   + 전역 reviewOpen(검수 큐 미처리 = 미해결 앵커 + 자동배점 stale).
 *   각 숫자 클릭 → 해당 문항만 필터된 목록(할일 큐) — 웹이 라우팅 담당.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getActiveCycle, resolveCycleParam } from './questions.js';

export interface ReadinessCategoryRow {
  id: number;
  code: string;
  name: string;
  questionCount: number;
  noEvidence: number;
  autofilled: number;
  needsRecheck: number;
  metricMissing: number;
}

/** 집계 본체 — 엑셀 '준비도 요약' 시트(export)와 공유. cycleId 미지정이면 현재 주기. */
export function computeReadiness(db: Database.Database, cycleId?: number): {
  categories: ReadinessCategoryRow[];
  totals: {
    noEvidence: number;
    autofilled: number;
    needsRecheck: number;
    metricMissing: number;
    anchorOpen: number;
    reviewOpen: number;
  };
} {
  const cycle = cycleId != null ? { id: cycleId } : getActiveCycle(db);
  const categories = cycle
    ? (db
        .prepare(
          `SELECT c.id, c.code, c.name,
                  COUNT(q.id) AS questionCount,
                  COALESCE(SUM(CASE WHEN q.id IS NOT NULL AND NOT EXISTS (
                      SELECT 1 FROM question_passage qp
                        JOIN passage p ON p.id = qp.passage_id AND p.deleted_at IS NULL
                      WHERE qp.question_id = q.id)
                    AND NOT EXISTS (
                      SELECT 1 FROM question_richdoc qr
                        JOIN rich_doc r ON r.id = qr.rich_doc_id AND r.deleted_at IS NULL
                      WHERE qr.question_id = q.id)
                    AND NOT EXISTS (
                      SELECT 1 FROM question_attachment qa
                      WHERE qa.question_id = q.id AND qa.deleted_at IS NULL)
                    AND NOT EXISTS (
                      SELECT 1 FROM question_link ql
                      WHERE ql.question_id = q.id AND ql.deleted_at IS NULL)
                    THEN 1 ELSE 0 END), 0) AS noEvidence,
                  COALESCE(SUM(q.score_autofilled), 0) AS autofilled,
                  COALESCE(SUM(q.needs_recheck), 0) AS needsRecheck,
                  COALESCE(SUM(CASE WHEN q.scoring_mode = 'auto' AND (
                      NOT EXISTS (SELECT 1 FROM auto_rule ar
                                  WHERE ar.question_id = q.id AND ar.source_metric_key IS NOT NULL)
                      OR NOT EXISTS (
                        SELECT 1 FROM auto_rule ar2
                          JOIN org_metric om ON om.metric_key = ar2.source_metric_key
                            AND om.cycle_id = ? AND om.deleted_at IS NULL AND om.value IS NOT NULL
                        WHERE ar2.question_id = q.id)
                    ) THEN 1 ELSE 0 END), 0) AS metricMissing
           FROM category c
           LEFT JOIN question q ON q.category_id = c.id AND q.deleted_at IS NULL
           WHERE c.cycle_id = ? AND c.deleted_at IS NULL
           GROUP BY c.id
           ORDER BY c.sort, c.code`,
        )
        .all(cycle.id, cycle.id) as ReadinessCategoryRow[])
    : [];

  // anchorOpen 은 의도적으로 전역(주기 무관)이다 — 지침서 문서와 근거(발췌) 연결은
  // 연도(주기)와 무관하게 공유되므로 주기 스코프로 좁히면 안 된다. '재수정' 금지.
  const anchorOpen = (db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM passage_anchor pa
       JOIN document_version dv ON dv.id = pa.document_version_id AND dv.is_current = 1
       JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
       JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL
       WHERE pa.status IN ('needs_review','unresolved')`,
    )
    .get() as { n: number }).n;
  // staleOpen 은 문항 단위 — totals의 나머지 수치와 동일하게 요청한 주기로 한정한다
  // (다른 연도 주기의 자동배점 문항이 이 주기 집계에 섞이면 안 된다).
  const staleOpen = cycle
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM auto_score_state s
           JOIN question q ON q.id = s.question_id AND q.deleted_at IS NULL
           JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL AND c.cycle_id = ?
           WHERE s.stale = 1 AND q.scoring_mode = 'auto'`,
        )
        .get(cycle.id) as { n: number }).n
    : 0;

  const sum = (k: keyof ReadinessCategoryRow): number =>
    categories.reduce((s, c) => s + Number(c[k] ?? 0), 0);
  // reviewOpen = 검수 큐 총계(/api/review/summary total)와 동일 정의: 앵커 + stale + 재확인 (3b)
  return {
    categories,
    totals: {
      noEvidence: sum('noEvidence'),
      autofilled: sum('autofilled'),
      needsRecheck: sum('needsRecheck'),
      metricMissing: sum('metricMissing'),
      anchorOpen, // 지침서 개정으로 재연결이 필요한 근거 수 — 대시보드 빨간 카드(§4 #2)
      reviewOpen: anchorOpen + staleOpen + sum('needsRecheck'),
    },
  };
}

export function createReadinessRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);

  // ?cycle=<id> 로 다른 연도(주기) 집계 조회 가능. 미지정이면 현재 주기.
  router.get('/readiness', auth, (req, res) => {
    const resolved = resolveCycleParam(db, req.query.cycle);
    if (!resolved.ok) {
      res.status(400).json({ error: '잘못된 주기입니다.' });
      return;
    }
    res.json(computeReadiness(db, resolved.cycle?.id));
  });

  return router;
}
