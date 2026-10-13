// 재앵커링 v1 분류(순수 로직) — 가드레일 5: 정확 1건만 auto, 나머지 전부 needs_review
import { describe, expect, it } from 'vitest';
import { quoteCells, type CellIndex } from './cells.js';
import { findAllOccurrences, planOne, planReanchor, type OldAnchorInput } from './reanchor.js';

function anchor(overrides: Partial<OldAnchorInput> = {}): OldAnchorInput {
  return {
    anchorId: 1,
    passageId: 10,
    quoteExact: '개인정보를 파기할 때에는 파기 대장을 작성한다',
    geometryPrimary: false,
    ...overrides,
  };
}

describe('findAllOccurrences', () => {
  it('전건 탐색 — 겹침 포함', () => {
    expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 1, 2]);
    expect(findAllOccurrences('파기 후 파기 대장', '파기')).toEqual([0, 5]);
    expect(findAllOccurrences('없음', '파기')).toEqual([]);
    expect(findAllOccurrences('abc', '')).toEqual([]);
  });
});

describe('planOne — 4분류', () => {
  const quote = '파기 대장을 작성하고 관리책임자의 확인을 받는다';

  it('케이스 1: 신판에 정확히 1건 → auto (오프셋 재계산)', () => {
    const newText = `제11조 보관\n제12조 파기\n${quote}\n제13조 위탁`;
    const d = planOne(anchor({ quoteExact: quote }), newText);
    expect(d.kind).toBe('auto');
    if (d.kind === 'auto') {
      expect(newText.slice(d.startOffset, d.endOffset)).toBe(quote);
    }
  });

  it('케이스 2: 문구가 바뀌어 0건 → needs_review(not_found)', () => {
    const newText = '제12조 파기\n파기 대장을 작성하고 부서장의 확인을 받는다';
    expect(planOne(anchor({ quoteExact: quote }), newText)).toEqual({
      kind: 'needs_review',
      reason: 'not_found',
      occurrences: 0,
    });
  });

  it('케이스 3: 중복 상용구 2건 → needs_review(ambiguous) — 조용한 오앵커 금지', () => {
    const newText = `${quote}\n…\n${quote}`;
    expect(planOne(anchor({ quoteExact: quote }), newText)).toEqual({
      kind: 'needs_review',
      reason: 'ambiguous',
      occurrences: 2,
    });
  });

  it('케이스 4: 박스 앵커(geometry_primary)는 1건이어도 무조건 needs_review', () => {
    const newText = `앞문장 ${quote} 뒷문장`;
    expect(planOne(anchor({ quoteExact: quote, geometryPrimary: true }), newText)).toEqual({
      kind: 'needs_review',
      reason: 'geometry_primary',
      occurrences: 0,
    });
  });

  it('케이스 5: 빈 인용문 → needs_review(not_found) (방어)', () => {
    expect(planOne(anchor({ quoteExact: '' }), '아무 텍스트').kind).toBe('needs_review');
  });
});

describe('planReanchor — 일괄 계획', () => {
  it('앵커별 독립 분류 + 입력 순서 유지', () => {
    const newText = '유일한 문장이다\n중복 중복';
    const plan = planReanchor(
      [
        anchor({ anchorId: 1, quoteExact: '유일한 문장이다' }),
        anchor({ anchorId: 2, quoteExact: '중복' }),
        anchor({ anchorId: 3, quoteExact: '삭제된 조항' }),
      ],
      newText,
    );
    expect(plan.map((p) => [p.anchor.anchorId, p.decision.kind])).toEqual([
      [1, 'auto'],
      [2, 'needs_review'],
      [3, 'needs_review'],
    ]);
  });
});

describe('표 칸 경계: 탭은 지우지 않고, 칸 조건은 렌더 모델의 칸 위치로 본다', () => {
  /** 칸 글자들을 앞에서부터 차례로 찾아 칸 색인을 만든다(시험용: 렌더 모델 대신) */
  function idx(text: string, cellTexts: string[]): CellIndex {
    const starts = new Set<number>();
    const ends = new Set<number>();
    const ranges: Array<[number, number]> = [];
    let from = 0;
    for (const c of cellTexts) {
      const s = text.indexOf(c, from);
      if (s < 0) throw new Error(`칸 글자를 찾지 못함: ${c}`);
      starts.add(s);
      ends.add(s + c.length);
      ranges.push([s, s + c.length]);
      from = s + c.length;
    }
    const bounds = [...new Set([...starts, ...ends])].sort((a, b) => a - b);
    return { starts, ends, ranges, bounds };
  }
  /** 시트처럼 탭, 줄바꿈 사이가 모두 칸인 글자 */
  const sheetIdx = (text: string): CellIndex => idx(text, text.split(/[\t\n]/).filter((x) => x.length > 0));
  const wholeCell = { start: true, end: true, single: true, inner: [] };

  it('셀 값이 바뀐 행(QC\\t1\\t23 → QC\\t12\\t3)은 자동 확정하지 않는다: 칸 색인이 없어도 탭이 남아 맞지 않는다', () => {
    const v2 = '항목\t1회\t2회\nQC\t12\t3';
    expect(planOne(anchor({ quoteExact: 'QC\t1\t23' }), v2, { sheet: true, cells: sheetIdx(v2) }).kind).toBe('needs_review');
    expect(planOne(anchor({ quoteExact: 'QC\t1\t23' }), v2).kind).toBe('needs_review');
  });

  it('칸이 그대로인 행은 자동이고 위치는 원문 그대로다', () => {
    const text = '항목\t1회\t2회\nQC\t1\t23';
    // QC 끝(2), 1 시작(2), 1 끝(3), 23 시작(3): 인용 앞에서부터 센 내용 글자 수
    const old = { start: true, end: true, single: false, inner: [2, 3] };
    expect(planOne(anchor({ quoteExact: 'QC\t1\t23', cells: old }), text, { sheet: true, cells: sheetIdx(text) })).toEqual({
      kind: 'auto',
      startOffset: text.indexOf('QC'),
      endOffset: text.length,
    });
  });

  it('시트: 행 경계를 걸쳐 이어 붙은 값(…\\t1 / 23\\t…)에 맞추지 않는다', () => {
    const text = 'A\t1\n23\tB';
    expect(planOne(anchor({ quoteExact: '123', cells: wholeCell }), text, { sheet: true, cells: sheetIdx(text) }).kind).toBe(
      'needs_review',
    );
  });

  it('칸 하나였던 값이 다른 값의 일부가 되면(128450 → 1284500) 자동 확정하지 않는다: 시트, 문서 표의 행 끝 칸 모두', () => {
    const sheet = '건수\t1284500';
    expect(planOne(anchor({ quoteExact: '128450', cells: wholeCell }), sheet, { sheet: true, cells: sheetIdx(sheet) })).toMatchObject(
      { kind: 'needs_review', reason: 'not_found' },
    );
    // Word 표: 행 사이 줄바꿈은 그림자에서 지워지지만 칸 끝은 렌더 모델이 안다
    const docx = '건수\t1284500\n비고\t정상';
    expect(
      planOne(anchor({ quoteExact: '128450', cells: wholeCell }), docx, { cells: idx(docx, ['건수', '1284500', '비고', '정상']) }),
    ).toMatchObject({ kind: 'needs_review', reason: 'not_found' });
  });

  it('칸 하나인 같은 값과 다른 값 안의 같은 글자가 함께 있으면 칸 쪽으로 자동', () => {
    const text = '건수\t1284500\n건수\t128450';
    expect(planOne(anchor({ quoteExact: '128450', cells: wholeCell }), text, { sheet: true, cells: sheetIdx(text) })).toEqual({
      kind: 'auto',
      startOffset: text.lastIndexOf('128450'),
      endOffset: text.length,
    });
  });

  it('칸 일부만 고른 인용(칸 끝에 닿지 않음)은 칸 하나 안에서만 찾는다', () => {
    const text = '비고\tSOP-12 개정판 적용\n다음\tSOP-12';
    const cells = idx(text, ['비고', 'SOP-12 개정판 적용', '다음', 'SOP-12']);
    const partial = { start: true, end: false, single: true, inner: [] };
    // 'SOP-12' 는 두 곳: 칸 일부(앞 끝만 칸 시작)인 쪽과 칸 전체인 쪽 둘 다 조건(앞 끝이 칸 시작, 칸 하나 안)을 만족한다
    expect(planOne(anchor({ quoteExact: 'SOP-12', cells: partial }), text, { sheet: true, cells })).toMatchObject({
      kind: 'needs_review',
      reason: 'ambiguous',
    });
    const only = '비고\tSOP-12 개정판 적용';
    expect(
      planOne(anchor({ quoteExact: 'SOP-12', cells: partial }), only, { sheet: true, cells: idx(only, ['비고', 'SOP-12 개정판 적용']) }),
    ).toEqual({ kind: 'auto', startOffset: only.indexOf('SOP-12'), endOffset: only.indexOf('SOP-12') + 6 });
  });

  it('표 밖 문장이던 인용은 예전처럼 글자로 찾는다', () => {
    const text = '제1조 목적\n검체는 2시간 안에 옮긴다.\n표\t값';
    const prose = { start: false, end: false, single: false, inner: [] };
    expect(planOne(anchor({ quoteExact: '검체는 2시간 안에', cells: prose }), text, { cells: idx(text, ['표', '값']) }).kind).toBe('auto');
  });

  it("칸 구조가 없던 판본(PDF)의 인용은 새 자리가 칸에 걸치면 칸 전체일 때만", () => {
    const docx = '기준\t15%\n이하로 관리한다';
    const cells = idx(docx, ['기준', '15%']);
    expect(planOne(anchor({ quoteExact: '5%', cells: 'none' }), docx, { cells }).kind).toBe('needs_review');
    expect(planOne(anchor({ quoteExact: '15%', cells: 'none' }), docx, { cells }).kind).toBe('auto');
    expect(planOne(anchor({ quoteExact: '이하로 관리', cells: 'none' }), docx, { cells }).kind).toBe('auto');
  });

  it('여러 칸 인용: 안쪽 칸 경계의 수와 자리가 같아야 자동이다(행이 갈라진 128450 → 128 / 450 은 확인 필요)', () => {
    // Word 표 행 [건수 | 128450] 전체를 고른 인용. 행 사이 줄바꿈은 그림자에서 지워진다
    const v1 = '건수\t128450\n비고\t정상';
    const v1Cells = idx(v1, ['건수', '128450', '비고', '정상']);
    const old = quoteCells(v1Cells, v1, 0, '건수\t128450'.length);
    expect(old).toEqual({ start: true, end: true, single: false, inner: [2] });
    // 행이 [건수 | 128] [450 | OK] 로 갈라진 개정: 글자는 이어 붙지만 칸 경계가 하나 더 생겼다
    const split = '건수\t128\n450\tOK';
    expect(planOne(anchor({ quoteExact: '건수\t128450', cells: old }), split, { cells: idx(split, ['건수', '128', '450', 'OK']) })).toMatchObject({
      kind: 'needs_review',
      reason: 'not_found',
    });
    // 칸이 그대로인 개정(다른 행만 바뀜)은 자동
    const same = '건수\t128450\n비고\t재검';
    expect(planOne(anchor({ quoteExact: '건수\t128450', cells: old }), same, { cells: idx(same, ['건수', '128450', '비고', '재검']) })).toEqual({
      kind: 'auto',
      startOffset: 0,
      endOffset: '건수\t128450'.length,
    });
    // 두 칸이 한 칸으로 합쳐진 개정(탭은 칸 안 글자로 남음)도 확인 필요
    const merged = '건수\t128450\n비고\t정상';
    const mergedCells = idx(merged, ['건수\t128450', '비고', '정상']);
    expect(planOne(anchor({ quoteExact: '건수\t128450', cells: old }), merged, { cells: mergedCells }).kind).toBe('needs_review');
  });

  it('표 밖 문장이던 인용이 새 판본에서 여러 칸에 걸치면 자동으로 정하지 않는다', () => {
    const prose = { start: false, end: false, single: false, inner: [] };
    const text = '항목\t기준\n보관\t2시간';
    const cells = idx(text, ['항목', '기준', '보관', '2시간']);
    expect(planOne(anchor({ quoteExact: '보관\t2시간', cells: prose }), text, { cells }).kind).toBe('needs_review');
    // 칸 하나 안으로 옮겨진 문장은 그대로 찾는다
    expect(planOne(anchor({ quoteExact: '2시간', cells: prose }), text, { cells }).kind).toBe('auto');
  });

  it('칸 관계를 알 수 없는 인용은 자동으로 정하지 않는다', () => {
    const text = '건수\t128450';
    expect(planOne(anchor({ quoteExact: '128450', cells: 'unknown' }), text, { sheet: true, cells: sheetIdx(text) }).kind).toBe(
      'needs_review',
    );
  });

  it('칸 조건이 있는 인용인데 새 판본에 칸 색인이 없으면(PDF, 텍스트로 형식 변경) 자동으로 정하지 않는다', () => {
    expect(planOne(anchor({ quoteExact: '128450', cells: wholeCell }), '건수 128450').kind).toBe('needs_review');
  });

  it('칸 조건으로 거를 때 찾은 자리가 상한(50건)에 닿으면 자동으로 정하지 않는다', () => {
    const text = `${'x1\t'.repeat(60)}1`;
    expect(planOne(anchor({ quoteExact: '1', cells: wholeCell }), text, { sheet: true, cells: sheetIdx(text) })).toMatchObject({
      kind: 'needs_review',
      reason: 'ambiguous',
    });
  });
});
