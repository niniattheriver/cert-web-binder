// 문항 파서 결과 모델 — 서식(패턴)과 무관하게 유지된다. 서식 교체는 patterns.ts에서만.
// (설계서 §6.2-1: "실물 서식 도착 시 patterns.ts만 교체" 원칙 — 이 파일과 index.ts는 안정)

export interface ParsedQuestion {
  questionNo: string; // 정규화 완료: NN.XXX.NNN (중간 그룹 영숫자 대문자 허용, 예 90.A01.080)
  body: string; // 본문(질문문 + "설명" 블록 포함, 줄은 \n으로 결합). 배점 창은 제외.
  maxScore: number | null; // "배점" 창의 배점 정수/소수. 핵심 필수문항(예/(필수))·미검출 시 null(warnings 기록)
  allowNa: boolean; // 배점 창에 "해당없음"(줄 걸침 포함) 존재 여부
  questionType?: 'core' | 'required' | 'basic'; // 유형기호 핵심C/필요R/기본B → core/required/basic
  gradeSymbol?: string; // 유형기호 원문 문자 'C' | 'R' | 'B'
  // ── Phase 3b 확장 (body 계약은 불변 — 아래는 전부 추가 필드. 구 summary_json 은 undefined) ──
  topic?: string | null; // 질문문만(설명 블록 제외) — question.topic 컬럼용
  chapterMajor?: string | null; // 대분류 목차 제목 (예: "3 질관리: 일반"). 목차 파싱 실패 시 null
  chapterMinor?: string | null; // 중분류 목차 제목 (예: "1. 검사지침서")
  subItems?: { label: string; maxScore: number }[] | null; // 세부 평가항목 표 (계약 검증은 인입 계층)
  autoCandidate?: { rows: string[] } | null; // 자동배점 임계표 후보 (감지·원문 추출까지만 — A-3)
}

export interface RevisionRow {
  kind: 'new' | 'modified' | 'deleted'; // 개정표 섹션 "• 신규 / • 수정 / • 삭제"
  questionNo: string; // 정규화 완료
  note: string; // 수정유형/사유 원문(예: "문항 수정, 설명 수정, 배점 변경"). needs_recheck 판정은 인입 계층 몫.
}

export interface ParseResult {
  // 파서는 분야코드를 더는 추론하지 않는다(문항번호 첫 그룹 ≠ 분야: 수혈=40·43·46, 미생물=30~36이 한 파일).
  // 항상 null이며, 인입 계층이 파일명 기반으로 주입한다(설계서 계약). 타입은 하위호환을 위해 nullable 유지.
  categoryCode: string | null;
  categoryName: string | null; // 표지 "신임인증 심사점검표" 다음 줄의 분야명
  revisionSummary: RevisionRow[]; // 3섹션(신규/수정/삭제) 전량. 다분야 파일은 소분야별 반복분을 모두 누적. 빈 섹션("-")은 행 없음.
  questions: ParsedQuestion[];
  warnings: string[]; // "pN 행M: ..." 형식 — 파싱은 중단하지 않고 축적
}
