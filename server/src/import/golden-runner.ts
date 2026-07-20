/**
 * 로컬 골든 러너 (v1.5 Phase 3b — 지시서 A-7)
 * `_로컬자료/문항PDF/` 전량을 파싱해 스냅샷을 만들고 직전 스냅샷과 비교한다 —
 * 파서 수정 시 1,662문항 추출 회귀 감지망.
 *
 * 실행:   npm run golden -w server            (기본 디렉토리 ../_로컬자료/문항PDF)
 *         npm run golden -w server -- <dir>
 * 산출물: <dir>/../golden/golden-latest.json (+ 타임스탬프 사본) — git 제외 폴더(_로컬자료).
 * 이 스크립트 자체는 실물 텍스트를 포함하지 않으며(해시·건수만 기록), 저장소에 커밋해도 안전하다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfPages } from '../pdf/extract.js';
import { parseQuestionPdf } from '../pdf/question-parser/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.resolve(here, '..', '..', '..', '_로컬자료', '문항PDF');

interface FileSnapshot {
  fileName: string;
  questionCount: number;
  warningCount: number;
  warnings: string[];
  /** 챕터 배정 문항 수 (목차 파싱·본문 대조 성공분) */
  withChapter: number;
  chapterMajors: number;
  /** topic(질문문) 추출 문항 수 */
  withTopic: number;
  /** 세부 평가항목 표 검출 문항번호 */
  subItemQuestions: string[];
  /** 자동배점 임계표 후보 문항번호 */
  autoCandidateQuestions: string[];
  /** 파싱 결과 전체(문항 배열 JSON)의 sha256 — 내용 회귀 감지용 (원문 비저장) */
  questionsHash: string;
}

interface GoldenSnapshot {
  createdAt: string;
  totalQuestions: number;
  files: FileSnapshot[];
}

async function snapshotFile(dir: string, fileName: string): Promise<FileSnapshot> {
  const buf = fs.readFileSync(path.join(dir, fileName));
  const pages = await extractPdfPages(new Uint8Array(buf));
  const parse = parseQuestionPdf(pages.map((p) => ({ pageNo: p.pageNo, text: p.text })));
  const majors = new Set(parse.questions.map((q) => q.chapterMajor).filter((c) => c != null));
  return {
    fileName,
    questionCount: parse.questions.length,
    warningCount: parse.warnings.length,
    warnings: parse.warnings,
    withChapter: parse.questions.filter((q) => q.chapterMajor != null).length,
    chapterMajors: majors.size,
    withTopic: parse.questions.filter((q) => q.topic != null && q.topic.length > 0).length,
    subItemQuestions: parse.questions.filter((q) => q.subItems != null).map((q) => q.questionNo),
    autoCandidateQuestions: parse.questions
      .filter((q) => q.autoCandidate != null)
      .map((q) => q.questionNo),
    questionsHash: crypto
      .createHash('sha256')
      .update(JSON.stringify(parse.questions))
      .digest('hex'),
  };
}

function compare(prev: GoldenSnapshot, next: GoldenSnapshot): string[] {
  const diffs: string[] = [];
  const prevByName = new Map(prev.files.map((f) => [f.fileName, f]));
  for (const f of next.files) {
    const p = prevByName.get(f.fileName);
    if (!p) {
      diffs.push(`+ 신규 파일: ${f.fileName} (${f.questionCount}문항)`);
      continue;
    }
    if (p.questionCount !== f.questionCount)
      diffs.push(`! ${f.fileName}: 문항 수 ${p.questionCount} → ${f.questionCount}`);
    if (p.warningCount !== f.warningCount)
      diffs.push(`! ${f.fileName}: 경고 ${p.warningCount} → ${f.warningCount}`);
    if (p.questionsHash !== f.questionsHash && p.questionCount === f.questionCount)
      diffs.push(`! ${f.fileName}: 문항 내용 해시 변경 (수 동일 — 필드/본문 차이)`);
    prevByName.delete(f.fileName);
  }
  for (const name of prevByName.keys()) diffs.push(`- 사라진 파일: ${name}`);
  return diffs;
}

async function main(): Promise<void> {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : defaultDir;
  if (!fs.existsSync(dir)) {
    console.error(`[골든] 디렉토리 없음: ${dir}`);
    process.exit(2);
  }
  const pdfs = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.pdf'))
    .sort();
  if (pdfs.length === 0) {
    console.error(`[골든] PDF 없음: ${dir}`);
    process.exit(2);
  }

  const files: FileSnapshot[] = [];
  for (const name of pdfs) {
    const snap = await snapshotFile(dir, name);
    files.push(snap);
    console.log(
      `  ${name}: ${snap.questionCount}문항 · 챕터 ${snap.withChapter}/${snap.questionCount}` +
        `(대분류 ${snap.chapterMajors}) · 합산표 ${snap.subItemQuestions.length} · ` +
        `자동후보 ${snap.autoCandidateQuestions.length} · 경고 ${snap.warningCount}`,
    );
    for (const w of snap.warnings) console.log(`      ⚠ ${w}`);
  }
  const next: GoldenSnapshot = {
    createdAt: new Date().toISOString(),
    totalQuestions: files.reduce((s, f) => s + f.questionCount, 0),
    files,
  };
  console.log(`[골든] 합계 ${next.totalQuestions}문항 / ${files.length}파일`);

  const goldenDir = path.join(path.dirname(dir), 'golden');
  fs.mkdirSync(goldenDir, { recursive: true });
  const latestPath = path.join(goldenDir, 'golden-latest.json');
  if (fs.existsSync(latestPath)) {
    const prev = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as GoldenSnapshot;
    const diffs = compare(prev, next);
    if (diffs.length === 0) {
      console.log(`[골든] 직전 스냅샷(${prev.createdAt})과 차이 없음 ✓`);
    } else {
      console.log(`[골든] 직전 스냅샷(${prev.createdAt}) 대비 차이 ${diffs.length}건:`);
      for (const d of diffs) console.log(`  ${d}`);
    }
  } else {
    console.log('[골든] 첫 스냅샷 — 비교 기준 생성');
  }
  const stamp = next.createdAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(goldenDir, `golden-${stamp}.json`), JSON.stringify(next, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(next, null, 2));
  console.log(`[골든] 저장: ${latestPath}`);
}

void main();
