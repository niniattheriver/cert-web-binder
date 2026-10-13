/**
 * 문항 완성도 파생 — 목록 행·상세 왼쪽 레일이 같은 규칙을 쓴다(저장 안 함, 설계서 §2).
 *   채점됨: 단순 모드는 예/아니오/해당없음 선택, 합산·자동 모드는 점수 존재 (대시보드 집계와 동일).
 *   준비됨: 근거(근거자료 하이라이트, 자유형식, 첨부, 링크)가 하나라도 있음. 서술 답변 칸은 화면에 없어 세지 않는다.
 *   ● full = 채점 + 준비 · ◐ partial = 둘 중 하나 · ○ none = 둘 다 없음.
 */
import type { QuestionListItem } from './api';
import type { StatusKind } from './components/StatusGlyph';

export function isGraded(q: QuestionListItem): boolean {
  if (q.scoringMode && q.scoringMode !== 'simple') return q.score != null;
  return q.answerChoice != null;
}

/** 근거 유무 — 목록의 '근거 연결 전' 필터·준비도 진단과 같은 정의(첨부·링크만 있어도 근거 있음) */
export function hasEvidence(q: QuestionListItem): boolean {
  return (
    (q.evidencePassages ?? 0) + (q.evidenceRichdocs ?? 0) > 0 ||
    (q.attachmentCount ?? 0) > 0 ||
    (q.linkCount ?? 0) > 0
  );
}

export function isPrepared(q: QuestionListItem): boolean {
  return hasEvidence(q);
}

export function deriveStatus(q: QuestionListItem): StatusKind {
  const graded = isGraded(q);
  const prepared = isPrepared(q);
  if (graded && prepared) return 'full';
  if (graded || prepared) return 'partial';
  return 'none';
}
