-- migrate: foreign_keys=off
-- 010_image_documents: 근거자료에 그림 파일(png, jpg, gif, webp, bmp)을 받는다 (설계서 §3.5)
-- ① document_version.file_kind 의 CHECK 에 'image' 를 더한다. SQLite 에는 CHECK 를 바꾸는 ALTER 가 없어
--    새 표를 만들어 옮긴 뒤 옛 표를 지우고 새 표의 이름을 바꾸는 공식 절차를 따른다
--    (https://www.sqlite.org/lang_altertable.html §7). 첫 줄 표지를 본 러너(db/migrate.ts)가 외래키 강제를 끈 채
--    한 트랜잭션으로 돌리고, 커밋 전에 PRAGMA foreign_key_check 위반이 늘지 않았는지 확인한다.
-- ② 열 순서, 기본값, 다른 CHECK, UNIQUE, 외래키는 001~009 가 만든 정의 그대로다. 행 id 를 그대로 옮기므로
--    page_text, passage_anchor, document_render 가 가리키는 판본은 바뀌지 않는다. 색인은 새 표에 다시 만든다.
-- ③ 그림 판본은 글자를 읽지 않는다(빈 1쪽). 실제 형식은 extractor('image-png-v1' 등)에 남는다(office/image.ts).
CREATE TABLE document_version_new (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  version_label TEXT NOT NULL,               -- '2026-개정1'
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  page_count INTEGER,
  extractor TEXT,                            -- 'pdfjs-4.x', 그림은 'image-png-v1' 등
  canon_norm TEXT,                           -- 'nfc-v1'
  status TEXT NOT NULL DEFAULT 'processing'
         CHECK (status IN ('processing','active','superseded','failed')),
  is_current INTEGER NOT NULL DEFAULT 0,
  text_warning TEXT,                          -- 저밀도 텍스트(스캔 페이지 의심) 경고
  uploaded_by INTEGER REFERENCES user(id),
  uploaded_at TEXT NOT NULL,
  source_sha256 TEXT,                         -- 004: PDF 판본의 편집용 원본 파일(내용주소)
  source_name TEXT,
  source_mime TEXT,
  source_size INTEGER,
  year INTEGER,                               -- 007: 판본 연도 태그
  file_kind TEXT NOT NULL DEFAULT 'pdf'       -- 008: 판본 원본 형식, 010: 그림(image) 추가
    CHECK (file_kind IN ('pdf','docx','xlsx','pptx','hwpx','text','image')),
  UNIQUE (document_id, version_label)
);
INSERT INTO document_version_new
  (id, document_id, version_label, file_sha256, file_name, file_size, page_count, extractor, canon_norm,
   status, is_current, text_warning, uploaded_by, uploaded_at, source_sha256, source_name, source_mime,
   source_size, year, file_kind)
SELECT id, document_id, version_label, file_sha256, file_name, file_size, page_count, extractor, canon_norm,
       status, is_current, text_warning, uploaded_by, uploaded_at, source_sha256, source_name, source_mime,
       source_size, year, file_kind
FROM document_version;
DROP TABLE document_version;
ALTER TABLE document_version_new RENAME TO document_version;
CREATE INDEX idx_docver_document ON document_version(document_id, is_current);
