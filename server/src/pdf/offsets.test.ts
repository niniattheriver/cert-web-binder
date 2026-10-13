// 전역↔페이지 오프셋 왕복 검증 — start_offset 누적의 정확성은 앵커 체계의 근간 (설계서 §3.1-4)
import { describe, expect, it } from 'vitest';
import {
  buildPageOffsets,
  fullTextLength,
  fullTextOf,
  globalToLocal,
  localToGlobal,
  rangeToPageRanges,
} from './offsets.js';

const pages = [
  { pageNo: 1, text: '가나다라' }, // start 0, len 4 → [0,4], 구분자 4
  { pageNo: 2, text: 'ABC' }, // start 5, len 3 → [5,8], 구분자 8
  { pageNo: 3, text: '' }, // start 9, len 0 (빈 페이지)
  { pageNo: 4, text: '마바사아자' }, // start 10, len 5 → [10,15]
];
const entries = buildPageOffsets(pages);

describe('buildPageOffsets', () => {
  it('start_offset 누적: 이전 페이지 시작 + 길이 + 구분자 1', () => {
    expect(entries.map((e) => e.startOffset)).toEqual([0, 5, 9, 10]);
    expect(fullTextLength(entries)).toBe(15);
  });

  it('전문 = 페이지 텍스트를 \\n 으로 연결', () => {
    const full = fullTextOf(entries);
    expect(full).toBe('가나다라\nABC\n\n마바사아자');
    // 각 페이지 텍스트가 자기 start_offset 위치에서 그대로 나타난다
    for (const e of entries) {
      expect(full.slice(e.startOffset, e.startOffset + e.text.length)).toBe(e.text);
    }
  });

  it('페이지 순서가 섞여 들어와도 pageNo 오름차순으로 누적한다', () => {
    const shuffled = buildPageOffsets([pages[1]!, pages[3]!, pages[0]!, pages[2]!]);
    expect(shuffled.map((e) => [e.pageNo, e.startOffset])).toEqual([
      [1, 0],
      [2, 5],
      [3, 9],
      [4, 10],
    ]);
  });
});

describe('globalToLocal ↔ localToGlobal 왕복', () => {
  it('케이스 1: 첫 페이지 시작(0)', () => {
    expect(globalToLocal(entries, 0)).toEqual({ pageNo: 1, offset: 0 });
    expect(localToGlobal(entries, 1, 0)).toBe(0);
  });

  it('케이스 2: 페이지 중간', () => {
    expect(globalToLocal(entries, 2)).toEqual({ pageNo: 1, offset: 2 });
    expect(localToGlobal(entries, 1, 2)).toBe(2);
  });

  it('케이스 3: 페이지 끝(exclusive) = 구분자 위치 → 그 페이지 text.length 로 귀속', () => {
    expect(globalToLocal(entries, 4)).toEqual({ pageNo: 1, offset: 4 });
    expect(localToGlobal(entries, 1, 4)).toBe(4);
  });

  it('케이스 4: 둘째 페이지 시작·중간', () => {
    expect(globalToLocal(entries, 5)).toEqual({ pageNo: 2, offset: 0 });
    expect(globalToLocal(entries, 7)).toEqual({ pageNo: 2, offset: 2 });
    expect(localToGlobal(entries, 2, 2)).toBe(7);
  });

  it('케이스 5: 빈 페이지(길이 0)', () => {
    expect(globalToLocal(entries, 9)).toEqual({ pageNo: 3, offset: 0 });
    expect(localToGlobal(entries, 3, 0)).toBe(9);
  });

  it('케이스 6: 마지막 페이지 마지막 문자와 전문 끝(exclusive)', () => {
    expect(globalToLocal(entries, 14)).toEqual({ pageNo: 4, offset: 4 });
    expect(globalToLocal(entries, 15)).toEqual({ pageNo: 4, offset: 5 });
    expect(localToGlobal(entries, 4, 5)).toBe(15);
  });

  it('케이스 7: 전 위치 왕복 — local→global→local 항등', () => {
    for (const e of entries) {
      for (let off = 0; off <= e.text.length; off++) {
        const g = localToGlobal(entries, e.pageNo, off);
        const back = globalToLocal(entries, g);
        // 빈 페이지 끝(0)과 다음 페이지 시작이 같은 전역 오프셋을 공유하지 않으므로 항등 성립
        expect(back).toEqual({ pageNo: e.pageNo, offset: off });
      }
    }
  });

  it('범위 밖은 RangeError', () => {
    expect(() => globalToLocal(entries, -1)).toThrow(RangeError);
    expect(() => globalToLocal(entries, 16)).toThrow(RangeError);
    expect(() => localToGlobal(entries, 9, 0)).toThrow(RangeError);
    expect(() => localToGlobal(entries, 1, 5)).toThrow(RangeError);
  });
});

describe('rangeToPageRanges', () => {
  it('한 페이지 내부 범위', () => {
    expect(rangeToPageRanges(entries, 1, 3)).toEqual([{ pageNo: 1, start: 1, end: 3 }]);
  });

  it('두 페이지에 걸친 범위 (구분자 넘어감)', () => {
    expect(rangeToPageRanges(entries, 2, 7)).toEqual([
      { pageNo: 1, start: 2, end: 4 },
      { pageNo: 2, start: 0, end: 2 },
    ]);
  });

  it('빈 페이지는 건너뛰고 다음 페이지로 이어진다', () => {
    expect(rangeToPageRanges(entries, 6, 12)).toEqual([
      { pageNo: 2, start: 1, end: 3 },
      { pageNo: 4, start: 0, end: 2 },
    ]);
  });

  it('구분자만 걸치는 범위는 빈 목록', () => {
    expect(rangeToPageRanges(entries, 4, 5)).toEqual([]);
  });
});
