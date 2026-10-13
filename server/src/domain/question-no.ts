/**
 * 옴니박스 문항번호 해석 (설계서 §4 옴니박스 — 번호 패스트패스)
 * 정식 형태 'NN.NNN.NNN'(예: 50.210.420)에 대해 다음 입력을 모두 해석한다:
 *   '50.210.420' · '50210420'  → 완전일치(full)
 *   '210.420'    · '210420'    → 뒤 6자리(그룹2+3) suffix 일치
 * 전각 숫자·전각 마침표·공백·구분자(., -) 혼용을 허용한다.
 * 파서의 normalizeQuestionNo(전각→반각·공백 제거)를 재사용하고, 옴니박스 전용
 * 부분입력 규칙(자릿수 판정)만 여기에 둔다.
 */
import { normalizeQuestionNo } from '../pdf/question-parser/index.js';

export interface QuestionNoQuery {
  /** full = 8자리 완전일치, suffix = 6자리(그룹2+3) 접미 일치 */
  kind: 'full' | 'suffix';
  /** 정규 표기: full → '50.210.420', suffix → '210.420' */
  canonical: string;
}

/**
 * 검색어가 문항번호(완전/부분)로 해석되면 그 결과를, 아니면 null(FTS 경로).
 */
export function parseQuestionNoQuery(raw: string): QuestionNoQuery | null {
  if (!raw) return null;
  // 전각→반각 + 공백 제거 (파서 정규화 재사용)
  const compact = normalizeQuestionNo(raw);
  // 숫자와 구분자(., -)만으로 구성된 입력만 번호 후보
  if (!/^[0-9.\-]+$/.test(compact)) return null;
  const digits = compact.replace(/[.\-]/g, '');
  if (!/^[0-9]+$/.test(digits)) return null;

  if (digits.length === 8) {
    return {
      kind: 'full',
      canonical: `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`,
    };
  }
  if (digits.length === 6) {
    return {
      kind: 'suffix',
      canonical: `${digits.slice(0, 3)}.${digits.slice(3)}`,
    };
  }
  return null; // 그 외 자릿수는 번호로 단정하지 않음 → FTS로
}
