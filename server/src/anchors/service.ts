/**
 * 앵커/매핑 서비스 (설계서 §3.2 무대화상자 매핑 루프, §2 무결성)
 * - 하이라이트 생성 = 한 트랜잭션: passage + 현재판본 passage_anchor(status='resolved',
 *   method='manual') + question_passage(문항별 sort=기존 max+1) + FTS(kind='passage') + change_log.
 * - 겹침 판정: 같은 document_version 내 앵커의 [start,end)와 교집합/min(길이) ≥ 0.6
 *   → force 없으면 아무것도 만들지 않고 기존 하이라이트 정보를 돌려준다("이 문항 추가" 제안용).
 * - 마지막 문항 연결 해제는 확인(confirm) 후 passage soft-delete — 앵커·change_log는 잔존.
 * - FTS(kind='passage')는 트리거가 없으므로 이 서비스가 유일한 기록 경로다.
 */
import type Database from 'better-sqlite3';
import { logChange } from '../db/change-log.js';

export const OVERLAP_THRESHOLD = 0.6;
export const SHORT_QUOTE_WORDS = 3;
/** 계약 고정 문자열 — "quote 3단어 미만이면 응답에 nudge:'짧은 선택' 포함" */
export const SHORT_QUOTE_NUDGE = '짧은 선택';

export type Rect = [number, number, number, number];
export interface RectGroup {
  page: number;
  rects: Rect[];
}

export interface CreateAnchorInput {
  documentVersionId: number;
  questionIds: number[];
  quoteExact: string;
  quotePrefix?: string | null;
  quoteSuffix?: string | null;
  startOffset: number;
  endOffset: number;
  pageStart: number;
  pageEnd: number;
  rects: RectGroup[];
  label?: string | null;
  color?: string;
  geometryPrimary?: boolean | number;
  force?: boolean;
}

export interface OverlapInfo {
  passageId: number;
  anchorId: number;
  quote: string;
  questions: { id: number; questionNo: string }[];
}

export type CreateAnchorResult =
  | { kind: 'version_not_found' }
  | { kind: 'questions_not_found'; missing: number[] }
  | { kind: 'overlap'; overlap: OverlapInfo }
  | { kind: 'created'; passageId: number; anchorId: number; nudge?: string };

/** 공백 기준 단어 수 (한국어 어절) — 초단문 선택 넛지 판정용 */
export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

interface OverlapRow {
  anchor_id: number;
  passage_id: number;
  quote_exact: string;
  start_offset: number;
  end_offset: number;
}

/** passage에 연결된 문항 목록 (soft-delete 문항 제외, 칩 순서) */
export function passageQuestions(
  db: Database.Database,
  passageId: number,
): { id: number; questionNo: string }[] {
  return db
    .prepare(
      `SELECT q.id, q.question_no AS questionNo
       FROM question_passage qp
       JOIN question q ON q.id = qp.question_id AND q.deleted_at IS NULL
       WHERE qp.passage_id = ?
       ORDER BY qp.sort, q.question_no`,
    )
    .all(passageId) as { id: number; questionNo: string }[];
}

/**
 * 같은 판본 내 기존 앵커와의 겹침 검사.
 * 겹침율 = 교집합 길이 / min(두 구간 길이) ≥ OVERLAP_THRESHOLD 인 것 중 최대 겹침율 1건.
 * soft-delete·obsolete passage의 앵커는 제외.
 */
export function findOverlappingAnchor(
  db: Database.Database,
  documentVersionId: number,
  startOffset: number,
  endOffset: number,
): OverlapInfo | null {
  const rows = db
    .prepare(
      `SELECT pa.id AS anchor_id, pa.passage_id, pa.quote_exact, pa.start_offset, pa.end_offset
       FROM passage_anchor pa
       JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL AND p.obsolete = 0
       WHERE pa.document_version_id = ?
         AND pa.start_offset IS NOT NULL AND pa.end_offset IS NOT NULL
         AND pa.end_offset > ? AND pa.start_offset < ?`,
    )
    .all(documentVersionId, startOffset, endOffset) as OverlapRow[];

  const newLen = endOffset - startOffset;
  let best: OverlapRow | null = null;
  let bestRatio = 0;
  for (const r of rows) {
    const existingLen = r.end_offset - r.start_offset;
    const denom = Math.min(newLen, existingLen);
    if (denom <= 0) continue;
    const inter = Math.min(endOffset, r.end_offset) - Math.max(startOffset, r.start_offset);
    const ratio = inter / denom;
    if (ratio >= OVERLAP_THRESHOLD && ratio > bestRatio) {
      best = r;
      bestRatio = ratio;
    }
  }
  if (!best) return null;
  return {
    passageId: best.passage_id,
    anchorId: best.anchor_id,
    quote: best.quote_exact,
    questions: passageQuestions(db, best.passage_id),
  };
}

/**
 * 문항별 다음 근거 칩 sort = (question_passage ∪ question_richdoc) 통합 max + 1.
 * (근거 칩 순서는 두 조인의 sort를 통합 정렬해 계산하므로 max도 통합으로 잡아야 끝에 붙는다.)
 */
export function nextEvidenceSort(db: Database.Database, questionId: number): number {
  const row = db
    .prepare(
      `SELECT MAX(s) AS m FROM (
         SELECT MAX(sort) AS s FROM question_passage WHERE question_id = ?
         UNION ALL
         SELECT MAX(sort) AS s FROM question_richdoc WHERE question_id = ?
       )`,
    )
    .get(questionId, questionId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

/** FTS(kind='passage') 갱신 — 기록 경로가 통제된 서비스 코드 (001_init.sql 주석 참조) */
export function upsertPassageFts(db: Database.Database, passageId: number, quote: string): void {
  db.prepare(`DELETE FROM fts WHERE kind = 'passage' AND ref_id = ?`).run(passageId);
  db.prepare(`INSERT INTO fts (kind, ref_id, content) VALUES ('passage', ?, ?)`).run(
    passageId,
    quote,
  );
}

export function removePassageFts(db: Database.Database, passageId: number): void {
  db.prepare(`DELETE FROM fts WHERE kind = 'passage' AND ref_id = ?`).run(passageId);
}

/** 하이라이트 생성 트랜잭션 (§3.2) */
export function createAnchorMapping(
  db: Database.Database,
  input: CreateAnchorInput,
  userId: number,
): CreateAnchorResult {
  const run = db.transaction((): CreateAnchorResult => {
    const version = db
      .prepare('SELECT id, document_id FROM document_version WHERE id = ?')
      .get(input.documentVersionId) as { id: number; document_id: number } | undefined;
    if (!version) return { kind: 'version_not_found' };

    const questionIds = [...new Set(input.questionIds)];
    const missing = questionIds.filter(
      (qid) =>
        !db.prepare('SELECT id FROM question WHERE id = ? AND deleted_at IS NULL').get(qid),
    );
    if (missing.length > 0) return { kind: 'questions_not_found', missing };

    if (!input.force) {
      const overlap = findOverlappingAnchor(
        db,
        input.documentVersionId,
        input.startOffset,
        input.endOffset,
      );
      if (overlap) return { kind: 'overlap', overlap };
    }

    const now = new Date().toISOString();
    const color = input.color ?? 'yellow';
    const label = input.label ?? null;
    const geometryPrimary = input.geometryPrimary ? 1 : 0;

    const passageInfo = db
      .prepare('INSERT INTO passage (document_id, label, color) VALUES (?, ?, ?)')
      .run(version.document_id, label, color);
    const passageId = Number(passageInfo.lastInsertRowid);

    const anchorInfo = db
      .prepare(
        `INSERT INTO passage_anchor
           (passage_id, document_version_id, quote_exact, quote_prefix, quote_suffix,
            start_offset, end_offset, page_start, page_end, rects_json, geometry_primary,
            status, method, confidence, resolved_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', 'manual', NULL, ?, ?)`,
      )
      .run(
        passageId,
        input.documentVersionId,
        input.quoteExact,
        input.quotePrefix ?? null,
        input.quoteSuffix ?? null,
        input.startOffset,
        input.endOffset,
        input.pageStart,
        input.pageEnd,
        JSON.stringify(input.rects),
        geometryPrimary,
        userId,
        now,
      );
    const anchorId = Number(anchorInfo.lastInsertRowid);

    for (const qid of questionIds) {
      const sort = nextEvidenceSort(db, qid);
      db.prepare(
        `INSERT INTO question_passage (question_id, passage_id, sort, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(qid, passageId, sort, userId, now);
      logChange(db, {
        actorId: userId,
        entity: 'question',
        entityId: qid,
        action: 'link',
        after: { passageId, anchorId, sort },
      });
    }

    upsertPassageFts(db, passageId, input.quoteExact);

    logChange(db, {
      actorId: userId,
      entity: 'passage',
      entityId: passageId,
      action: 'create',
      after: { documentId: version.document_id, label, color, questionIds },
    });
    logChange(db, {
      actorId: userId,
      entity: 'passage_anchor',
      entityId: anchorId,
      action: 'create',
      after: {
        passageId,
        documentVersionId: input.documentVersionId,
        quoteExact: input.quoteExact,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        geometryPrimary,
        status: 'resolved',
        method: 'manual',
      },
    });

    const result: CreateAnchorResult = { kind: 'created', passageId, anchorId };
    if (countWords(input.quoteExact) < SHORT_QUOTE_WORDS) result.nudge = SHORT_QUOTE_NUDGE;
    return result;
  });
  return run();
}

export type LinkResult =
  | { kind: 'passage_not_found' }
  | { kind: 'question_not_found' }
  | { kind: 'duplicate' }
  | { kind: 'linked'; sort: number };

/** 기존 passage에 문항 추가 (중복은 무동작) — §3.2 "기존 하이라이트에 이 문항 추가" */
export function linkQuestionToPassage(
  db: Database.Database,
  passageId: number,
  questionId: number,
  userId: number,
): LinkResult {
  const run = db.transaction((): LinkResult => {
    const passage = db
      .prepare('SELECT id FROM passage WHERE id = ? AND deleted_at IS NULL')
      .get(passageId);
    if (!passage) return { kind: 'passage_not_found' };
    const question = db
      .prepare('SELECT id FROM question WHERE id = ? AND deleted_at IS NULL')
      .get(questionId);
    if (!question) return { kind: 'question_not_found' };
    const existing = db
      .prepare('SELECT sort FROM question_passage WHERE question_id = ? AND passage_id = ?')
      .get(questionId, passageId);
    if (existing) return { kind: 'duplicate' };

    const sort = nextEvidenceSort(db, questionId);
    db.prepare(
      `INSERT INTO question_passage (question_id, passage_id, sort, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(questionId, passageId, sort, userId, new Date().toISOString());
    logChange(db, {
      actorId: userId,
      entity: 'question',
      entityId: questionId,
      action: 'link',
      after: { passageId, sort },
    });
    return { kind: 'linked', sort };
  });
  return run();
}

export type UnlinkResult =
  | { kind: 'passage_not_found' }
  | { kind: 'link_not_found' }
  | { kind: 'last_link' } // 마지막 연결 — confirm 없이는 아무것도 하지 않음 (409)
  | { kind: 'unlinked'; passageDeleted: boolean };

/**
 * 문항 연결 해제 — 마지막 링크면 확인(confirm) 요구, 확인 시 passage soft-delete.
 * 앵커 행과 change_log 이력은 그대로 잔존한다(하드삭제 금지).
 */
export function unlinkQuestionFromPassage(
  db: Database.Database,
  passageId: number,
  questionId: number,
  userId: number,
  confirm: boolean,
): UnlinkResult {
  const run = db.transaction((): UnlinkResult => {
    const passage = db
      .prepare('SELECT id, label, color, document_id FROM passage WHERE id = ? AND deleted_at IS NULL')
      .get(passageId) as
      | { id: number; label: string | null; color: string; document_id: number }
      | undefined;
    if (!passage) return { kind: 'passage_not_found' };

    const link = db
      .prepare('SELECT sort, note FROM question_passage WHERE question_id = ? AND passage_id = ?')
      .get(questionId, passageId) as { sort: number; note: string | null } | undefined;
    if (!link) return { kind: 'link_not_found' };

    const total = (
      db
        .prepare('SELECT COUNT(*) AS n FROM question_passage WHERE passage_id = ?')
        .get(passageId) as { n: number }
    ).n;
    const isLast = total <= 1;
    if (isLast && !confirm) return { kind: 'last_link' };

    db.prepare('DELETE FROM question_passage WHERE question_id = ? AND passage_id = ?').run(
      questionId,
      passageId,
    );
    logChange(db, {
      actorId: userId,
      entity: 'question',
      entityId: questionId,
      action: 'unlink',
      before: { passageId, sort: link.sort, note: link.note },
    });

    if (isLast) {
      db.prepare(
        `UPDATE passage SET deleted_at = ?, row_version = row_version + 1 WHERE id = ?`,
      ).run(new Date().toISOString(), passageId);
      removePassageFts(db, passageId);
      logChange(db, {
        actorId: userId,
        entity: 'passage',
        entityId: passageId,
        action: 'delete',
        before: { documentId: passage.document_id, label: passage.label, color: passage.color },
        after: { softDeleted: true, reason: 'last_link_unlinked' },
      });
    }
    return { kind: 'unlinked', passageDeleted: isLast };
  });
  return run();
}
