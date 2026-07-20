/**
 * 무결성 점검기 (설계서 §2 무결성 불변식, §7 관리 대시보드 표시)
 * 기동 시 1회 + 주간 전수 점검. 결과는 app_setting('integrity:last')에 JSON으로 보존해
 * GET /api/admin/integrity 로 노출하고 재기동 후에도 유지한다.
 *
 * 점검 불변식(§2):
 *  1) 문서당 is_current=1 판본은 정확히 1개(활성 판본이 있는데 0개거나, 2개 이상이면 위반).
 *  2) 모든 판본의 sha256 파일이 디스크에 존재(주간 전수 검사).
 *  3) 채점 정합: no→score=0 / na→score IS NULL & allow_na=1 /
 *     yes→score IS NULL(미채점 허용) 또는 0..max_score & 0.5 간격.
 *  4) question_passage·question_richdoc 조인이 soft-delete된 행을 참조하지 않음.
 *  5) 문항이 연결한 비-obsolete passage는 그 문서의 현재 판본에 앵커 행 존재(상태 불문).
 *  6) 첨부 저장소 파일(문항 첨부·지침서 원본·에디터 이미지)의 sha256 파일이 디스크에 존재.
 *  7) 채점 정합(composite/auto): composite → score==Σ리프 criterion.score,
 *     max_score==Σ리프 criterion.max_score(파서 오추출 감지망) / auto →
 *     score==auto_score_state.computed_score (score_overridden=1 은 제외).
 *
 * (읽기 전용 SQL — 도메인 데이터를 변경하지 않는다. 하드삭제·수정 없음.)
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { contentPath } from '../docs/store.js';
import { attachmentPath } from '../richdocs/service.js';

const SETTING_KEY = 'integrity:last';
const MAX_OFFENDERS = 50; // 결과 저장 시 위반 표본 상한(대량 위반 시 폭주 방지)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  offenderCount: number;
  offenders: unknown[];
}

export interface IntegrityResult {
  checkedAt: string;
  ok: boolean;
  checks: IntegrityCheck[];
}

function checkIsCurrent(db: Database.Database): IntegrityCheck {
  const rows = db
    .prepare(
      `SELECT d.id AS documentId, d.title AS title,
              (SELECT COUNT(*) FROM document_version v WHERE v.document_id = d.id AND v.is_current = 1) AS current,
              (SELECT COUNT(*) FROM document_version v WHERE v.document_id = d.id
                 AND v.status IN ('active','superseded')) AS liveVersions
       FROM document d WHERE d.deleted_at IS NULL`,
    )
    .all() as { documentId: number; title: string; current: number; liveVersions: number }[];
  const offenders = rows
    .filter((r) => r.current > 1 || (r.liveVersions > 0 && r.current === 0))
    .map((r) => ({
      documentId: r.documentId,
      title: r.title,
      currentCount: r.current,
      reason: r.current > 1 ? 'is_current 판본이 2개 이상' : '활성 판본이 있으나 is_current 없음',
    }));
  return {
    name: '문서당 현재 판본(is_current) 정확히 1개',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

function checkFilesExist(db: Database.Database, filesDir: string): IntegrityCheck {
  const rows = db
    .prepare(
      `SELECT id, document_id AS documentId, version_label AS versionLabel,
              file_sha256 AS sha256, file_name AS fileName
       FROM document_version`,
    )
    .all() as {
    id: number;
    documentId: number;
    versionLabel: string;
    sha256: string;
    fileName: string;
  }[];
  const offenders = rows
    .filter((r) => !fs.existsSync(contentPath(filesDir, r.sha256)))
    .map((r) => ({
      versionId: r.id,
      documentId: r.documentId,
      versionLabel: r.versionLabel,
      sha256: r.sha256,
      fileName: r.fileName,
    }));
  return {
    name: '모든 판본의 sha256 파일 디스크 존재',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

function checkScoring(db: Database.Database): IntegrityCheck {
  const rows = db
    .prepare(
      `SELECT id, question_no AS questionNo, answer_choice AS answerChoice,
              score, max_score AS maxScore, allow_na AS allowNa
       FROM question
       WHERE deleted_at IS NULL AND answer_choice IS NOT NULL AND scoring_mode = 'simple'`,
    )
    .all() as {
    id: number;
    questionNo: string;
    answerChoice: 'yes' | 'no' | 'na';
    score: number | null;
    maxScore: number | null;
    allowNa: number;
  }[];

  const offenders: { questionId: number; questionNo: string; reason: string }[] = [];
  for (const r of rows) {
    let reason: string | null = null;
    if (r.answerChoice === 'no') {
      if (r.score !== 0) reason = "'아니오'인데 score가 0이 아님";
    } else if (r.answerChoice === 'na') {
      if (r.score !== null) reason = "'해당없음'인데 score가 NULL이 아님";
      else if (r.allowNa !== 1) reason = "'해당없음'인데 allow_na=0 문항";
    } else if (r.answerChoice === 'yes') {
      // score NULL = 미채점 — 쓰기 검증(domain/scoring.ts)·채점 위젯이 허용하는 정상 중간 상태
      if (r.score === null) reason = null;
      else if (r.maxScore !== null && (r.score < 0 || r.score > r.maxScore))
        reason = '점수가 0..max_score 범위를 벗어남';
      else if (!Number.isInteger(r.score * 2)) reason = '점수가 0.5 간격이 아님';
    }
    if (reason) offenders.push({ questionId: r.id, questionNo: r.questionNo, reason });
  }
  return {
    name: '채점 정합(answer_choice ↔ score)',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

function checkJoinSoftDelete(db: Database.Database): IntegrityCheck {
  const passageOffenders = db
    .prepare(
      `SELECT qp.question_id AS questionId, qp.passage_id AS passageId
       FROM question_passage qp
       JOIN question q ON q.id = qp.question_id
       JOIN passage p ON p.id = qp.passage_id
       WHERE q.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL`,
    )
    .all() as { questionId: number; passageId: number }[];
  const richOffenders = db
    .prepare(
      `SELECT qr.question_id AS questionId, qr.rich_doc_id AS richDocId
       FROM question_richdoc qr
       JOIN question q ON q.id = qr.question_id
       JOIN rich_doc r ON r.id = qr.rich_doc_id
       WHERE q.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL`,
    )
    .all() as { questionId: number; richDocId: number }[];
  const offenders = [
    ...passageOffenders.map((o) => ({ join: 'question_passage', ...o })),
    ...richOffenders.map((o) => ({ join: 'question_richdoc', ...o })),
  ];
  return {
    name: '조인(question_passage·question_richdoc)의 soft-delete 참조 없음',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

function checkAnchorsOnCurrent(db: Database.Database): IntegrityCheck {
  // §2 첫 불변식: 문항이 연결한 모든 비-obsolete passage는 그 문서의 현재 판본에
  // 앵커 행이 존재해야 함(상태 불문 — 추적이 핵심). 위반 시 검수 큐·배지에서 조용히 사라진다.
  const offenders = db
    .prepare(
      `SELECT DISTINCT p.id AS passageId, p.document_id AS documentId, d.title AS title
       FROM passage p
       JOIN question_passage qp ON qp.passage_id = p.id
       JOIN question q ON q.id = qp.question_id AND q.deleted_at IS NULL
       JOIN document d ON d.id = p.document_id AND d.deleted_at IS NULL
       JOIN document_version dv ON dv.document_id = p.document_id AND dv.is_current = 1
       WHERE p.deleted_at IS NULL AND p.obsolete = 0
         AND NOT EXISTS (SELECT 1 FROM passage_anchor pa
                         WHERE pa.passage_id = p.id AND pa.document_version_id = dv.id)`,
    )
    .all() as { passageId: number; documentId: number; title: string }[];
  return {
    name: '연결 passage의 현재 판본 앵커 존재(상태 불문)',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

function checkAttachmentFilesExist(db: Database.Database, filesDir: string): IntegrityCheck {
  // 첨부 저장소(files/attachments/) 참조분 — 백업 매니페스트(jobs/backup.ts)와 동일 대상.
  // soft delete된 문항 첨부도 포함(하드삭제 금지 — 파일은 보존 대상).
  const rows = db
    .prepare(
      `SELECT sha256, MIN(fileName) AS fileName FROM (
         SELECT sha256, orig_name AS fileName FROM question_attachment
         UNION ALL
         SELECT source_sha256, source_name FROM document_version WHERE source_sha256 IS NOT NULL
         UNION ALL
         SELECT sha256, orig_name FROM attachment
       ) GROUP BY sha256`,
    )
    .all() as { sha256: string; fileName: string | null }[];
  const offenders = rows
    .filter((r) => !fs.existsSync(attachmentPath(filesDir, r.sha256)))
    .map((r) => ({ sha256: r.sha256, fileName: r.fileName }));
  return {
    name: '첨부·원본·에디터 이미지 파일 디스크 존재',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

function checkModeScoring(db: Database.Database): IntegrityCheck {
  const offenders: { questionId: number; questionNo: string; reason: string }[] = [];
  const eq = (a: number | null, b: number | null): boolean =>
    (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-9);

  // composite: score == Σ리프 criterion.score / max_score == Σ리프 max (후자는 파서 오추출 감지망 — A-4)
  const composites = db
    .prepare(
      `SELECT id, question_no AS questionNo, score, max_score AS maxScore
       FROM question WHERE deleted_at IS NULL AND scoring_mode = 'composite'`,
    )
    .all() as { id: number; questionNo: string; score: number | null; maxScore: number | null }[];
  const critStmt = db.prepare(
    `SELECT id, parent_id AS parentId, max_score AS maxScore, score
     FROM question_criterion WHERE question_id = ? AND deleted_at IS NULL`,
  );
  for (const q of composites) {
    const rows = critStmt.all(q.id) as {
      id: number;
      parentId: number | null;
      maxScore: number;
      score: number | null;
    }[];
    if (rows.length === 0) {
      offenders.push({ questionId: q.id, questionNo: q.questionNo, reason: '합산 문항인데 세부항목 없음' });
      continue;
    }
    const parents = new Set(rows.filter((r) => r.parentId != null).map((r) => r.parentId));
    const leaves = rows.filter((r) => !parents.has(r.id));
    const scored = leaves.filter((l) => l.score != null);
    const sum = scored.length === 0 ? null : scored.reduce((s, l) => s + (l.score as number), 0);
    const maxSum = leaves.reduce((s, l) => s + l.maxScore, 0);
    if (!eq(q.score, sum))
      offenders.push({ questionId: q.id, questionNo: q.questionNo, reason: 'score ≠ Σ세부항목 취득점' });
    if (q.maxScore !== null && Math.abs(q.maxScore - maxSum) > 1e-9)
      offenders.push({
        questionId: q.id,
        questionNo: q.questionNo,
        reason: `배점(${q.maxScore}) ≠ Σ세부항목 배점(${maxSum})`,
      });
  }

  // auto: score == auto_score_state.computed_score (override 제외)
  const autos = db
    .prepare(
      `SELECT q.id, q.question_no AS questionNo, q.score, s.computed_score AS computedScore,
              s.question_id AS hasState
       FROM question q
       LEFT JOIN auto_score_state s ON s.question_id = q.id
       WHERE q.deleted_at IS NULL AND q.scoring_mode = 'auto' AND q.score_overridden = 0`,
    )
    .all() as {
    id: number;
    questionNo: string;
    score: number | null;
    computedScore: number | null;
    hasState: number | null;
  }[];
  for (const q of autos) {
    const computed = q.hasState == null ? null : q.computedScore;
    if (!eq(q.score, computed))
      offenders.push({
        questionId: q.id,
        questionNo: q.questionNo,
        reason: 'score ≠ 자동배점 계산값(스냅샷)',
      });
  }

  return {
    name: '채점 정합(합산/자동 — score=파생값)',
    ok: offenders.length === 0,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

/** 전 불변식을 점검해 구조화된 결과를 반환한다(읽기 전용). */
export function runIntegrityCheck(
  db: Database.Database,
  filesDir: string,
  now: Date = new Date(),
): IntegrityResult {
  const checks = [
    checkIsCurrent(db),
    checkFilesExist(db, filesDir),
    checkScoring(db),
    checkJoinSoftDelete(db),
    checkAnchorsOnCurrent(db),
    checkAttachmentFilesExist(db, filesDir),
    checkModeScoring(db),
  ];
  return {
    checkedAt: now.toISOString(),
    ok: checks.every((c) => c.ok),
    checks,
  };
}

/** 결과를 app_setting에 보존(재기동 후에도 유지, 백업에도 포함됨) */
export function persistIntegrityResult(db: Database.Database, result: IntegrityResult): void {
  db.prepare('INSERT OR REPLACE INTO app_setting (key, value) VALUES (?, ?)').run(
    SETTING_KEY,
    JSON.stringify(result),
  );
}

export function getLastIntegrityResult(db: Database.Database): IntegrityResult | null {
  const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as IntegrityResult;
  } catch {
    return null;
  }
}

/** 점검 실행 + 보존을 한 번에 */
export function runAndPersist(db: Database.Database, filesDir: string): IntegrityResult {
  const result = runIntegrityCheck(db, filesDir);
  persistIntegrityResult(db, result);
  return result;
}

export interface Scheduler {
  stop(): void;
}

/**
 * 기동 직후 1회 + 주간 무결성 점검을 등록한다(process 로컬 타이머, unref).
 * 기동 점검은 다음 틱으로 미뤄 리슨을 막지 않는다.
 */
export function startIntegrityScheduler(db: Database.Database, filesDir: string): Scheduler {
  const run = () => {
    try {
      const result = runAndPersist(db, filesDir);
      const failed = result.checks.filter((c) => !c.ok);
      if (result.ok) console.log('[무결성] 점검 통과');
      else console.warn(`[무결성] 위반 ${failed.length}건: ${failed.map((c) => c.name).join(', ')}`);
    } catch (err) {
      console.error('[무결성] 점검 실패:', (err as Error).message);
    }
  };

  const startTimer = setTimeout(run, 0);
  startTimer.unref?.();
  const interval = setInterval(run, WEEK_MS);
  interval.unref?.();

  return {
    stop() {
      clearTimeout(startTimer);
      clearInterval(interval);
    },
  };
}
