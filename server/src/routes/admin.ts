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
import { createBackupBundle, createFullBackupBundle } from '../jobs/backup.js';
import { getLastIntegrityResult, runAndPersist } from '../jobs/integrity.js';

export interface AdminRouterDeps {
  dataDir: string;
  filesDir: string;
  backupsDir: string;
}

// 파일시스템이 이보다 크다고 보고하면 허위값으로 본다(Docker Desktop bind mount가
// 수십 TB대 가짜 용량을 반환하는 사례 실측 — 내부망 단일 서버에서 비상식 규모).
const DISK_SANITY_LIMIT = 64 * 1024 * 1024 * 1024 * 1024; // 64TiB

/** statfs 원시값 → 게이지 값. 비상식 값이면 null(화면은 "확인 불가"로 표시). */
export function computeDiskUsage(s: {
  blocks: number;
  bsize: number;
  bavail: number;
}): { totalBytes: number; freeBytes: number; usedPct: number } | null {
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return null;
  if (totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes) return null;
  if (totalBytes > DISK_SANITY_LIMIT) return null;
  const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
  return { totalBytes, freeBytes, usedPct };
}

function diskUsage(dir: string): { totalBytes: number; freeBytes: number; usedPct: number } | null {
  try {
    return computeDiskUsage(fs.statfsSync(dir));
  } catch {
    return null; // statfs 미지원 플랫폼 → 게이지 생략
  }
}

function backupSummary(backupsDir: string): { count: number; latest: string | null; latestBytes: number | null; latestAt: string | null } {
  if (!fs.existsSync(backupsDir)) return { count: 0, latest: null, latestBytes: null, latestAt: null };
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => /^app-\d{8}\.db$/.test(f) || /^(backup|full-backup)-.*\.zip$/.test(f));
  if (files.length === 0) return { count: 0, latest: null, latestBytes: null, latestAt: null };
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
  return {
    count: files.length,
    latest,
    latestBytes,
    latestAt: latestMtime >= 0 ? new Date(latestMtime).toISOString() : null,
  };
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

  // 전체 백업(PDF 포함) — 몇 분 걸릴 수 있어 동시 실행은 막는다(라우터 인스턴스 로컬 플래그)
  let fullBackupRunning = false;
  router.post('/backup/full', async (req, res, next) => {
    if (fullBackupRunning) {
      res.status(409).json({
        error: 'backup_in_progress',
        details: '이미 전체 백업이 진행 중입니다. 잠시 후 다시 시도하세요.',
      });
      return;
    }
    fullBackupRunning = true;
    try {
      const bundle = await createFullBackupBundle(db, deps.backupsDir, deps.filesDir);
      logChange(db, {
        actorId: req.user?.id ?? null,
        actorKind: 'user',
        entity: 'backup',
        entityId: 0,
        action: 'create',
        after: {
          kind: 'full',
          zipFile: bundle.zipFile,
          zipBytes: bundle.zipBytes,
          fileCount: bundle.fileCount,
          missingCount: bundle.missingCount,
        },
      });
      res.json({ ok: true, ...bundle });
    } catch (err) {
      next(err);
    } finally {
      fullBackupRunning = false;
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
