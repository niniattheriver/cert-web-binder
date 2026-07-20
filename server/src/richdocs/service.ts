/**
 * 자유양식 근거문서(rich_doc) 서비스 (설계서 §2 rich_doc/question_richdoc, §4 #8)
 * - CRUD: soft delete(deleted_at) + row_version 낙관적 잠금(409) + change_log 추가.
 * - content_plain은 클라이언트가 보낸 평문 투영(FTS는 001_init.sql 트리거가 title+content_plain 동기화).
 * - 문항 링크(question_richdoc): sort는 (question_passage ∪ question_richdoc) 통합 max+1
 *   (anchors/service.nextEvidenceSort 재사용) — 근거 칩 통합 정렬과 일관.
 * - 이미지 등 첨부는 내용주소(sha256) 저장 — base64 금지. 저장 경로는 data/files/attachments/.
 * - 하드삭제 없음: 문서 soft delete 시 question_richdoc 링크 행은 제거(question_passage 해제와 동일 방식)
 *   + change_log 보존. rich_doc 행/이력은 잔존.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nextEvidenceSort } from '../anchors/service.js';
import { logChange } from '../db/change-log.js';

// ── 내용주소 첨부 저장 (data/files/attachments/<앞2>/<나머지>) ─────────────────

/** 허용 이미지 MIME (SVG는 스크립트 위험으로 제외 — 래스터만) */
export const ALLOWED_ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function sha256Hex(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** filesDir(= data/files) 기준 첨부 절대 경로 */
export function attachmentPath(filesDir: string, sha256: string): string {
  return path.join(filesDir, 'attachments', sha256.slice(0, 2), sha256.slice(2));
}

/** 없으면 저장(내용주소라 재작성 불필요). tmp+rename 원자적 쓰기. */
export function saveAttachmentFile(filesDir: string, sha256: string, buf: Uint8Array): void {
  const target = attachmentPath(filesDir, sha256);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
}

export interface AttachmentInfo {
  sha256: string;
  mime: string;
  size: number;
  url: string;
}

/** 첨부 저장(파일 + attachment 행 upsert). 동일 sha256 재업로드는 무동작(중복 제거). */
export function storeAttachment(
  db: Database.Database,
  filesDir: string,
  buf: Uint8Array,
  mime: string,
  origName: string | null,
): AttachmentInfo {
  const sha256 = sha256Hex(buf);
  saveAttachmentFile(filesDir, sha256, buf);
  const existing = db
    .prepare('SELECT id FROM attachment WHERE sha256 = ?')
    .get(sha256) as { id: number } | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO attachment (sha256, mime, orig_name, size) VALUES (?, ?, ?, ?)',
    ).run(sha256, mime, origName, buf.byteLength);
  }
  return { sha256, mime, size: buf.byteLength, url: `/api/attachments/${sha256}` };
}

export function getAttachment(
  db: Database.Database,
  sha256: string,
): { sha256: string; mime: string; size: number } | null {
  const row = db
    .prepare('SELECT sha256, mime, size FROM attachment WHERE sha256 = ?')
    .get(sha256) as { sha256: string; mime: string; size: number } | undefined;
  return row ?? null;
}

// ── rich_doc 조회/투영 ────────────────────────────────────────────────────────

interface RichDocRow {
  id: number;
  title: string;
  content_json: string;
  content_plain: string | null;
  row_version: number;
  updated_at: string;
  updated_by: number | null;
  deleted_at: string | null;
}

export interface LinkedQuestion {
  questionId: number;
  questionNo: string;
  categoryId: number;
  categoryCode: string;
  sort: number;
  note: string | null;
}

export interface RichDocFull {
  id: number;
  title: string;
  /** ProseMirror JSON (TEXT 원본 문자열) */
  contentJson: string;
  contentPlain: string | null;
  rowVersion: number;
  updatedAt: string;
  updatedByName: string | null;
  questions: LinkedQuestion[];
}

/** 문항 링크 목록 (soft-delete 문항 제외, sort 순) */
export function linkedQuestions(db: Database.Database, richDocId: number): LinkedQuestion[] {
  return db
    .prepare(
      `SELECT q.id AS questionId, q.question_no AS questionNo,
              c.id AS categoryId, c.code AS categoryCode,
              qr.sort AS sort, qr.note AS note
       FROM question_richdoc qr
       JOIN question q ON q.id = qr.question_id AND q.deleted_at IS NULL
       JOIN category c ON c.id = q.category_id
       WHERE qr.rich_doc_id = ?
       ORDER BY qr.sort, q.question_no`,
    )
    .all(richDocId) as LinkedQuestion[];
}

/** 상세 페이로드 (없거나 soft-delete면 null) */
export function fullRichDocPayload(db: Database.Database, id: number): RichDocFull | null {
  const row = db
    .prepare('SELECT * FROM rich_doc WHERE id = ? AND deleted_at IS NULL')
    .get(id) as RichDocRow | undefined;
  if (!row) return null;
  const updatedByName = row.updated_by
    ? ((db.prepare('SELECT display_name FROM user WHERE id = ?').get(row.updated_by) as
        | { display_name: string }
        | undefined)?.display_name ?? null)
    : null;
  return {
    id: row.id,
    title: row.title,
    contentJson: row.content_json,
    contentPlain: row.content_plain,
    rowVersion: row.row_version,
    updatedAt: row.updated_at,
    updatedByName,
    questions: linkedQuestions(db, row.id),
  };
}

export interface RichDocListItem {
  id: number;
  title: string;
  updatedAt: string;
  updatedByName: string | null;
  plainPreview: string;
  questionCount: number;
}

/** 목록(피커용) — soft-delete 제외, 최근 수정 순 */
export function listRichDocs(db: Database.Database): RichDocListItem[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.title, r.content_plain, r.updated_at, u.display_name AS updated_by_name,
              (SELECT COUNT(*) FROM question_richdoc qr
                 JOIN question q ON q.id = qr.question_id AND q.deleted_at IS NULL
               WHERE qr.rich_doc_id = r.id) AS question_count
       FROM rich_doc r
       LEFT JOIN user u ON u.id = r.updated_by
       WHERE r.deleted_at IS NULL
       ORDER BY r.updated_at DESC, r.id DESC`,
    )
    .all() as {
    id: number;
    title: string;
    content_plain: string | null;
    updated_at: string;
    updated_by_name: string | null;
    question_count: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    updatedByName: r.updated_by_name,
    plainPreview: (r.content_plain ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    questionCount: r.question_count,
  }));
}

// ── content_json 정규화 ───────────────────────────────────────────────────────

const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}';

/** 객체/문자열 모두 TEXT 저장값으로 정규화 (미전송이면 빈 문서) */
export function normalizeContentJson(v: unknown): string {
  if (v === undefined || v === null) return EMPTY_DOC;
  if (typeof v === 'string') return v.trim() === '' ? EMPTY_DOC : v;
  return JSON.stringify(v);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export interface CreateRichDocInput {
  title: string;
  contentJson?: unknown;
  contentPlain?: string | null;
  /** 지정 시 생성 직후 이 문항에 근거로 링크 */
  questionId?: number | null;
}

export type CreateRichDocResult =
  | { kind: 'question_not_found' }
  | { kind: 'ok'; doc: RichDocFull };

export function createRichDoc(
  db: Database.Database,
  input: CreateRichDocInput,
  userId: number,
): CreateRichDocResult {
  const run = db.transaction((): CreateRichDocResult => {
    const now = new Date().toISOString();
    const contentJson = normalizeContentJson(input.contentJson);
    const contentPlain = input.contentPlain ?? null;

    if (input.questionId != null) {
      const q = db
        .prepare('SELECT id FROM question WHERE id = ? AND deleted_at IS NULL')
        .get(input.questionId);
      if (!q) return { kind: 'question_not_found' };
    }

    const info = db
      .prepare(
        `INSERT INTO rich_doc (title, content_json, content_plain, row_version, updated_at, updated_by)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(input.title, contentJson, contentPlain, now, userId);
    const id = Number(info.lastInsertRowid);

    logChange(db, {
      actorId: userId,
      entity: 'rich_doc',
      entityId: id,
      action: 'create',
      after: { title: input.title, plainLen: (contentPlain ?? '').length },
    });

    if (input.questionId != null) {
      const sort = nextEvidenceSort(db, input.questionId);
      db.prepare(
        'INSERT INTO question_richdoc (question_id, rich_doc_id, sort) VALUES (?, ?, ?)',
      ).run(input.questionId, id, sort);
      logChange(db, {
        actorId: userId,
        entity: 'question',
        entityId: input.questionId,
        action: 'link',
        after: { richDocId: id, sort },
      });
    }

    return { kind: 'ok', doc: fullRichDocPayload(db, id)! };
  });
  return run();
}

export interface UpdateRichDocInput {
  rowVersion: number;
  title?: string;
  contentJson?: unknown;
  contentPlain?: string | null;
}

export type UpdateRichDocResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; server: RichDocFull }
  | { kind: 'ok'; doc: RichDocFull };

export function updateRichDoc(
  db: Database.Database,
  id: number,
  input: UpdateRichDocInput,
  userId: number,
): UpdateRichDocResult {
  const run = db.transaction((): UpdateRichDocResult => {
    const row = db
      .prepare('SELECT * FROM rich_doc WHERE id = ? AND deleted_at IS NULL')
      .get(id) as RichDocRow | undefined;
    if (!row) return { kind: 'not_found' };

    // 낙관적 잠금 — 불일치 시 지는 쪽 제출본도 change_log 보존(조용한 유실 금지)
    if (input.rowVersion !== row.row_version) {
      logChange(db, {
        actorId: userId,
        entity: 'rich_doc',
        entityId: id,
        action: 'conflict_lost',
        before: { rowVersion: row.row_version, note: '서버 최신본 유지' },
        after: {
          submitted: {
            title: input.title,
            plainLen: (input.contentPlain ?? '').length,
            rowVersion: input.rowVersion,
          },
          note: '409로 거부된 클라이언트 제출본',
        },
      });
      return { kind: 'conflict', server: fullRichDocPayload(db, id)! };
    }

    const nextTitle = 'title' in input && input.title !== undefined ? input.title : row.title;
    const nextJson =
      'contentJson' in input && input.contentJson !== undefined
        ? normalizeContentJson(input.contentJson)
        : row.content_json;
    const nextPlain =
      'contentPlain' in input ? (input.contentPlain ?? null) : row.content_plain;

    const changed =
      nextTitle !== row.title || nextJson !== row.content_json || nextPlain !== row.content_plain;
    if (!changed) {
      // 실변경 없음 — 버전 증가·로그 없이 현재본 반환 (멱등)
      return { kind: 'ok', doc: fullRichDocPayload(db, id)! };
    }

    db.prepare(
      `UPDATE rich_doc
       SET title = ?, content_json = ?, content_plain = ?, row_version = row_version + 1,
           updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(nextTitle, nextJson, nextPlain, new Date().toISOString(), userId, id);

    logChange(db, {
      actorId: userId,
      entity: 'rich_doc',
      entityId: id,
      action: 'update',
      before: { title: row.title, plainLen: (row.content_plain ?? '').length, rowVersion: row.row_version },
      after: { title: nextTitle, plainLen: (nextPlain ?? '').length, rowVersion: row.row_version + 1 },
    });

    return { kind: 'ok', doc: fullRichDocPayload(db, id)! };
  });
  return run();
}

export type DeleteRichDocResult = { kind: 'not_found' } | { kind: 'ok' };

/** soft delete — 링크 행 제거(question_passage 해제와 동일 방식) + change_log 보존 */
export function deleteRichDoc(
  db: Database.Database,
  id: number,
  userId: number,
): DeleteRichDocResult {
  const run = db.transaction((): DeleteRichDocResult => {
    const row = db
      .prepare('SELECT id, title FROM rich_doc WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { id: number; title: string } | undefined;
    if (!row) return { kind: 'not_found' };

    const links = db
      .prepare('SELECT question_id, sort, note FROM question_richdoc WHERE rich_doc_id = ?')
      .all(id) as { question_id: number; sort: number; note: string | null }[];
    for (const l of links) {
      db.prepare('DELETE FROM question_richdoc WHERE question_id = ? AND rich_doc_id = ?').run(
        l.question_id,
        id,
      );
      logChange(db, {
        actorId: userId,
        entity: 'question',
        entityId: l.question_id,
        action: 'unlink',
        before: { richDocId: id, sort: l.sort, note: l.note, reason: 'rich_doc_deleted' },
      });
    }

    db.prepare(
      'UPDATE rich_doc SET deleted_at = ?, row_version = row_version + 1 WHERE id = ?',
    ).run(new Date().toISOString(), id);
    logChange(db, {
      actorId: userId,
      entity: 'rich_doc',
      entityId: id,
      action: 'delete',
      before: { title: row.title },
      after: { softDeleted: true },
    });
    return { kind: 'ok' };
  });
  return run();
}

// ── 문항 링크 ─────────────────────────────────────────────────────────────────

export type LinkRichDocResult =
  | { kind: 'rich_doc_not_found' }
  | { kind: 'question_not_found' }
  | { kind: 'duplicate' }
  | { kind: 'linked'; sort: number };

export function linkRichDocToQuestion(
  db: Database.Database,
  richDocId: number,
  questionId: number,
  userId: number,
): LinkRichDocResult {
  const run = db.transaction((): LinkRichDocResult => {
    const doc = db
      .prepare('SELECT id FROM rich_doc WHERE id = ? AND deleted_at IS NULL')
      .get(richDocId);
    if (!doc) return { kind: 'rich_doc_not_found' };
    const question = db
      .prepare('SELECT id FROM question WHERE id = ? AND deleted_at IS NULL')
      .get(questionId);
    if (!question) return { kind: 'question_not_found' };
    const existing = db
      .prepare('SELECT sort FROM question_richdoc WHERE question_id = ? AND rich_doc_id = ?')
      .get(questionId, richDocId);
    if (existing) return { kind: 'duplicate' };

    const sort = nextEvidenceSort(db, questionId);
    db.prepare(
      'INSERT INTO question_richdoc (question_id, rich_doc_id, sort) VALUES (?, ?, ?)',
    ).run(questionId, richDocId, sort);
    logChange(db, {
      actorId: userId,
      entity: 'question',
      entityId: questionId,
      action: 'link',
      after: { richDocId, sort },
    });
    return { kind: 'linked', sort };
  });
  return run();
}

export type UnlinkRichDocResult =
  | { kind: 'link_not_found' }
  | { kind: 'unlinked' };

/** 문항-문서 링크 해제 (문서 자체는 삭제하지 않음 — 공유/독립 가능) */
export function unlinkRichDocFromQuestion(
  db: Database.Database,
  richDocId: number,
  questionId: number,
  userId: number,
): UnlinkRichDocResult {
  const run = db.transaction((): UnlinkRichDocResult => {
    const link = db
      .prepare('SELECT sort, note FROM question_richdoc WHERE question_id = ? AND rich_doc_id = ?')
      .get(questionId, richDocId) as { sort: number; note: string | null } | undefined;
    if (!link) return { kind: 'link_not_found' };
    db.prepare('DELETE FROM question_richdoc WHERE question_id = ? AND rich_doc_id = ?').run(
      questionId,
      richDocId,
    );
    logChange(db, {
      actorId: userId,
      entity: 'question',
      entityId: questionId,
      action: 'unlink',
      before: { richDocId, sort: link.sort, note: link.note },
    });
    return { kind: 'unlinked' };
  });
  return run();
}
