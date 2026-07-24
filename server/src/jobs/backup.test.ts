// 백업 잡 단위 검증 — VACUUM 스냅샷 생성·보존 정리·파일 매니페스트·즉시 번들.
import Database from 'better-sqlite3';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { contentPath } from '../docs/store.js';
import {
  buildFileManifest,
  createBackupBundle,
  createFullBackupBundle,
  dailyBackupName,
  pruneBackups,
  runDailyBackup,
  msUntilNext,
} from './backup.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-backup-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedDb(): Database.Database {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name) VALUES (1,'50','개인정보')`).run();
  db.prepare(
    `INSERT INTO question (category_id, question_no, body, updated_at) VALUES (1,'50.010.010','문항',?)`,
  ).run(now);
  db.prepare(`INSERT INTO document (code, title) VALUES ('D1','지침')`).run();
  return db;
}

describe('runDailyBackup + vacuumInto', () => {
  it('VACUUM INTO 스냅샷 파일을 만들고 열 수 있다', () => {
    const db = seedDb();
    const backupsDir = path.join(tmp, 'backups');
    const now = new Date(2026, 6, 13, 3, 0, 0); // 2026-07-13 03:00 (로컬)
    const res = runDailyBackup(db, backupsDir, now);

    expect(res.file).toBe('app-20260713.db');
    expect(fs.existsSync(res.filePath)).toBe(true);
    expect(res.sizeBytes).toBeGreaterThan(0);

    // 스냅샷이 정상 SQLite DB인지 — 열어서 시드 데이터 확인
    const snap = new Database(res.filePath, { readonly: true });
    const cat = snap.prepare('SELECT code FROM category').get() as { code: string };
    expect(cat.code).toBe('50');
    snap.close();
    db.close();
  });

  it('같은 날 재실행 시 덮어쓴다(기존 파일 충돌 없이)', () => {
    const db = seedDb();
    const backupsDir = path.join(tmp, 'backups');
    const now = new Date(2026, 6, 13, 3, 0, 0);
    runDailyBackup(db, backupsDir, now);
    expect(() => runDailyBackup(db, backupsDir, now)).not.toThrow();
    db.close();
  });
});

describe('pruneBackups 보존 정책', () => {
  it('최근 30일은 전부 유지, 그 이전은 월별 대표 1개(최근 12개월)만 유지', () => {
    const backupsDir = path.join(tmp, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const now = new Date(2027, 5, 15); // 2027-06-15 기준

    // 월 1개씩 30개월(각 달 15일) — 경계 모호성 없이 대표 판정
    const names: string[] = [];
    for (let m = 0; m < 30; m++) {
      const dt = new Date(2027, 5, 15);
      dt.setMonth(dt.getMonth() - m);
      const y = dt.getFullYear();
      const mo = String(dt.getMonth() + 1).padStart(2, '0');
      names.push(`app-${y}${mo}15.db`);
    }
    // 정리 대상 아님(형식 불일치) — 남아야 함
    names.push('pre-import-20260101-0300.db');
    names.push('backup-20270610-120000.zip');
    for (const n of names) fs.writeFileSync(path.join(backupsDir, n), 'x');

    const res = pruneBackups(backupsDir, now);
    const remaining = fs.readdirSync(backupsDir);
    const appKept = remaining.filter((n) => /^app-\d{8}\.db$/.test(n)).sort();

    // 30일 내 1개(2027-06-15) + 그 이전 월별 대표 12개월 = 13개
    expect(appKept.length).toBe(13);
    expect(remaining).toContain('app-20270615.db'); // 최근(일일)
    expect(remaining).toContain('app-20270515.db'); // 최신 월별 대표
    expect(remaining).toContain('app-20260615.db'); // 12번째(가장 오래된 유지 월)
    expect(remaining).not.toContain('app-20260515.db'); // 13개월 전 → 삭제
    // 무관 파일은 보존
    expect(remaining).toContain('pre-import-20260101-0300.db');
    expect(remaining).toContain('backup-20270610-120000.zip');
    expect(res.deleted.length).toBe(17);
  });
});

describe('buildFileManifest', () => {
  it('디스크에 있는 파일과 누락 파일을 구분한다', () => {
    const db = seedDb();
    const filesDir = path.join(tmp, 'files');
    const now = new Date().toISOString();
    const present = 'a'.repeat(64);
    const missing = 'b'.repeat(64);
    const insV = db.prepare(
      `INSERT INTO document_version
         (document_id, version_label, file_sha256, file_name, file_size, status, is_current, uploaded_at)
       VALUES (1,?,?,?,?,'active',?,?)`,
    );
    insV.run('v1', present, 'present.pdf', 1234, 1, now);
    insV.run('v2', missing, 'missing.pdf', 5678, 0, now);

    // present 파일만 디스크에 배치
    const p = contentPath(filesDir, present);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'pdf');

    const man = buildFileManifest(db, filesDir);
    expect(man.fileCount).toBe(2);
    expect(man.missingCount).toBe(1);
    expect(man.missing[0]!.sha256).toBe(missing);
    expect(man.totalBytes).toBe(1234); // 존재하는 것만 합산
    db.close();
  });
});

describe('createBackupBundle', () => {
  it('스냅샷+매니페스트 ZIP을 만들고 임시 .db는 남기지 않는다', () => {
    const db = seedDb();
    const backupsDir = path.join(tmp, 'backups');
    const filesDir = path.join(tmp, 'files');
    const now = new Date(2026, 6, 13, 9, 30, 15);
    const res = createBackupBundle(db, backupsDir, filesDir, now);

    expect(res.zipFile).toBe('backup-20260713-093015.zip');
    expect(fs.existsSync(res.zipPath)).toBe(true);
    expect(res.zipBytes).toBeGreaterThan(0);
    expect(res.snapshotBytes).toBeGreaterThan(0);

    // 임시 스냅샷 미잔존
    expect(fs.readdirSync(backupsDir).filter((f) => f.startsWith('.tmp-backup-'))).toHaveLength(0);

    // ZIP 안의 manifest.json 을 inflate 해 확인
    const buf = fs.readFileSync(res.zipPath);
    let i = 0;
    let manifestJson: string | null = null;
    while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const compressedSize = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
      const dataStart = i + 30 + nameLen + extraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (name === 'manifest.json') {
        manifestJson = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      }
      i = dataStart + compressedSize;
    }
    expect(manifestJson).not.toBeNull();
    const parsed = JSON.parse(manifestJson!);
    expect(parsed).toHaveProperty('fileCount');
    expect(parsed).toHaveProperty('files');
    db.close();
  });
});

describe('createFullBackupBundle (전체 백업 — PDF 포함)', () => {
  it('data/app.db + data/files/… + manifest.json 을 담고, 누락 파일은 건너뛰며 집계한다', async () => {
    const db = seedDb();
    const backupsDir = path.join(tmp, 'backups');
    const filesDir = path.join(tmp, 'files');
    const now = new Date(2026, 6, 13, 9, 30, 15);
    const nowIso = now.toISOString();

    const present = 'a'.repeat(64);
    const missing = 'b'.repeat(64);
    const insV = db.prepare(
      `INSERT INTO document_version
         (document_id, version_label, file_sha256, file_name, file_size, status, is_current, uploaded_at)
       VALUES (1,?,?,?,?,'active',?,?)`,
    );
    insV.run('v1', present, 'present.pdf', 7, 1, nowIso);
    insV.run('v2', missing, 'missing.pdf', 5678, 0, nowIso);
    const p = contentPath(filesDir, present);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'pdf-데이터');

    const res = await createFullBackupBundle(db, backupsDir, filesDir, now);
    expect(res.zipFile).toBe('full-backup-20260713-093015.zip');
    expect(fs.existsSync(res.zipPath)).toBe(true);
    expect(res.fileCount).toBe(1); // present 만 담김
    expect(res.missingCount).toBe(1);

    // 임시 파일 미잔존
    expect(fs.readdirSync(backupsDir).filter((f) => f.startsWith('.tmp-'))).toHaveLength(0);

    // 왕복: 로컬 헤더 스캔
    const buf = fs.readFileSync(res.zipPath);
    const names: string[] = [];
    let dbBytes: Buffer | null = null;
    let pdfBytes: Buffer | null = null;
    let i = 0;
    while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const compressedSize = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
      const dataStart = i + 30 + nameLen + extraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      const content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
      names.push(name);
      if (name === 'data/app.db') dbBytes = content;
      if (name.startsWith('data/files/')) pdfBytes = content;
      i = dataStart + compressedSize;
    }
    expect(names).toContain('data/app.db');
    expect(names).toContain('manifest.json');
    expect(names.some((n) => n.startsWith('data/files/'))).toBe(true);
    expect(names.every((n) => !n.includes('\\'))).toBe(true); // 엔트리명 / 정규화
    expect(pdfBytes!.toString('utf8')).toBe('pdf-데이터');

    // 추출한 DB 스냅샷이 정상 SQLite 인지 — 파일로 써서 열어본다(복원 리허설)
    const restored = path.join(tmp, 'restored.db');
    fs.writeFileSync(restored, dbBytes!);
    const snap = new Database(restored, { readonly: true });
    const cat = snap.prepare('SELECT code FROM category').get() as { code: string };
    expect(cat.code).toBe('50');
    snap.close();
    db.close();
  });
});

describe('msUntilNext', () => {
  it('오늘 지정 시각 이전이면 오늘, 이후면 내일까지의 ms', () => {
    const before = new Date(2026, 6, 13, 1, 0, 0); // 01:00 → 03:00까지 2시간
    expect(msUntilNext(3, 0, before)).toBe(2 * 60 * 60 * 1000);
    const after = new Date(2026, 6, 13, 5, 0, 0); // 05:00 → 다음날 03:00까지 22시간
    expect(msUntilNext(3, 0, after)).toBe(22 * 60 * 60 * 1000);
  });

  it('dailyBackupName은 로컬 YYYYMMDD를 쓴다', () => {
    expect(dailyBackupName(new Date(2026, 0, 5))).toBe('app-20260105.db');
  });
});
