-- 002_add_question_type: 문항 유형(핵심 C / 필요 R / 기본 B) 저장 (실물 서식 계약 §6.2-1)
-- ADD COLUMN만 사용 — 기존 행/스키마 무손상. 두 열 모두 nullable 이므로 기존 데이터에 안전하다
-- (기존 행은 NULL; CHECK는 NULL을 통과). migrate 러너가 user_version=2로 적용한다.
--   question_type : 정규화 유형('core'|'required'|'basic')  — 목록/상세 배지·필터의 안정 키
--   grade_symbol  : 원문 유형기호('C'|'R'|'B')             — 표시/원문 보존용
ALTER TABLE question ADD COLUMN question_type TEXT CHECK (question_type IN ('core','required','basic'));
ALTER TABLE question ADD COLUMN grade_symbol TEXT;
