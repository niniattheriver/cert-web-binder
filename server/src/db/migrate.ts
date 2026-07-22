/**
 * 마이그레이션 러너 (설계서 §7 업그레이드 절차)
 * - db/migrations/NNN_*.sql 을 파일명 순으로 적용하고 PRAGMA user_version으로 추적한다.
 * - 각 파일은 단일 트랜잭션 — 중간 실패 시 해당 파일 전체가 롤백되고 기동이 중단된다.
 * - 테스트용 임시 DB도 openDatabase()로 동일 스키마를 얻는다(부작용 없는 모듈).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

interface MigrationFile {
  version: number;
  fileName: string;
  fullPath: string;
}

/** migrations/ 디렉토리에서 NNN_*.sql 목록을 번호 순으로 수집 */
export function listMigrations(dir: string = migrationsDir): MigrationFile[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  const result: MigrationFile[] = [];
  for (const fileName of files) {
    const m = /^(\d+)/.exec(fileName);
    if (!m) continue;
    const version = Number.parseInt(m[1]!, 10);
    if (result.some((r) => r.version === version)) {
      throw new Error(`마이그레이션 번호 중복: ${fileName} (버전 ${version})`);
    }
    result.push({ version, fileName, fullPath: path.join(dir, fileName) });
  }
  return result;
}

/**
 * 미적용 마이그레이션을 순서대로 적용한다. 실패 시 명확한 한국어 에러를 던진다(기동 중단).
 * @returns 이번 기동에서 새로 적용된 파일명 목록
 */
export function runMigrations(db: Database.Database, dir: string = migrationsDir): string[] {
  const applied: string[] = [];
  const migrations = listMigrations(dir);
  for (const mig of migrations) {
    const current = db.pragma('user_version', { simple: true }) as number;
    if (mig.version <= current) continue;
    if (mig.version !== current + 1) {
      throw new Error(
        `마이그레이션 순서 오류: 현재 user_version=${current} 인데 다음 파일이 ${mig.fileName} 입니다. ` +
          `누락된 번호가 없는지 확인하세요.`,
      );
    }
    const sql = fs.readFileSync(mig.fullPath, 'utf8');
    try {
      db.transaction(() => {
        db.exec(sql);
        db.pragma(`user_version = ${mig.version}`);
      })();
      applied.push(mig.fileName);
    } catch (err) {
      throw new Error(
        `마이그레이션 실패: ${mig.fileName} — ${(err as Error).message} (전체 롤백됨, 기동 중단)`,
        { cause: err },
      );
    }
  }
  return applied;
}

/**
 * DB 파일을 열고(WAL·외래키 강제) 마이그레이션까지 적용해 반환한다.
 * 앱 본체와 테스트(임시 파일 경로)가 공용으로 사용.
 */
export function openDatabase(dbFilePath: string): Database.Database {
  const db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
