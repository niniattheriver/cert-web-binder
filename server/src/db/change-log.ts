/**
 * change_log 기록 헬퍼 (설계서 §2 — 추가-전용 감사 추적)
 * 모든 도메인 변경(채점·답변·충돌 패배 페이로드 포함)은 이 함수로 남긴다.
 */
import type Database from 'better-sqlite3';

export interface ChangeLogEntry {
  actorId?: number | null;
  actorKind?: 'user' | 'import' | 'system';
  batchId?: number | null;
  entity: string;
  entityId: number;
  action: string; // create|update|delete|link|unlink|conflict_lost|import|freeze…
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

export function logChange(db: Database.Database, e: ChangeLogEntry): void {
  db.prepare(
    `INSERT INTO change_log (ts, actor_id, actor_kind, batch_id, entity, entity_id, action, before_json, after_json, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    e.actorId ?? null,
    e.actorKind ?? 'user',
    e.batchId ?? null,
    e.entity,
    e.entityId,
    e.action,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.requestId ?? null,
  );
}
