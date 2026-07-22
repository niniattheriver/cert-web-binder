/**
 * 문항 근거(evidence) 통합 목록 (설계서 §3.3 양방향 표시, §2 데이터 모델 주석)
 * - 근거 칩 = (question_passage ∪ question_richdoc)의 sort를 통합 정렬해 계산.
 * - passage 항목은 문서의 "현재 판본" 앵커를 조인해 인용문·페이지·상태를 보여준다
 *   (현재 판본 앵커가 없으면 무결성 위반이지만 목록에서는 anchorId=null로 노출 — 추적이 핵심).
 * - PATCH는 순서(sort)/메모(note)만 갱신 — 링크 추가/해제는 anchors 라우트 소관.
 */
import type Database from 'better-sqlite3';
import { logChange } from '../db/change-log.js';

export interface PassageEvidenceItem {
  type: 'passage';
  passageId: number;
  anchorId: number | null;
  documentId: number;
  versionId: number | null;
  sort: number;
  note: string | null;
  quote: string | null;
  label: string | null;
  color: string;
  docTitle: string;
  versionLabel: string | null;
  pageStart: number | null;
  status: string | null;
}

export interface RichdocEvidenceItem {
  type: 'richdoc';
  richDocId: number;
  sort: number;
  note: string | null;
  title: string;
  /** 본문 앞부분 발췌(공백 정규화, ~200자) — 칩에서 1~2줄 미리보기용 */
  excerpt: string | null;
}

export type EvidenceItem = PassageEvidenceItem | RichdocEvidenceItem;

interface PassageRow {
  passage_id: number;
  sort: number;
  note: string | null;
  label: string | null;
  color: string;
  document_id: number;
  doc_title: string;
  version_id: number | null;
  version_label: string | null;
  anchor_id: number | null;
  quote_exact: string | null;
  page_start: number | null;
  status: string | null;
}

interface RichdocRow {
  rich_doc_id: number;
  sort: number;
  note: string | null;
  title: string;
  excerpt: string | null;
}

/** 문항의 근거 항목을 sort 통합 정렬로 반환 (soft-delete passage/rich_doc 제외) */
export function getEvidenceItems(db: Database.Database, questionId: number): EvidenceItem[] {
  const passageRows = db
    .prepare(
      `SELECT qp.passage_id, qp.sort, qp.note, p.label, p.color, p.document_id,
              d.title AS doc_title, dv.id AS version_id, dv.version_label,
              pa.id AS anchor_id, pa.quote_exact, pa.page_start, pa.status
       FROM question_passage qp
       JOIN passage p ON p.id = qp.passage_id AND p.deleted_at IS NULL
       JOIN document d ON d.id = p.document_id
       LEFT JOIN document_version dv ON dv.document_id = p.document_id AND dv.is_current = 1
       LEFT JOIN passage_anchor pa ON pa.passage_id = p.id AND pa.document_version_id = dv.id
       WHERE qp.question_id = ?`,
    )
    .all(questionId) as PassageRow[];

  const richdocRows = db
    .prepare(
      `SELECT qr.rich_doc_id, qr.sort, qr.note, r.title,
              substr(r.content_plain, 1, 400) AS excerpt
       FROM question_richdoc qr
       JOIN rich_doc r ON r.id = qr.rich_doc_id AND r.deleted_at IS NULL
       WHERE qr.question_id = ?`,
    )
    .all(questionId) as RichdocRow[];

  const items: EvidenceItem[] = [
    ...passageRows.map(
      (r): PassageEvidenceItem => ({
        type: 'passage',
        passageId: r.passage_id,
        anchorId: r.anchor_id,
        documentId: r.document_id,
        versionId: r.version_id,
        sort: r.sort,
        note: r.note,
        quote: r.quote_exact,
        label: r.label,
        color: r.color,
        docTitle: r.doc_title,
        versionLabel: r.version_label,
        pageStart: r.page_start,
        status: r.status,
      }),
    ),
    ...richdocRows.map(
      (r): RichdocEvidenceItem => ({
        type: 'richdoc',
        richDocId: r.rich_doc_id,
        sort: r.sort,
        note: r.note,
        title: r.title,
        // 공백·개행을 한 칸으로 눌러 1~2줄 미리보기 텍스트로 (본문 없으면 null)
        excerpt: r.excerpt ? r.excerpt.replace(/\s+/g, ' ').trim().slice(0, 200) || null : null,
      }),
    ),
  ];

  items.sort((a, b) => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    if (a.type !== b.type) return a.type === 'passage' ? -1 : 1;
    const aId = a.type === 'passage' ? a.passageId : a.richDocId;
    const bId = b.type === 'passage' ? b.passageId : b.richDocId;
    return aId - bId;
  });
  return items;
}

export interface EvidenceUpdateItem {
  type: 'passage' | 'richdoc';
  passageId?: number;
  richDocId?: number;
  sort: number;
  /** note 키가 요청에 있을 때만 갱신 (없으면 기존 값 유지, null이면 비움) */
  note?: string | null;
  noteProvided: boolean;
}

export type EvidenceUpdateResult =
  | { kind: 'question_not_found' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; items: EvidenceItem[] };

/** 근거 칩 순서/메모 갱신 (PATCH /api/questions/:id/evidence) */
export function updateEvidence(
  db: Database.Database,
  questionId: number,
  items: EvidenceUpdateItem[],
  userId: number,
): EvidenceUpdateResult {
  const run = db.transaction((): EvidenceUpdateResult => {
    const question = db
      .prepare('SELECT id FROM question WHERE id = ? AND deleted_at IS NULL')
      .get(questionId);
    if (!question) return { kind: 'question_not_found' };

    const before = getEvidenceItems(db, questionId).map((it) => ({
      type: it.type,
      id: it.type === 'passage' ? it.passageId : it.richDocId,
      sort: it.sort,
      note: it.note,
    }));

    for (const item of items) {
      if (item.type === 'passage') {
        if (!item.passageId) {
          return { kind: 'invalid', message: 'passage 항목에는 passageId가 필요합니다.' };
        }
        const link = db
          .prepare(
            'SELECT sort, note FROM question_passage WHERE question_id = ? AND passage_id = ?',
          )
          .get(questionId, item.passageId) as { sort: number; note: string | null } | undefined;
        if (!link) {
          return {
            kind: 'invalid',
            message: `이 문항에 연결되지 않은 발췌입니다 (passageId=${item.passageId}).`,
          };
        }
        db.prepare(
          'UPDATE question_passage SET sort = ?, note = ? WHERE question_id = ? AND passage_id = ?',
        ).run(
          item.sort,
          item.noteProvided ? (item.note ?? null) : link.note,
          questionId,
          item.passageId,
        );
      } else {
        if (!item.richDocId) {
          return { kind: 'invalid', message: 'richdoc 항목에는 richDocId가 필요합니다.' };
        }
        const link = db
          .prepare(
            'SELECT sort, note FROM question_richdoc WHERE question_id = ? AND rich_doc_id = ?',
          )
          .get(questionId, item.richDocId) as { sort: number; note: string | null } | undefined;
        if (!link) {
          return {
            kind: 'invalid',
            message: `이 문항에 연결되지 않은 문서입니다 (richDocId=${item.richDocId}).`,
          };
        }
        db.prepare(
          'UPDATE question_richdoc SET sort = ?, note = ? WHERE question_id = ? AND rich_doc_id = ?',
        ).run(
          item.sort,
          item.noteProvided ? (item.note ?? null) : link.note,
          questionId,
          item.richDocId,
        );
      }
    }

    const after = getEvidenceItems(db, questionId);
    logChange(db, {
      actorId: userId,
      entity: 'question',
      entityId: questionId,
      action: 'evidence_update',
      before,
      after: after.map((it) => ({
        type: it.type,
        id: it.type === 'passage' ? it.passageId : it.richDocId,
        sort: it.sort,
        note: it.note,
      })),
    });
    return { kind: 'ok', items: after };
  });
  return run();
}
