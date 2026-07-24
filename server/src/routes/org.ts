/**
 * 기관 정보 라우트 (v1.5 Phase 1 — 설계서 §4 #14)
 * - GET    /api/org             → settings(기관명·표시명) + 활성 주기 + 기관 지표(org_metric) 목록
 * - PATCH  /api/org/settings    → app_setting(orgName/systemName) 갱신 (editor, change_log)
 * - POST   /api/org/metrics     → 지표 신설 (활성 주기 스코프. 같은 키의 soft delete 행은 복원)
 * - PATCH  /api/org/metrics/:id → 값/표시명/단위 갱신 — 낙관적 잠금 409 (question과 동일 규약)
 * - DELETE /api/org/metrics/:id → soft delete (가드레일: 하드삭제 금지)
 * 지표 미입력(value NULL)은 '입력값 없음' — 0이 아니다 (자동배점 Phase 3a에서 '계산 불가'로 취급).
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import { logChange } from '../db/change-log.js';
import { getSettings } from '../db/settings.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { getActiveCycle } from './questions.js';

interface MetricRow {
  id: number;
  cycle_id: number;
  metric_key: string;
  label: string;
  value: string | null;
  unit: string | null;
  value_type: 'number' | 'integer' | 'text';
  row_version: number;
  updated_at: string;
  updated_by: number | null;
  deleted_at: string | null;
}

const METRIC_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

const settingsSchema = z.object({
  orgName: z.string().trim().min(1).max(200).optional(),
  systemName: z.string().trim().min(1).max(200).optional(),
});

const metricCreateSchema = z.object({
  metricKey: z.string().regex(METRIC_KEY_RE, '지표 키는 영소문자로 시작하는 영소문자·숫자·밑줄 2~64자입니다.'),
  label: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(40).nullable().optional(),
  valueType: z.enum(['number', 'integer', 'text']).optional(),
  value: z.union([z.string(), z.number()]).nullable().optional(),
});

const metricPatchSchema = z.object({
  rowVersion: z.number().int().min(1),
  label: z.string().trim().min(1).max(200).optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  value: z.union([z.string(), z.number()]).nullable().optional(),
});

/** 입력값을 value_type에 맞춰 TEXT 저장값으로 정규화. 빈 문자열은 NULL(입력값 없음). 위반 시 한국어 사유. */
function normalizeValue(
  raw: string | number | null | undefined,
  valueType: MetricRow['value_type'],
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw == null) return { ok: true, value: null };
  const s = String(raw).trim();
  if (s === '') return { ok: true, value: null };
  if (valueType === 'number' || valueType === 'integer') {
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, reason: '숫자 형식이 아닙니다.' };
    if (valueType === 'integer' && !Number.isInteger(n))
      return { ok: false, reason: '정수만 입력할 수 있습니다.' };
    return { ok: true, value: String(n) };
  }
  return { ok: true, value: s };
}

function metricPayload(r: MetricRow, updatedByName: string | null): Record<string, unknown> {
  return {
    id: r.id,
    metricKey: r.metric_key,
    label: r.label,
    value: r.value,
    unit: r.unit,
    valueType: r.value_type,
    rowVersion: r.row_version,
    updatedAt: r.updated_at,
    updatedByName,
  };
}

export function createOrgRouter(db: Database.Database): Router {
  const router = Router();
  const auth = requireAuth(db);
  const editor = requireEditor(db);

  const userName = (id: number | null): string | null =>
    id
      ? ((db.prepare('SELECT display_name FROM user WHERE id = ?').get(id) as
          | { display_name: string }
          | undefined)?.display_name ?? null)
      : null;

  // ---------- GET /api/org ----------
  router.get('/org', auth, (_req, res) => {
    const activeCycle = getActiveCycle(db);
    const metrics = activeCycle
      ? (db
          .prepare(
            `SELECT * FROM org_metric
             WHERE cycle_id = ? AND deleted_at IS NULL
             ORDER BY label, metric_key`,
          )
          .all(activeCycle.id) as MetricRow[])
      : [];
    res.json({
      settings: getSettings(db),
      activeCycle,
      metrics: metrics.map((m) => metricPayload(m, userName(m.updated_by))),
    });
  });

  // ---------- PATCH /api/org/settings ----------
  router.patch('/org/settings', editor, (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    if (body.orgName === undefined && body.systemName === undefined) {
      res.status(400).json({ error: 'validation', details: '변경할 항목이 없습니다.' });
      return;
    }
    const before = getSettings(db);
    db.transaction(() => {
      const upsert = db.prepare('INSERT OR REPLACE INTO app_setting (key, value) VALUES (?, ?)');
      if (body.orgName !== undefined) upsert.run('orgName', body.orgName);
      if (body.systemName !== undefined) upsert.run('systemName', body.systemName);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'app_setting',
        entityId: 0,
        action: 'update',
        before,
        after: getSettings(db),
      });
    })();
    res.json({ settings: getSettings(db) });
  });

  // ---------- POST /api/org/metrics ----------
  router.post('/org/metrics', editor, (req, res) => {
    const parsed = metricCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const activeCycle = getActiveCycle(db);
    if (!activeCycle) {
      res.status(400).json({ error: 'validation', details: '활성 주기가 없습니다.' });
      return;
    }
    const valueType = body.valueType ?? 'number';
    const norm = normalizeValue(body.value, valueType);
    if (!norm.ok) {
      res.status(400).json({ error: 'validation', details: norm.reason });
      return;
    }
    const now = new Date().toISOString();
    type Outcome =
      | { kind: 'duplicate' }
      | { kind: 'invalid'; reason: string }
      | { kind: 'ok'; row: MetricRow; action: 'create' | 'restore' };
    const outcome = db.transaction((): Outcome => {
      const existing = db
        .prepare('SELECT * FROM org_metric WHERE cycle_id = ? AND metric_key = ?')
        .get(activeCycle.id, body.metricKey) as MetricRow | undefined;
      if (existing && existing.deleted_at === null) return { kind: 'duplicate' };
      if (existing) {
        // 자동배점 규칙이 이 키에 바인딩돼 있으면 텍스트형으로의 복원 금지
        // (PUT auto-rule 의 '텍스트형 바인딩 불가' 검증을 사후 우회하는 경로 차단 — 검토 반영)
        if (valueType === 'text') {
          const bound = db
            .prepare('SELECT 1 FROM auto_rule WHERE source_metric_key = ? LIMIT 1')
            .get(body.metricKey);
          if (bound)
            return {
              kind: 'invalid',
              reason: '자동배점에 바인딩된 지표는 텍스트형으로 복원할 수 없습니다.',
            };
        }
        // soft delete 행 복원 (UNIQUE 키 재사용 — 하드삭제 금지 원칙과의 정합)
        db.prepare(
          `UPDATE org_metric
           SET label = ?, unit = ?, value_type = ?, value = ?, deleted_at = NULL,
               row_version = row_version + 1, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        ).run(body.label, body.unit ?? null, valueType, norm.value, now, req.user!.id, existing.id);
        const row = db.prepare('SELECT * FROM org_metric WHERE id = ?').get(existing.id) as MetricRow;
        logChange(db, {
          actorId: req.user!.id,
          entity: 'org_metric',
          entityId: row.id,
          action: 'restore',
          before: existing,
          after: row,
        });
        // 복원도 의존 자동배점 문항 재검토 대상 — '입력값 없음' 확정 상태가 조용히 남는 것 방지
        db.prepare(
          `UPDATE auto_score_state SET stale = 1
           WHERE question_id IN (SELECT question_id FROM auto_rule WHERE source_metric_key = ?)`,
        ).run(body.metricKey);
        return { kind: 'ok', row, action: 'restore' };
      }
      const info = db
        .prepare(
          `INSERT INTO org_metric (cycle_id, metric_key, label, value, unit, value_type, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          activeCycle.id,
          body.metricKey,
          body.label,
          norm.value,
          body.unit ?? null,
          valueType,
          now,
          req.user!.id,
        );
      const row = db
        .prepare('SELECT * FROM org_metric WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as MetricRow;
      logChange(db, {
        actorId: req.user!.id,
        entity: 'org_metric',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return { kind: 'ok', row, action: 'create' };
    })();
    if (outcome.kind === 'duplicate') {
      res.status(400).json({ error: 'validation', details: '이미 존재하는 지표 키입니다.' });
      return;
    }
    if (outcome.kind === 'invalid') {
      res.status(400).json({ error: 'validation', details: outcome.reason });
      return;
    }
    res.status(201).json(metricPayload(outcome.row, userName(outcome.row.updated_by)));
  });

  // ---------- PATCH /api/org/metrics/:id ----------
  router.patch('/org/metrics/:id', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '지표 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = metricPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const now = new Date().toISOString();
    type Outcome =
      | { kind: 'not_found' }
      | { kind: 'conflict'; server: Record<string, unknown> }
      | { kind: 'invalid'; reason: string }
      | { kind: 'ok'; row: MetricRow };
    const outcome = db.transaction((): Outcome => {
      const row = db
        .prepare('SELECT * FROM org_metric WHERE id = ? AND deleted_at IS NULL')
        .get(id) as MetricRow | undefined;
      if (!row) return { kind: 'not_found' };
      if (body.rowVersion !== row.row_version) {
        logChange(db, {
          actorId: req.user!.id,
          entity: 'org_metric',
          entityId: id,
          action: 'conflict_lost',
          after: body,
        });
        return { kind: 'conflict', server: metricPayload(row, userName(row.updated_by)) };
      }
      const nextLabel = body.label !== undefined ? body.label : row.label;
      const nextUnit = body.unit !== undefined ? body.unit : row.unit;
      let nextValue = row.value;
      if ('value' in body) {
        const norm = normalizeValue(body.value, row.value_type);
        if (!norm.ok) return { kind: 'invalid', reason: norm.reason };
        nextValue = norm.value;
      }
      if (nextLabel === row.label && nextUnit === row.unit && nextValue === row.value) {
        return { kind: 'ok', row }; // 실변경 없음 — 멱등 (버전·로그 스킵)
      }
      db.prepare(
        `UPDATE org_metric
         SET label = ?, unit = ?, value = ?, row_version = row_version + 1,
             updated_at = ?, updated_by = ?
         WHERE id = ?`,
      ).run(nextLabel, nextUnit, nextValue, now, req.user!.id, id);
      const after = db.prepare('SELECT * FROM org_metric WHERE id = ?').get(id) as MetricRow;
      logChange(db, {
        actorId: req.user!.id,
        entity: 'org_metric',
        entityId: id,
        action: 'update',
        before: row,
        after,
      });
      // 지표 값 변경 → 조용한 재계산 금지: 의존 자동배점 문항의 스냅샷을 stale 로 표시,
      // 검수 큐에서 "X점→Y점" diff 를 원클릭 확정한다 (Phase 3a — A-3)
      if (nextValue !== row.value) {
        db.prepare(
          `UPDATE auto_score_state SET stale = 1
           WHERE question_id IN (SELECT question_id FROM auto_rule WHERE source_metric_key = ?)`,
        ).run(row.metric_key);
      }
      return { kind: 'ok', row: after };
    })();
    switch (outcome.kind) {
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'conflict':
        res.status(409).json({ error: 'conflict', server: outcome.server });
        return;
      case 'invalid':
        res.status(400).json({ error: 'validation', details: outcome.reason });
        return;
      case 'ok':
        res.json(metricPayload(outcome.row, userName(outcome.row.updated_by)));
    }
  });

  // ---------- DELETE /api/org/metrics/:id (soft delete) ----------
  router.delete('/org/metrics/:id', editor, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '지표 ID가 올바르지 않습니다.' });
      return;
    }
    const now = new Date().toISOString();
    const outcome = db.transaction((): 'not_found' | 'ok' => {
      const row = db
        .prepare('SELECT * FROM org_metric WHERE id = ? AND deleted_at IS NULL')
        .get(id) as MetricRow | undefined;
      if (!row) return 'not_found';
      db.prepare(
        `UPDATE org_metric
         SET deleted_at = ?, row_version = row_version + 1, updated_at = ?, updated_by = ?
         WHERE id = ?`,
      ).run(now, now, req.user!.id, id);
      logChange(db, {
        actorId: req.user!.id,
        entity: 'org_metric',
        entityId: id,
        action: 'delete',
        before: row,
      });
      // 삭제된 지표에 바인딩된 자동배점 문항도 재검토 대상 (계산 시 '입력값 없음' 처리)
      db.prepare(
        `UPDATE auto_score_state SET stale = 1
         WHERE question_id IN (SELECT question_id FROM auto_rule WHERE source_metric_key = ?)`,
      ).run(row.metric_key);
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
