// 엑셀 내보내기 워크북 — 합계/달성률(해당없음 분모 제외)·열 스펙을 ExcelJS 재파싱으로 검증
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ExportCategory, ExportQuestionRow } from './data.js';
import {
  buildExportWorkbook,
  buildTemplateWorkbook,
  computeTotals,
  statusText,
} from './workbook.js';

function q(partial: Partial<ExportQuestionRow>): ExportQuestionRow {
  return {
    id: 1,
    categoryCode: '50',
    questionNo: '50.010.010',
    body: '문항 본문',
    questionType: null,
    gradeSymbol: null,
    maxScore: null,
    allowNa: false,
    answerChoice: null,
    score: null,
    scoringMode: 'simple',
    findingsText: null,
    answerPlain: null,
    hasAnswer: false,
    reviewed: false,
    revisionStatus: null,
    needsRecheck: false,
    evidenceSummary: '',
    updatedByName: null,
    updatedAt: '2026-07-13T00:00:00.000Z',
    ...partial,
  };
}

const sampleQuestions: ExportQuestionRow[] = [
  q({ id: 1, questionNo: '50.010.010', answerChoice: 'yes', score: 3, maxScore: 3, hasAnswer: true }),
  q({ id: 2, questionNo: '50.010.020', answerChoice: 'no', score: 0, maxScore: 2 }),
  q({ id: 3, questionNo: '50.010.030', answerChoice: 'na', maxScore: 2, allowNa: true }),
  q({ id: 4, questionNo: '50.010.040', answerChoice: null, maxScore: 5 }),
];

describe('computeTotals (해당없음 분모 제외)', () => {
  it('취득=예/아니오 점수합, 만점=na 제외 배점합, 달성률', () => {
    const t = computeTotals(sampleQuestions);
    expect(t.scoreSum).toBe(3); // 3 + 0
    expect(t.maxSum).toBe(10); // 3 + 2 + 5 (na의 2 제외)
    expect(t.achievementPct).toBe(30); // 3/10
  });

  it('합산/자동 모드는 answer_choice 없이 score 가 합계에 포함 (Phase 3a)', () => {
    const t = computeTotals([
      q({ scoringMode: 'composite', answerChoice: null, score: 8.5, maxScore: 10 }),
      q({ scoringMode: 'auto', answerChoice: null, score: 4, maxScore: 5 }),
      q({ answerChoice: 'yes', score: 3, maxScore: 3 }),
    ]);
    expect(t.scoreSum).toBe(15.5);
    expect(t.maxSum).toBe(18);
  });

  it('만점 0이면 달성률 null', () => {
    const t = computeTotals([q({ answerChoice: 'na', maxScore: 4, allowNa: true })]);
    expect(t.maxSum).toBe(0);
    expect(t.achievementPct).toBeNull();
  });
});

describe('statusText', () => {
  it('채점+답변 → 완료, 검토완료 접미', () => {
    expect(statusText(q({ answerChoice: 'yes', hasAnswer: true }))).toBe('완료');
    expect(statusText(q({ answerChoice: 'yes', hasAnswer: true, reviewed: true }))).toBe(
      '완료 · 검토완료',
    );
  });
  it('일부/미작성', () => {
    expect(statusText(q({ answerChoice: 'yes', hasAnswer: false }))).toBe('일부작성');
    expect(statusText(q({ answerChoice: null, hasAnswer: false }))).toBe('미작성');
  });
});

async function reparse(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buf = await wb.xlsx.writeBuffer();
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(buf as ArrayBuffer);
  return out;
}

function cellText(row: ExcelJS.Row, col: number): string {
  const v = row.getCell(col).value;
  return v == null ? '' : String(v);
}

describe('buildExportWorkbook (분야별)', () => {
  it('헤더·데이터·분야 합계 행이 재파싱으로 일치', async () => {
    const cats: ExportCategory[] = [
      { id: 1, code: '50', name: '개인정보보호', questions: sampleQuestions },
    ];
    const parsed = await reparse(buildExportWorkbook(cats, { scopeLabel: '50 개인정보보호' }));
    const ws = parsed.getWorksheet('문항');
    expect(ws).toBeDefined();
    const sheet = ws!;

    // 헤더
    expect(cellText(sheet.getRow(1), 1)).toBe('분야코드');
    expect(cellText(sheet.getRow(1), 3)).toBe('문항');
    expect(cellText(sheet.getRow(1), 5)).toBe('배점');
    expect(cellText(sheet.getRow(1), 7)).toBe('점수');
    expect(cellText(sheet.getRow(1), 10)).toBe('상태');
    expect(cellText(sheet.getRow(1), 11)).toBe('근거요약');

    // 첫 데이터 행 (yes, 3점)
    expect(cellText(sheet.getRow(2), 1)).toBe('50');
    expect(cellText(sheet.getRow(2), 6)).toBe('예');
    expect(sheet.getRow(2).getCell(7).value).toBe(3);
    expect(cellText(sheet.getRow(2), 10)).toBe('완료');

    // na 행: 점수 셀 비어 있음, 선택=해당없음
    expect(cellText(sheet.getRow(4), 6)).toBe('해당없음');
    expect(sheet.getRow(4).getCell(7).value == null).toBe(true);

    // 합계 행(6행): 만점=10, 취득=3, 달성률 30%
    const sub = sheet.getRow(6);
    expect(cellText(sub, 1)).toBe('합계');
    expect(sub.getCell(5).value).toBe(10);
    expect(sub.getCell(7).value).toBe(3);
    expect(cellText(sub, 10)).toBe('달성률 30%');
  });

  it('전체(분야 2개↑)는 전체 합계 행을 추가', async () => {
    const cats: ExportCategory[] = [
      { id: 1, code: '50', name: '개인정보보호', questions: [sampleQuestions[0]!] },
      { id: 2, code: '60', name: '정보보안', questions: [sampleQuestions[1]!] },
    ];
    const parsed = await reparse(buildExportWorkbook(cats, { scopeLabel: '전체' }));
    const sheet = parsed.getWorksheet('문항')!;
    // 마지막 행이 전체합계
    const last = sheet.getRow(sheet.rowCount);
    expect(cellText(last, 1)).toBe('전체합계');
    expect(last.getCell(5).value).toBe(5); // 3 + 2
    expect(last.getCell(7).value).toBe(3); // 3 + 0
    expect(cellText(last, 10)).toBe('달성률 60%'); // 3/5
  });
});

describe('buildTemplateWorkbook (§6.1)', () => {
  it('문항·안내 두 시트, 양식 헤더 순서', async () => {
    const parsed = await reparse(buildTemplateWorkbook());
    const ws = parsed.getWorksheet('문항')!;
    const guide = parsed.getWorksheet('안내')!;
    expect(ws).toBeDefined();
    expect(guide).toBeDefined();
    const headers = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => cellText(ws.getRow(1), c));
    expect(headers).toEqual([
      '분야코드',
      '분야명',
      '문항번호',
      '문항',
      '배점',
      '해당없음가능',
      '유형(선택)',
      '답변(선택)',
      '근거참조(선택)',
    ]);
  });
});
