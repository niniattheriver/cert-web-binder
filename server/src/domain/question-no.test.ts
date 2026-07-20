// 옴니박스 문항번호 해석 테스트 (설계서 §4 — 4형식·부분입력·전각·비번호)
import { describe, expect, it } from 'vitest';
import { parseQuestionNoQuery } from './question-no.js';

describe('parseQuestionNoQuery', () => {
  // --- 4형식 ---
  it("점 구분 완전형 '50.210.420' → full", () => {
    expect(parseQuestionNoQuery('50.210.420')).toEqual({ kind: 'full', canonical: '50.210.420' });
  });

  it("구분자 없는 완전형 '50210420' → full", () => {
    expect(parseQuestionNoQuery('50210420')).toEqual({ kind: 'full', canonical: '50.210.420' });
  });

  it("점 구분 부분형 '210.420' → suffix", () => {
    expect(parseQuestionNoQuery('210.420')).toEqual({ kind: 'suffix', canonical: '210.420' });
  });

  it("구분자 없는 부분형 '210420' → suffix", () => {
    expect(parseQuestionNoQuery('210420')).toEqual({ kind: 'suffix', canonical: '210.420' });
  });

  // --- 전각·공백·구분자 혼용 ---
  it('전각 숫자·전각 마침표 입력 정규화', () => {
    expect(parseQuestionNoQuery('５０．２１０．４２０')).toEqual({
      kind: 'full',
      canonical: '50.210.420',
    });
  });

  it('공백 섞인 입력 허용', () => {
    expect(parseQuestionNoQuery(' 50 . 210 . 420 ')).toEqual({
      kind: 'full',
      canonical: '50.210.420',
    });
  });

  it("하이픈 구분자 '50-210-420' 허용", () => {
    expect(parseQuestionNoQuery('50-210-420')).toEqual({ kind: 'full', canonical: '50.210.420' });
  });

  // --- 비번호 문자열·모호한 자릿수 → null (FTS 경로) ---
  it('한글 검색어는 번호가 아님', () => {
    expect(parseQuestionNoQuery('개인정보 파기')).toBeNull();
  });

  it('숫자+문자 혼합은 번호가 아님', () => {
    expect(parseQuestionNoQuery('50조 210')).toBeNull();
  });

  it('자릿수가 6도 8도 아니면 null (5자리·7자리)', () => {
    expect(parseQuestionNoQuery('50210')).toBeNull();
    expect(parseQuestionNoQuery('5021042')).toBeNull();
  });

  it('빈 문자열·구분자만 있는 입력은 null', () => {
    expect(parseQuestionNoQuery('')).toBeNull();
    expect(parseQuestionNoQuery('...')).toBeNull();
  });
});
