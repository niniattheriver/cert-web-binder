/**
 * 데모 재시드: 프레시 DB(001+002) → admin → 데모 문항 PDF 2부 인입 →
 * 지침서 PDF 2부 뒤에 가상 Office 지침서 3부(docx, xlsx, csv: seed/office-fixtures.ts 가
 * 시드 때 생성)와 오프셋 기반 텍스트 앵커를 더한다. 문서 1, 2 는 계속 PDF 다(e2e 가 기대).
 * 마지막으로 그림 자료 1부(망 분리 구성도 png: seed/image-fixtures.ts 가 시드 때 생성)를 올려 그림 전체를
 * 60.040.010 의 근거로 잇는다(설계서 §3.6: 그림은 글자를 읽지 않는다).
 * Day 2 매핑(제12조↔50.030.010/50.030.020, 제4조↔50.010.010, 백업↔60.060.010) → Q8 채점(yes 2.5).
 *
 * 지침서 PDF는 바이트 동일(재생성하지 않음)이므로 추출 전문/오프셋/rects 가 종전과 동일하다.
 * seed/demo-anchors.json 의 앵커 필드(quote/offset/rects)를 그대로 재사용해 passage_anchor 를
 * verbatim 재생성한다(오프셋/rects 재계산 불필요 — 동일 PDF·동일 추출기).
 *
 * 전제: data/ 가 비어 있어야 한다(프레시 시드). 기존 데이터가 있으면 먼저 data.bak-<시각>/로 옮길 것.
 * 실행: ADMIN_INITIAL_PASSWORD=day1pass npx tsx seed/seed-demo.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/src/db/migrate.js';
import { ensureBootstrapData } from '../server/src/db/bootstrap.js';
import { extractPdfPages } from '../server/src/pdf/extract.js';
import { parseQuestionPdf } from '../server/src/pdf/question-parser/index.js';
import { dryRunFromParsed, commitBatch } from '../server/src/import/question-pdf-service.js';
import { uploadGuideline } from '../server/src/docs/service.js';
import { createAnchorMapping, createWholeImageMapping, type RectGroup } from '../server/src/anchors/service.js';
import { logChange } from '../server/src/db/change-log.js';
import { buildDemoPng } from './image-fixtures.js';
import { buildDemoCsv, buildDemoDocx, buildDemoXlsx } from './office-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const dataDir = path.join(repoRoot, 'data');
const filesDir = path.join(dataDir, 'files');
const demoDir = path.join(repoRoot, 'seed', 'demo-pdfs');
// 매핑 앵커 원본 필드(quote/offset/rects) — 데모 지침서 PDF에서 추출해 둔 재사용 자산.
const ANCHORS_JSON = path.join(repoRoot, 'seed', 'demo-anchors.json');

interface DumpAnchor {
  id: number;
  document_version_id: number;
  quote_exact: string;
  quote_prefix: string | null;
  quote_suffix: string | null;
  start_offset: number;
  end_offset: number;
  page_start: number;
  page_end: number;
  rects_json: string;
  geometry_primary: number;
}
interface DumpPassage { id: number; document_id: number; label: string | null; color: string }
interface Dump { passages: DumpPassage[]; anchors: DumpAnchor[] }

async function main(): Promise<void> {
  // 데모 계정은 admin/day1pass 로 고정(e2e·문서와 일치). 환경변수로 덮어쓸 수 있다.
  // (env 프리픽스 없이도 `npm run seed:demo` 한 줄로 재현되도록 스크립트 자체에서 기본값 주입.)
  if (!process.env.ADMIN_INITIAL_PASSWORD) process.env.ADMIN_INITIAL_PASSWORD = 'day1pass';

  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const dbFile = path.join(dataDir, 'app.db');

  const db = openDatabase(dbFile); // 001 + 002
  const version = db.pragma('user_version', { simple: true });
  console.log(`[seed] DB 열림 user_version=${version}: ${dbFile}`);

  // 안전장치: 이미 데이터가 있는 DB에는 시드하지 않는다(실데이터·중복 오염 방지).
  const existingUsers = (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;
  if (existingUsers > 0) {
    db.close();
    throw new Error(
      `데이터가 이미 존재합니다(user ${existingUsers}명). 데모 재시드는 빈 data/ 에서만 실행하세요.\n` +
        `기존 data/ 를 data.bak-<시각>/ 로 옮긴 뒤 다시 실행하세요.`,
    );
  }

  // 1) 부트스트랩(admin/day1pass + cycle "2026년 심사" + 설정)
  ensureBootstrapData(db, dataDir);
  const admin = db.prepare("SELECT id FROM user WHERE username = 'admin'").get() as { id: number };
  const adminId = admin.id;
  const cycle = db.prepare("SELECT id, name FROM cycle WHERE status='active' ORDER BY id DESC LIMIT 1").get() as { id: number; name: string };
  console.log(`[seed] admin id=${adminId}, cycle="${cycle.name}"(id=${cycle.id})`);

  // 2) 데모 문항 PDF 2부 인입 (분야코드 50/60 주입 — 파일명 아님)
  const demoFiles = [
    { file: '가상문항-50-개인정보보호.pdf', code: '50' },
    { file: '가상문항-60-정보보안.pdf', code: '60' },
  ];
  const parsed = [];
  for (const d of demoFiles) {
    const buf = new Uint8Array(fs.readFileSync(path.join(demoDir, d.file)));
    const pages = await extractPdfPages(buf);
    const parse = parseQuestionPdf(pages.map((p) => ({ pageNo: p.pageNo, text: p.text })));
    parse.categoryCode = d.code; // 데모: 분야코드 명시 주입(실물은 파일명 기반)
    parsed.push({ fileName: d.file, parse });
    console.log(`[seed] 파싱 ${d.file}: 분야 ${d.code}(${parse.categoryName}) 문항 ${parse.questions.length}`);
  }
  const dry = dryRunFromParsed(db, parsed, adminId);
  const commit = await commitBatch(db, dry.batchId, 'overwrite', adminId, { backupDir: null });
  console.log(`[seed] 문항 커밋: 생성 ${commit.created} · 분야 ${commit.categoriesCreated}`);

  // 3) 지침서 PDF 2부 업로드 (바이트 동일 — document 1/2, version 1/2)
  const g1 = await uploadGuideline(db, {
    buffer: new Uint8Array(fs.readFileSync(path.join(demoDir, '가상지침서-개인정보처리지침.pdf'))),
    fileName: '가상지침서-개인정보처리지침.pdf',
    title: '가상기관 개인정보 처리지침', versionLabel: '2026-1', code: 'PRIV-지침',
    kind: 'manual', userId: adminId, filesDir,
  });
  const g2 = await uploadGuideline(db, {
    buffer: new Uint8Array(fs.readFileSync(path.join(demoDir, '가상지침서-정보보안운영지침.pdf'))),
    fileName: '가상지침서-정보보안운영지침.pdf',
    title: '가상기관 정보보안 운영지침', versionLabel: '2026-1', code: 'SEC-지침',
    kind: 'manual', userId: adminId, filesDir,
  });
  if (g1.duplicate || g2.duplicate) throw new Error('지침서 업로드가 중복으로 처리됨');
  console.log(`[seed] 지침서 업로드: doc1 v${g1.versionId}(${g1.pageCount}p), doc2 v${g2.versionId}(${g2.pageCount}p)`);
  const versionMap = new Map<number, number>([[1, g1.versionId], [2, g2.versionId]]); // old docVer → new

  // 4) 매핑 앵커 verbatim 재생성 (동일 PDF → 동일 오프셋/rects)
  const dump = JSON.parse(fs.readFileSync(ANCHORS_JSON, 'utf8')) as Dump;
  const anchorById = new Map(dump.anchors.map((a) => [a.id, a]));
  const passageById = new Map(dump.passages.map((p) => [p.id, p]));
  const qid = (no: string): number => {
    const r = db.prepare('SELECT id FROM question WHERE question_no = ? AND deleted_at IS NULL').get(no) as { id: number } | undefined;
    if (!r) throw new Error(`문항번호 미존재: ${no}`);
    return r.id;
  };

  const specs: { oldAnchorId: number; oldPassageId: number; questionNos: string[]; noteByNo?: Record<string, string> }[] = [
    { oldAnchorId: 1, oldPassageId: 1, questionNos: ['50.030.010', '50.030.020'], noteByNo: { '50.030.010': '파기 절차·파기대장 근거' } },
    { oldAnchorId: 2, oldPassageId: 2, questionNos: ['50.010.010'] },
    { oldAnchorId: 4, oldPassageId: 4, questionNos: ['60.060.010'] },
  ];
  for (const s of specs) {
    const a = anchorById.get(s.oldAnchorId)!;
    const p = passageById.get(s.oldPassageId)!;
    const newVersionId = versionMap.get(a.document_version_id)!;
    const rects = JSON.parse(a.rects_json) as RectGroup[];
    const res = createAnchorMapping(db, {
      documentVersionId: newVersionId,
      questionIds: s.questionNos.map(qid),
      quoteExact: a.quote_exact,
      quotePrefix: a.quote_prefix,
      quoteSuffix: a.quote_suffix,
      startOffset: a.start_offset,
      endOffset: a.end_offset,
      pageStart: a.page_start,
      pageEnd: a.page_end,
      rects,
      label: p.label,
      color: p.color,
      geometryPrimary: a.geometry_primary,
    }, adminId);
    if (res.kind !== 'created') throw new Error(`앵커 생성 실패(${s.oldAnchorId}): ${JSON.stringify(res)}`);
    // 원본 데모의 링크 메모 복원(선택)
    if (s.noteByNo) {
      for (const [no, note] of Object.entries(s.noteByNo)) {
        db.prepare('UPDATE question_passage SET note = ? WHERE question_id = ? AND passage_id = ?')
          .run(note, qid(no), res.passageId);
      }
    }
    console.log(`[seed] 앵커 생성: passage=${res.passageId} anchor=${res.anchorId} ← ${a.quote_exact.slice(0, 18)}… 문항[${s.questionNos.join(',')}]`);
  }

  // 4-2) 가상 Office 지침서 (설계서 §3.5) — 문서 3, 4, 5. 바이너리는 저장소에 두지 않고 지금 만든다
  const officeDocs = [
    { fileName: '가상기관 정보보안 점검 절차서.docx', title: '가상기관 정보보안 점검 절차서', code: 'SEC-점검', buf: buildDemoDocx() },
    { fileName: '가상기관 정보자산 목록.xlsx', title: '가상기관 정보자산 목록', code: 'SEC-자산', buf: await buildDemoXlsx() },
    { fileName: '가상기관 접근권한 검토 기록.csv', title: '가상기관 접근권한 검토 기록', code: null, buf: buildDemoCsv() },
  ];
  const officeVersion = new Map<string, number>();
  for (const d of officeDocs) {
    const r = await uploadGuideline(db, {
      buffer: new Uint8Array(d.buf), fileName: d.fileName, title: d.title, versionLabel: '2026-1',
      code: d.code, kind: 'manual', userId: adminId, filesDir,
    });
    if (r.duplicate) throw new Error(`Office 지침서 업로드가 중복으로 처리됨: ${d.title}`);
    officeVersion.set(d.title, r.versionId);
    console.log(`[seed] Office 지침서: ${d.title} (${r.fileKind}, 논리 쪽 ${r.pageCount})`);
  }
  // 텍스트 앵커: 정본 page_text 에서 인용을 찾아 오프셋으로 연결 (PDF 외 판본이라 rects 없음)
  const textAnchor = (versionId: number, quote: string, questionNos: string[], label: string | null): void => {
    const pages = db
      .prepare('SELECT page_no, start_offset, text FROM page_text WHERE document_version_id = ? ORDER BY page_no')
      .all(versionId) as { page_no: number; start_offset: number; text: string }[];
    for (const p of pages) {
      const i = p.text.indexOf(quote);
      if (i < 0) continue;
      const res = createAnchorMapping(db, {
        documentVersionId: versionId,
        questionIds: questionNos.map(qid),
        quoteExact: quote,
        quotePrefix: p.text.slice(Math.max(0, i - 64), i) || null,
        quoteSuffix: p.text.slice(i + quote.length, i + quote.length + 64) || null,
        startOffset: p.start_offset + i,
        endOffset: p.start_offset + i + quote.length,
        pageStart: p.page_no,
        pageEnd: p.page_no,
        label,
      }, adminId);
      if (res.kind !== 'created') throw new Error(`텍스트 앵커 생성 실패: ${JSON.stringify(res)}`);
      console.log(`[seed] 텍스트 앵커: anchor=${res.anchorId} ← ${quote.slice(0, 18)}… 문항[${questionNos.join(',')}]`);
      return;
    }
    throw new Error(`인용을 정본 글자에서 찾지 못함: ${quote}`);
  };
  textAnchor(officeVersion.get('가상기관 정보보안 점검 절차서')!,
    '주요 데이터는 매일 자동 백업하고, 백업 매체는 월 1회 복구 시험으로 확인한다.', ['60.060.010', '60.060.020'], '백업 주기');
  textAnchor(officeVersion.get('가상기관 정보보안 점검 절차서')!,
    '복구 시험 결과는 점검 기록표에 남기고 담당자와 책임자가 확인 서명한다.', ['60.060.020'], null);
  textAnchor(officeVersion.get('가상기관 정보자산 목록')!, '가상기관 정보자산 목록 (2026년)', ['60.020.010'], '자산 목록');
  textAnchor(officeVersion.get('가상기관 접근권한 검토 기록')!, '퇴직자 계정 2건 잠금', ['60.030.010', '60.030.030'], null);

  // 4-3) 가상 그림 자료 (설계서 §3.6): 문서 6. 글자를 읽지 않으므로 그림 전체를 근거로 잇는다
  const img = await uploadGuideline(db, {
    buffer: new Uint8Array(buildDemoPng()), fileName: '가상기관 망 분리 구성도.png', title: '가상기관 망 분리 구성도',
    versionLabel: '2026-1', code: 'SEC-망', kind: 'manual', userId: adminId, filesDir,
  });
  if (img.duplicate) throw new Error('그림 자료 업로드가 중복으로 처리됨');
  const imgLink = createWholeImageMapping(db, { documentVersionId: img.versionId, questionIds: [qid('60.040.010')] }, adminId);
  if (imgLink.kind !== 'created') throw new Error(`그림 근거 연결 실패: ${JSON.stringify(imgLink)}`);
  console.log(`[seed] 그림 자료: 가상기관 망 분리 구성도 (${img.fileKind}) → 그림 전체 근거 anchor=${imgLink.anchorId} 문항[60.040.010]`);

  // 5) Q8(50.030.010) 채점 yes 2.5
  const q8 = db.prepare("SELECT id, row_version, max_score FROM question WHERE question_no = '50.030.010'").get() as { id: number; row_version: number; max_score: number };
  const now = new Date().toISOString();
  db.prepare(`UPDATE question SET answer_choice='yes', score=2.5, row_version=row_version+1, updated_at=?, updated_by=? WHERE id=?`)
    .run(now, adminId, q8.id);
  logChange(db, {
    actorId: adminId, entity: 'question', entityId: q8.id, action: 'update',
    before: { answerChoice: null, score: null }, after: { answerChoice: 'yes', score: 2.5 },
  });
  console.log(`[seed] Q8(id=${q8.id}, 50.030.010) 채점: yes 2.5 (배점 ${q8.max_score})`);

  // 요약
  const cats = db.prepare('SELECT COUNT(*) n FROM category').get() as { n: number };
  const qs = db.prepare('SELECT COUNT(*) n FROM question').get() as { n: number };
  const docs = db.prepare('SELECT COUNT(*) n FROM document').get() as { n: number };
  const links = db.prepare('SELECT COUNT(*) n FROM question_passage').get() as { n: number };
  console.log(`[seed] 완료 — 분야 ${cats.n}, 문항 ${qs.n}, 지침서 ${docs.n}, 매핑링크 ${links.n}`);
  db.close();
}

main().catch((e) => { console.error('[seed 실패]', e); process.exit(1); });
