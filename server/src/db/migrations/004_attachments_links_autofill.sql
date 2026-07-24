-- 004_attachments_links_autofill: 문항 첨부·하이퍼링크 + 예→만점 자동 채움 비트 + 지침서 원본파일
-- (설계서 §2 / v1.5 개편 Phase 2)
--
-- ADD COLUMN + CREATE TABLE만 사용 → 기존 행 무손상 (002·003과 동일 원칙).
--   · question.score_autofilled: 예 선택 시 배점 만점을 "자동 채움"한 뒤 사용자가 아직
--     확인(수정/재선택)하지 않았음을 표시하는 1비트. 임포트·마이그레이션 경로에서는
--     절대 1로 설정하지 않는다(조용한 자동화 금지 — 사용자 UI 액션에서만 발동).
--   · question_attachment: 문항 근거 파일 첨부. 파일 본문은 내용주소(sha256) 저장,
--     표시명(orig_name)은 링크 행에 둔다(동일 파일을 다른 이름으로 첨부 가능).
--     inline 미리보기는 서버가 pdf/png/jpg 화이트리스트로만 허용(HTML/SVG 저장형 XSS 차단).
--   · question_link: 문항 근거 하이퍼링크(내부망 문서함 등).
--   · document_version.source_*: 지침서 판본의 원본 파일(hwp/docx/xlsx — B-2).
--     매핑(하이라이트)은 PDF 사본에, 편집·다운로드는 원본으로. 판본당 0..1개(컬럼).
-- 첨부·링크는 근거 칩(question_passage ∪ question_richdoc 통합 정렬) 체계에 편입하지 않고
-- 별도 섹션으로 표시한다 — 칩은 "본문 근거", 첨부·링크는 "보조 자료" (설계서 §4 #4).

ALTER TABLE question ADD COLUMN score_autofilled INTEGER NOT NULL DEFAULT 0;

-- 문항 파일 첨부 (Phase 2 안전장치: 디스크 스트리밍 저장·서버 통제 저장명(내용주소)·
-- 파일당 상한(app_setting 'attachmentMaxMB')·soft delete)
CREATE TABLE question_attachment (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES question(id),
  sha256 TEXT NOT NULL,                                   -- 내용주소 (files/attachments/<2>/<62>)
  orig_name TEXT NOT NULL,                                -- 업로드 시 파일명(표시·다운로드용)
  mime TEXT NOT NULL,                                     -- 서버가 확장자 기준으로 재판정한 MIME
  size INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES user(id),
  uploaded_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_qattach_question ON question_attachment(question_id);

-- 문항 하이퍼링크
CREATE TABLE question_link (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES question(id),
  url TEXT NOT NULL,                                      -- http(s):// 만 허용(서버 검증)
  label TEXT,                                             -- 표시명(없으면 url 표시)
  sort INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES user(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_qlink_question ON question_link(question_id);

-- 지침서 판본 원본 파일 (B-2 — 매핑은 PDF 사본, 편집·다운로드는 원본)
ALTER TABLE document_version ADD COLUMN source_sha256 TEXT;  -- 내용주소(첨부와 동일 저장소)
ALTER TABLE document_version ADD COLUMN source_name TEXT;
ALTER TABLE document_version ADD COLUMN source_mime TEXT;
ALTER TABLE document_version ADD COLUMN source_size INTEGER;
