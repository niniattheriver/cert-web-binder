// 문항 PDF 인입 서비스 테스트 — :memory: DB + 마이그레이션 러너(001+002) 적용.
// (runMigrations 사용으로 002의 question_type/grade_symbol 열까지 프로덕션과 동일하게 확보 — 프레시 마이그레이션 리허설 겸용)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BatchNotFoundError,
  categoryCodeFromFileName,
  commitBatch,
  dryRunFromParsed,
  type ParsedFileInput,
} from './question-pdf-service.js';
import { runMigrations } from '../db/migrate.js';
import { getActiveCycle } from '../routes/questions.js';
import type { ParseResult } from '../pdf/question-parser/types.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // 001~007 전체 적용 → user_version=7
  // change_log.actor_id / question.updated_by FK용 테스트 사용자 (id=1)
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role) VALUES ('tester', 'x', '테스터', 'editor')`,
  ).run();
  return db;
}

/** 기본 픽스처: 분야 50, 문항 3건, 개정표(수정 1행 + 삭제 1행) */
function fixtureA(): ParseResult {
  return {
    categoryCode: '50',
    categoryName: '개인정보보호',
    revisionSummary: [
      { kind: 'modified', questionNo: '50.010.020', note: '배점 변경' },
      { kind: 'deleted', questionNo: '50.999.999', note: '문항 삭제' },
    ],
    questions: [
      { questionNo: '50.010.010', body: '개인정보 처리방침을 공개하고 있는가?', maxScore: 5, allowNa: false },
      { questionNo: '50.010.020', body: '수집 항목을 최소한으로 제한하고 있는가?', maxScore: 3, allowNa: true },
      { questionNo: '50.010.030', body: '파기 절차를 문서화하여 이행하고 있는가?', maxScore: 2, allowNa: false },
    ],
    warnings: [],
  };
}

function filesOf(parse: ParseResult, fileName = '가상문항-50.pdf'): ParsedFileInput[] {
  return [{ fileName, parse }];
}

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
});

afterEach(() => {
  db.close();
});

function commitFixture(parse: ParseResult, mode: 'overwrite' | 'keep_existing' = 'overwrite') {
  const dry = dryRunFromParsed(db, filesOf(parse), 1);
  return { dry, result: commitBatch(db, dry.batchId, mode, 1, {}) };
}

describe('드라이런', () => {
  it('계약 형태 응답 + import_batch 기록, 도메인 테이블은 무변경', () => {
    const dry = dryRunFromParsed(db, filesOf(fixtureA()), 1);
    expect(dry.batchId).toBeGreaterThan(0);
    expect(dry.files).toHaveLength(1);
    const f = dry.files[0]!;
    expect(f.fileName).toBe('가상문항-50.pdf');
    expect(f.categoryCode).toBe('50');
    expect(f.categoryName).toBe('개인정보보호');
    expect(f.questionCount).toBe(3);
    expect(f.revisionRows).toBe(2);
    expect(f.warnings).toEqual([]);
    expect(f.questions[0]).toEqual({
      questionNo: '50.010.010',
      body: '개인정보 처리방침을 공개하고 있는가?',
      maxScore: 5,
      allowNa: false,
    });

    const batch = db
      .prepare(`SELECT kind, dry_run, summary_json FROM import_batch WHERE id = ?`)
      .get(dry.batchId) as { kind: string; dry_run: number; summary_json: string };
    expect(batch.kind).toBe('question_pdf');
    expect(batch.dry_run).toBe(1);
    expect(JSON.parse(batch.summary_json).files).toHaveLength(1);

    // 드라이런은 도메인 데이터를 만들지 않는다
    for (const table of ['cycle', 'category', 'question', 'change_log']) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(n.n, table).toBe(0);
    }
  });
});

describe('커밋 — 신규', () => {
  it('active cycle 없으면 생성, 분야·문항 생성 수 집계, sort_key=파싱 순서', async () => {
    const { result } = commitFixture(fixtureA());
    const r = await result;
    expect(r.created).toBe(3);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(0);
    expect(r.categoriesCreated).toBe(1);

    const cycle = db.prepare(`SELECT id, status FROM cycle`).get() as { id: number; status: string };
    expect(cycle.status).toBe('active');
    expect(r.cycleId).toBe(cycle.id);

    const cat = db.prepare(`SELECT code, name, cycle_id FROM category`).get() as {
      code: string; name: string; cycle_id: number;
    };
    expect(cat).toEqual({ code: '50', name: '개인정보보호', cycle_id: cycle.id });

    const rows = db
      .prepare(`SELECT question_no, sort_key, body, max_score, allow_na, row_version FROM question ORDER BY sort_key`)
      .all() as Array<{ question_no: string; sort_key: number; max_score: number; allow_na: number; row_version: number }>;
    expect(rows.map((x) => x.question_no)).toEqual(['50.010.010', '50.010.020', '50.010.030']);
    expect(rows.map((x) => x.sort_key)).toEqual([0, 1, 2]);
    expect(rows[1]!.max_score).toBe(3);
    expect(rows[1]!.allow_na).toBe(1);
    expect(rows[0]!.row_version).toBe(1);
  });

  it('개정표 매칭 시 revision_status/note 기록, 비매칭은 NULL', async () => {
    await commitFixture(fixtureA()).result;
    const modified = db
      .prepare(`SELECT revision_status, revision_note FROM question WHERE question_no = '50.010.020'`)
      .get() as { revision_status: string; revision_note: string };
    expect(modified).toEqual({ revision_status: 'modified', revision_note: '배점 변경' });
    const plain = db
      .prepare(`SELECT revision_status, revision_note FROM question WHERE question_no = '50.010.010'`)
      .get() as { revision_status: string | null; revision_note: string | null };
    expect(plain).toEqual({ revision_status: null, revision_note: null });
  });
});

describe('커밋 — 멱등', () => {
  it('동일 내용 재커밋(새 배치) → 전부 unchanged, row_version 불변', async () => {
    await commitFixture(fixtureA()).result;
    const r2 = await commitFixture(fixtureA()).result;
    expect(r2).toMatchObject({ created: 0, updated: 0, unchanged: 3, categoriesCreated: 0 });
    const versions = db.prepare(`SELECT row_version FROM question`).all() as Array<{ row_version: number }>;
    expect(versions.every((v) => v.row_version === 1)).toBe(true);
  });

  it('같은 배치 재커밋도 멱등(unchanged)', async () => {
    const { dry, result } = commitFixture(fixtureA());
    await result;
    const r2 = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    expect(r2).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
  });
});

describe('커밋 — overwrite / keep_existing', () => {
  it("overwrite: 본문·배점·해당없음 갱신 + row_version 증가", async () => {
    await commitFixture(fixtureA()).result;
    const changed = fixtureA();
    changed.questions[0]!.body = '개인정보 처리방침을 홈페이지에 공개하고 있는가?';
    const r = await commitFixture(changed).result;
    expect(r).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    const row = db
      .prepare(`SELECT body, row_version FROM question WHERE question_no = '50.010.010'`)
      .get() as { body: string; row_version: number };
    expect(row.body).toBe('개인정보 처리방침을 홈페이지에 공개하고 있는가?');
    expect(row.row_version).toBe(2);
  });

  it('keep_existing: 기존 행은 본문이 달라도 건너뜀(unchanged), 신규만 생성', async () => {
    await commitFixture(fixtureA()).result;
    const changed = fixtureA();
    changed.questions[0]!.body = '완전히 다른 본문';
    changed.questions.push({
      questionNo: '50.010.040', body: '신규 점검 항목인가?', maxScore: 1, allowNa: false,
    });
    const r = await commitFixture(changed, 'keep_existing').result;
    expect(r).toMatchObject({ created: 1, updated: 0, unchanged: 3 });
    const row = db
      .prepare(`SELECT body, row_version FROM question WHERE question_no = '50.010.010'`)
      .get() as { body: string; row_version: number };
    expect(row.body).toBe('개인정보 처리방침을 공개하고 있는가?'); // 원본 유지
    expect(row.row_version).toBe(1);
    const added = db.prepare(`SELECT body FROM question WHERE question_no = '50.010.040'`).get();
    expect(added).toBeTruthy();
  });

  it('기존 답변·채점·지적사항은 어떤 모드에서도 불변', async () => {
    await commitFixture(fixtureA()).result;
    db.prepare(
      `UPDATE question SET answer_choice='yes', score=4, findings_text='접근권한 분기 점검 누락',
              answer_json='{"type":"doc"}', answer_plain='답변 본문'
        WHERE question_no='50.010.010'`,
    ).run();
    const changed = fixtureA();
    changed.questions[0]!.body = '본문 개정판';
    await commitFixture(changed).result; // overwrite
    const row = db
      .prepare(
        `SELECT body, answer_choice, score, findings_text, answer_json, answer_plain
           FROM question WHERE question_no='50.010.010'`,
      )
      .get() as Record<string, unknown>;
    expect(row.body).toBe('본문 개정판');
    expect(row.answer_choice).toBe('yes');
    expect(row.score).toBe(4);
    expect(row.findings_text).toBe('접근권한 분기 점검 누락');
    expect(row.answer_json).toBe('{"type":"doc"}');
    expect(row.answer_plain).toBe('답변 본문');
  });
});

describe('커밋 — 스킵/경고 행', () => {
  it('파일 내 중복 문항번호는 첫 행만 반영하고 skipped에 사유 기록', async () => {
    const parse = fixtureA();
    parse.questions.push({
      questionNo: '50.010.010', body: '중복된 행', maxScore: 9, allowNa: false,
    });
    const r = await commitFixture(parse).result;
    expect(r.created).toBe(3);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ questionNo: '50.010.010' });
    expect(r.skipped[0]!.reason).toContain('중복');
    const row = db
      .prepare(`SELECT body FROM question WHERE question_no='50.010.010'`)
      .get() as { body: string };
    expect(row.body).toBe('개인정보 처리방침을 공개하고 있는가?'); // 첫 행 값
  });

  it('문항번호 형식 불일치 행은 스킵하고 사유 기록', async () => {
    const parse = fixtureA();
    parse.questions.push({ questionNo: '50.10.10', body: '형식 이상', maxScore: 1, allowNa: false });
    const r = await commitFixture(parse).result;
    expect(r.created).toBe(3);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain('형식');
  });
});

describe('커밋 — 삭제 금지 / 개정표 삭제 행', () => {
  it("개정표 '삭제' 행은 보고만 하고 기존 문항을 절대 삭제하지 않는다", async () => {
    await commitFixture(fixtureA()).result;
    const catId = (db.prepare(`SELECT id FROM category WHERE code='50'`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO question (category_id, question_no, sort_key, body, updated_at)
       VALUES (?, '50.999.999', 99, '작년에 있던 문항', ?)`,
    ).run(catId, new Date().toISOString());

    const r = await commitFixture(fixtureA()).result;
    expect(r.revisionDeleted).toEqual([
      { fileName: '가상문항-50.pdf', questionNo: '50.999.999', note: '문항 삭제' },
    ]);
    const row = db
      .prepare(`SELECT deleted_at FROM question WHERE question_no='50.999.999'`)
      .get() as { deleted_at: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row!.deleted_at).toBeNull(); // soft delete조차 하지 않음 — 보고만
  });
});

describe('커밋 — change_log / needs_recheck / 스냅샷', () => {
  it("모든 생성·갱신이 change_log(actor_kind='import', batch_id, action='import')에 남는다", async () => {
    const { dry, result } = commitFixture(fixtureA());
    await result;
    const logs = db
      .prepare(
        `SELECT entity, action, actor_kind, batch_id FROM change_log
          WHERE batch_id = ? AND action = 'import'`,
      )
      .all(dry.batchId) as Array<{ entity: string; actor_kind: string }>;
    expect(logs.filter((l) => l.entity === 'question')).toHaveLength(3);
    expect(logs.filter((l) => l.entity === 'category')).toHaveLength(1);
    expect(logs.every((l) => l.actor_kind === 'import')).toBe(true);

    // 갱신도 before/after와 함께 기록
    const changed = fixtureA();
    changed.questions[0]!.body = '개정된 본문';
    const second = commitFixture(changed);
    await second.result;
    const upd = db
      .prepare(
        `SELECT before_json, after_json FROM change_log
          WHERE batch_id = ? AND entity = 'question' AND action = 'import'`,
      )
      .all(second.dry.batchId) as Array<{ before_json: string | null; after_json: string | null }>;
    expect(upd).toHaveLength(1);
    expect(JSON.parse(upd[0]!.before_json!).body).toBe('개인정보 처리방침을 공개하고 있는가?');
    expect(JSON.parse(upd[0]!.after_json!).body).toBe('개정된 본문');
  });

  it('overwrite로 배점이 기존 점수 미만으로 줄면 needs_recheck=1 (§6.2 채점 정합성)', async () => {
    await commitFixture(fixtureA()).result;
    db.prepare(`UPDATE question SET answer_choice='yes', score=5 WHERE question_no='50.010.010'`).run();
    const changed = fixtureA();
    changed.questions[0]!.maxScore = 3; // 5점 취득 상태에서 배점 3으로 축소
    await commitFixture(changed).result;
    const row = db
      .prepare(`SELECT needs_recheck, score FROM question WHERE question_no='50.010.010'`)
      .get() as { needs_recheck: number; score: number };
    expect(row.needs_recheck).toBe(1);
    expect(row.score).toBe(5); // 점수 자체는 건드리지 않는다(재검토는 사람이)
  });

  it('backupDir 지정 시 커밋 직전 pre-import-*.db 스냅샷 생성 + 배치 행 갱신', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-backup-'));
    try {
      const dry = dryRunFromParsed(db, filesOf(fixtureA()), 1);
      const r = await commitBatch(db, dry.batchId, 'overwrite', 1, { backupDir: tmp });
      expect(r.snapshotFile).toBeTruthy();
      expect(path.basename(r.snapshotFile!)).toMatch(/^pre-import-\d{8}-\d{4}/);
      expect(fs.existsSync(r.snapshotFile!)).toBe(true);
      const batch = db
        .prepare(`SELECT dry_run, snapshot_file FROM import_batch WHERE id = ?`)
        .get(dry.batchId) as { dry_run: number; snapshot_file: string };
      expect(batch.dry_run).toBe(0);
      expect(batch.snapshot_file).toBe(r.snapshotFile);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('존재하지 않는 배치 커밋 → BatchNotFoundError', async () => {
    await expect(commitBatch(db, 12345, 'overwrite', 1, {})).rejects.toBeInstanceOf(BatchNotFoundError);
  });
});

// ── 임무 W: 파일명 코드 · 문항 유형 · needs_recheck 트리거 ──────────────────────

/** 실물형 픽스처: parse.categoryCode=null(파서 계약), 유형기호(C/R/B)·영숫자 번호 포함 */
function fixtureReal(): ParseResult {
  return {
    categoryCode: null,
    categoryName: '분자진단검사',
    revisionSummary: [
      { kind: 'modified', questionNo: '90.010.090', note: '설명 수정' },
      { kind: 'modified', questionNo: '90.210.420', note: '문항 수정, 설명 수정, 배점 변경' },
    ],
    questions: [
      { questionNo: '90.010.090', body: '핵심 문항 본문', maxScore: 8, allowNa: false, questionType: 'core', gradeSymbol: 'C' },
      { questionNo: '90.A01.080', body: '필요 문항 본문(영숫자 번호)', maxScore: 4, allowNa: true, questionType: 'required', gradeSymbol: 'R' },
      { questionNo: '90.210.420', body: '기본 문항 본문', maxScore: 2, allowNa: false, questionType: 'basic', gradeSymbol: 'B' },
    ],
    warnings: [],
  };
}

describe('프레시 마이그레이션(007)', () => {
  it('makeDb는 user_version=7 이며 question에 유형·채점·챕터·자동배점 열이 존재한다', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    const cols = (db.prepare(`PRAGMA table_info(question)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('question_type');
    expect(cols).toContain('grade_symbol');
    expect(cols).toContain('scoring_mode');
    expect(cols).toContain('topic');
    expect(cols).toContain('score_overridden');
    expect(cols).toContain('score_autofilled');
    expect(cols).toContain('chapter_major');
    expect(cols).toContain('chapter_minor');
  });

  it('003 채점·기관지표 5종 + 004 첨부·링크 테이블이 생성된다', () => {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const t of [
      'question_criterion', 'auto_rule', 'auto_rule_band', 'org_metric', 'auto_score_state',
      'question_attachment', 'question_link',
    ]) {
      expect(tables).toContain(t);
    }
    const dvCols = (
      db.prepare(`PRAGMA table_info(document_version)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(dvCols).toContain('source_sha256');
  });
});

describe('파일명 기반 분야코드 (설계서 §6.2-1 계약)', () => {
  it('categoryCodeFromFileName: NFD(macOS 파일명) → NFC 정규화 — 중복 분야 생성 방지', () => {
    const nfd = '2026_분자진단검사.pdf'.normalize('NFD');
    expect(categoryCodeFromFileName(nfd)).toBe('분자진단검사'.normalize('NFC'));
    expect(categoryCodeFromFileName(nfd).length).toBe(6); // 자모 분해(16자) 아님
  });

  it('categoryCodeFromFileName: 선행 YYYY_ 와 확장자 제거, 내부 밑줄 보존', () => {
    expect(categoryCodeFromFileName('2026_분자진단검사.pdf')).toBe('분자진단검사');
    expect(categoryCodeFromFileName('2026_임상화학_요경검학.pdf')).toBe('임상화학_요경검학');
    expect(categoryCodeFromFileName('2026_수혈의학.PDF')).toBe('수혈의학');
    expect(categoryCodeFromFileName('연도없는분야.pdf')).toBe('연도없는분야'); // YYYY_ 없으면 stem 그대로
  });

  it('parse.categoryCode=null이면 드라이런·커밋 모두 파일명에서 코드 도출, 분야명은 표지 우선', async () => {
    const parse = fixtureReal();
    const dry = dryRunFromParsed(db, filesOf(parse, '2026_임상화학_요경검학.pdf'), 1);
    expect(dry.files[0]!.categoryCode).toBe('임상화학_요경검학');
    expect(dry.files[0]!.categoryName).toBe('분자진단검사'); // 표지 파서값 우선
    const r = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    expect(r.created).toBe(3);
    const cat = db.prepare(`SELECT code, name FROM category`).get() as { code: string; name: string };
    expect(cat).toEqual({ code: '임상화학_요경검학', name: '분자진단검사' });
  });

  it('표지 분야명이 없으면 categoryName = 파일명 코드', () => {
    const parse = fixtureReal();
    parse.categoryName = null;
    const dry = dryRunFromParsed(db, filesOf(parse, '2026_수탁검사.pdf'), 1);
    expect(dry.files[0]!.categoryName).toBe('수탁검사');
  });
});

describe('문항 유형(question_type/grade_symbol) 저장', () => {
  it('신규 커밋 시 유형·유형기호를 저장', async () => {
    const dry = dryRunFromParsed(db, filesOf(fixtureReal(), '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const rows = db
      .prepare(`SELECT question_no, question_type, grade_symbol FROM question ORDER BY sort_key`)
      .all() as Array<{ question_no: string; question_type: string | null; grade_symbol: string | null }>;
    expect(rows).toEqual([
      { question_no: '90.010.090', question_type: 'core', grade_symbol: 'C' },
      { question_no: '90.A01.080', question_type: 'required', grade_symbol: 'R' },
      { question_no: '90.210.420', question_type: 'basic', grade_symbol: 'B' },
    ]);
  });

  it('유형 미검출(undefined) 문항은 NULL 저장', async () => {
    const parse = fixtureReal();
    delete parse.questions[0]!.questionType;
    delete parse.questions[0]!.gradeSymbol;
    const dry = dryRunFromParsed(db, filesOf(parse, '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const row = db
      .prepare(`SELECT question_type, grade_symbol FROM question WHERE question_no='90.010.090'`)
      .get() as { question_type: string | null; grade_symbol: string | null };
    expect(row).toEqual({ question_type: null, grade_symbol: null });
  });

  it('overwrite: 유형 변경 시 갱신 + row_version 증가', async () => {
    let dry = dryRunFromParsed(db, filesOf(fixtureReal(), '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const changed = fixtureReal();
    changed.questions[2]!.questionType = 'required'; // basic → required
    changed.questions[2]!.gradeSymbol = 'R';
    dry = dryRunFromParsed(db, filesOf(changed, '2026_분자진단검사.pdf'), 1);
    const r = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    expect(r.updated).toBe(1);
    const row = db
      .prepare(`SELECT question_type, grade_symbol, row_version FROM question WHERE question_no='90.210.420'`)
      .get() as { question_type: string; grade_symbol: string; row_version: number };
    expect(row).toMatchObject({ question_type: 'required', grade_symbol: 'R', row_version: 2 });
  });

  it('keep_existing: 유형이 달라도 기존 값 유지', async () => {
    let dry = dryRunFromParsed(db, filesOf(fixtureReal(), '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const changed = fixtureReal();
    changed.questions[0]!.questionType = 'basic';
    changed.questions[0]!.gradeSymbol = 'B';
    dry = dryRunFromParsed(db, filesOf(changed, '2026_분자진단검사.pdf'), 1);
    const r = await commitBatch(db, dry.batchId, 'keep_existing', 1, {});
    expect(r.unchanged).toBe(3);
    const row = db
      .prepare(`SELECT question_type, grade_symbol FROM question WHERE question_no='90.010.090'`)
      .get() as { question_type: string; grade_symbol: string };
    expect(row).toEqual({ question_type: 'core', grade_symbol: 'C' });
  });

  it('동일 유형 재커밋은 unchanged (유형이 멱등 판정에 포함)', async () => {
    const dry1 = dryRunFromParsed(db, filesOf(fixtureReal(), '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry1.batchId, 'overwrite', 1, {});
    const dry2 = dryRunFromParsed(db, filesOf(fixtureReal(), '2026_분자진단검사.pdf'), 1);
    const r2 = await commitBatch(db, dry2.batchId, 'overwrite', 1, {});
    expect(r2).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
  });
});

describe('개정표 매칭 → needs_recheck 트리거 (배점변경·해당없음유무변경)', () => {
  it('신규 인입: 사유에 "배점 변경" 포함이면 needs_recheck=1, 그 외 사유는 0', async () => {
    const dry = dryRunFromParsed(db, filesOf(fixtureReal(), '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const trig = db
      .prepare(`SELECT needs_recheck FROM question WHERE question_no='90.210.420'`)
      .get() as { needs_recheck: number };
    expect(trig.needs_recheck).toBe(1); // note='문항 수정, 설명 수정, 배점 변경'
    const plain = db
      .prepare(`SELECT needs_recheck FROM question WHERE question_no='90.010.090'`)
      .get() as { needs_recheck: number };
    expect(plain.needs_recheck).toBe(0); // note='설명 수정'
  });

  it('"해당없음 유무변경" 사유도 needs_recheck=1', async () => {
    const parse = fixtureReal();
    parse.revisionSummary = [{ kind: 'modified', questionNo: '90.010.090', note: '해당없음 유무변경' }];
    const dry = dryRunFromParsed(db, filesOf(parse, '2026_분자진단검사.pdf'), 1);
    await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const row = db
      .prepare(`SELECT needs_recheck, revision_note FROM question WHERE question_no='90.010.090'`)
      .get() as { needs_recheck: number; revision_note: string };
    expect(row.needs_recheck).toBe(1);
    expect(row.revision_note).toBe('해당없음 유무변경');
  });
});

describe('재인입 (A-1 — 비파괴 upsert + 화이트리스트)', () => {
  /** 채점·답변이 붙은 상태를 만든 뒤 파서 개선분(topic·챕터·body 수정)을 재인입한다 */
  function seedAndScore(): void {
    void commitFixture(fixtureA(), 'overwrite');
    // 사용자 데이터 부착 (불가침 필드)
    db.prepare(
      `UPDATE question SET answer_choice='yes', score=4, findings_text='기존 지적',
                           answer_plain='기존 답변', reviewed=1
       WHERE question_no='50.010.010'`,
    ).run();
  }

  function reingestFixture(): ParseResult {
    const p = fixtureA();
    p.questions = p.questions.map((q, i) => ({
      ...q,
      topic: `주제 ${i + 1}`,
      chapterMajor: '1 가상 대분류',
      chapterMinor: i === 0 ? '1. 가상 중분류' : null,
      body: i === 0 ? q.body + '\n(파서 개선으로 설명 정제)' : q.body,
    }));
    return p;
  }

  it('파서 소유분(body·topic·챕터)만 갱신 — 채점·답변·지적·검토는 불변', async () => {
    seedAndScore();
    const dry = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    const d = dry.files[0]!.diff;
    expect(d.create).toBe(0);
    expect(d.update).toBe(3); // topic/챕터 전 행 + body 1행
    expect(d.fieldChanges['topic']).toBe(3);
    expect(d.fieldChanges['chapterMajor']).toBe(3);
    expect(d.fieldChanges['body']).toBe(1);
    expect(d.protectedDiffs).toEqual([]);
    expect(d.missingInPdf).toEqual([]);

    const r = await commitBatch(db, dry.batchId, 'reingest', 1, {});
    expect(r.updated).toBe(3);
    const row = db
      .prepare(
        `SELECT topic, chapter_major, chapter_minor, answer_choice, score, findings_text,
                answer_plain, reviewed, body
         FROM question WHERE question_no='50.010.010'`,
      )
      .get() as Record<string, unknown>;
    expect(row.topic).toBe('주제 1');
    expect(row.chapter_major).toBe('1 가상 대분류');
    expect(row.chapter_minor).toBe('1. 가상 중분류');
    expect(row.body).toContain('파서 개선으로 설명 정제');
    // 불가침 필드 보존
    expect(row.answer_choice).toBe('yes');
    expect(row.score).toBe(4);
    expect(row.findings_text).toBe('기존 지적');
    expect(row.answer_plain).toBe('기존 답변');
    expect(row.reviewed).toBe(1);
  });

  it('보호 필드(배점/유형) 차이 → 덮어쓰지 않고 needs_recheck + 차이 목록', async () => {
    seedAndScore();
    const p = reingestFixture();
    p.questions[0] = { ...p.questions[0]!, maxScore: 10 }; // 배점 5 → 10 상이
    const dry = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry.files[0]!.diff.protectedDiffs).toEqual([
      { questionNo: '50.010.010', field: 'maxScore', current: 5, parsed: 10 },
    ]);
    const r = await commitBatch(db, dry.batchId, 'reingest', 1, {});
    expect(r.protectedDiffs).toHaveLength(1);
    const row = db
      .prepare(`SELECT max_score, needs_recheck FROM question WHERE question_no='50.010.010'`)
      .get() as { max_score: number; needs_recheck: number };
    expect(row.max_score).toBe(5); // 보존 — 덮어쓰지 않음
    expect(row.needs_recheck).toBe(1);
  });

  it('세부항목표: 계약 통과 + 미채점 → 항목 인입 + composite 전환 / 채점 존재 → 수동 전환(검수)', async () => {
    seedAndScore();
    const p = reingestFixture();
    const items = [
      { label: '항목 하나', maxScore: 1 },
      { label: '항목 둘', maxScore: 2 },
    ];
    p.questions[0] = { ...p.questions[0]!, subItems: items }; // 채점 존재(Σ3 ≠ 배점5 → 위반이 아니라..)
    p.questions[2] = { ...p.questions[2]!, subItems: items }; // 미채점, 배점 2... Σ3 ≠ 2 → 위반
    // 계약 정합을 위해 배점 맞춤: q0(배점5)엔 Σ5, q2(배점2)엔 Σ2
    p.questions[0] = {
      ...p.questions[0]!,
      subItems: [
        { label: '항목 하나', maxScore: 2 },
        { label: '항목 둘', maxScore: 3 },
      ],
    };
    p.questions[2] = {
      ...p.questions[2]!,
      subItems: [
        { label: '항목 하나', maxScore: 0.5 },
        { label: '항목 둘', maxScore: 1.5 },
      ],
    };
    const dry = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry.files[0]!.diff.criteriaEligible).toBe(1); // q2 (미채점)
    expect(dry.files[0]!.diff.criteriaManual).toEqual(['50.010.010']); // q0 (채점 존재)

    const r = await commitBatch(db, dry.batchId, 'reingest', 1, {});
    expect(r.criteriaApplied).toBe(1);
    expect(r.criteriaManual).toEqual([{ fileName: '가상문항-50.pdf', questionNo: '50.010.010' }]);
    const q2 = db
      .prepare(`SELECT id, scoring_mode, needs_recheck FROM question WHERE question_no='50.010.030'`)
      .get() as { id: number; scoring_mode: string; needs_recheck: number };
    expect(q2.scoring_mode).toBe('composite'); // 미채점 → 자동 전환
    const crit = db
      .prepare(`SELECT label, max_score, score FROM question_criterion WHERE question_id = ? ORDER BY sort`)
      .all(q2.id) as Array<{ label: string; max_score: number; score: number | null }>;
    expect(crit).toEqual([
      { label: '항목 하나', max_score: 0.5, score: null },
      { label: '항목 둘', max_score: 1.5, score: null },
    ]);
    const q0 = db
      .prepare(`SELECT scoring_mode, score, needs_recheck FROM question WHERE question_no='50.010.010'`)
      .get() as { scoring_mode: string; score: number; needs_recheck: number };
    expect(q0.scoring_mode).toBe('simple'); // 채점 존재 — 조용한 전환 금지
    expect(q0.score).toBe(4); // 점수 보존
    expect(q0.needs_recheck).toBe(1);
  });

  it('세부항목표 계약 위반(Σ≠배점) → 부분 인입 금지 + needs_recheck', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    const p = reingestFixture();
    p.questions[1] = {
      ...p.questions[1]!,
      subItems: [{ label: '항목', maxScore: 99 }], // Σ99 ≠ 배점3
    };
    const dry = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry.files[0]!.diff.criteriaViolations).toEqual([
      { questionNo: '50.010.020', reason: 'Σ세부배점(99) ≠ 문항배점(3)' },
    ]);
    const r = await commitBatch(db, dry.batchId, 'reingest', 1, {});
    expect(r.criteriaViolations).toHaveLength(1);
    const q = db
      .prepare(
        `SELECT q.needs_recheck, (SELECT COUNT(*) FROM question_criterion c WHERE c.question_id = q.id) AS crit
         FROM question q WHERE q.question_no='50.010.020'`,
      )
      .get() as { needs_recheck: number; crit: number };
    expect(q.crit).toBe(0); // 부분 인입 금지
    expect(q.needs_recheck).toBe(1);
  });

  it('재인입 멱등: 동일 내용 재커밋 → 전량 unchanged', async () => {
    seedAndScore();
    const dry1 = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    await commitBatch(db, dry1.batchId, 'reingest', 1, {});
    const dry2 = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    expect(dry2.files[0]!.diff.update).toBe(0);
    expect(dry2.files[0]!.diff.unchanged).toBe(3);
    const r2 = await commitBatch(db, dry2.batchId, 'reingest', 1, {});
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(3);
  });

  it('PDF에 없는 DB 문항 → missingInPdf 보고만(삭제 없음)', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    const p = reingestFixture();
    p.questions = p.questions.slice(0, 2); // 50.010.030 누락
    const dry = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry.files[0]!.diff.missingInPdf).toEqual(['50.010.030']);
    await commitBatch(db, dry.batchId, 'reingest', 1, {});
    const n = (db
      .prepare(`SELECT COUNT(*) AS n FROM question WHERE deleted_at IS NULL`)
      .get() as { n: number }).n;
    expect(n).toBe(3); // 삭제 없음
  });

  // ── 리뷰 확정 결함 회귀 (①~⑥) ──

  it('① soft-delete 문항이 PDF에 다시 담기면 드라이런은 update로 보고하고 커밋이 부활시킨다', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    const dry1 = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    await commitBatch(db, dry1.batchId, 'reingest', 1, {}); // topic/chapter 정착
    db.prepare(`UPDATE question SET deleted_at='2026-01-01' WHERE question_no='50.010.030'`).run();

    const dry2 = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    const d = dry2.files[0]!.diff;
    expect(d.create).toBe(0); // soft-delete를 create로 오보하지 않는다
    expect(d.update).toBe(1); // 부활 대상
    expect(d.unchanged).toBe(2);
    expect(d.missingInPdf).toEqual([]); // 이미 삭제된 행은 '누락'이 아니다

    const r = await commitBatch(db, dry2.batchId, 'reingest', 1, {});
    expect(r.updated).toBe(1);
    expect(r.created).toBe(0);
    const row = db
      .prepare(`SELECT deleted_at FROM question WHERE question_no='50.010.030'`)
      .get() as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull(); // 부활됨
  });

  it('② 구배치(topic/chapter 필드 없음) 재커밋은 기존 topic·chapter를 소거하지 않는다', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    const dry1 = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    await commitBatch(db, dry1.batchId, 'reingest', 1, {}); // topic='주제 1', chapter 정착

    // 3b 이전 배치를 흉내 — topic/chapterMajor/chapterMinor 키 자체가 없음(undefined)
    const oldFmt = reingestFixture();
    oldFmt.questions = oldFmt.questions.map((q) => {
      const { topic, chapterMajor, chapterMinor, ...rest } = q;
      void topic; void chapterMajor; void chapterMinor;
      return rest;
    });
    const dry2 = dryRunFromParsed(db, filesOf(oldFmt), 1);
    // 파서가 필드를 안 실었으므로 topic/chapter 변경으로 세지 않는다
    expect(dry2.files[0]!.diff.fieldChanges['topic']).toBeUndefined();
    expect(dry2.files[0]!.diff.fieldChanges['chapterMajor']).toBeUndefined();
    expect(dry2.files[0]!.diff.unchanged).toBe(3);

    await commitBatch(db, dry2.batchId, 'reingest', 1, {});
    const row = db
      .prepare(`SELECT topic, chapter_major FROM question WHERE question_no='50.010.010'`)
      .get() as { topic: string | null; chapter_major: string | null };
    expect(row.topic).toBe('주제 1'); // 보존 — null로 소거되지 않음
    expect(row.chapter_major).toBe('1 가상 대분류');
  });

  it('③ 동일 세부항목표 2회차 드라이런은 criteria를 다시 경보하지 않는다', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    const p = reingestFixture();
    p.questions[2] = {
      ...p.questions[2]!,
      subItems: [
        { label: '항목 하나', maxScore: 0.5 },
        { label: '항목 둘', maxScore: 1.5 },
      ],
    }; // q030 배점2, Σ2 — 미채점
    const dry1 = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry1.files[0]!.diff.criteriaEligible).toBe(1);
    await commitBatch(db, dry1.batchId, 'reingest', 1, {}); // composite 전환

    const dry2 = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry2.files[0]!.diff.criteriaEligible).toBe(0); // 이미 적용됨 — 오경보 없음
    expect(dry2.files[0]!.diff.criteriaManual).toEqual([]);
  });

  it('④ revision_note가 동일하면 이미 해소된 needs_recheck를 재점화하지 않는다', async () => {
    void commitFixture(fixtureA(), 'overwrite'); // q020 note '배점 변경' → needs_recheck=1
    db.prepare(`UPDATE question SET needs_recheck=0 WHERE question_no='50.010.020'`).run(); // 사용자 해소

    const dry = dryRunFromParsed(db, filesOf(reingestFixture()), 1); // 같은 개정표(동일 note)
    const r = await commitBatch(db, dry.batchId, 'reingest', 1, {});
    void r;
    const same = db
      .prepare(`SELECT needs_recheck FROM question WHERE question_no='50.010.020'`)
      .get() as { needs_recheck: number };
    expect(same.needs_recheck).toBe(0); // 재점화 안 됨

    // 대조: note가 새 개정으로 바뀌면 재점화
    const p2 = reingestFixture();
    p2.revisionSummary = [{ kind: 'modified', questionNo: '50.010.020', note: '해당없음 유무변경' }];
    const dry2 = dryRunFromParsed(db, filesOf(p2), 1);
    await commitBatch(db, dry2.batchId, 'reingest', 1, {});
    const bumped = db
      .prepare(`SELECT needs_recheck FROM question WHERE question_no='50.010.020'`)
      .get() as { needs_recheck: number };
    expect(bumped.needs_recheck).toBe(1); // 새 개정 → 점화
  });

  it('⑤ soft-delete된 분야가 PDF에 다시 등장하면 커밋이 분야를 부활시킨다', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    db.prepare(`UPDATE category SET deleted_at='2026-01-01' WHERE code='50'`).run();

    const dry = dryRunFromParsed(db, filesOf(fixtureA()), 1);
    expect(dry.files[0]!.diff.create).toBe(0); // 삭제된 분야의 기존 문항을 전량 create로 오보하지 않는다
    const r = await commitBatch(db, dry.batchId, 'reingest', 1, {});
    expect(r.categoriesCreated).toBe(0); // 재생성이 아니라 부활
    const cat = db
      .prepare(`SELECT deleted_at FROM category WHERE code='50'`)
      .get() as { deleted_at: string | null };
    expect(cat.deleted_at).toBeNull();
  });

  it('⑥ composite 전환만 발생한 문항은 unchanged가 아니라 update로 집계 + change_log 기록', async () => {
    void commitFixture(fixtureA(), 'overwrite');
    const dry1 = dryRunFromParsed(db, filesOf(reingestFixture()), 1);
    await commitBatch(db, dry1.batchId, 'reingest', 1, {}); // topic/chapter 정착

    // q030에만 세부항목표 추가(그 외 전부 동일) — 유일한 변화는 composite 전환
    const p = reingestFixture();
    p.questions[2] = {
      ...p.questions[2]!,
      subItems: [
        { label: 'a', maxScore: 1 },
        { label: 'b', maxScore: 1 },
      ],
    };
    const dry2 = dryRunFromParsed(db, filesOf(p), 1);
    expect(dry2.files[0]!.diff.update).toBe(1); // q030 — unchanged 아님
    expect(dry2.files[0]!.diff.unchanged).toBe(2);

    const r = await commitBatch(db, dry2.batchId, 'reingest', 1, {});
    expect(r.criteriaApplied).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.unchanged).toBe(2);
    const q030 = db
      .prepare(`SELECT id, scoring_mode FROM question WHERE question_no='50.010.030'`)
      .get() as { id: number; scoring_mode: string };
    expect(q030.scoring_mode).toBe('composite');
    const flip = db
      .prepare(
        `SELECT after_json FROM change_log
         WHERE entity='question' AND entity_id=? AND after_json LIKE '%composite%'`,
      )
      .get(q030.id) as { after_json: string } | undefined;
    expect(flip).toBeTruthy(); // 모드 전환이 감사 이력에 남는다
  });
});

describe('자동배점 후보(auto_candidate) — 파서 소유 표시 필드', () => {
  function fixtureAuto(withAuto: boolean): ParseResult {
    const base = fixtureA();
    base.questions[1] = {
      ...base.questions[1]!,
      autoCandidate: withAuto ? { rows: ['100% (3)', '80~99% (2)', '80% 미만 (0)'] } : null,
    };
    return base;
  }

  it('신규 커밋 시 감지 문항만 auto_candidate=1, 재인입에서 감지 해제되면 0으로 갱신', async () => {
    await commitFixture(fixtureAuto(true)).result;
    const val = (no: string): number =>
      (db.prepare(`SELECT auto_candidate FROM question WHERE question_no = ?`).get(no) as {
        auto_candidate: number;
      }).auto_candidate;
    expect(val('50.010.020')).toBe(1);
    expect(val('50.010.010')).toBe(0);

    // 동일 재인입 → unchanged (auto_candidate 비교 포함 — 드라이런/커밋 판정 일치)
    const dry2 = dryRunFromParsed(db, filesOf(fixtureAuto(true)), 1);
    expect(dry2.files[0]!.diff.unchanged).toBe(3);
    const r2 = await commitBatch(db, dry2.batchId, 'reingest', 1, {});
    expect(r2.unchanged).toBe(3);

    // 파서가 더 이상 감지하지 않으면(개정으로 임계표 삭제) 0으로 되돌린다 — 파서 소유
    const dry3 = dryRunFromParsed(db, filesOf(fixtureAuto(false)), 1);
    expect(dry3.files[0]!.diff.update).toBe(1);
    await commitBatch(db, dry3.batchId, 'reingest', 1, {});
    expect(val('50.010.020')).toBe(0);
  });
});

// ── 연도 지정 가져오기 + 전년도 이월 ──────────────────

describe('연도 지정 가져오기 + 전년도 이월(carry)', () => {
  /** 개정표 없는 이월용 픽스처 — 개정표 침묵 시 본문 대조 경로를 검증하기 위함 */
  function yearFixture(questions: ParseResult['questions']): ParseResult {
    return {
      categoryCode: '50',
      categoryName: '개인정보보호',
      revisionSummary: [],
      questions,
      warnings: [],
    };
  }

  const q2026 = (): ParseResult['questions'] => [
    { questionNo: '50.010.010', body: '처리방침을 공개하고 있는가?', maxScore: 5, allowNa: false },
    { questionNo: '50.010.020', body: '수집 항목을 제한하고 있는가?', maxScore: 3, allowNa: true },
  ];

  /** 2026 주기 커밋 + 답변·채점·링크·발췌 근거 부착 → { cycle2026Id, srcQ1Id } */
  async function seed2026(): Promise<{ cycle2026Id: number; srcQ1Id: number }> {
    const dry = dryRunFromParsed(db, filesOf(yearFixture(q2026())), 1, { year: 2026 });
    const r = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    const cycle2026Id = r.cycleId;
    const srcQ1Id = (db
      .prepare(`SELECT id FROM question WHERE question_no='50.010.010'`)
      .get() as { id: number }).id;
    db.prepare(
      `UPDATE question SET answer_json='{"type":"doc"}', answer_plain='작년 답변',
              answer_choice='yes', score=5, score_autofilled=1,
              findings_text='작년 지적', reviewed=1
       WHERE id = ?`,
    ).run(srcQ1Id);
    db.prepare(
      `INSERT INTO question_link (question_id, url, label, sort, created_by, created_at)
       VALUES (?, 'http://intranet/문서1', '내부 문서', 1, 1, ?)`,
    ).run(srcQ1Id, new Date().toISOString());
    return { cycle2026Id, srcQ1Id };
  }

  const q2027 = (): ParseResult['questions'] => [
    { questionNo: '50.010.010', body: '처리방침을  공개하고 있는가?', maxScore: 5, allowNa: false }, // 공백만 다름 → same
    { questionNo: '50.010.020', body: '수집 항목을 최소한으로 제한하고 있는가?', maxScore: 3, allowNa: true }, // 본문 변경
    { questionNo: '50.010.030', body: '올해 신설 문항인가?', maxScore: 2, allowNa: false }, // 전년도에 없음
  ];

  it('드라이런: 대상 연도·이월 원본 주기·이월 예고 수치를 보고하고 배치에 기록한다', async () => {
    const { cycle2026Id } = await seed2026();
    const dry = dryRunFromParsed(db, filesOf(yearFixture(q2027())), 1, { year: 2027 });
    expect(dry.targetYear).toBe(2027);
    expect(dry.carry).toBe(true);
    expect(dry.carrySourceCycleId).toBe(cycle2026Id);
    expect(dry.carryMatched).toBe(2);
    expect(dry.carryWithAnswer).toBe(1); // 50.010.010만 답변 존재
    expect(dry.carryWithEvidence).toBe(1); // 50.010.010만 링크 존재
    const f = dry.files[0]!;
    expect(f.carryMatched).toBe(2);
    expect(f.diff.create).toBe(3); // 2027 주기가 아직 없으므로 전량 신규

    // 커밋은 클라이언트 입력이 아니라 배치 기록을 신뢰한다
    const stored = JSON.parse(
      (db.prepare(`SELECT summary_json FROM import_batch WHERE id = ?`).get(dry.batchId) as {
        summary_json: string;
      }).summary_json,
    );
    expect(stored.targetYear).toBe(2027);
    expect(stored.carry).toBe(true);
    expect(stored.carrySourceCycleId).toBe(cycle2026Id);
  });

  it('커밋: 2027 주기 생성 + 답변·근거 이월, 채점은 새해 초기값, 현재 주기는 2026 유지', async () => {
    const { cycle2026Id, srcQ1Id } = await seed2026();
    expect(getActiveCycle(db)!.id).toBe(cycle2026Id);

    const dry = dryRunFromParsed(db, filesOf(yearFixture(q2027())), 1, { year: 2027 });
    const r = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    expect(r.created).toBe(3);
    expect(r.carriedQuestions).toBe(2);
    expect(r.carriedAnswers).toBe(1);
    expect(r.carriedEvidence).toBe(1); // 링크 1행

    const cycle2027 = db
      .prepare(`SELECT id, year, status FROM cycle WHERE year = 2027`)
      .get() as { id: number; year: number; status: string };
    expect(cycle2027).toBeTruthy();
    expect(r.cycleId).toBe(cycle2027.id);
    // 미래 연도 주기를 만들어도 현재 주기는 바뀌지 않는다
    expect(getActiveCycle(db)!.id).toBe(cycle2026Id);

    const get2027 = (no: string): Record<string, unknown> =>
      db
        .prepare(
          `SELECT q.* FROM question q JOIN category c ON c.id = q.category_id
           WHERE c.cycle_id = ? AND q.question_no = ?`,
        )
        .get(cycle2027.id, no) as Record<string, unknown>;

    // 동일 본문(공백 차이만): 답변 이월 + 채점 초기화 + same
    const same = get2027('50.010.010');
    expect(same.answer_json).toBe('{"type":"doc"}');
    expect(same.answer_plain).toBe('작년 답변');
    expect(same.carried_from_id).toBe(srcQ1Id);
    expect(same.answer_choice).toBeNull();
    expect(same.score).toBeNull();
    expect(same.score_autofilled).toBe(0);
    expect(same.findings_text).toBeNull();
    expect(same.reviewed).toBe(0);
    expect(same.revision_status).toBe('same');
    expect(same.needs_recheck).toBe(0);
    const links = db
      .prepare(`SELECT url, label, sort FROM question_link WHERE question_id = ?`)
      .all(same.id) as Array<Record<string, unknown>>;
    expect(links).toEqual([{ url: 'http://intranet/문서1', label: '내부 문서', sort: 1 }]);

    // 본문 변경(개정표 미기재): modified + needs_recheck
    const changed = get2027('50.010.020');
    expect(changed.revision_status).toBe('modified');
    expect(changed.needs_recheck).toBe(1);
    expect(changed.revision_note).toBe('전년도 대비 내용 변경(개정표 미기재)');
    expect(changed.carried_from_id).not.toBeNull();

    // 전년도에 없던 신설 문항: 이월 없음
    const fresh = get2027('50.010.030');
    expect(fresh.carried_from_id).toBeNull();
    expect(fresh.answer_json).toBeNull();
    expect(fresh.revision_status).toBeNull();

    // 2026 원본 행은 그대로
    const src = db.prepare(`SELECT * FROM question WHERE id = ?`).get(srcQ1Id) as Record<string, unknown>;
    expect(src.answer_choice).toBe('yes');
    expect(src.score).toBe(5);
    expect(src.reviewed).toBe(1);
    expect(src.carried_from_id).toBeNull();
    const n2026 = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM question q JOIN category c ON c.id = q.category_id
         WHERE c.cycle_id = ?`,
      )
      .get(cycle2026Id) as { n: number }).n;
    expect(n2026).toBe(2);

    // 이월이 change_log에 배치 단위로 남는다
    const carryLogs = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log
         WHERE batch_id = ? AND action = 'carry' AND actor_kind = 'import'`,
      )
      .get(dry.batchId) as { n: number };
    expect(carryLogs.n).toBe(2);
  });

  it('carry=false: 아무것도 복사하지 않는다', async () => {
    await seed2026();
    const dry = dryRunFromParsed(db, filesOf(yearFixture(q2027())), 1, { year: 2027, carry: false });
    expect(dry.carry).toBe(false);
    expect(dry.carrySourceCycleId).toBeNull();
    expect(dry.carryMatched).toBe(0);
    const r = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    expect(r.carriedQuestions).toBe(0);
    const rows = db
      .prepare(
        `SELECT q.answer_json, q.carried_from_id FROM question q
         JOIN category c ON c.id = q.category_id JOIN cycle cy ON cy.id = c.cycle_id
         WHERE cy.year = 2027`,
      )
      .all() as Array<{ answer_json: string | null; carried_from_id: number | null }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.answer_json === null && x.carried_from_id === null)).toBe(true);
  });

  it('연도 미지정 드라이런·커밋은 종전과 동일(이월 없음, 활성 주기 인입)', async () => {
    const { cycle2026Id } = await seed2026();
    const dry = dryRunFromParsed(db, filesOf(yearFixture(q2026())), 1);
    expect(dry.targetYear).toBeNull();
    expect(dry.carrySourceCycleId).toBeNull();
    const stored = JSON.parse(
      (db.prepare(`SELECT summary_json FROM import_batch WHERE id = ?`).get(dry.batchId) as {
        summary_json: string;
      }).summary_json,
    );
    expect('targetYear' in stored).toBe(false); // 종전 저장분과 동일
    const r = await commitBatch(db, dry.batchId, 'overwrite', 1, {});
    expect(r.cycleId).toBe(cycle2026Id);
    expect(r.carriedQuestions).toBe(0);
  });

  // ── 리뷰 확정 결함 회귀 (C0/C2/C8 — 현재 주기 핀 무시, C1 — 이월 예고 과대) ──

  it('회귀(C0): 미래 연도(2027) 주기 생성 뒤에도 연도 미지정 가져오기는 고정된 현재 주기(2026)로 간다', async () => {
    const { cycle2026Id } = await seed2026();
    // 2027 인입 → 더 높은 id의 active 주기가 생기지만 현재 주기(핀)는 2026 유지
    const dry27 = dryRunFromParsed(db, filesOf(yearFixture(q2027())), 1, { year: 2027 });
    const r27 = await commitBatch(db, dry27.batchId, 'overwrite', 1, {});
    const cycle2027Id = r27.cycleId;
    expect(cycle2027Id).not.toBe(cycle2026Id);
    expect(getActiveCycle(db)!.id).toBe(cycle2026Id);

    // 연도 미지정 드라이런 — diff는 2026 주기(핀)와 대조되어야 한다.
    // (최신 id의 active 주기=2027와 대조하면 update 2 + missingInPdf ['50.010.030']가 된다)
    const noYear = yearFixture(q2026());
    noYear.questions[0] = { ...noYear.questions[0]!, body: '처리방침을 홈페이지에 공개하고 있는가?' };
    const dryNo = dryRunFromParsed(db, filesOf(noYear), 1);
    const d = dryNo.files[0]!.diff;
    expect(d.create).toBe(0);
    expect(d.update).toBe(1); // body 1건만 변경
    expect(d.unchanged).toBe(1);
    expect(d.missingInPdf).toEqual([]);

    // 커밋도 2026 주기(핀)로 인입되고 2027 주기는 그대로다
    const rNo = await commitBatch(db, dryNo.batchId, 'overwrite', 1, {});
    expect(rNo.cycleId).toBe(cycle2026Id);
    expect(rNo).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    const body2026 = (db
      .prepare(
        `SELECT q.body FROM question q JOIN category c ON c.id = q.category_id
         WHERE c.cycle_id = ? AND q.question_no = '50.010.010'`,
      )
      .get(cycle2026Id) as { body: string }).body;
    expect(body2026).toBe('처리방침을 홈페이지에 공개하고 있는가?');
    const rows2027 = db
      .prepare(
        `SELECT q.question_no, q.body FROM question q JOIN category c ON c.id = q.category_id
         WHERE c.cycle_id = ? ORDER BY q.question_no`,
      )
      .all(cycle2027Id) as Array<{ question_no: string; body: string }>;
    expect(rows2027).toHaveLength(3); // 2027 주기 불변
    expect(rows2027[0]!.body).toBe('처리방침을  공개하고 있는가?'); // 2027 본문 그대로
  });

  it('회귀(C0): 과거 연도(2025) 백필 뒤에도 연도 미지정 가져오기는 2026으로 간다', async () => {
    const { cycle2026Id } = await seed2026();
    const q2025: ParseResult['questions'] = [
      { questionNo: '50.010.010', body: '재작년 판 본문', maxScore: 5, allowNa: false },
    ];
    const dry25 = dryRunFromParsed(db, filesOf(yearFixture(q2025)), 1, { year: 2025, carry: false });
    const r25 = await commitBatch(db, dry25.batchId, 'overwrite', 1, {});
    expect(r25.cycleId).not.toBe(cycle2026Id); // 2025 주기가 더 높은 id로 생성됨
    expect(getActiveCycle(db)!.id).toBe(cycle2026Id);

    // 연도 미지정 — 2026(핀) 대조: 전부 unchanged. (2025 대조라면 update 1 + create 1)
    const dryNo = dryRunFromParsed(db, filesOf(yearFixture(q2026())), 1);
    expect(dryNo.files[0]!.diff.create).toBe(0);
    expect(dryNo.files[0]!.diff.unchanged).toBe(2);
    const rNo = await commitBatch(db, dryNo.batchId, 'overwrite', 1, {});
    expect(rNo.cycleId).toBe(cycle2026Id);
    expect(rNo).toMatchObject({ created: 0, unchanged: 2 });
  });

  it('회귀(C1): 이미 채워진 연도로 정정본을 재가져오면 이월 예고는 신규 문항만 세고 커밋과 일치한다', async () => {
    await seed2026();
    // 1차: 2027로 50.010.010 하나만 인입 → 이월 1건 예고 = 실이월 1건
    const dry1 = dryRunFromParsed(db, filesOf(yearFixture([q2027()[0]!])), 1, { year: 2027 });
    expect(dry1.carryMatched).toBe(1);
    const r1 = await commitBatch(db, dry1.batchId, 'overwrite', 1, {});
    expect(r1.carriedQuestions).toBe(1);

    // 2차(정정본): 3문항 전체 — 이미 존재하는 010은 예고에서 제외, 신규 020만 예고
    const dry2 = dryRunFromParsed(db, filesOf(yearFixture(q2027())), 1, { year: 2027 });
    expect(dry2.carryMatched).toBe(1); // 020만 (종전엔 010 포함 2건으로 과대 예고)
    expect(dry2.carryWithAnswer).toBe(0); // 답변 보유(010)는 이미 존재 → 제외
    expect(dry2.carryWithEvidence).toBe(0);
    const r2 = await commitBatch(db, dry2.batchId, 'overwrite', 1, {});
    expect(r2.carriedQuestions).toBe(1); // 예고와 커밋 결과 일치

    // 3차(같은 파일 재업로드): 전 문항이 이미 존재 → 예고 0 = 실이월 0
    const dry3 = dryRunFromParsed(db, filesOf(yearFixture(q2027())), 1, { year: 2027 });
    expect(dry3.carryMatched).toBe(0);
    const r3 = await commitBatch(db, dry3.batchId, 'overwrite', 1, {});
    expect(r3.carriedQuestions).toBe(0);
  });
});
