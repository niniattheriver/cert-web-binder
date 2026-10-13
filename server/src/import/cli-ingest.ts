// CLI: 문항 PDF 일괄 인입 (초기 1,000문항 인입용 — 설계서 §10 Day 1)
//
// 사용법:
//   npx tsx server/src/import/cli-ingest.ts <pdf...> [--commit] [--mode=overwrite|keep_existing] [--db=DB경로]
//
// 기본은 드라이런(파일별 요약 출력·DB 도메인 무변경). --commit 시 커밋(actor_kind='import').
// --db 미지정 시 config.json의 dataDir/app.db 사용. 지정한 DB가 빈 파일이면 001_init.sql을 적용한다.
// 스냅샷은 DB 파일과 같은 디렉토리의 backups/에 남는다.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { commitBatch, dryRunFromFiles, type ImportMode } from './question-pdf-service.js';

interface CliArgs {
  pdfs: string[];
  commit: boolean;
  mode: ImportMode;
  dbPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { pdfs: [], commit: false, mode: 'overwrite', dbPath: null };
  for (const a of argv) {
    if (a === '--commit') args.commit = true;
    else if (a.startsWith('--mode=')) {
      const m = a.slice('--mode='.length);
      if (m !== 'overwrite' && m !== 'keep_existing') {
        fail(`--mode는 overwrite 또는 keep_existing이어야 합니다: ${m}`);
      }
      args.mode = m as ImportMode;
    } else if (a.startsWith('--db=')) args.dbPath = a.slice('--db='.length);
    else if (a.startsWith('--')) fail(`알 수 없는 옵션: ${a}`);
    else args.pdfs.push(a);
  }
  return args;
}

function fail(msg: string): never {
  process.stderr.write(`[cli-ingest] ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.pdfs.length === 0) {
    fail(
      '사용법: npx tsx server/src/import/cli-ingest.ts <pdf...> [--commit] [--mode=overwrite|keep_existing] [--db=DB경로]',
    );
  }

  let dbFile: string;
  if (args.dbPath) {
    dbFile = path.resolve(args.dbPath);
  } else {
    // 기본 DB(data/app.db)는 config 로더를 통해 해석 — --db 사용 시에는 config를 건드리지 않는다.
    const { dataDir } = await import('../config.js');
    dbFile = path.join(dataDir, 'app.db');
  }

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    // 마이그레이션 러너로 스키마를 최신(001+002…)까지 적용 — 앱 기동과 동일 경로.
    // 빈 DB는 전량 적용, 기존 DB는 미적용분만 올린다(user_version 추적).
    const applied = runMigrations(db);
    if (applied.length > 0) {
      const version = db.pragma('user_version', { simple: true });
      console.log(
        `[cli-ingest] 마이그레이션 적용(${applied.join(', ')}) → user_version=${version}: ${dbFile}`,
      );
    }

    const files = args.pdfs.map((p) => {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) fail(`파일이 없습니다: ${abs}`);
      return { name: path.basename(abs), buffer: new Uint8Array(fs.readFileSync(abs)) };
    });

    console.log(`[cli-ingest] DB: ${dbFile}`);
    const dry = await dryRunFromFiles(db, files, null);
    console.log(`[드라이런] batchId=${dry.batchId}, 파일 ${dry.files.length}개`);
    let totalQuestions = 0;
    for (const f of dry.files) {
      totalQuestions += f.questionCount;
      console.log(
        `  - ${f.fileName}: 분야 ${f.categoryCode ?? '?'}(${f.categoryName ?? '분야명 미검출'}) · ` +
          `문항 ${f.questionCount}건 · 개정표 ${f.revisionRows}행 · 경고 ${f.warnings.length}건`,
      );
      for (const w of f.warnings) console.log(`      경고: ${w}`);
    }
    console.log(`[드라이런] 총 문항 ${totalQuestions}건`);

    if (!args.commit) {
      console.log('[cli-ingest] 드라이런만 수행했습니다. 반영하려면 --commit 플래그를 추가하세요.');
      return;
    }

    const backupDir = path.join(path.dirname(dbFile), 'backups');
    const r = await commitBatch(db, dry.batchId, args.mode, null, { backupDir });
    console.log(
      `[커밋] mode=${args.mode} → 생성 ${r.created} · 갱신 ${r.updated} · 변화없음 ${r.unchanged} · ` +
        `분야 생성 ${r.categoriesCreated} (cycleId=${r.cycleId})`,
    );
    for (const s of r.skipped) {
      console.log(`  건너뜀: ${s.fileName} ${s.questionNo} — ${s.reason}`);
    }
    for (const d of r.revisionDeleted) {
      console.log(`  개정표 '삭제' 행(보고만, 삭제하지 않음): ${d.questionNo} — ${d.note}`);
    }
    if (r.snapshotFile) console.log(`[스냅샷] ${r.snapshotFile}`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  const e = err as { name?: string; message?: string };
  process.stderr.write(`[cli-ingest 실패] ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}\n`);
  process.exit(1);
});
