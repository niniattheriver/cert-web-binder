/**
 * 야간 자동 백업 + 즉시 백업 번들 (설계서 §7 배포·백업)
 * - 앱 자체가 매일 03:00 SQLite 온라인 백업(VACUUM INTO)으로 data/backups/app-YYYYMMDD.db 생성.
 *   cron/작업 스케줄러 설정 불요 — process 로컬 타이머로 등록한다.
 * - 보존: 일 30개 + 월 12개. 초과분은 정리한다(하드삭제 대상은 도메인 데이터가 아닌 백업 파일이므로 허용).
 * - POST /api/admin/backup = 즉시 DB 스냅샷 + 파일 매니페스트를 ZIP 번들로 산출.
 * - 회사 측 실제 파일 백업 절차는 "data/ 폴더 복사"(내용주소·불변이라 자연 증분) — 이 잡은 DB 중심.
 *
 * (Date.now/new Date는 실제 서버 런타임 코드이므로 사용 가능 — 워크플로 스크립트 아님.)
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { contentPath, contentRelPath } from '../docs/store.js';
import { attachmentPath } from '../richdocs/service.js';
import { zipEntries } from './zip.js';

const DAILY_KEEP = 30; // 최근 30일치 일일 백업 보존
const MONTHLY_KEEP = 12; // 월별 대표 백업 12개월 보존
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 로컬 시각 기준 YYYYMMDD */
export function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** 로컬 시각 기준 YYYYMMDD-HHMMSS */
export function timestampLabel(d: Date): string {
  return `${yyyymmdd(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function dailyBackupName(d: Date): string {
  return `app-${yyyymmdd(d)}.db`;
}

export interface BackupResult {
  file: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * VACUUM INTO 로 온라인 스냅샷을 만든다(WAL 반영·조각모음된 단일 파일).
 * 대상 파일이 이미 있으면 먼저 지운다(VACUUM INTO는 기존 파일에 실패).
 */
export function vacuumInto(db: Database.Database, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const p = targetPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

/** 야간 스냅샷: data/backups/app-YYYYMMDD.db (같은 날 재실행 시 갱신) */
export function runDailyBackup(
  db: Database.Database,
  backupsDir: string,
  now: Date = new Date(),
): BackupResult {
  const file = dailyBackupName(now);
  const filePath = path.join(backupsDir, file);
  vacuumInto(db, filePath);
  const sizeBytes = fs.statSync(filePath).size;
  return { file, filePath, sizeBytes, createdAt: now.toISOString() };
}

interface DatedFile {
  name: string;
  date: Date;
  ym: string;
  day: number;
}

function listDailyBackups(backupsDir: string): DatedFile[] {
  if (!fs.existsSync(backupsDir)) return [];
  const result: DatedFile[] = [];
  for (const name of fs.readdirSync(backupsDir)) {
    const m = /^app-(\d{4})(\d{2})(\d{2})\.db$/.exec(name);
    if (!m) continue; // pre-import-*.db 등은 정리 대상 아님
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    result.push({
      name,
      date: new Date(y, mo - 1, d),
      ym: `${m[1]}${m[2]}`,
      day: d,
    });
  }
  return result;
}

export interface PruneResult {
  kept: string[];
  deleted: string[];
}

/**
 * 보존 정책 적용: 최근 30일치 전부 유지 + 그보다 오래된 것은 월별 최신 1개만(12개월) 유지.
 * app-YYYYMMDD.db 형식만 대상 — pre-import 스냅샷·수동 파일은 건드리지 않는다.
 */
export function pruneBackups(backupsDir: string, now: Date = new Date()): PruneResult {
  const files = listDailyBackups(backupsDir);
  const keep = new Set<string>();
  const older: DatedFile[] = [];

  for (const f of files) {
    const ageDays = (now.getTime() - f.date.getTime()) / DAY_MS;
    if (ageDays < DAILY_KEEP) keep.add(f.name);
    else older.push(f);
  }

  // 월별 대표(그 달의 최신 일자) 선정 → 최근 12개월치만 유지
  const byMonth = new Map<string, DatedFile>();
  for (const f of older) {
    const cur = byMonth.get(f.ym);
    if (!cur || f.day > cur.day) byMonth.set(f.ym, f);
  }
  const reps = [...byMonth.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
  for (const rep of reps.slice(0, MONTHLY_KEEP)) keep.add(rep.name);

  const deleted: string[] = [];
  for (const f of files) {
    if (!keep.has(f.name)) {
      fs.rmSync(path.join(backupsDir, f.name));
      deleted.push(f.name);
    }
  }
  return { kept: [...keep].sort(), deleted: deleted.sort() };
}

export interface FileManifestRow {
  sha256: string;
  fileName: string;
  sizeBytes: number;
  relPath: string;
  exists: boolean;
}

export interface FileManifest {
  generatedAt: string;
  fileCount: number;
  totalBytes: number;
  missingCount: number;
  missing: { sha256: string; fileName: string }[];
  files: FileManifestRow[];
}

/**
 * 내용주소 파일 매니페스트 — document_version PDF + (Phase 2) 문항 첨부·지침서 원본.
 * data/ 폴더를 다른 장비로 복사·복원한 뒤 근거 파일 누락 여부를 검증하는 용도.
 */
export function buildFileManifest(
  db: Database.Database,
  filesDir: string,
  now: Date = new Date(),
): FileManifest {
  const rows = db
    .prepare(
      `SELECT file_sha256 AS sha256, MIN(file_name) AS fileName, MAX(file_size) AS sizeBytes
       FROM document_version GROUP BY file_sha256 ORDER BY file_sha256`,
    )
    .all() as { sha256: string; fileName: string; sizeBytes: number }[];
  // 첨부 저장소(files/attachments/) 참조분 — 문항 첨부(soft delete 포함: 파일은 보존 대상)
  // + 지침서 원본파일 + 자유문서 에디터 이미지(attachment 테이블) (Phase 2)
  const attachRows = db
    .prepare(
      `SELECT sha256, MIN(fileName) AS fileName, MAX(sizeBytes) AS sizeBytes FROM (
         SELECT sha256, orig_name AS fileName, size AS sizeBytes
         FROM question_attachment
         UNION ALL
         SELECT source_sha256, source_name, source_size
         FROM document_version WHERE source_sha256 IS NOT NULL
         UNION ALL
         SELECT sha256, orig_name, size FROM attachment
       ) GROUP BY sha256 ORDER BY sha256`,
    )
    .all() as { sha256: string; fileName: string; sizeBytes: number }[];

  const files: FileManifestRow[] = [];
  const missing: { sha256: string; fileName: string }[] = [];
  let totalBytes = 0;
  for (const r of rows) {
    const exists = fs.existsSync(contentPath(filesDir, r.sha256));
    if (exists) totalBytes += r.sizeBytes ?? 0;
    else missing.push({ sha256: r.sha256, fileName: r.fileName });
    files.push({
      sha256: r.sha256,
      fileName: r.fileName,
      sizeBytes: r.sizeBytes ?? 0,
      relPath: contentRelPath(r.sha256),
      exists,
    });
  }
  for (const r of attachRows) {
    const abs = attachmentPath(filesDir, r.sha256);
    const exists = fs.existsSync(abs);
    if (exists) totalBytes += r.sizeBytes ?? 0;
    else missing.push({ sha256: r.sha256, fileName: r.fileName });
    files.push({
      sha256: r.sha256,
      fileName: r.fileName,
      sizeBytes: r.sizeBytes ?? 0,
      relPath: path.relative(filesDir, abs),
      exists,
    });
  }
  return {
    generatedAt: now.toISOString(),
    fileCount: files.length,
    totalBytes,
    missingCount: missing.length,
    missing,
    files,
  };
}

export interface BundleResult {
  zipFile: string;
  zipPath: string;
  zipBytes: number;
  snapshotBytes: number;
  manifest: { fileCount: number; totalBytes: number; missingCount: number };
  createdAt: string;
}

/**
 * 즉시 백업 번들: VACUUM 스냅샷 + 파일 매니페스트(JSON)를 한 ZIP으로 묶어 backups/에 저장.
 * 스냅샷은 임시 파일로 만든 뒤 ZIP에 담고 삭제 — 루즈 .db 파일이 쌓이지 않는다.
 */
export function createBackupBundle(
  db: Database.Database,
  backupsDir: string,
  filesDir: string,
  now: Date = new Date(),
): BundleResult {
  fs.mkdirSync(backupsDir, { recursive: true });
  const label = timestampLabel(now);
  const tmpSnapshot = path.join(backupsDir, `.tmp-backup-${label}-${process.pid}.db`);
  vacuumInto(db, tmpSnapshot);
  try {
    const snapshotBuf = fs.readFileSync(tmpSnapshot);
    const manifest = buildFileManifest(db, filesDir, now);
    const zipBuf = zipEntries([
      { name: `app-${label}.db`, data: snapshotBuf, date: now },
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
        date: now,
      },
    ]);
    const zipFile = `backup-${label}.zip`;
    const zipPath = path.join(backupsDir, zipFile);
    fs.writeFileSync(zipPath, zipBuf);
    return {
      zipFile,
      zipPath,
      zipBytes: zipBuf.length,
      snapshotBytes: snapshotBuf.length,
      manifest: {
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        missingCount: manifest.missingCount,
      },
      createdAt: now.toISOString(),
    };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = tmpSnapshot + suffix;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
}

/** 다음 지정 시각(로컬)까지 남은 ms */
export function msUntilNext(hour: number, minute: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface Scheduler {
  stop(): void;
}

/**
 * 매일 03:00 백업 + 보존 정리를 등록한다(process 로컬 타이머, cron 불요).
 * 타이머는 unref — 백업 스케줄이 프로세스 종료를 막지 않는다.
 */
export function startBackupScheduler(
  db: Database.Database,
  backupsDir: string,
  opts: { hour?: number; minute?: number } = {},
): Scheduler {
  const hour = opts.hour ?? 3;
  const minute = opts.minute ?? 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  const runOnce = () => {
    try {
      const res = runDailyBackup(db, backupsDir);
      const prune = pruneBackups(backupsDir);
      console.log(
        `[백업] ${res.file} (${(res.sizeBytes / 1024 / 1024).toFixed(1)}MB)` +
          (prune.deleted.length ? ` · 정리 ${prune.deleted.length}개` : ''),
      );
    } catch (err) {
      console.error('[백업] 실패:', (err as Error).message);
    }
  };

  const firstDelay = msUntilNext(hour, minute);
  const startTimer = setTimeout(() => {
    runOnce();
    interval = setInterval(runOnce, DAY_MS);
    interval.unref?.();
  }, firstDelay);
  startTimer.unref?.();

  console.log(
    `[백업] 매일 ${pad2(hour)}:${pad2(minute)} 자동 백업 예약됨 (다음 실행까지 ${Math.round(firstDelay / 60000)}분)`,
  );

  return {
    stop() {
      clearTimeout(startTimer);
      if (interval) clearInterval(interval);
    },
  };
}
