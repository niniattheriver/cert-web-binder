/**
 * 채점 무결성 검증 (설계서 §2 무결성 불변식, R3)
 * - 'no'  → score 0 강제 (클라이언트가 무엇을 보냈든 0으로 정규화)
 * - 'na'  → allow_na=1 문항만 허용, score는 NULL 강제
 * - 'yes' → 0 ≤ score ≤ max_score, 0.5 간격(score*2가 정수). score 미입력(null)은 "미채점"으로 허용
 * - 선택 없음(null) → score NULL 강제
 * 위반 시 한국어 사유 메시지를 돌려준다(400 응답용).
 */

export interface ScoringInput {
  answerChoice: 'yes' | 'no' | 'na' | null;
  score: number | null;
  maxScore: number | null;
  allowNa: boolean;
}

export type ScoringResult =
  | { ok: true; score: number | null } // score = 서버가 확정한 정규화 값
  | { ok: false; message: string };

export function validateScoring(input: ScoringInput): ScoringResult {
  const { answerChoice, score, maxScore, allowNa } = input;

  switch (answerChoice) {
    case null:
      // 선택이 없으면 점수도 없다
      return { ok: true, score: null };

    case 'no':
      // 아니오 = 0점 자동 (강제 정규화)
      return { ok: true, score: 0 };

    case 'na':
      if (!allowNa) {
        return { ok: false, message: "'해당없음'을 선택할 수 없는 문항입니다." };
      }
      // 해당없음 = 점수 없음(집계 분모에서도 제외)
      return { ok: true, score: null };

    case 'yes': {
      if (score === null || score === undefined) {
        return { ok: true, score: null }; // 미채점 상태 허용
      }
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        return { ok: false, message: '점수는 숫자여야 합니다.' };
      }
      if (maxScore === null || maxScore === undefined) {
        return { ok: false, message: '배점이 설정되지 않은 문항에는 점수를 입력할 수 없습니다.' };
      }
      if (score < 0) {
        return { ok: false, message: '점수는 0 이상이어야 합니다.' };
      }
      if (score > maxScore) {
        return { ok: false, message: `점수는 배점(${maxScore})을 초과할 수 없습니다.` };
      }
      if (!Number.isInteger(score * 2)) {
        return { ok: false, message: '점수는 0.5점 간격으로만 입력할 수 있습니다.' };
      }
      return { ok: true, score };
    }

    default:
      return { ok: false, message: "선택값은 '예/아니오/해당없음' 중 하나여야 합니다." };
  }
}
