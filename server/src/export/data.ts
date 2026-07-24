/**
 * 엑셀 내보내기 — DB 수집 계층 (설계서 §6.3)
 * 활성 주기의 분야·문항과 근거요약(발췌 출처행·문서 제목 / 자유형식 문서 제목)을 한 번에 모은다.
 * - 근거 조회는 IN(...) 대신 question→category→cycle 조인으로 필터해 SQLite 변수 상한(999)을 피한다.
 * - passage 근거는 문서의 "현재 판본" 앵커를 조인해 페이지·인용문을 붙인다(없으면 제목만).
 * 정렬은 대시보드/목록과 동일한 c.sort, c.code, q.sort_key, q.question_no.
 */
import type Database from 'better-sqlite3';

export type QuestionTypeCode = 'core' | 'required' | 'basic';
export type AnswerChoice = 'yes' | 'no' | 'na';

export interface ExportQuestionRow {
  id: number;
  categoryCode: string;
  questionNo: string;
  body: string;
  questionType: QuestionTypeCode | null;
  gradeSymbol: string | null;
  maxScore: number | null;
  allowNa: boolean;
  answerChoice: AnswerChoice | null;
  score: number | null;
  /** 채점 방식 (v1.5 Phase 3a) — composite/auto 는 answer_choice 없이 score 가 유효 총점 */
  scoringMode: 'simple' | 'composite' | 'auto';
  findingsText: string | null;
  answerPlain: string | null;
  /** 답변 존재 여부 (평문 또는 Tiptap JSON) — 목록의 hasAnswer와 동일 기준 */
  hasAnswer: boolean;
  reviewed: boolean;
  revisionStatus: 'same' | 'modified' | 'new' | null;
  needsRecheck: boolean;
  /** 근거요약: 여러 근거를 줄바꿈으로 연결 (빈 문자열이면 근거 없음) */
  evidenceSummary: string;
  updatedByName: string | null;
  updatedAt: string;
}

export interface ExportCategory {
  id: number;
  code: string;
  name: string;
  questions: ExportQuestionRow[];
}

interface CategoryRow {
  id: number;
  code: string;
  name: string;
}

interface QuestionDbRow {
  id: number;
  category_id: number;
  category_code: string;
  question_no: string;
  body: string;
  question_type: QuestionTypeCode | null;
  grade_symbol: string | null;
  max_score: number | null;
  allow_na: number;
  answer_choice: AnswerChoice | null;
  score: number | null;
  scoring_mode: 'simple' | 'composite' | 'auto';
  findings_text: string | null;
  answer_plain: string | null;
  answer_json: string | null;
  reviewed: number;
  revision_status: 'same' | 'modified' | 'new' | null;
  needs_recheck: number;
  sort_key: number;
  updated_at: string;
  updated_by_name: string | null;
}

interface PassageEvidenceRow {
  question_id: number;
  sort: number;
  doc_title: string;
  page_start: number | null;
  quote_exact: string | null;
  label: string | null;
}

interface RichdocEvidenceRow {
  question_id: number;
  sort: number;
  title: string;
}

/** 인용문 발췌 요약 길이 제한 (셀 과대 방지) */
const QUOTE_MAX = 60;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 문항별 근거요약 문자열 맵 (sort 통합 정렬로 줄바꿈 연결) */
function buildEvidenceMap(
  db: Database.Database,
  cycleId: number,
  categoryId?: number,
): Map<number, string> {
  const catFilter = categoryId != null ? 'AND q.category_id = ?' : '';
  const params: unknown[] = categoryId != null ? [cycleId, categoryId] : [cycleId];

  const passages = db
    .prepare(
      `SELECT qp.question_id, qp.sort,
              d.title AS doc_title, pa.page_start, pa.quote_exact, p.label
       FROM question_passage qp
       JOIN question q ON q.id = qp.question_id AND q.deleted_at IS NULL
       JOIN category c ON c.id = q.category_id
       JOIN passage p ON p.id = qp.passage_id AND p.deleted_at IS NULL
       JOIN document d ON d.id = p.document_id
       LEFT JOIN document_version dv ON dv.document_id = p.document_id AND dv.is_current = 1
       LEFT JOIN passage_anchor pa ON pa.passage_id = p.id AND pa.document_version_id = dv.id
       WHERE c.cycle_id = ? ${catFilter}`,
    )
    .all(...params) as PassageEvidenceRow[];

  const richdocs = db
    .prepare(
      `SELECT qr.question_id, qr.sort, r.title
       FROM question_richdoc qr
       JOIN question q ON q.id = qr.question_id AND q.deleted_at IS NULL
       JOIN category c ON c.id = q.category_id
       JOIN rich_doc r ON r.id = qr.rich_doc_id AND r.deleted_at IS NULL
       WHERE c.cycle_id = ? ${catFilter}`,
    )
    .all(...params) as RichdocEvidenceRow[];

  interface Item {
    sort: number;
    kind: 'passage' | 'richdoc';
    text: string;
  }
  const byQuestion = new Map<number, Item[]>();
  const push = (qid: number, item: Item) => {
    const arr = byQuestion.get(qid);
    if (arr) arr.push(item);
    else byQuestion.set(qid, [item]);
  };

  for (const p of passages) {
    const parts: string[] = [p.doc_title];
    if (p.page_start != null) parts.push(`p.${p.page_start}`);
    let text = parts.join(' ');
    if (p.label) text += ` [${truncate(p.label, 30)}]`;
    if (p.quote_exact) text += ` "${truncate(p.quote_exact, QUOTE_MAX)}"`;
    push(p.question_id, { sort: p.sort, kind: 'passage', text });
  }
  for (const r of richdocs) {
    push(r.question_id, { sort: r.sort, kind: 'richdoc', text: `[자유형식] ${r.title}` });
  }

  const out = new Map<number, string>();
  for (const [qid, items] of byQuestion) {
    items.sort((a, b) => {
      if (a.sort !== b.sort) return a.sort - b.sort;
      if (a.kind !== b.kind) return a.kind === 'passage' ? -1 : 1;
      return 0;
    });
    out.set(qid, items.map((i) => i.text).join('\n'));
  }
  return out;
}

/**
 * 활성 주기의 내보내기용 분야·문항을 수집한다.
 * @param categoryId 지정 시 해당 분야만(분야별 내보내기), 미지정 시 전체.
 */
export function collectExportCategories(
  db: Database.Database,
  cycleId: number,
  categoryId?: number,
): ExportCategory[] {
  const catFilter = categoryId != null ? 'AND id = ?' : '';
  const catParams: unknown[] = categoryId != null ? [cycleId, categoryId] : [cycleId];
  const categories = db
    .prepare(
      `SELECT id, code, name FROM category
       WHERE cycle_id = ? ${catFilter} AND deleted_at IS NULL
       ORDER BY sort, code`,
    )
    .all(...catParams) as CategoryRow[];
  if (categories.length === 0) return [];

  const qFilter = categoryId != null ? 'AND q.category_id = ?' : '';
  const qParams: unknown[] = categoryId != null ? [cycleId, categoryId] : [cycleId];
  const rows = db
    .prepare(
      `SELECT q.id, q.category_id, c.code AS category_code, q.question_no, q.body,
              q.question_type, q.grade_symbol, q.max_score, q.allow_na, q.answer_choice,
              q.score, q.scoring_mode, q.findings_text, q.answer_plain, q.answer_json, q.reviewed,
              q.revision_status, q.needs_recheck, q.sort_key, q.updated_at,
              u.display_name AS updated_by_name
       FROM question q
       JOIN category c ON c.id = q.category_id
       LEFT JOIN user u ON u.id = q.updated_by
       WHERE c.cycle_id = ? ${qFilter} AND q.deleted_at IS NULL
       ORDER BY c.sort, c.code, q.sort_key, q.question_no`,
    )
    .all(...qParams) as QuestionDbRow[];

  const evidence = buildEvidenceMap(db, cycleId, categoryId);

  const catMap = new Map<number, ExportCategory>();
  for (const c of categories) {
    catMap.set(c.id, { id: c.id, code: c.code, name: c.name, questions: [] });
  }
  for (const r of rows) {
    const cat = catMap.get(r.category_id);
    if (!cat) continue;
    const hasAnswer =
      (r.answer_plain != null && r.answer_plain.trim() !== '') || r.answer_json != null;
    cat.questions.push({
      id: r.id,
      categoryCode: r.category_code,
      questionNo: r.question_no,
      body: r.body,
      questionType: r.question_type,
      gradeSymbol: r.grade_symbol,
      maxScore: r.max_score,
      allowNa: r.allow_na === 1,
      answerChoice: r.answer_choice,
      score: r.score,
      scoringMode: r.scoring_mode,
      findingsText: r.findings_text,
      answerPlain: r.answer_plain,
      hasAnswer,
      reviewed: r.reviewed === 1,
      revisionStatus: r.revision_status,
      needsRecheck: r.needs_recheck === 1,
      evidenceSummary: evidence.get(r.id) ?? '',
      updatedByName: r.updated_by_name,
      updatedAt: r.updated_at,
    });
  }
  // categories 순서(sort, code) 유지
  return categories.map((c) => catMap.get(c.id)!).filter((c): c is ExportCategory => c != null);
}
