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
import { buildPageOffsets, fullTextOf, rangeToPageRanges } from '../pdf/offsets.js';

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
  /** PDF 판본에만 필수. Word, Excel 같은 판본은 좌표가 없다(화면이 오프셋으로 위치를 찾는다) */
  rects?: RectGroup[] | null;
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
  | { kind: 'invalid'; message: string }
  | { kind: 'created'; passageId: number; anchorId: number; nudge?: string };

/** 공백(개행 포함), 제로폭 문자를 뺀 그림자 문자열 (web/src/pdf/pageText.ts 의 buildShadow 와 같은 규칙) */
function shadowOf(s: string): string {
  return s.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
}

/**
 * PDF 외 판본의 앵커 검증: 오프셋 구간의 정본 글자가 인용과 같고(공백 무시), 쪽 범위가 맞는지.
 * 화면은 정본 글자에서 인용을 잘라 보내므로 정상이면 언제나 맞는다. 틀리면 화면 결함이니 만들지 않는다
 * (조용한 오앵커 금지, 설계서 §3.4).
 */
function verifyTextAnchor(
  db: Database.Database,
  input: CreateAnchorInput,
): string | null {
  const rows = db
    .prepare(
      `SELECT page_no AS pageNo, text FROM page_text WHERE document_version_id = ? ORDER BY page_no`,
    )
    .all(input.documentVersionId) as { pageNo: number; text: string }[];
  if (rows.length === 0) return '이 버전에는 글자가 없어 근거를 연결할 수 없습니다.';
  // 공백, 개행뿐인 인용은 그림자가 빈 문자열이라 아래 비교를 그대로 통과한다: 글자 없는 근거를 만들지 않는다
  if (shadowOf(input.quoteExact) === '') {
    return '선택한 부분에 글자가 없습니다. 글자를 포함해 다시 선택해 주세요.';
  }
  const entries = buildPageOffsets(rows);
  const full = fullTextOf(entries);
  if (input.startOffset < 0 || input.endOffset > full.length || input.endOffset <= input.startOffset) {
    return '선택 위치가 문서 범위를 벗어났습니다. 다시 선택해 주세요.';
  }
  if (shadowOf(full.slice(input.startOffset, input.endOffset)) !== shadowOf(input.quoteExact)) {
    return '선택한 문구가 문서 글자와 일치하지 않습니다. 다시 선택해 주세요.';
  }
  const ranges = rangeToPageRanges(entries, input.startOffset, input.endOffset);
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (!first || !last || first.pageNo !== input.pageStart || last.pageNo !== input.pageEnd) {
    return '선택한 쪽 범위가 문서와 맞지 않습니다. 다시 선택해 주세요.';
  }
  return null;
}

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
      .prepare(
        `SELECT dv.id, dv.document_id, dv.file_kind, dv.is_current
         FROM document_version dv
         JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
         WHERE dv.id = ?`,
      )
      .get(input.documentVersionId) as
      | { id: number; document_id: number; file_kind: string; is_current: number }
      | undefined;
    if (!version) return { kind: 'version_not_found' };
    // 근거는 현재 판본에만 연결한다. 과거 판본에 만든 앵커는 현재 판본에 앵커가 없는 passage 가 되어
    // (§2 첫 불변식 위반, 무결성 점검 5) 근거 카드의 인용이 비고 다음 개정의 재앵커링에서도 빠진다.
    // 화면은 과거 판본의 매핑을 막지만, 뷰어를 연 사이 새 판본이 올라오면 옛 판본 ID 로 요청이 온다
    if (version.is_current !== 1) {
      return {
        kind: 'invalid',
        message: '이 버전은 현재 버전이 아니어서 근거를 연결할 수 없습니다. 문서를 다시 열어 현재 버전에서 선택해 주세요.',
      };
    }

    // 형식별 계약: PDF 는 좌표(rects) 필수, 그 외 형식은 좌표·박스 앵커 없이 오프셋만 (설계서 §3.5)
    const isPdf = version.file_kind === 'pdf';
    const hasRects = Array.isArray(input.rects) && input.rects.length > 0;
    if (isPdf && !hasRects) {
      return { kind: 'invalid', message: 'PDF 버전에는 선택 영역 좌표(rects)가 필요합니다.' };
    }
    if (!isPdf) {
      if (hasRects || input.geometryPrimary) {
        return {
          kind: 'invalid',
          message: '이 형식(Word, Excel 등)의 버전에는 좌표나 박스 앵커를 쓸 수 없습니다.',
        };
      }
      const problem = verifyTextAnchor(db, input);
      if (problem) return { kind: 'invalid', message: problem };
    }

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
    const geometryPrimary = isPdf && input.geometryPrimary ? 1 : 0;

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
        isPdf ? JSON.stringify(input.rects) : null, // 좌표 캐시는 PDF 만 (NULL 이면 화면이 오프셋으로 그린다)
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
