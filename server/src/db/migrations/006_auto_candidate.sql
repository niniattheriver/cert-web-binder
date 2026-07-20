-- 006: 자동배점 후보 표시
-- 파서가 본문에서 지표→점수 구간표(임계표)를 감지한 문항을 표시한다.
-- 파서 소유 필드 — 재인입 시 파서 결과로 갱신되며, 채점 방식(scoring_mode)과는 별개다
-- (배지는 "자동배점 문항"임을 알리는 표시일 뿐, auto 모드 활성화는 사람이 결정한다).
ALTER TABLE question ADD COLUMN auto_candidate INTEGER NOT NULL DEFAULT 0;
