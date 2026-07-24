/**
 * 엑셀 내보내기 — ExcelJS 워크북 생성 (설계서 §6.3, §6.1)
 * - buildExportWorkbook: 분야별/전체 왕복 내보내기(문항·채점·근거요약 + 분야별 합계 행 + 전체 합계).
 * - buildTemplateWorkbook: §6.1 가져오기 양식(+안내 시트).
 *
 * 합계 계산(대시보드/bootstrap과 동일 정의):
 *   취득(scoreSum) = Σ score  where answer_choice ∈ (yes,no)      // 아니오는 0, 해당없음/미선택 제외
 *   만점(maxSum)   = Σ max_score where answer_choice ≠ na         // 해당없음은 분모에서 제외
 *   달성률          = maxSum>0 ? round(scoreSum/maxSum*100, 0.1) : null
 */
import ExcelJS from 'exceljs';
import type { AnswerChoice, ExportCategory, ExportQuestionRow, QuestionTypeCode } from './data.js';

// ── 표시 매핑 ────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<QuestionTypeCode, string> = {
  core: '핵심',
  required: '필요',
  basic: '기본',
};
const CHOICE_LABEL: Record<AnswerChoice, string> = {
  yes: '예',
  no: '아니오',
  na: '해당없음',
};

/** 완성도 파생(저장 안 함): ● 완료 / ◐ 일부작성 / ○ 미작성 + 검토완료.
 *  합산/자동 모드는 answer_choice 없이 score 존재가 '채점됨' (Phase 3a — 대시보드와 동일 정의) */
export function statusText(q: ExportQuestionRow): string {
  const graded =
    q.answerChoice != null || (q.scoringMode !== 'simple' && q.score != null);
  const answered = q.hasAnswer;
  const base = graded && answered ? '완료' : graded || answered ? '일부작성' : '미작성';
  return q.reviewed ? `${base} · 검토완료` : base;
}

export interface CategoryTotals {
  scoreSum: number;
  maxSum: number;
  /** 달성률(%) — 소수 1자리 반올림. 분모 0이면 null. */
  achievementPct: number | null;
}

/** 분야(또는 문항 묶음) 합계 — 해당없음은 분모(만점)에서 제외.
 *  합산/자동 모드는 answer_choice 없이 score 가 유효 총점 (bootstrap 집계와 동일 정의 — Phase 3a) */
export function computeTotals(questions: ExportQuestionRow[]): CategoryTotals {
  let scoreSum = 0;
  let maxSum = 0;
  for (const q of questions) {
    if (q.answerChoice === 'yes' || q.answerChoice === 'no' || q.scoringMode !== 'simple')
      scoreSum += q.score ?? 0;
    if (q.answerChoice !== 'na') maxSum += q.maxScore ?? 0;
  }
  const achievementPct = maxSum > 0 ? Math.round((scoreSum / maxSum) * 1000) / 10 : null;
  return { scoreSum, maxSum, achievementPct };
}

function pctText(pct: number | null): string {
  return pct != null ? `달성률 ${pct}%` : '달성률 —';
}

// ── 열 정의 (§6.3) ───────────────────────────────────────────────────────────

interface ColSpec {
  header: string;
  key: string;
  width: number;
}
const COLUMNS: ColSpec[] = [
  { header: '분야코드', key: 'categoryCode', width: 10 },
  { header: '문항번호', key: 'questionNo', width: 14 },
  { header: '문항', key: 'body', width: 50 },
  { header: '유형', key: 'type', width: 8 },
  { header: '배점', key: 'maxScore', width: 8 },
  { header: '선택', key: 'choice', width: 12 },
  { header: '점수', key: 'score', width: 8 },
  { header: '지적/권장사항', key: 'findings', width: 30 },
  { header: '답변(평문)', key: 'answer', width: 40 },
  { header: '상태', key: 'status', width: 16 },
  { header: '근거요약', key: 'evidence', width: 45 },
  { header: '최종수정자', key: 'updatedBy', width: 12 },
  { header: '최종수정일시', key: 'updatedAt', width: 20 },
];
// 합계 행에서 값을 채우는 열 위치(1-base) — 재파싱/검증의 기준
export const COL_INDEX = {
  categoryCode: 1,
  maxScore: 5,
  score: 7,
  status: 10,
} as const;

const HEADER_FILL = 'FFE8EEF7';
const SUBTOTAL_FILL = 'FFF3F4F6';
const GRANDTOTAL_FILL = 'FFE5E7EB';

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB0B7C3' } } };
  });
}

export interface ExportMeta {
  orgName?: string;
  cycleName?: string;
  /** 시트에 표기할 범위 명칭 (예: '전체' 또는 '50 개인정보보호') */
  scopeLabel?: string;
  /** '준비도 요약' 시트 데이터 (C-2 — 전체 내보내기에서만 전달. 심사 D-7 점검 회의용) */
  readiness?: {
    categories: {
      code: string;
      name: string;
      questionCount: number;
      noEvidence: number;
      autofilled: number;
      needsRecheck: number;
      metricMissing: number;
    }[];
    totals: {
      noEvidence: number;
      autofilled: number;
      needsRecheck: number;
      metricMissing: number;
      reviewOpen: number;
    };
  };
}

export function buildExportWorkbook(
  categories: ExportCategory[],
  meta: ExportMeta = {},
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.orgName && meta.orgName.length > 0 ? meta.orgName : '우수검사실 인증심사 웹 바인더';
  wb.created = new Date();

  const ws = wb.addWorksheet('문항', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeaderRow(ws.getRow(1));

  let grandScore = 0;
  let grandMax = 0;

  for (const cat of categories) {
    for (const q of cat.questions) {
      const scoreCell =
        q.scoringMode !== 'simple'
          ? (q.score ?? null) // 합산/자동 — 구체화된 유효 총점 그대로 (§6.3)
          : q.answerChoice === 'na' || q.answerChoice == null
            ? null
            : (q.score ?? null);
      const row = ws.addRow({
        categoryCode: cat.code,
        questionNo: q.questionNo,
        body: q.body,
        type: q.questionType ? TYPE_LABEL[q.questionType] : '',
        maxScore: q.maxScore ?? null,
        choice: q.answerChoice ? CHOICE_LABEL[q.answerChoice] : '',
        score: scoreCell,
        findings: q.findingsText ?? '',
        answer: q.answerPlain ?? '',
        status: statusText(q),
        evidence: q.evidenceSummary,
        updatedBy: q.updatedByName ?? '',
        updatedAt: q.updatedAt ?? '',
      });
      row.alignment = { vertical: 'top', wrapText: true };
    }

    const totals = computeTotals(cat.questions);
    grandScore += totals.scoreSum;
    grandMax += totals.maxSum;
    const sub = ws.addRow({
      categoryCode: '합계',
      body: `${cat.code} ${cat.name} 합계`,
      maxScore: totals.maxSum,
      score: totals.scoreSum,
      status: pctText(totals.achievementPct),
    });
    sub.font = { bold: true };
    sub.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBTOTAL_FILL } };
    });
  }

  // 전체 내보내기(분야 2개↑)일 때만 전체 합계 행
  if (categories.length > 1) {
    const pct = grandMax > 0 ? Math.round((grandScore / grandMax) * 1000) / 10 : null;
    const grand = ws.addRow({
      categoryCode: '전체합계',
      body: '전체 합계',
      maxScore: grandMax,
      score: grandScore,
      status: pctText(pct),
    });
    grand.font = { bold: true };
    grand.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRANDTOTAL_FILL } };
      cell.border = { top: { style: 'medium', color: { argb: 'FF9CA3AF' } } };
    });
  }

  // '준비도 요약' 시트 (C-2 — 전체 내보내기에서만. ①'근거 없음'은 발췌·자유문서·첨부파일·
  // 링크 네 종류 모두 없는 문항 — 대시보드 준비도 진단(computeReadiness)과 동일 정의)
  if (meta.readiness) {
    const rs = wb.addWorksheet('준비도 요약', { views: [{ state: 'frozen', ySplit: 1 }] });
    rs.columns = [
      { header: '분야코드', key: 'code', width: 10 },
      { header: '분야명', key: 'name', width: 26 },
      { header: '문항 수', key: 'questionCount', width: 10 },
      { header: '근거 연결 전', key: 'noEvidence', width: 12 },
      { header: '자동입력 미확정', key: 'autofilled', width: 16 },
      { header: '재확인 필요', key: 'needsRecheck', width: 12 },
      { header: '지표 미입력(자동배점)', key: 'metricMissing', width: 20 },
    ];
    styleHeaderRow(rs.getRow(1));
    for (const c of meta.readiness.categories) {
      rs.addRow({
        code: c.code,
        name: c.name,
        questionCount: c.questionCount,
        noEvidence: c.noEvidence,
        autofilled: c.autofilled,
        needsRecheck: c.needsRecheck,
        metricMissing: c.metricMissing,
      });
    }
    const t = meta.readiness.totals;
    const totalRow = rs.addRow({
      code: '전체',
      name: `확인 필요 미처리 ${t.reviewOpen}건`,
      questionCount: meta.readiness.categories.reduce((s, c) => s + c.questionCount, 0),
      noEvidence: t.noEvidence,
      autofilled: t.autofilled,
      needsRecheck: t.needsRecheck,
      metricMissing: t.metricMissing,
    });
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRANDTOTAL_FILL } };
      cell.border = { top: { style: 'medium', color: { argb: 'FF9CA3AF' } } };
    });
  }

  return wb;
}

// ── §6.1 가져오기 양식 ────────────────────────────────────────────────────────

interface TemplateColSpec {
  header: string;
  key: string;
  width: number;
}
const TEMPLATE_COLUMNS: TemplateColSpec[] = [
  { header: '분야코드', key: 'code', width: 12 },
  { header: '분야명', key: 'name', width: 20 },
  { header: '문항번호', key: 'no', width: 14 },
  { header: '문항', key: 'body', width: 50 },
  { header: '배점', key: 'max', width: 8 },
  { header: '해당없음가능', key: 'na', width: 14 },
  { header: '유형(선택)', key: 'type', width: 12 },
  { header: '답변(선택)', key: 'answer', width: 40 },
  { header: '근거참조(선택)', key: 'ref', width: 30 },
];

export function buildTemplateWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = '우수검사실 인증심사 웹 바인더';
  wb.created = new Date();

  const ws = wb.addWorksheet('문항', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeaderRow(ws.getRow(1));

  // 예시 행(무저작권 가상 문항 — 실제 인증 문항 아님)
  const examples = [
    {
      code: '50',
      name: '개인정보보호',
      no: '50.010.010',
      body: '(예시) 개인정보 처리방침을 수립하여 공개하고 있는가?',
      max: 3,
      na: '아니오',
      type: '핵심',
      answer: '',
      ref: '처리지침 p.12, 처리방침 게시화면',
    },
    {
      code: '50',
      name: '개인정보보호',
      no: '50.010.020',
      body: '(예시) 개인정보 파기 대장을 작성·관리하고 있는가?',
      max: 2,
      na: '예',
      type: '기본',
      answer: '',
      ref: '',
    },
  ];
  for (const e of examples) {
    const r = ws.addRow(e);
    r.alignment = { vertical: 'top', wrapText: true };
    r.font = { color: { argb: 'FF6B7280' } }; // 예시행은 회색 — 삭제 후 실데이터 입력 안내
  }

  // 안내 시트
  const guide = wb.addWorksheet('안내');
  guide.columns = [
    { header: '항목', key: 'k', width: 18 },
    { header: '설명', key: 'v', width: 80 },
  ];
  styleHeaderRow(guide.getRow(1));
  const notes: [string, string][] = [
    ['사용 방법', "‘문항’ 시트의 회색 예시 2행을 지우고, 아래 규칙에 따라 문항을 입력한 뒤 가져오기 화면에서 업로드하세요."],
    ['분야코드', '분야 식별 코드(필수). 같은 분야는 동일 코드를 사용합니다. 예: 50'],
    ['분야명', '분야 이름(필수). 예: 개인정보보호'],
    ['문항번호', '문항 식별 번호(필수). 형식 예: 50.010.010'],
    ['문항', '문항 본문(필수).'],
    ['배점', '문항 배점(숫자). 예: 3, 2.5'],
    ['해당없음가능', "‘해당없음’ 선택 허용 여부. ‘예’ 또는 ‘아니오’로 입력."],
    ['유형(선택)', "문항 유형. ‘핵심’·‘필요’·‘기본’ 중 하나(비워도 됨)."],
    ['답변(선택)', '초기 답변 평문(비워도 됨).'],
    ['근거참조(선택)', "기존 바인더의 페이지 참조·키워드. 예: ‘처리지침 p.37, 파기대장’. 매핑 시 검색 시드로 사용됩니다."],
    ['업서트 키', "(분야코드, 문항번호) 조합으로 신규/갱신을 판별합니다. 가져오기는 삭제하지 않습니다(빠진 행은 보고만)."],
    ['근거 연결', '가져오기는 이미 연결된 근거를 건드리지 않습니다.'],
  ];
  for (const [k, v] of notes) {
    const r = guide.addRow({ k, v });
    r.getCell('k').font = { bold: true };
    r.getCell('v').alignment = { wrapText: true, vertical: 'top' };
  }

  return wb;
}
