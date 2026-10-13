-- 001_init: 전체 스키마 (설계서 §2 — Day 1에 전부 생성)
-- 주의: 도메인 데이터 하드삭제 금지(soft delete + change_log). 판본·앵커 모델은 불변.

-- 사용자
CREATE TABLE user (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,                      -- bcryptjs
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),  -- viewer = 심사위원 열람용
  expires_at TEXT,                            -- viewer 임시계정 만료
  active INTEGER NOT NULL DEFAULT 1
);

-- 기관 설정 (R2: 하드코딩 금지 — 기관명/표시명/로고 등)
CREATE TABLE app_setting ( key TEXT PRIMARY KEY, value TEXT NOT NULL );

-- 감사 주기 = 연도별 문항 판 (R1)
CREATE TABLE cycle (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                                  -- '2026년 정기심사'
  status TEXT NOT NULL DEFAULT 'active'
         CHECK (status IN ('active','frozen')),        -- frozen = 제출본 동결, 전면 읽기전용
  frozen_at TEXT,
  frozen_by INTEGER REFERENCES user(id),
  created_at TEXT NOT NULL
);

CREATE TABLE category (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycle(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES user(id),           -- 소유는 표식일 뿐 ACL 아님
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  UNIQUE (cycle_id, code)
);
CREATE INDEX idx_category_cycle ON category(cycle_id);

CREATE TABLE question (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES category(id),
  question_no TEXT NOT NULL,                 -- '50.010.090' 점 구분 코드 (표시용; 정체성은 id)
  sort_key INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  answer_json TEXT,                          -- Tiptap JSON
  answer_plain TEXT,                         -- FTS/내보내기용 평문 투영
  -- 채점 (R3)
  max_score REAL,                            -- 배점 (문항서 기재; 문항별 상이)
  allow_na INTEGER NOT NULL DEFAULT 0,       -- '해당없음' 선택 가능 여부
  answer_choice TEXT CHECK (answer_choice IN ('yes','no','na')),
  score REAL,                                -- 예: 0~max_score, 0.5 간격(서버 검증); 아니오: 0 자동; 해당없음: NULL
  findings_text TEXT,                        -- 지적/권장사항 (하단 입력칸)
  -- 연차 개정 (R1)
  revision_status TEXT CHECK (revision_status IN ('same','modified','new')),
  revision_note TEXT,                        -- 공식 개정 요약표의 수정유형 원문 ('배점 변경, 설명 수정')
  needs_recheck INTEGER NOT NULL DEFAULT 0,  -- 본문 변경/배점 변경/해당없음 유무변경 시 마법사가 설정
  carried_from_id INTEGER REFERENCES question(id),  -- 전년도 문항 행 (비교 보기의 근거)
  -- 공통
  reviewed INTEGER NOT NULL DEFAULT 0,       -- 수동 '검토완료 ✓' (완성도 ○/◐/●는 파생값, 저장 안 함)
  row_version INTEGER NOT NULL DEFAULT 1,    -- 낙관적 잠금
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id),
  deleted_at TEXT,
  UNIQUE (category_id, question_no)
);
CREATE INDEX idx_question_category ON question(category_id);
CREATE INDEX idx_question_no ON question(question_no);

-- 지침서: 논리 문서 / 불변 판본
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual'
       CHECK (kind IN ('manual','question_source')),   -- 인증기관 배포 문항 원본 PDF도 등록 가능(참고용, 매핑 대상 아님)
  deleted_at TEXT
);

CREATE TABLE document_version (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  version_label TEXT NOT NULL,               -- '2026-개정1'
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  page_count INTEGER,
  extractor TEXT,                            -- 'pdfjs-4.x'
  canon_norm TEXT,                           -- 'nfc-v1'
  status TEXT NOT NULL DEFAULT 'processing'
         CHECK (status IN ('processing','active','superseded','failed')),
  is_current INTEGER NOT NULL DEFAULT 0,
  text_warning TEXT,                          -- 저밀도 텍스트(스캔 페이지 의심) 경고
  uploaded_by INTEGER REFERENCES user(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (document_id, version_label)
);
CREATE INDEX idx_docver_document ON document_version(document_id, is_current);

CREATE TABLE page_text (                      -- 판본별 정규화(NFC) 페이지 텍스트
  document_version_id INTEGER NOT NULL REFERENCES document_version(id),
  page_no INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,              -- 판본 전문 기준 페이지 시작 오프셋
  text TEXT NOT NULL,
  PRIMARY KEY (document_version_id, page_no)
);

-- 논리 발췌: 문항이 연결되는 대상. 좌표를 갖지 않는다.
CREATE TABLE passage (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  label TEXT,                                 -- '제12조 파기' (선택)
  color TEXT NOT NULL DEFAULT 'yellow',
  obsolete INTEGER NOT NULL DEFAULT 0,        -- 개정으로 조항 삭제 시
  row_version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX idx_passage_document ON passage(document_id);

-- 판본별 앵커: 좌표 + 생애주기. 핵심 테이블.
CREATE TABLE passage_anchor (
  id INTEGER PRIMARY KEY,
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  document_version_id INTEGER NOT NULL REFERENCES document_version(id),
  quote_exact TEXT NOT NULL,                  -- 선택된 원문 (의미적 앵커, 1순위)
  quote_prefix TEXT,                          -- 앞 최대 64자 문맥
  quote_suffix TEXT,                          -- 뒤 최대 64자 문맥
  start_offset INTEGER,                       -- 정규화 전문 기준 (2순위, 중복 인용 판별)
  end_offset INTEGER,
  page_start INTEGER,
  page_end INTEGER,
  rects_json TEXT,                            -- [{page, rects:[[x0,y0,x1,y1],…]}] 페이지 크기 대비 0..1 정규화
                                              -- 렌더링 전용 파생 캐시(3순위). 판본 간 절대 신뢰 금지.
  geometry_primary INTEGER NOT NULL DEFAULT 0,-- 표/이상한 읽기순서용 박스 앵커: 개정 시 무조건 검수행
  status TEXT NOT NULL CHECK (status IN
    ('resolved','resolved_auto','resolved_fuzzy','needs_review',
     'unresolved','historical','obsolete')),
  method TEXT CHECK (method IN ('manual','exact','context','fuzzy')),
  confidence REAL,
  resolved_by INTEGER REFERENCES user(id),
  resolved_at TEXT,
  UNIQUE (passage_id, document_version_id)
);
CREATE INDEX idx_anchor_docver_status ON passage_anchor(document_version_id, status);

-- 핵심 N:M 매핑
CREATE TABLE question_passage (
  question_id INTEGER NOT NULL REFERENCES question(id),
  passage_id  INTEGER NOT NULL REFERENCES passage(id),
  sort INTEGER NOT NULL DEFAULT 0,            -- ①②③ 칩 순서 = 숫자키 1–9 (드래그 재정렬)
  note TEXT,                                  -- 칩별 한 줄 메모 ('제12조 본문')
  created_by INTEGER REFERENCES user(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (question_id, passage_id)
);
CREATE INDEX idx_qp_passage ON question_passage(passage_id);

-- 자유양식 근거문서 (Word 대체)
CREATE TABLE rich_doc (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,                 -- ProseMirror JSON
  content_plain TEXT,                         -- FTS 투영
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id),
  deleted_at TEXT
);

CREATE TABLE question_richdoc (
  question_id INTEGER NOT NULL REFERENCES question(id),
  rich_doc_id INTEGER NOT NULL REFERENCES rich_doc(id),
  sort INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (question_id, rich_doc_id)
);
CREATE INDEX idx_qr_richdoc ON question_richdoc(rich_doc_id);
-- 주: 다형성 kind/ref_id 대신 FK 무결성이 살아 있는 조인 2개.
-- 근거 칩 순서는 (question_passage ∪ question_richdoc)의 sort를 통합 정렬해 계산.

CREATE TABLE attachment (                     -- 에디터 이미지 등 (내용주소 저장)
  id INTEGER PRIMARY KEY,
  sha256 TEXT UNIQUE NOT NULL,
  mime TEXT NOT NULL,
  orig_name TEXT,
  size INTEGER NOT NULL
);

CREATE TABLE import_batch (                   -- 엑셀 가져오기·문항 PDF 파싱·주기 이월 공통
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'excel'
       CHECK (kind IN ('excel','question_pdf','cycle_carry')),
  file_name TEXT,
  uploaded_by INTEGER,
  uploaded_at TEXT,
  dry_run INTEGER,
  summary_json TEXT,                          -- 파싱 결과·공식 개정표·diff 요약 저장
  snapshot_file TEXT                          -- pre-import DB 스냅샷 경로
);

-- 추가-전용 변경 이력 (감사 추적; 채점 변경 포함)
CREATE TABLE change_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_id INTEGER REFERENCES user(id),
  actor_kind TEXT NOT NULL DEFAULT 'user'
         CHECK (actor_kind IN ('user','import','system')),
  batch_id INTEGER REFERENCES import_batch(id),
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,                        -- create|update|delete|link|unlink|reanchor|import|freeze…
  before_json TEXT,
  after_json TEXT,
  request_id TEXT
);
CREATE INDEX idx_changelog_entity ON change_log(entity, entity_id, ts);

CREATE TABLE editing_lease (                  -- 권고형 소프트락 (v1은 스키마만, 동작은 v2)
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES user(id),
  acquired_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id)
);

-- 세션 스토어 (express-session용 — 도메인 데이터 아님)
CREATE TABLE session (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL                     -- epoch ms
);
CREATE INDEX idx_session_expire ON session(expire);

-- 통합 전문 검색 (한국어 = trigram 부분문자열)
-- kind: 'question' | 'passage' | 'rich_doc' | 'page_text'
CREATE VIRTUAL TABLE fts USING fts5(
  kind, ref_id UNINDEXED, content, tokenize='trigram'
);

-- FTS 동기화: question/rich_doc은 트리거, passage(quote)/page_text는 기록 경로가 통제된
-- 서비스 코드(업로드 파이프라인·매핑 트랜잭션)에서 유지한다.
CREATE TRIGGER trg_question_fts_ai AFTER INSERT ON question BEGIN
  INSERT INTO fts(kind, ref_id, content)
  VALUES ('question', NEW.id,
          NEW.question_no || ' ' || NEW.body || ' ' || COALESCE(NEW.answer_plain,'') || ' ' || COALESCE(NEW.findings_text,''));
END;
CREATE TRIGGER trg_question_fts_au AFTER UPDATE ON question BEGIN
  DELETE FROM fts WHERE kind='question' AND ref_id=OLD.id;
  INSERT INTO fts(kind, ref_id, content)
  SELECT 'question', NEW.id,
         NEW.question_no || ' ' || NEW.body || ' ' || COALESCE(NEW.answer_plain,'') || ' ' || COALESCE(NEW.findings_text,'')
  WHERE NEW.deleted_at IS NULL;
END;
CREATE TRIGGER trg_richdoc_fts_ai AFTER INSERT ON rich_doc BEGIN
  INSERT INTO fts(kind, ref_id, content) VALUES ('rich_doc', NEW.id, NEW.title || ' ' || COALESCE(NEW.content_plain,''));
END;
CREATE TRIGGER trg_richdoc_fts_au AFTER UPDATE ON rich_doc BEGIN
  DELETE FROM fts WHERE kind='rich_doc' AND ref_id=OLD.id;
  INSERT INTO fts(kind, ref_id, content)
  SELECT 'rich_doc', NEW.id, NEW.title || ' ' || COALESCE(NEW.content_plain,'')
  WHERE NEW.deleted_at IS NULL;
END;
