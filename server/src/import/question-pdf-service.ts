/**
 * 문항 PDF 일괄 인입 서비스 — 설계서 §6.1(가져오기 원칙 공유), §6.2-1·3, §10 Day 1
 *
 * 드라이런: PDF 추출·파싱 결과를 import_batch(kind='question_pdf', dry_run=1)에 통째로 저장.
 *           DB 도메인 데이터는 절대 변경하지 않는다.
 * 커밋:     드라이런이 저장한 summary_json을 재사용(재파싱 없음) →
 *           커밋 직전 data/backups/pre-import-YYYYMMDD-HHmm.db 스냅샷(backup API) →
 *           전체 단일 트랜잭션으로 category/question 업서트.
 *           업서트 키 (분야코드, 문항번호). **가져오기는 절대 삭제하지 않는다** —
 *           개정표 '삭제' 행은 결과에 보고만 한다. 답변·채점·근거 링크는 어떤 모드에서도 불변.
 *           모든 변경은 change_log(actor_kind='import', batch_id, action='import')에 기록.
 * 멱등:     동일 내용 재커밋 → unchanged로 집계(행 변경·row_version 증가 없음).
 *
 * DB 핸들은 인자로 받는다(테스트 :memory: / CLI 임의 파일 / 라우트의 공용 db).
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getActiveCycle } from '../db/cycles.js';
import { extractPdfPages } from '../pdf/extract.js';
import { parseQuestionPdf } from '../pdf/question-parser/index.js';
import { QUESTION_NO_RE } from '../pdf/question-parser/patterns.js';
import type { ParseResult } from '../pdf/question-parser/types.js';

type DB = Database.Database;

/**
 * 인입 모드 (§6.1 + v1.5 A-1):
 *  - overwrite:     본문·배점·유형을 파서 값으로 덮어씀 (연초 신규 인입/연차 개정 기본)
 *  - keep_existing: 기존 행은 그대로 두고 신규만 추가
 *  - reingest:      비파괴 재인입 — 파서 소유분(body·topic·챕터·sort)만 갱신,
 *                   배점/유형/해당없음이 저장값과 다르면 덮어쓰지 않고 needs_recheck + 차이 목록.
 *                   세부항목표는 계약 통과 시에만 인입(채점 존재 문항은 모드 자동 전환 금지).
 */
export type ImportMode = 'overwrite' | 'keep_existing' | 'reingest';

/**
 * 파일명 기반 분야코드 도출 (설계서 §6.2-1 계약: 파서는 분야코드를 추론하지 않고
 * 인입 계층이 파일명으로 주입한다 — 문항번호 첫 그룹 ≠ 분야이므로).
 * 확장자(.pdf)와 선행 "YYYY_"(4자리 연도 + 밑줄)를 제거한 stem 이 분야코드다.
 *   "2026_분자진단검사.pdf"       → "분자진단검사"
 *   "2026_임상화학_요경검학.pdf"  → "임상화학_요경검학"  (분야명 내부의 밑줄은 보존)
 */
export function categoryCodeFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName; // 경로가 섞여 와도 방어
  return base
    .replace(/\.pdf$/i, '')
    .replace(/^\d{4}_/, '')
    .trim()
    .normalize('NFC'); // macOS 파일명은 NFD(자모 분해) — DB 코드(NFC)와 불일치 시 중복 분야 생성 사고 방지
}

/**
 * 커밋/드라이런 공용 분야코드 결정.
 * 파서가 명시적으로 코드를 주면(구 경로·테스트 픽스처의 명시 주입) 우선하고,
 * 없으면(실물 파서는 항상 null) 파일명에서 도출한다 — 설계서의 "파일명 우선" 계약.
 */
function resolveCategoryCode(fileName: string, parse: ParseResult): string {
  const fromParse = parse.categoryCode?.trim();
  return fromParse && fromParse.length > 0 ? fromParse : categoryCodeFromFileName(fileName);
}

/**
 * 개정표 수정유형 원문이 채점 재확인(needs_recheck)을 유발하는지 (설계서 실물 서식 계약).
 * 트리거: "배점 변경", "해당없음 유무변경" (공백 변형 허용).
 */
const RECHECK_TRIGGER_RE = /배점\s*변경|해당\s*없음\s*유무\s*변경/;
function revisionTriggersRecheck(note: string | null): boolean {
  return note != null && RECHECK_TRIGGER_RE.test(note);
}

/** 드라이런 입력(업로드 파일 또는 CLI가 읽은 파일) */
export interface DryRunFileInput {
  name: string;
  buffer: Uint8Array;
}

/**
 * 가져오기 대상 연도·전년도 이월 옵션.
 * year 미지정이면 종전과 동일하게 활성 주기로 인입한다.
 * carry(기본 켬): 새 연도 커밋 시 번호가 같은 문항의 답변·근거 연결을 전년도에서 복사.
 */
export interface DryRunOptions {
  year?: number;
  carry?: boolean;
}

/** 파싱 완료 입력 — summary_json에 이 형태 그대로 저장되어 커밋이 재사용한다. */
export interface ParsedFileInput {
  fileName: string;
  parse: ParseResult;
}

/** 재인입 보호 필드 차이 (덮어쓰지 않고 보고 — A-1) */
export interface ProtectedDiff {
  questionNo: string;
  field: 'maxScore' | 'allowNa' | 'questionType' | 'gradeSymbol';
  current: unknown;
  parsed: unknown;
}

/** 드라이런 시점의 DB 대조 diff 리포트 (A-1 — 필드별 변경 건수. 커밋이 트랜잭션 안에서 재검증) */
export interface DryRunDiff {
  create: number;
  update: number;
  unchanged: number;
  /** DB에는 있으나 PDF에 없는 문항번호 — 삭제하지 않고 보고만 */
  missingInPdf: string[];
  /** 파서 소유 필드별 변경 문항 수 (재인입 모드 기준) */
  fieldChanges: Record<string, number>;
  /** 보호 필드(배점/유형/해당없음) 차이 — 재인입은 덮어쓰지 않고 needs_recheck */
  protectedDiffs: ProtectedDiff[];
  /** 세부항목표: 계약 통과 + 미채점 → 자동 인입 예정 건수 */
  criteriaEligible: number;
  /** 세부항목표: 계약 통과 + 채점 존재 → 수동 전환 필요 문항번호 */
  criteriaManual: string[];
  /** 세부항목표 계약 위반 — 문항 전체 검수(부분 인입 금지) */
  criteriaViolations: Array<{ questionNo: string; reason: string }>;
  /** 자동배점 임계표 후보 문항번호 (활성화는 수동 — A-3) */
  autoCandidates: string[];
  /** 챕터 미배정 문항 수 (0이 아니면 목차 파싱 부분 실패 — UI 접두 폴백) */
  chapterMissing: number;
}

/** API 계약의 드라이런 파일 요약 */
export interface DryRunFileSummary {
  fileName: string;
  categoryCode: string | null;
  categoryName: string | null;
  questionCount: number;
  revisionRows: number;
  warnings: string[];
  questions: Array<{ questionNo: string; body: string; maxScore: number | null; allowNa: boolean }>;
  /** DB 대조 diff (대상 주기에 해당 분야가 있을 때. 없으면 전량 create) */
  diff: DryRunDiff;
  // ── 전년도 이월 미리보기 (연도 지정 + 이월 켬일 때만 0 초과) ──
  /** 업로드 문항 중 (분야코드, 문항번호)로 전년도 문항과 매칭된 수 */
  carryMatched: number;
  /** 매칭 중 전년도에 답변이 있는 문항 수 */
  carryWithAnswer: number;
  /** 매칭 중 전년도에 근거 연결(발췌·자유문서·첨부·링크)이 하나라도 있는 문항 수 */
  carryWithEvidence: number;
}

export interface DryRunResult {
  batchId: number;
  files: DryRunFileSummary[];
  /** 가져오기 대상 연도 (미지정이면 null = 활성 주기 인입) */
  targetYear: number | null;
  /** 전년도 이월 여부 (연도 미지정이면 의미 없음) */
  carry: boolean;
  /** 이월 원본 주기 id — 대상 연도보다 작은 최신 연도 주기 (없으면 null) */
  carrySourceCycleId: number | null;
  /** 전 파일 합계 (파일별 carry* 필드의 합) */
  carryMatched: number;
  carryWithAnswer: number;
  carryWithEvidence: number;
}

export interface CommitSkippedRow {
  fileName: string;
  questionNo: string;
  reason: string;
}

export interface CommitResult {
  created: number;
  updated: number;
  unchanged: number;
  categoriesCreated: number;
  /** 문항번호 형식 불일치·파일 내 중복 번호 등으로 건너뛴 행 */
  skipped: CommitSkippedRow[];
  /** 개정표 '삭제' 행 — 보고만 하고 절대 삭제하지 않는다 (§6.2) */
  revisionDeleted: Array<{ fileName: string; questionNo: string; note: string }>;
  snapshotFile: string | null;
  cycleId: number;
  // ── v1.5 A-1 (재인입) ──
  /** 보호 필드 차이 — 덮어쓰지 않고 needs_recheck 처리한 목록 */
  protectedDiffs: Array<ProtectedDiff & { fileName: string }>;
  /** 세부항목표 자동 인입(계약 통과 + 미채점 → composite 전환) 건수 */
  criteriaApplied: number;
  /** 세부항목표 계약 통과했으나 채점 존재 → 수동 전환 필요(needs_recheck) */
  criteriaManual: Array<{ fileName: string; questionNo: string }>;
  /** 세부항목표 계약 위반 — 부분 인입 금지, needs_recheck */
  criteriaViolations: Array<{ fileName: string; questionNo: string; reason: string }>;
  /** 자동배점 임계표 후보 (활성화는 수동 — A-3) */
  autoCandidates: Array<{ fileName: string; questionNo: string; rows: string[] }>;
  // ── 전년도 이월 (연도 지정 + 이월 켬 커밋에서만 0 초과) ──
  /** 답변·근거 연결을 전년도에서 복사한 신규 문항 수 (carried_from_id 설정) */
  carriedQuestions: number;
  /** 그중 답변(answer_json/answer_plain)이 복사된 문항 수 */
  carriedAnswers: number;
  /** 복사된 근거 연결 행 수 합계 (발췌 + 자유문서 + 첨부 + 링크) */
  carriedEvidence: number;
}

export interface CommitOptions {
  /** 스냅샷 저장 디렉토리. null/미지정이면 스냅샷 생략(테스트 전용 — 운영 경로는 반드시 지정). */
  backupDir?: string | null;
}

/** 커밋 대상 배치가 없거나 드라이런 요약이 없을 때 */
export class BatchNotFoundError extends Error {
  constructor(batchId: number) {
    super(`가져오기 배치를 찾을 수 없습니다: ${batchId}`);
    this.name = 'BatchNotFoundError';
  }
}

interface BatchSummaryJson {
  files: ParsedFileInput[];
  /** 커밋 이력(참고용) — files는 재커밋 멱등성을 위해 원본 그대로 유지한다. */
  commits?: Array<{ at: string; mode: ImportMode; created: number; updated: number; unchanged: number }>;
  // 연도 지정 드라이런이 기록 — 커밋은 클라이언트 입력을 믿지 않고 이 값을 쓴다.
  targetYear?: number;
  carry?: boolean;
  carrySourceCycleId?: number | null;
}

// ---------------------------------------------------------------------------
// 드라이런
// ---------------------------------------------------------------------------

/** PDF 버퍼들 → 추출·파싱 → 드라이런 기록. 암호화/손상 PDF는 extract.ts의 에러가 그대로 전파된다. */
export async function dryRunFromFiles(
  db: DB,
  files: DryRunFileInput[],
  userId: number | null,
  opts: DryRunOptions = {},
): Promise<DryRunResult> {
  const parsed: ParsedFileInput[] = [];
  for (const f of files) {
    // pdfjs가 버퍼 소유권을 가져갈 수 있으므로 복사본을 넘긴다.
    const pages = await extractPdfPages(new Uint8Array(f.buffer));
    const parse = parseQuestionPdf(pages.map((p) => ({ pageNo: p.pageNo, text: p.text })));
    parsed.push({ fileName: f.name, parse });
  }
  return dryRunFromParsed(db, parsed, userId, opts);
}

/** 대상 연도의 이월 원본 주기 — 그보다 작은 최신 연도 중 살아있는 분야가 있는 주기 */
function findCarrySourceCycleId(db: DB, targetYear: number): number | null {
  const row = db
    .prepare(
      `SELECT cy.id FROM cycle cy
       WHERE cy.year IS NOT NULL AND cy.year < ?
         AND EXISTS (SELECT 1 FROM category c WHERE c.cycle_id = cy.id AND c.deleted_at IS NULL)
       ORDER BY cy.year DESC, cy.id DESC LIMIT 1`,
    )
    .get(targetYear) as { id: number } | undefined;
  return row?.id ?? null;
}

/** 파싱 결과 → import_batch(dry_run=1) 기록 + 계약 형태 응답. 도메인 테이블 무변경. */
export function dryRunFromParsed(
  db: DB,
  files: ParsedFileInput[],
  userId: number | null,
  opts: DryRunOptions = {},
): DryRunResult {
  const now = new Date().toISOString();
  const targetYear = opts.year ?? null;
  const carry = opts.carry ?? true;
  // 대상 주기 — 연도 지정 시 그 연도의 주기(없으면 diff는 빈 DB 대조 = 전량 create)
  const targetCycleId =
    targetYear != null
      ? ((db
          .prepare(`SELECT id FROM cycle WHERE year = ? ORDER BY id DESC LIMIT 1`)
          .get(targetYear) as { id: number } | undefined)?.id ?? null)
      : undefined;
  const carrySourceCycleId =
    targetYear != null && carry ? findCarrySourceCycleId(db, targetYear) : null;

  const summary: BatchSummaryJson = {
    files,
    // 연도 미지정이면 키를 넣지 않는다(undefined 는 JSON 직렬화에서 탈락 — 종전과 동일 저장분)
    ...(targetYear != null ? { targetYear, carry, carrySourceCycleId } : {}),
  };
  const info = db
    .prepare(
      `INSERT INTO import_batch (kind, file_name, uploaded_by, uploaded_at, dry_run, summary_json)
       VALUES ('question_pdf', ?, ?, ?, 1, ?)`,
    )
    .run(files.map((f) => f.fileName).join(', '), userId, now, JSON.stringify(summary));
  const fileSummaries = files.map((f) => toFileSummary(db, f, targetCycleId, carrySourceCycleId));
  return {
    batchId: Number(info.lastInsertRowid),
    files: fileSummaries,
    targetYear,
    carry,
    carrySourceCycleId,
    carryMatched: fileSummaries.reduce((s, f) => s + f.carryMatched, 0),
    carryWithAnswer: fileSummaries.reduce((s, f) => s + f.carryWithAnswer, 0),
    carryWithEvidence: fileSummaries.reduce((s, f) => s + f.carryWithEvidence, 0),
  };
}

function toFileSummary(
  db: DB,
  f: ParsedFileInput,
  targetCycleId: number | null | undefined,
  carrySourceCycleId: number | null,
): DryRunFileSummary {
  const categoryCode = resolveCategoryCode(f.fileName, f.parse);
  const carryStats = computeCarryStats(
    db,
    carrySourceCycleId,
    targetCycleId ?? null,
    categoryCode,
    f.parse,
  );
  return {
    fileName: f.fileName,
    categoryCode,
    // 분야명은 표지 파서값 우선, 없으면 파일명 코드 (설계서 계약)
    categoryName: f.parse.categoryName ?? categoryCode,
    questionCount: f.parse.questions.length,
    revisionRows: f.parse.revisionSummary.length,
    warnings: f.parse.warnings,
    questions: f.parse.questions.map((q) => ({
      questionNo: q.questionNo,
      body: q.body,
      maxScore: q.maxScore,
      allowNa: q.allowNa,
    })),
    diff: computeDryRunDiff(db, categoryCode, f.parse, targetCycleId),
    ...carryStats,
  };
}

/**
 * 전년도 이월 미리보기 집계 — (분야코드, 문항번호) 매칭 + 답변/근거 존재 여부.
 * 커밋은 신규 삽입 문항에만 이월하므로, 대상 주기(targetCycleId)에 이미 행이 있는 문항은
 * 예고에서 제외한다 — 안 그러면 이미 채워진 연도로 정정본을 재가져올 때 이월 N건을
 * 예고하고 실제로는 0건 이월하는 불일치가 난다. 존재 판정 술어는 커밋과 동일:
 * 분야는 (cycle_id, code) — 삭제 여부 불문(catSelect), 문항도 삭제 여부 불문(qSelect).
 */
function computeCarryStats(
  db: DB,
  sourceCycleId: number | null,
  targetCycleId: number | null,
  categoryCode: string | null,
  parse: ParseResult,
): { carryMatched: number; carryWithAnswer: number; carryWithEvidence: number } {
  const stats = { carryMatched: 0, carryWithAnswer: 0, carryWithEvidence: 0 };
  if (sourceCycleId == null || !categoryCode) return stats;
  const targetCat =
    targetCycleId != null
      ? (db
          .prepare(`SELECT id FROM category WHERE cycle_id = ? AND code = ?`)
          .get(targetCycleId, categoryCode) as { id: number } | undefined)
      : undefined;
  const targetExists = targetCat
    ? db.prepare(`SELECT 1 AS x FROM question WHERE category_id = ? AND question_no = ?`)
    : null;
  const stmt = db.prepare(
    `SELECT q.id,
            CASE WHEN q.answer_json IS NOT NULL
                   OR (q.answer_plain IS NOT NULL AND TRIM(q.answer_plain) <> '')
                 THEN 1 ELSE 0 END AS hasAnswer,
            CASE WHEN EXISTS (SELECT 1 FROM question_passage qp
                                JOIN passage p ON p.id = qp.passage_id AND p.deleted_at IS NULL
                              WHERE qp.question_id = q.id)
                   OR EXISTS (SELECT 1 FROM question_richdoc qr
                                JOIN rich_doc r ON r.id = qr.rich_doc_id AND r.deleted_at IS NULL
                              WHERE qr.question_id = q.id)
                   OR EXISTS (SELECT 1 FROM question_attachment qa
                              WHERE qa.question_id = q.id AND qa.deleted_at IS NULL)
                   OR EXISTS (SELECT 1 FROM question_link ql
                              WHERE ql.question_id = q.id AND ql.deleted_at IS NULL)
                 THEN 1 ELSE 0 END AS hasEvidence
     FROM question q
     JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
     WHERE c.cycle_id = ? AND c.code = ? AND q.question_no = ? AND q.deleted_at IS NULL`,
  );
  const seen = new Set<string>();
  for (const q of parse.questions) {
    if (!QUESTION_NO_RE.test(q.questionNo) || seen.has(q.questionNo)) continue;
    seen.add(q.questionNo);
    // 대상 주기에 이미 있는 문항(삭제 여부 불문) — 커밋이 이월하지 않으므로 예고 제외
    if (targetExists && targetExists.get(targetCat!.id, q.questionNo)) continue;
    const src = stmt.get(sourceCycleId, categoryCode, q.questionNo) as
      | { id: number; hasAnswer: number; hasEvidence: number }
      | undefined;
    if (!src) continue;
    stats.carryMatched += 1;
    if (src.hasAnswer === 1) stats.carryWithAnswer += 1;
    if (src.hasEvidence === 1) stats.carryWithEvidence += 1;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// 드라이런 DB 대조 diff (A-1 — 리포트 → 사람 승인 → 커밋. 커밋은 트랜잭션 안에서 재검증)
// ---------------------------------------------------------------------------

interface DiffQuestionRow {
  id: number;
  question_no: string;
  body: string;
  topic: string | null;
  chapter_major: string | null;
  chapter_minor: string | null;
  sort_key: number;
  max_score: number | null;
  allow_na: number;
  question_type: string | null;
  grade_symbol: string | null;
  answer_choice: string | null;
  score: number | null;
  scoring_mode: string;
  auto_candidate: number;
  deleted_at: string | null;
}

/** @param targetCycleId 연도 지정 시 대상 주기(null=그 연도 주기 아직 없음 → 전량 create). undefined=종전대로 활성 주기 대조. */
function computeDryRunDiff(
  db: DB,
  categoryCode: string | null,
  parse: ParseResult,
  targetCycleId?: number | null,
): DryRunDiff {
  const diff: DryRunDiff = {
    create: 0,
    update: 0,
    unchanged: 0,
    missingInPdf: [],
    fieldChanges: {},
    protectedDiffs: [],
    criteriaEligible: 0,
    criteriaManual: [],
    criteriaViolations: [],
    autoCandidates: [],
    chapterMissing: 0,
  };
  const bump = (field: string): void => {
    diff.fieldChanges[field] = (diff.fieldChanges[field] ?? 0) + 1;
  };

  // 연도 미지정이면 현재 주기(app_setting 'activeCycleId' 핀) 대조 — 최신 id의 active 주기가
  // 아니다. 연도 지정 가져오기가 미래/과거 연도 주기(status='active')를 만들어도
  // 연도 미지정 드라이런은 UI가 보여주는 핀 고정 주기와 대조해야 한다.
  const cycleId =
    targetCycleId !== undefined ? targetCycleId : (getActiveCycle(db)?.id ?? null);
  // soft-delete 분야도 커밋이 부활시키므로(⑤) 드라이런도 필터하지 않는다 —
  // 안 그러면 부활 대상을 전량 create로 오보한다.
  const cat =
    cycleId != null && categoryCode
      ? (db
          .prepare(`SELECT id FROM category WHERE cycle_id = ? AND code = ?`)
          .get(cycleId, categoryCode) as { id: number } | undefined)
      : undefined;

  const existingByNo = new Map<string, DiffQuestionRow>();
  if (cat) {
    // soft-delete 문항도 포함 — 커밋 qReingest/qUpdate가 부활시키므로(①) 드라이런이
    // create로 오보하지 않도록 deleted_at 필터를 걸지 않는다.
    const rows = db
      .prepare(
        `SELECT id, question_no, body, topic, chapter_major, chapter_minor, sort_key,
                max_score, allow_na, question_type, grade_symbol, answer_choice, score,
                scoring_mode, auto_candidate, deleted_at
         FROM question WHERE category_id = ?`,
      )
      .all(cat.id) as DiffQuestionRow[];
    for (const r of rows) existingByNo.set(r.question_no, r);
  }

  const pdfNos = new Set<string>();
  for (let idx = 0; idx < parse.questions.length; idx++) {
    const q = parse.questions[idx]!;
    if (!QUESTION_NO_RE.test(q.questionNo) || pdfNos.has(q.questionNo)) continue;
    pdfNos.add(q.questionNo);
    if ((q.chapterMajor ?? null) === null) diff.chapterMissing += 1;
    if (q.autoCandidate) diff.autoCandidates.push(q.questionNo);

    const existing = existingByNo.get(q.questionNo);
    const contract = q.subItems ? validateSubItemContract(q.subItems, q.maxScore) : null;
    if (contract && !contract.ok) {
      diff.criteriaViolations.push({ questionNo: q.questionNo, reason: contract.reason });
    }

    if (!existing) {
      diff.create += 1;
      if (contract?.ok) diff.criteriaEligible += 1;
      continue;
    }

    let changed = false;
    // soft-delete 문항을 PDF가 다시 담고 있으면 커밋이 부활시킨다(deleted_at=NULL) → 변경(①)
    if (existing.deleted_at !== null) changed = true;
    if (existing.body !== q.body) {
      bump('body');
      changed = true;
    }
    // topic/chapter는 파서 소유분. 단 구(3b 이전) 배치는 필드가 undefined —
    // 커밋이 기존값을 보존하므로(②) 드라이런도 변경으로 세지 않는다.
    if (q.topic !== undefined && (existing.topic ?? null) !== (q.topic ?? null)) {
      bump('topic');
      changed = true;
    }
    if (q.chapterMajor !== undefined && (existing.chapter_major ?? null) !== (q.chapterMajor ?? null)) {
      bump('chapterMajor');
      changed = true;
    }
    if (q.chapterMinor !== undefined && (existing.chapter_minor ?? null) !== (q.chapterMinor ?? null)) {
      bump('chapterMinor');
      changed = true;
    }
    if (existing.sort_key !== idx) {
      bump('sortKey');
      changed = true;
    }
    // 자동배점 후보 표시(파서 소유) — 커밋 qReingest/qUpdate가 갱신하므로 드라이런도 동일 판정.
    // 구배치(undefined)는 커밋이 기존값을 보존하므로 변경으로 세지 않는다(② 관례)
    if (q.autoCandidate !== undefined && existing.auto_candidate !== (q.autoCandidate ? 1 : 0)) {
      bump('autoCandidate');
      changed = true;
    }
    // 보호 필드 — 재인입은 덮어쓰지 않고 needs_recheck + 차이 목록 (A-1)
    if (!numEq(existing.max_score, q.maxScore)) {
      diff.protectedDiffs.push({
        questionNo: q.questionNo,
        field: 'maxScore',
        current: existing.max_score,
        parsed: q.maxScore,
      });
    }
    if (existing.allow_na !== (q.allowNa ? 1 : 0)) {
      diff.protectedDiffs.push({
        questionNo: q.questionNo,
        field: 'allowNa',
        current: existing.allow_na === 1,
        parsed: q.allowNa,
      });
    }
    if (!strEq(existing.question_type, q.questionType ?? null)) {
      diff.protectedDiffs.push({
        questionNo: q.questionNo,
        field: 'questionType',
        current: existing.question_type,
        parsed: q.questionType ?? null,
      });
    }
    if (!strEq(existing.grade_symbol, q.gradeSymbol ?? null)) {
      diff.protectedDiffs.push({
        questionNo: q.questionNo,
        field: 'gradeSymbol',
        current: existing.grade_symbol,
        parsed: q.gradeSymbol ?? null,
      });
    }

    if (contract?.ok) {
      // 커밋 applyCriteria와 동일 4분기 — 이미 동일 세부항목이 있으면(2회차) 오경보 금지(③)
      const existingCrit = db
        .prepare(
          `SELECT label, max_score FROM question_criterion
           WHERE question_id = ? AND deleted_at IS NULL ORDER BY sort, id`,
        )
        .all(existing.id) as Array<{ label: string; max_score: number }>;
      if (existingCrit.length > 0) {
        const sameSet =
          existingCrit.length === q.subItems!.length &&
          existingCrit.every(
            (c, i) =>
              c.label === q.subItems![i]!.label &&
              Math.abs(c.max_score - q.subItems![i]!.maxScore) < 1e-9,
          );
        if (!sameSet) diff.criteriaManual.push(q.questionNo); // 상이 — 수동 검수(행 미변경)
      } else {
        // 세부항목 행이 새로 삽입될 예정 → 커밋의 crit.changed와 동일하게 변경으로 집계(⑥ 정합)
        changed = true;
        const unGraded =
          existing.scoring_mode === 'simple' &&
          existing.score === null &&
          existing.answer_choice === null;
        if (unGraded) diff.criteriaEligible += 1;
        else diff.criteriaManual.push(q.questionNo);
      }
    }

    if (changed) diff.update += 1;
    else diff.unchanged += 1;
  }

  // 이미 soft-delete된 문항은 '누락'이 아니다 — 살아있는 행만 보고(①)
  for (const [no, row] of existingByNo) {
    if (!pdfNos.has(no) && row.deleted_at === null) diff.missingInPdf.push(no);
  }
  return diff;
}

/** 세부항목표 계약 (지시서: Σ배점==문항배점 ∧ 항목명 유일 ∧ 배점 양수 ∧ 항목 수 상한) */
export function validateSubItemContract(
  items: { label: string; maxScore: number }[],
  questionMaxScore: number | null,
): { ok: true } | { ok: false; reason: string } {
  if (items.length === 0) return { ok: false, reason: '세부항목 없음' };
  if (items.length > 30) return { ok: false, reason: `항목 수 상한 초과(${items.length} > 30)` };
  const labels = new Set<string>();
  let sum = 0;
  for (const it of items) {
    if (!(it.maxScore > 0)) return { ok: false, reason: `배점이 양수가 아님: "${it.label}"` };
    if (labels.has(it.label)) return { ok: false, reason: `항목명 중복: "${it.label}"` };
    labels.add(it.label);
    sum += it.maxScore;
  }
  if (questionMaxScore === null) return { ok: false, reason: '문항 배점 미검출 — 합계 대조 불가' };
  if (Math.abs(sum - questionMaxScore) > 1e-9)
    return { ok: false, reason: `Σ세부배점(${sum}) ≠ 문항배점(${questionMaxScore})` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 커밋
// ---------------------------------------------------------------------------

interface CategoryRow {
  id: number;
  name: string;
  deleted_at: string | null;
}

interface QuestionRow {
  id: number;
  body: string;
  topic: string | null;
  chapter_major: string | null;
  chapter_minor: string | null;
  max_score: number | null;
  allow_na: number;
  answer_choice: string | null;
  score: number | null;
  scoring_mode: string;
  sort_key: number;
  question_type: string | null;
  grade_symbol: string | null;
  revision_status: string | null;
  revision_note: string | null;
  needs_recheck: number;
  auto_candidate: number;
  row_version: number;
  deleted_at: string | null;
}

/**
 * 드라이런 배치를 커밋한다.
 * @param userId 라우트 경로의 세션 사용자. CLI 경로는 null(actor_kind='import'만으로 기록).
 */
export async function commitBatch(
  db: DB,
  batchId: number,
  mode: ImportMode,
  userId: number | null,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  const batch = db
    .prepare(`SELECT id, summary_json FROM import_batch WHERE id = ? AND kind = 'question_pdf'`)
    .get(batchId) as { id: number; summary_json: string | null } | undefined;
  if (!batch?.summary_json) throw new BatchNotFoundError(batchId);
  const summary = JSON.parse(batch.summary_json) as BatchSummaryJson;
  if (!Array.isArray(summary.files)) throw new BatchNotFoundError(batchId);

  // 1) 커밋 직전 스냅샷 (better-sqlite3 backup API — §6.1)
  let snapshotFile: string | null = null;
  if (opts.backupDir) {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const stamp = formatStamp(new Date());
    let dest = path.join(opts.backupDir, `pre-import-${stamp}.db`);
    if (fs.existsSync(dest)) {
      // 같은 분(minute) 내 재실행 — 배치 번호로 구분해 덮어쓰기 방지
      dest = path.join(opts.backupDir, `pre-import-${stamp}-batch${batchId}.db`);
    }
    await db.backup(dest);
    snapshotFile = dest;
  }

  const result: CommitResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    categoriesCreated: 0,
    skipped: [],
    revisionDeleted: [],
    snapshotFile,
    cycleId: 0,
    protectedDiffs: [],
    criteriaApplied: 0,
    criteriaManual: [],
    criteriaViolations: [],
    autoCandidates: [],
    carriedQuestions: 0,
    carriedAnswers: 0,
    carriedEvidence: 0,
  };

  // 2) 전체 단일 트랜잭션
  const runCommit = db.transaction(() => {
    const now = new Date().toISOString();
    // 연도 지정 배치는 그 연도의 주기로 인입 (드라이런이 기록한 값 — 클라이언트 입력을 믿지 않음)
    const cycleId =
      summary.targetYear != null
        ? ensureCycleForYear(db, summary.targetYear, now, userId, batchId)
        : ensureActiveCycle(db, now, userId, batchId);
    result.cycleId = cycleId;
    const carrySrcCycleId =
      summary.targetYear != null && (summary.carry ?? true)
        ? (summary.carrySourceCycleId ?? null)
        : null;

    const catSelect = db.prepare(
      `SELECT id, name, deleted_at FROM category WHERE cycle_id = ? AND code = ?`,
    );
    const catInsert = db.prepare(
      `INSERT INTO category (cycle_id, code, name, sort) VALUES (?, ?, ?, ?)`,
    );
    const catUpdateName = db.prepare(`UPDATE category SET name = ? WHERE id = ?`);
    const catRestore = db.prepare(`UPDATE category SET deleted_at = NULL WHERE id = ?`);
    const qSelect = db.prepare(
      `SELECT id, body, topic, chapter_major, chapter_minor, max_score, allow_na,
              answer_choice, score, scoring_mode, sort_key,
              question_type, grade_symbol,
              revision_status, revision_note, needs_recheck, auto_candidate, row_version, deleted_at
         FROM question WHERE category_id = ? AND question_no = ?`,
    );
    const qInsert = db.prepare(
      `INSERT INTO question (category_id, question_no, sort_key, body, topic,
                             chapter_major, chapter_minor, max_score, allow_na,
                             question_type, grade_symbol,
                             revision_status, revision_note, needs_recheck, auto_candidate,
                             updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const qUpdate = db.prepare(
      `UPDATE question
          SET body = ?, topic = ?, chapter_major = ?, chapter_minor = ?,
              max_score = ?, allow_na = ?, sort_key = ?,
              question_type = ?, grade_symbol = ?,
              revision_status = ?, revision_note = ?, needs_recheck = ?, auto_candidate = ?,
              deleted_at = NULL,
              row_version = row_version + 1, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    );
    // 재인입(A-1): 파서 소유분만 갱신 — 배점/유형/해당없음은 보존, 채점·답변·근거는 애초에 불가침.
    // deleted_at=NULL: PDF에 다시 담긴 soft-delete 문항은 부활시킨다(overwrite와 동일 — ①).
    const qReingest = db.prepare(
      `UPDATE question
          SET body = ?, topic = ?, chapter_major = ?, chapter_minor = ?, sort_key = ?,
              revision_status = ?, revision_note = ?, needs_recheck = ?, auto_candidate = ?,
              deleted_at = NULL,
              row_version = row_version + 1, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    );
    const qSetComposite = db.prepare(
      `UPDATE question SET scoring_mode = 'composite', row_version = row_version + 1,
                           updated_at = ?, updated_by = ? WHERE id = ?`,
    );
    const critSelect = db.prepare(
      `SELECT id, label, max_score FROM question_criterion
       WHERE question_id = ? AND deleted_at IS NULL ORDER BY sort, id`,
    );
    const critInsert = db.prepare(
      `INSERT INTO question_criterion (question_id, sort, label, max_score) VALUES (?, ?, ?, ?)`,
    );
    const logInsert = db.prepare(
      `INSERT INTO change_log (ts, actor_id, actor_kind, batch_id, entity, entity_id, action, before_json, after_json)
       VALUES (?, ?, 'import', ?, ?, ?, 'import', ?, ?)`,
    );
    // ── 전년도 이월 (신규 문항만): 답변·근거 연결 복사. 채점은 새해 초기값 그대로 ──
    const carrySrcSelect = db.prepare(
      `SELECT q.id, q.body, q.answer_json, q.answer_plain
         FROM question q
         JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
        WHERE c.cycle_id = ? AND c.code = ? AND q.question_no = ? AND q.deleted_at IS NULL`,
    );
    const carryAnswerUpdate = db.prepare(
      `UPDATE question SET answer_json = ?, answer_plain = ? WHERE id = ?`,
    );
    const carryFromUpdate = db.prepare(`UPDATE question SET carried_from_id = ? WHERE id = ?`);
    // MAX: 'same'(0)은 세부항목 검수 등으로 이미 켜진 needs_recheck를 끄지 않는다
    const carryRevisionUpdate = db.prepare(
      `UPDATE question SET revision_status = ?, revision_note = COALESCE(?, revision_note),
              needs_recheck = MAX(needs_recheck, ?) WHERE id = ?`,
    );
    const carryPassages = db.prepare(
      `INSERT INTO question_passage (question_id, passage_id, sort, note, created_by, created_at)
       SELECT ?, qp.passage_id, qp.sort, qp.note, ?, ?
         FROM question_passage qp
         JOIN passage p ON p.id = qp.passage_id AND p.deleted_at IS NULL
        WHERE qp.question_id = ?`,
    );
    const carryRichdocs = db.prepare(
      `INSERT INTO question_richdoc (question_id, rich_doc_id, sort, note)
       SELECT ?, qr.rich_doc_id, qr.sort, qr.note
         FROM question_richdoc qr
         JOIN rich_doc r ON r.id = qr.rich_doc_id AND r.deleted_at IS NULL
        WHERE qr.question_id = ?`,
    );
    const carryAttachments = db.prepare(
      `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, sort, uploaded_by, uploaded_at)
       SELECT ?, qa.sha256, qa.orig_name, qa.mime, qa.size, qa.sort, ?, ?
         FROM question_attachment qa
        WHERE qa.question_id = ? AND qa.deleted_at IS NULL`,
    );
    const carryLinks = db.prepare(
      `INSERT INTO question_link (question_id, url, label, sort, created_by, created_at)
       SELECT ?, ql.url, ql.label, ql.sort, ?, ?
         FROM question_link ql
        WHERE ql.question_id = ? AND ql.deleted_at IS NULL`,
    );
    const carryLog = db.prepare(
      `INSERT INTO change_log (ts, actor_id, actor_kind, batch_id, entity, entity_id, action, before_json, after_json)
       VALUES (?, ?, 'import', ?, 'question', ?, 'carry', NULL, ?)`,
    );

    for (const file of summary.files) {
      const { fileName, parse } = file;

      // 개정 요약표: new/modified → 문항 매칭용, deleted → 보고만 (§6.2 — 절대 삭제 없음)
      const revByNo = new Map<string, { kind: 'new' | 'modified'; note: string }>();
      for (const r of parse.revisionSummary) {
        if (r.kind === 'deleted') {
          result.revisionDeleted.push({ fileName, questionNo: r.questionNo, note: r.note });
        } else {
          revByNo.set(r.questionNo, { kind: r.kind, note: r.note });
        }
      }

      // 분야코드는 파일명 기반(설계서 계약) — 파서 추론 폐기
      const categoryCode = resolveCategoryCode(fileName, parse);
      if (!categoryCode || parse.questions.length === 0) {
        result.skipped.push({
          fileName,
          questionNo: '-',
          reason: '파싱된 문항이 없어 파일을 건너뜀',
        });
        continue;
      }

      // 분야 업서트 (cycle 내 code 키; code→name 갱신). 분야명은 표지 파서값 우선, 없으면 code.
      const catName = parse.categoryName ?? categoryCode;
      let cat = catSelect.get(cycleId, categoryCode) as CategoryRow | undefined;
      if (!cat) {
        const sort = Number.parseInt(categoryCode, 10) || 0;
        const info = catInsert.run(cycleId, categoryCode, catName, sort);
        cat = { id: Number(info.lastInsertRowid), name: catName, deleted_at: null };
        result.categoriesCreated += 1;
        logInsert.run(
          now, userId, batchId, 'category', cat.id, null,
          JSON.stringify({ cycleId, code: categoryCode, name: catName, sort }),
        );
      } else {
        // soft-delete된 분야가 PDF에 다시 등장 → 부활(⑤). 안 그러면 문항이 삭제된 분야 아래 인입.
        if (cat.deleted_at !== null) {
          logInsert.run(
            now, userId, batchId, 'category', cat.id,
            JSON.stringify({ deletedAt: cat.deleted_at }),
            JSON.stringify({ deletedAt: null, action: 'restore' }),
          );
          catRestore.run(cat.id);
          cat.deleted_at = null;
        }
        if (parse.categoryName && cat.name !== parse.categoryName) {
          logInsert.run(
            now, userId, batchId, 'category', cat.id,
            JSON.stringify({ name: cat.name }),
            JSON.stringify({ name: parse.categoryName }),
          );
          catUpdateName.run(parse.categoryName, cat.id);
        }
      }

      // 문항 업서트 — sort_key는 파싱 순서
      const seenNos = new Set<string>();
      for (let idx = 0; idx < parse.questions.length; idx++) {
        const q = parse.questions[idx]!;

        if (!QUESTION_NO_RE.test(q.questionNo)) {
          result.skipped.push({
            fileName,
            questionNo: q.questionNo,
            reason: '문항번호 형식 불일치(NN.NNN.NNN 아님)',
          });
          continue;
        }
        if (seenNos.has(q.questionNo)) {
          result.skipped.push({
            fileName,
            questionNo: q.questionNo,
            reason: '파일 내 중복 문항번호 — 첫 행만 반영',
          });
          continue;
        }
        seenNos.add(q.questionNo);

        const existing = qSelect.get(cat.id, q.questionNo) as QuestionRow | undefined;
        const rev = revByNo.get(q.questionNo);
        const revStatus = rev ? rev.kind : null;
        const revNote = rev ? rev.note : null;
        const allowNaInt = q.allowNa ? 1 : 0;
        const qType = q.questionType ?? null; // 'core' | 'required' | 'basic' | null
        const qGrade = q.gradeSymbol ?? null; // 'C' | 'R' | 'B' | null
        // 파서 소유분(topic/chapter). 구(3b 이전) 배치는 필드가 undefined —
        // 그럴 땐 기존 DB값을 보존한다(②). 신규 파서는 null(미검출)을 명시하므로 null은 그대로 기록.
        const qTopic = q.topic === undefined ? (existing?.topic ?? null) : (q.topic ?? null);
        const qChMajor =
          q.chapterMajor === undefined ? (existing?.chapter_major ?? null) : (q.chapterMajor ?? null);
        const qChMinor =
          q.chapterMinor === undefined ? (existing?.chapter_minor ?? null) : (q.chapterMinor ?? null);
        // 개정표 매칭이 배점변경·해당없음유무변경을 알리면 채점 재확인 플래그(설계서 실물 서식 계약)
        const revRecheck = revisionTriggersRecheck(revNote);
        if (q.autoCandidate) {
          result.autoCandidates.push({
            fileName,
            questionNo: q.questionNo,
            rows: q.autoCandidate.rows,
          });
        }
        const contract = q.subItems ? validateSubItemContract(q.subItems, q.maxScore) : null;

        /**
         * 세부항목표 적용 (지시서 Q3 — 계약 통과 시에만, 부분 인입 금지):
         *  · 미채점(simple·선택/점수 없음)·기존 세부항목 없음 → 항목 생성 + composite 전환
         *  · 채점 존재 → 항목만 생성(참고 데이터, 취득점 NULL) + needs_recheck (수동 전환 필요)
         *  · 기존 세부항목과 상이 → 덮어쓰지 않음(취득점 보존) + needs_recheck
         *  반환: recheck = needs_recheck 유발 여부, changed = 이 문항의 행/자식이 실제 변경됐는지
         *        (changed 는 재인입 same 판정에서 unchanged 오집계를 막는다 — ⑥)
         */
        const applyCriteria = (
          questionId: number,
          row: QuestionRow | null,
        ): { recheck: boolean; changed: boolean } => {
          if (!q.subItems) return { recheck: false, changed: false };
          if (contract && !contract.ok) {
            result.criteriaViolations.push({
              fileName,
              questionNo: q.questionNo,
              reason: contract.reason,
            });
            return { recheck: true, changed: false }; // 문항 전체 검수 (부분 인입 금지, 미변경)
          }
          const existingCrit = critSelect.all(questionId) as Array<{
            id: number;
            label: string;
            max_score: number;
          }>;
          if (existingCrit.length > 0) {
            const sameSet =
              existingCrit.length === q.subItems.length &&
              existingCrit.every(
                (c, i) =>
                  c.label === q.subItems![i]!.label &&
                  Math.abs(c.max_score - q.subItems![i]!.maxScore) < 1e-9,
              );
            if (sameSet) return { recheck: false, changed: false }; // 동일 — 무동작 (취득점 보존)
            result.criteriaManual.push({ fileName, questionNo: q.questionNo });
            return { recheck: true, changed: false }; // 상이 — 덮어쓰지 않고 검수
          }
          for (let s = 0; s < q.subItems.length; s++) {
            const it = q.subItems[s]!;
            critInsert.run(questionId, s + 1, it.label, it.maxScore);
          }
          logInsert.run(
            now, userId, batchId, 'question_criterion', questionId, null,
            JSON.stringify({ questionNo: q.questionNo, items: q.subItems }),
          );
          const unGraded =
            row === null ||
            (row.scoring_mode === 'simple' && row.score === null && row.answer_choice === null);
          if (unGraded) {
            qSetComposite.run(now, userId, questionId);
            // composite 전환도 감사 이력에 남긴다(⑥ — 이전엔 question_criterion 로그만 있었음)
            logInsert.run(
              now, userId, batchId, 'question', questionId,
              JSON.stringify({ scoringMode: row?.scoring_mode ?? 'simple' }),
              JSON.stringify({ scoringMode: 'composite', reason: 'criteria_applied' }),
            );
            result.criteriaApplied += 1;
            return { recheck: false, changed: true }; // 모드 전환됨 — 변경
          }
          // 채점 존재 — 조용한 모드 전환 금지(점수가 리프 합으로 재계산돼 소실됨). 수동 전환 유도.
          result.criteriaManual.push({ fileName, questionNo: q.questionNo });
          return { recheck: true, changed: true }; // 참고용 세부항목 행이 추가됨 — 변경
        };

        // 자동배점 후보(임계표 감지) — 파서 소유 표시 필드.
        // 구(006 이전) 배치 재커밋은 필드가 undefined — 기존값 보존 (topic/chapter 관례 ②와 동일)
        const autoInt =
          q.autoCandidate === undefined
            ? (existing?.auto_candidate ?? 0)
            : q.autoCandidate
              ? 1
              : 0;

        if (!existing) {
          let insRecheck = revRecheck ? 1 : 0;
          const info = qInsert.run(
            cat.id, q.questionNo, idx, q.body, qTopic, qChMajor, qChMinor,
            q.maxScore, allowNaInt,
            qType, qGrade, revStatus, revNote, insRecheck, autoInt, now, userId,
          );
          const newId = Number(info.lastInsertRowid);
          if (applyCriteria(newId, null).recheck && insRecheck === 0) {
            insRecheck = 1;
            db.prepare(`UPDATE question SET needs_recheck = 1 WHERE id = ?`).run(newId);
          }
          result.created += 1;
          logInsert.run(
            now, userId, batchId, 'question', newId, null,
            JSON.stringify({
              categoryId: cat.id, questionNo: q.questionNo, body: q.body, topic: qTopic,
              chapterMajor: qChMajor, chapterMinor: qChMinor,
              maxScore: q.maxScore, allowNa: allowNaInt,
              questionType: qType, gradeSymbol: qGrade,
              revisionStatus: revStatus, revisionNote: revNote,
              needsRecheck: insRecheck, sortKey: idx, autoCandidate: autoInt === 1,
            }),
          );

          // ── 전년도 이월: (분야코드, 문항번호) 매칭 시 답변·근거 연결 복사 ──
          // 채점(answer_choice/score/자동채움/지적/검토)은 새해 초기값 그대로 둔다.
          if (carrySrcCycleId != null) {
            const src = carrySrcSelect.get(carrySrcCycleId, categoryCode, q.questionNo) as
              | { id: number; body: string; answer_json: string | null; answer_plain: string | null }
              | undefined;
            if (src) {
              const hasAnswer =
                src.answer_json != null ||
                (src.answer_plain != null && src.answer_plain.trim() !== '');
              if (hasAnswer) carryAnswerUpdate.run(src.answer_json, src.answer_plain, newId);
              carryFromUpdate.run(src.id, newId);
              const nPassages = carryPassages.run(newId, userId, now, src.id).changes;
              const nRichdocs = carryRichdocs.run(newId, src.id).changes;
              const nAttachments = carryAttachments.run(newId, userId, now, src.id).changes;
              const nLinks = carryLinks.run(newId, userId, now, src.id).changes;
              // 개정표가 침묵한 문항은 전년도 본문과 대조해 변경 여부를 표시 (조용한 이관 금지)
              let finalRevStatus: 'same' | 'modified' | 'new' | null = revStatus;
              if (revStatus === null) {
                if (normalizeBodyForCompare(q.body) !== normalizeBodyForCompare(src.body)) {
                  finalRevStatus = 'modified';
                  carryRevisionUpdate.run(
                    'modified', '전년도 대비 내용 변경(개정표 미기재)', 1, newId,
                  );
                } else {
                  finalRevStatus = 'same';
                  carryRevisionUpdate.run('same', null, 0, newId);
                }
              }
              result.carriedQuestions += 1;
              if (hasAnswer) result.carriedAnswers += 1;
              result.carriedEvidence += nPassages + nRichdocs + nAttachments + nLinks;
              carryLog.run(
                now, userId, batchId, newId,
                JSON.stringify({
                  carriedFromId: src.id, sourceCycleId: carrySrcCycleId,
                  answerCopied: hasAnswer,
                  passages: nPassages, richdocs: nRichdocs,
                  attachments: nAttachments, links: nLinks,
                  revisionStatus: finalRevStatus,
                }),
              );
            }
          }
          continue;
        }

        // 기존 행 — keep_existing이면 본문/배점을 두고 건너뜀 (§6.1 라디오 의미)
        if (mode === 'keep_existing') {
          result.unchanged += 1;
          continue;
        }

        if (mode === 'reingest') {
          // ── A-1 비파괴 재인입: 파서 소유분만 갱신, 보호 필드 차이는 needs_recheck + 목록 ──
          let needsRecheck = existing.needs_recheck;
          const protect = (
            field: ProtectedDiff['field'],
            current: unknown,
            parsed: unknown,
          ): void => {
            result.protectedDiffs.push({ fileName, questionNo: q.questionNo, field, current, parsed });
            needsRecheck = 1;
          };
          if (!numEq(existing.max_score, q.maxScore))
            protect('maxScore', existing.max_score, q.maxScore);
          if (existing.allow_na !== allowNaInt)
            protect('allowNa', existing.allow_na === 1, q.allowNa);
          if (!strEq(existing.question_type, qType))
            protect('questionType', existing.question_type, qType);
          if (!strEq(existing.grade_symbol, qGrade))
            protect('gradeSymbol', existing.grade_symbol, qGrade);
          // revRecheck는 개정표가 새로 그 문항을 배점변경/해당없음유무변경으로 지목했을 때만 점화.
          // revision_note가 이전과 동일하면(이미 처리·해소된 건) 재점화하지 않는다(④).
          if (revRecheck && !strEq(existing.revision_note, revNote)) needsRecheck = 1;
          const crit = applyCriteria(existing.id, existing);
          if (crit.recheck) needsRecheck = 1;

          const same =
            existing.deleted_at === null && // soft-delete면 부활(update) — 절대 unchanged 아님(①)
            !crit.changed && // 세부항목/모드가 바뀌었으면 unchanged 오집계 금지(⑥)
            existing.body === q.body &&
            strEq(existing.topic, qTopic) &&
            strEq(existing.chapter_major, qChMajor) &&
            strEq(existing.chapter_minor, qChMinor) &&
            existing.sort_key === idx &&
            strEq(existing.revision_status, revStatus) &&
            strEq(existing.revision_note, revNote) &&
            existing.needs_recheck === needsRecheck &&
            existing.auto_candidate === autoInt;
          if (same) {
            result.unchanged += 1;
            continue;
          }
          logInsert.run(
            now, userId, batchId, 'question', existing.id,
            JSON.stringify({
              body: existing.body, topic: existing.topic,
              chapterMajor: existing.chapter_major, chapterMinor: existing.chapter_minor,
              sortKey: existing.sort_key, revisionStatus: existing.revision_status,
              revisionNote: existing.revision_note, needsRecheck: existing.needs_recheck,
              autoCandidate: existing.auto_candidate === 1,
              rowVersion: existing.row_version, deletedAt: existing.deleted_at,
            }),
            JSON.stringify({
              body: q.body, topic: qTopic, chapterMajor: qChMajor, chapterMinor: qChMinor,
              sortKey: idx, revisionStatus: revStatus, revisionNote: revNote,
              needsRecheck, autoCandidate: autoInt === 1, deletedAt: null, mode: 'reingest',
            }),
          );
          // 배점/유형/해당없음은 보존, 채점·답변·findings·근거는 애초에 불가침
          qReingest.run(
            q.body, qTopic, qChMajor, qChMinor, idx, revStatus, revNote, needsRecheck, autoInt,
            now, userId, existing.id,
          );
          result.updated += 1;
          continue;
        }

        const same =
          existing.deleted_at === null &&
          existing.body === q.body &&
          strEq(existing.topic, qTopic) &&
          strEq(existing.chapter_major, qChMajor) &&
          strEq(existing.chapter_minor, qChMinor) &&
          numEq(existing.max_score, q.maxScore) &&
          existing.allow_na === allowNaInt &&
          existing.sort_key === idx &&
          strEq(existing.question_type, qType) &&
          strEq(existing.grade_symbol, qGrade) &&
          strEq(existing.revision_status, revStatus) &&
          strEq(existing.revision_note, revNote) &&
          existing.auto_candidate === autoInt;
        if (same) {
          result.unchanged += 1;
          continue;
        }

        // §6.2-2 채점 정합성 재검증: 기존 점수가 새 배점 초과 / 해당없음 선택 불가 전환 /
        //           개정표가 배점변경·해당없음유무변경을 명시(revRecheck). 한 번 켜지면 유지.
        let needsRecheck = existing.needs_recheck;
        if (existing.score !== null && q.maxScore !== null && existing.score > q.maxScore) {
          needsRecheck = 1;
        }
        if (existing.answer_choice === 'na' && !q.allowNa) {
          needsRecheck = 1;
        }
        // 개정표 재확인 지목은 revision_note가 실제로 바뀌었을 때만 점화 —
        // 동일 원문 재커밋이 이미 해소된 recheck를 되살리지 않게 한다(④).
        if (revRecheck && !strEq(existing.revision_note, revNote)) {
          needsRecheck = 1;
        }

        logInsert.run(
          now, userId, batchId, 'question', existing.id,
          JSON.stringify({
            body: existing.body, topic: existing.topic,
            chapterMajor: existing.chapter_major, chapterMinor: existing.chapter_minor,
            maxScore: existing.max_score, allowNa: existing.allow_na,
            sortKey: existing.sort_key,
            questionType: existing.question_type, gradeSymbol: existing.grade_symbol,
            revisionStatus: existing.revision_status,
            revisionNote: existing.revision_note, autoCandidate: existing.auto_candidate === 1,
            rowVersion: existing.row_version,
            deletedAt: existing.deleted_at,
          }),
          JSON.stringify({
            body: q.body, topic: qTopic, chapterMajor: qChMajor, chapterMinor: qChMinor,
            maxScore: q.maxScore, allowNa: allowNaInt, sortKey: idx,
            questionType: qType, gradeSymbol: qGrade,
            revisionStatus: revStatus, revisionNote: revNote, needsRecheck,
            autoCandidate: autoInt === 1,
          }),
        );
        // 답변(answer_*)·채점(answer_choice/score)·findings·근거 링크는 절대 건드리지 않는다.
        qUpdate.run(
          q.body, qTopic, qChMajor, qChMinor, q.maxScore, allowNaInt, idx,
          qType, qGrade, revStatus, revNote, needsRecheck, autoInt,
          now, userId, existing.id,
        );
        result.updated += 1;
      }
    }

    // 배치 행 갱신: 커밋됨 표시 + 스냅샷 경로. files 원본은 재커밋 멱등성을 위해 유지.
    const commits = summary.commits ?? [];
    commits.push({
      at: now, mode,
      created: result.created, updated: result.updated, unchanged: result.unchanged,
    });
    db.prepare(`UPDATE import_batch SET dry_run = 0, snapshot_file = ?, summary_json = ? WHERE id = ?`)
      .run(snapshotFile, JSON.stringify({ ...summary, commits }), batchId);
  });
  runCommit();

  return result;
}

/** 현재 주기 고정 설정이 없을 때만 심는다 — 있으면 절대 바꾸지 않는다(전환은 별도 관리 기능) */
function seedActiveCycleSetting(db: DB, cycleId: number): void {
  db.prepare(`INSERT OR IGNORE INTO app_setting (key, value) VALUES ('activeCycleId', ?)`).run(
    String(cycleId),
  );
}

/**
 * 현재 주기 조회 — 없으면 생성(초기 CLI 인입용) + change_log 기록.
 * app_setting 'activeCycleId' 핀을 우선한다(getActiveCycle) — 최신 id의 active 주기가 아니다.
 * 연도 지정 가져오기가 미래/과거 연도 주기(status='active')를 만든 뒤에도 연도 미지정
 * 커밋(라우트·cli-ingest·reingest-cli)은 UI가 보여주는 핀 고정 주기로 인입해야 한다.
 */
function ensureActiveCycle(db: DB, now: string, userId: number | null, batchId: number): number {
  const current = getActiveCycle(db); // 핀 우선, 없으면 최신 active를 핀에 고정하고 반환
  if (current) return current.id;
  const year = Number.parseInt(now.slice(0, 4), 10);
  const name = `${year}년 심사 주기`;
  const info = db
    .prepare(`INSERT INTO cycle (name, status, year, created_at) VALUES (?, 'active', ?, ?)`)
    .run(name, year, now);
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO change_log (ts, actor_id, actor_kind, batch_id, entity, entity_id, action, before_json, after_json)
     VALUES (?, ?, 'import', ?, 'cycle', ?, 'create', NULL, ?)`,
  ).run(now, userId, batchId, id, JSON.stringify({ name, status: 'active', year }));
  seedActiveCycleSetting(db, id);
  return id;
}

/**
 * 연도 지정 커밋의 대상 주기 — 그 연도 주기가 없으면 생성 + change_log 기록.
 * 새 연도 주기를 만들어도 '현재 주기'는 바뀌지 않는다: 생성 전에 현재 활성 주기를
 * activeCycleId 설정에 먼저 고정한다(설정이 이미 있으면 어느 쪽도 건드리지 않음).
 */
function ensureCycleForYear(
  db: DB,
  year: number,
  now: string,
  userId: number | null,
  batchId: number,
): number {
  // 새 연도 주기를 만들기 전에 현재 주기를 핀에 고정한다
  // (설정이 이미 있으면 getActiveCycle 은 아무것도 바꾸지 않는다).
  getActiveCycle(db);
  const existing = db
    .prepare(`SELECT id FROM cycle WHERE year = ? ORDER BY id DESC LIMIT 1`)
    .get(year) as { id: number } | undefined;
  if (existing) return existing.id;
  const name = `${year}년 심사`;
  const info = db
    .prepare(`INSERT INTO cycle (name, status, year, created_at) VALUES (?, 'active', ?, ?)`)
    .run(name, year, now);
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO change_log (ts, actor_id, actor_kind, batch_id, entity, entity_id, action, before_json, after_json)
     VALUES (?, ?, 'import', ?, 'cycle', ?, 'create', NULL, ?)`,
  ).run(now, userId, batchId, id, JSON.stringify({ name, status: 'active', year }));
  seedActiveCycleSetting(db, id); // 주기가 하나도 없던 DB라면 새 주기가 곧 현재 주기
  return id;
}

/** 이월 본문 비교용 정규화 — 앞뒤 공백 제거 + 연속 공백 축약 (줄바꿈 차이를 개정으로 오인 방지) */
function normalizeBodyForCompare(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function numEq(a: number | null, b: number | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a === b);
}

function strEq(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** 스냅샷 파일명용 타임스탬프: YYYYMMDD-HHmm (로컬 시간) */
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
