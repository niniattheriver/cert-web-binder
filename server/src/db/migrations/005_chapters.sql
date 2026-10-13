-- 005_chapters: 문항 챕터(목차 대·중분류 제목) 소속 (설계서 §2 / v1.5 개편 Phase 3b)
--
-- ADD COLUMN만 사용 → 기존 1,662행 무손상 (002~004와 동일 원칙).
--   · chapter_major: 목차 대분류 제목 원문 (예: "3 질관리: 일반"). 파서 소유분 —
--       재인입 갱신 화이트리스트 대상. 목차 파싱 실패 시 NULL(UI는 문항번호 접두 그룹핑 폴백).
--   · chapter_minor: 목차 중분류 제목 원문 (예: "1. 검사지침서"). 대분류 직속 문항은 NULL.
-- topic(003)은 문항 '주제(질문문)'로 별개 축 — 챕터와 혼용하지 않는다.

ALTER TABLE question ADD COLUMN chapter_major TEXT;
ALTER TABLE question ADD COLUMN chapter_minor TEXT;
