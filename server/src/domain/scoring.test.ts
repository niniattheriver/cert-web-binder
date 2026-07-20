// 채점 무결성 검증 테스트 (설계서 §2 무결성, R3)
import { describe, expect, it } from 'vitest';
import { validateScoring } from './scoring.js';

describe('validateScoring', () => {
  // --- '아니오' = 0점 강제 ---
  it("no: 클라이언트가 점수를 보내도 0으로 강제", () => {
    const r = validateScoring({ answerChoice: 'no', score: 3, maxScore: 5, allowNa: false });
    expect(r).toEqual({ ok: true, score: 0 });
  });

  it('no: 점수 미전송(null)도 0으로 확정', () => {
    const r = validateScoring({ answerChoice: 'no', score: null, maxScore: 5, allowNa: false });
    expect(r).toEqual({ ok: true, score: 0 });
  });

  // --- '해당없음' ---
  it('na: allow_na=1 문항이면 허용, 점수는 NULL 강제', () => {
    const r = validateScoring({ answerChoice: 'na', score: 2, maxScore: 5, allowNa: true });
    expect(r).toEqual({ ok: true, score: null });
  });

  it('na: allow_na=0 문항이면 거부(한국어 사유)', () => {
    const r = validateScoring({ answerChoice: 'na', score: null, maxScore: 5, allowNa: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('해당없음');
  });

  // --- '예' 상한·간격·음수 ---
  it('yes: 0 ≤ score ≤ max_score 범위 내 0.5 간격 값 허용', () => {
    const r = validateScoring({ answerChoice: 'yes', score: 2.5, maxScore: 3, allowNa: false });
    expect(r).toEqual({ ok: true, score: 2.5 });
  });

  it('yes: 상한 경계값(= max_score) 허용', () => {
    const r = validateScoring({ answerChoice: 'yes', score: 3, maxScore: 3, allowNa: false });
    expect(r).toEqual({ ok: true, score: 3 });
  });

  it('yes: 0점 허용', () => {
    const r = validateScoring({ answerChoice: 'yes', score: 0, maxScore: 3, allowNa: false });
    expect(r).toEqual({ ok: true, score: 0 });
  });

  it('yes: 배점 초과 거부', () => {
    const r = validateScoring({ answerChoice: 'yes', score: 3.5, maxScore: 3, allowNa: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('배점');
  });

  it('yes: 음수 거부', () => {
    const r = validateScoring({ answerChoice: 'yes', score: -0.5, maxScore: 3, allowNa: false });
    expect(r.ok).toBe(false);
  });

  it('yes: 0.5 간격 위반(2.3) 거부', () => {
    const r = validateScoring({ answerChoice: 'yes', score: 2.3, maxScore: 3, allowNa: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('0.5');
  });

  it('yes: 점수 미입력(null)은 미채점 상태로 허용', () => {
    const r = validateScoring({ answerChoice: 'yes', score: null, maxScore: 3, allowNa: false });
    expect(r).toEqual({ ok: true, score: null });
  });

  it('yes: maxScore가 NULL이면 점수 입력 거부', () => {
    const r = validateScoring({ answerChoice: 'yes', score: 1, maxScore: null, allowNa: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('배점');
  });

  it('yes: maxScore NULL + 점수 미입력은 허용(미채점)', () => {
    const r = validateScoring({ answerChoice: 'yes', score: null, maxScore: null, allowNa: false });
    expect(r).toEqual({ ok: true, score: null });
  });

  it('yes: NaN·Infinity 거부', () => {
    expect(
      validateScoring({ answerChoice: 'yes', score: Number.NaN, maxScore: 3, allowNa: false }).ok,
    ).toBe(false);
    expect(
      validateScoring({
        answerChoice: 'yes',
        score: Number.POSITIVE_INFINITY,
        maxScore: 3,
        allowNa: false,
      }).ok,
    ).toBe(false);
  });

  // --- 선택 없음 ---
  it('선택 없음(null): 점수를 NULL로 강제', () => {
    const r = validateScoring({ answerChoice: null, score: 2, maxScore: 3, allowNa: false });
    expect(r).toEqual({ ok: true, score: null });
  });
});
