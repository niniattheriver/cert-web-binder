/**
 * 실물 문항 PDF 재인입 CLI (v1.5 Phase 3b — A-1 비파괴 재인입)
 * `_로컬자료/문항PDF/` 전량을 드라이런 → pre-import 스냅샷 → 단일 트랜잭션 커밋한다.
 *
 * **사람 승인 게이트**: 이 CLI는 승인된 재인입의 "실행" 단계다. 실행 전 반드시
 * 드라이런 diff 리포트(가져오기 화면 또는 이전 드라이런)를 사람이 확인해야 한다.
 *
 * 실행:   npm run reingest -w server            (기본 디렉토리 ../_로컬자료/문항PDF)
 *         npm run reingest -w server -- <pdf-dir>
 * 대상 DB: <repo>/data/app.db (운영 DB — 커밋 직전 data/backups/ 스냅샷 자동 생성)
 * 불가침: 채점·답변·지적·검토·근거 매핑. 갱신은 파서 소유분(body·topic·챕터·sort·개정정보)만.
 * 이 스크립트 자체는 실물 텍스트를 포함하지 않으므로 저장소에 커밋해도 안전하다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db/migrate.js';
import { commitBatch, dryRunFromFiles } from './question-pdf-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..');
const pdfDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(rootDir, '_로컬자료', '문항PDF');

async function main(): Promise<void> {
  if (!fs.existsSync(pdfDir)) {
    console.error(`문항 PDF 디렉토리가 없습니다: ${pdfDir}`);
    process.exitCode = 1;
    return;
  }
  const dbFile = path.join(rootDir, 'data', 'app.db');
  if (!fs.existsSync(dbFile)) {
    console.error(`운영 DB가 없습니다: ${dbFile}`);
    process.exitCode = 1;
    return;
  }
  const db = openDatabase(dbFile);
  db.pragma('busy_timeout = 15000');
  try {
    const files = fs
      .readdirSync(pdfDir)
      .filter((n) => n.toLowerCase().endsWith('.pdf'))
      .sort()
      .map((n) => ({ name: n, buffer: new Uint8Array(fs.readFileSync(path.join(pdfDir, n))) }));
    if (files.length === 0) {
      console.error(`PDF가 없습니다: ${pdfDir}`);
      process.exitCode = 1;
      return;
    }

    console.log(`드라이런 중… (${files.length}개 파일)`);
    const dry = await dryRunFromFiles(db, files, null);
    console.log(`  batchId=${dry.batchId}`);

    console.log('커밋(reingest, 스냅샷 포함) 중…');
    const res = await commitBatch(db, dry.batchId, 'reingest', null, {
      backupDir: path.join(rootDir, 'data', 'backups'),
    });
    console.log('── 커밋 결과 ──');
    console.log(`  신규 ${res.created} / 갱신 ${res.updated} / 동일 ${res.unchanged}`);
    console.log(`  분야 생성 ${res.categoriesCreated} / 건너뜀 ${res.skipped.length}`);
    console.log(`  보호필드 차이(미덮어씀·needs_recheck) ${res.protectedDiffs.length}`);
    console.log(
      `  세부항목 자동적용(composite) ${res.criteriaApplied} / 수동검수 ${res.criteriaManual.length} / 위반 ${res.criteriaViolations.length}`,
    );
    console.log(`  자동배점 후보 ${res.autoCandidates.length} (활성화는 수동 — A-3)`);
    console.log(`  스냅샷 백업: ${res.snapshotFile}`);

    // 사후 검증 — 챕터 채움/불가침 필드 요약
    const total = (
      db.prepare(`SELECT COUNT(*) n FROM question WHERE deleted_at IS NULL`).get() as { n: number }
    ).n;
    const nullMaj = (
      db
        .prepare(`SELECT COUNT(*) n FROM question WHERE deleted_at IS NULL AND chapter_major IS NULL`)
        .get() as { n: number }
    ).n;
    const withMinor = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM question WHERE deleted_at IS NULL AND chapter_minor IS NOT NULL`,
        )
        .get() as { n: number }
    ).n;
    console.log('── 사후 검증 ──');
    console.log(
      `  전체 ${total} / 대분류 채워짐 ${total - nullMaj} / 소분류 있음 ${withMinor} / 대분류 NULL ${nullMaj}`,
    );
  } finally {
    db.close();
  }
  console.log('완료. 브라우저에서 분야 화면을 새로고침하면 목차가 반영됩니다.');
}

void main();
