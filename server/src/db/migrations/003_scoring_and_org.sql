-- 003_scoring_and_org: 통합 채점 모델 + 기관 지표(공통문항) 스키마 선행 생성 (설계서 §2 / v1.5 개편 Phase 1)
--
-- 가드레일 4(전체 스키마 Day 1): v1에서 동작을 만들지 않는 테이블(합산·자동배점·기관지표)도
-- 스키마는 지금 만든다 — 채점 모델은 후장착이 재작성급이라 미리 자리를 잡는다.
-- ADD COLUMN + CREATE TABLE만 사용 → 기존 1,662행/스키마 무손상.
--   · scoring_mode: 문항 채점 방식. 기존 전 행은 DEFAULT 'simple'(예/아니오 단일 배점)로 자동 채워진다.
--       simple    = 예→만점 / 아니오→0 (현행)
--       composite = 세부항목(question_criterion) 점수 합산 = 총점
--       auto      = 기관지표(org_metric) 기반 자동 계산(auto_rule)
--   · topic: 문항 '주제'(설명과 분리). 파서 확장(3b) 전까지는 NULL — 본문(body)에서 파생 표시.
--   · score_overridden: 합산·자동 모드에서 사용자가 총점을 수기 override 했는지(1) 표식.
-- 무결성 불변식(서버가 강제, 스키마는 자리만): composite면 score==Σcriterion.score,
--   max_score==Σcriterion.max_score / auto면 score=auto_score_state.computed_score.

ALTER TABLE question ADD COLUMN scoring_mode TEXT NOT NULL DEFAULT 'simple'
  CHECK (scoring_mode IN ('simple','composite','auto'));
ALTER TABLE question ADD COLUMN topic TEXT;
ALTER TABLE question ADD COLUMN score_overridden INTEGER NOT NULL DEFAULT 0;

-- 세부 평가항목 — 합산(composite) 문항의 항목별 배점/취득점. parent_id로 2단 계층 허용.
CREATE TABLE question_criterion (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES question(id),
  parent_id INTEGER REFERENCES question_criterion(id),   -- 중첩 항목(선택). NULL=최상위
  sort INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,                                    -- 항목명(파서 추출 또는 수기)
  max_score REAL NOT NULL,                                -- 항목 배점(양수, 서버 검증)
  score REAL,                                             -- 취득점(0~max_score, 미채점 NULL)
  deleted_at TEXT
);
CREATE INDEX idx_criterion_question ON question_criterion(question_id);

-- 자동배점 규칙 — 문항 1개당 0/1개. source_metric_key가 NULL이면 '미활성'(바인딩 전).
-- 파서(3b)는 감지·임계표 추출까지, 지표 바인딩·활성화는 사람이 수동으로 한다(조용한 자동화 금지).
CREATE TABLE auto_rule (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES question(id),
  source_metric_key TEXT,                                 -- org_metric.metric_key (수동 바인딩; NULL=미활성)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (question_id)
);

-- 자동배점 구간표 — [lower, upper) 구간별 점수. 서버가 겹침·구멍을 검증한다.
CREATE TABLE auto_rule_band (
  id INTEGER PRIMARY KEY,
  auto_rule_id INTEGER NOT NULL REFERENCES auto_rule(id),
  lower REAL,                                             -- 하한(포함). NULL=−∞
  upper REAL,                                             -- 상한(미만). NULL=+∞
  score REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_band_rule ON auto_rule_band(auto_rule_id);

-- 기관 지표 — 공통문항 입력값(전년도 검사건수·상근 전문의 수 등). cycle 스코프(주기별 상이).
-- 하드코딩 금지(가드레일 6): 지표는 데이터로 관리. value는 TEXT 저장 + value_type로 해석.
CREATE TABLE org_metric (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycle(id),
  metric_key TEXT NOT NULL,                               -- 'annual_test_count' 등 안정 키
  label TEXT NOT NULL,                                    -- '전년도 검사 건수' 표시명
  value TEXT,                                             -- 입력값(미입력 NULL = '입력값 없음', 0 아님)
  unit TEXT,                                              -- '건','명' 등 표시 단위
  value_type TEXT NOT NULL DEFAULT 'number'
         CHECK (value_type IN ('number','integer','text')),
  row_version INTEGER NOT NULL DEFAULT 1,                 -- 낙관적 잠금(question과 동일 409 규약)
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id),
  deleted_at TEXT,                                        -- soft delete(가드레일 6)
  UNIQUE (cycle_id, metric_key)
);
CREATE INDEX idx_orgmetric_cycle ON org_metric(cycle_id);

-- 자동배점 계산 스냅샷 — 계산 시점의 지표·구간표를 동결 보관. 지표 수정 시 stale=1로 표시,
-- 검수 큐가 'X→Y점' diff를 원클릭 확정하게 한다.
CREATE TABLE auto_score_state (
  question_id INTEGER PRIMARY KEY REFERENCES question(id),
  metric_snapshot_json TEXT,                              -- 계산에 쓴 지표값 동결
  band_snapshot_json TEXT,                                -- 계산에 쓴 구간표 동결
  computed_score REAL,
  stale INTEGER NOT NULL DEFAULT 0,                       -- 1=지표/구간 변경으로 재계산 필요
  computed_at TEXT
);
