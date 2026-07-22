// 재앵커링 v1 분류(순수 로직) — 가드레일 5: 정확 1건만 auto, 나머지 전부 needs_review
import { describe, expect, it } from 'vitest';
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
