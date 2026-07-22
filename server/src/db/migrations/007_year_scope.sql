-- 007_year_scope: 연도별 관리
-- ① cycle.year — 이름 문자열('2026년 심사') 파싱 대신 정식 연도 필드.
--    연도별 홈 리스트·가져오기 대상 연도 지정·전년도 이월 소스 판별에 사용.
-- ④ document_version.year — 지침서 판본의 연도 태그(업로드 시 지정, 기본=업로드한 해).
--    같은 문서의 판본 사슬은 연도가 달라도 유지된다(완전 분리 아님 — 개정 자동 이관 보존).
ALTER TABLE cycle ADD COLUMN year INTEGER;
UPDATE cycle SET year = CAST(substr(name, 1, 4) AS INTEGER)
 WHERE year IS NULL AND substr(name, 1, 4) GLOB '[0-9][0-9][0-9][0-9]';
ALTER TABLE document_version ADD COLUMN year INTEGER;
UPDATE document_version SET year = CAST(substr(uploaded_at, 1, 4) AS INTEGER)
 WHERE year IS NULL;
