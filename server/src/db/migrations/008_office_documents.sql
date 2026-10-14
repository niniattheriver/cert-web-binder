-- 008_office_documents: 검사실 자료에 PDF 외 형식(Word, Excel, PowerPoint, 한글 hwpx, 텍스트) (설계서 §3.5)
-- ① document_version.file_kind: 판본 원본의 형식. 기존 판본은 전부 pdf.js 추출을 통과한 PDF 이므로 'pdf' 로 채운다.
--    형식은 판본 단위다: 같은 문서의 판본 사슬 안에서 PDF 다음 판본이 docx 일 수 있다.
ALTER TABLE document_version ADD COLUMN file_kind TEXT NOT NULL DEFAULT 'pdf'
  CHECK (file_kind IN ('pdf','docx','xlsx','pptx','hwpx','text'));
-- ② page_text.label: 논리 쪽의 이름. xlsx 시트 이름, pptx '슬라이드 N', 쪽 정보가 없는 문서는 '구간 N'.
--    NULL 이면 화면은 'p.N' 으로 적는다(PDF, Word 가 저장한 쪽 나눔을 따른 docx).
ALTER TABLE page_text ADD COLUMN label TEXT;
-- ③ document_render: PDF 외 판본의 렌더 모델(JSON 을 gzip 한 것). 업로드 때 page_text 와 같은 해석에서 한 번 만들어
--    판본과 함께 불변 저장한다. 화면은 원본 바이트 대신 이것만 받는다(설계서 §4 첨부 미리보기 원칙 ①과 같은 취지).
--    DB 안에 두므로 빠른 백업(DB 스냅샷)에도 함께 들어간다.
CREATE TABLE document_render (
  document_version_id INTEGER PRIMARY KEY REFERENCES document_version(id),
  model_version INTEGER NOT NULL,          -- RENDER_MODEL_VERSION (server/src/office/model.ts)
  extractor TEXT NOT NULL,                 -- 만든 추출기 라벨 (document_version.extractor 와 같다)
  json_gz BLOB NOT NULL,
  created_at TEXT NOT NULL
);
