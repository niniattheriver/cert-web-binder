/**
 * 관리 라우트 (설계서 §7 백업·무결성·저장공간, API 계약)
 * 마운트는 index.ts에서 requireAdmin으로 감싸므로 이 라우터의 모든 엔드포인트는 admin 전용이다.
 *  - POST /api/admin/backup       즉시 DB 스냅샷 + 파일 매니페스트 ZIP 번들 생성
 *  - GET  /api/admin/integrity    마지막 무결성 점검 결과(없으면 즉석 실행)
 *  - POST /api/admin/integrity/run 무결성 점검 즉시 실행 + 보존
 *  - GET  /api/admin/status       대시보드용: 디스크 게이지 + 백업/무결성 요약 + 실효 설정
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logChange } from '../db/change-log.js';
import { createBackupBundle } from '../jobs/backup.js';
import { getLastIntegrityResult, runAndPersist } from '../jobs/integrity.js';

export interface AdminRouterDeps {
  dataDir: string;
  filesDir: string;
  backupsDir: string;
}

function diskUsage(dir: string): { totalBytes: number; freeBytes: number; usedPct: number } | null {
  try {
    const s = fs.statfsSync(dir);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedPct = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
    return { totalBytes, freeBytes, usedPct };
  } catch {
    return null; // statfs 미지원 플랫폼 → 게이지 생략
  }
}

function backupSummary(backupsDir: string): { count: number; latest: string | null; latestBytes: number | null } {
  if (!fs.existsSync(backupsDir)) return { count: 0, latest: null, latestBytes: null };
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => /^app-\d{8}\.db$/.test(f) || /^backup-.*\.zip$/.test(f));
  if (files.length === 0) return { count: 0, latest: null, latestBytes: null };
  let latest: string | null = null;
  let latestMtime = -1;
  for (const f of files) {
    const st = fs.statSync(path.join(backupsDir, f));
    if (st.mtimeMs > latestMtime) {
      latestMtime = st.mtimeMs;
      latest = f;
    }
  }
  const latestBytes = latest ? fs.statSync(path.join(backupsDir, latest)).size : null;
  return { count: files.length, latest, latestBytes };
}

export function createAdminRouter(db: Database.Database, deps: AdminRouterDeps): Router {
  const router = Router();

  // 즉시 백업 번들 — DB 스냅샷 + 파일 매니페스트 ZIP
  router.post('/backup', (req, res, next) => {
    try {
      const bundle = createBackupBundle(db, deps.backupsDir, deps.filesDir);
      logChange(db, {
        actorId: req.user?.id ?? null,
        actorKind: 'user',
        entity: 'backup',
        entityId: 0,
        action: 'create',
        after: { zipFile: bundle.zipFile, zipBytes: bundle.zipBytes, manifest: bundle.manifest },
      });
      res.json({ ok: true, ...bundle });
    } catch (err) {
      next(err);
    }
  });

  // 무결성 점검 즉시 실행
  router.post('/integrity/run', (_req, res, next) => {
    try {
      res.json(runAndPersist(db, deps.filesDir));
    } catch (err) {
      next(err);
    }
  });

  // 마지막 무결성 결과 (없으면 즉석 실행 후 보존)
  router.get('/integrity', (_req, res, next) => {
    try {
      res.json(getLastIntegrityResult(db) ?? runAndPersist(db, deps.filesDir));
    } catch (err) {
      next(err);
    }
  });

  // 대시보드 요약
  router.get('/status', (_req, res, next) => {
    try {
      const integrity = getLastIntegrityResult(db);
      res.json({
        disk: diskUsage(deps.dataDir),
        backups: backupSummary(deps.backupsDir),
        integrity: integrity ? { ok: integrity.ok, checkedAt: integrity.checkedAt } : null,
        config: { port: config.port, dataDir: deps.dataDir, maxPdfMB: config.maxPdfMB },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
