/**
 * 현재 주기(연도) 해석 — 단일 원천 헬퍼.
 * 라우트(routes/questions.ts)와 가져오기 서비스(import/question-pdf-service.ts)가 함께 쓴다.
 * (중립 모듈로 분리 — 서비스가 라우트를 import 하는 순환을 피한다)
 */
import type Database from 'better-sqlite3';

export interface ActiveCycle {
  id: number;
  name: string;
  status: string;
  year: number | null;
}

/**
 * 현재 주기 — app_setting 'activeCycleId'에 고정한다.
 * 미래 연도 주기(가져오기 연도 지정)를 만들어도 기관이 전환하기 전까지 현재 주기가
 * 바뀌면 안 되므로, 설정이 없을 때의 폴백(최신 active)도 즉시 설정에 고정해 sticky 하게 만든다.
 */
export function getActiveCycle(db: Database.Database): ActiveCycle | null {
  const selectCycle = db.prepare('SELECT id, name, status, year FROM cycle WHERE id = ?');
  const setting = db
    .prepare("SELECT value FROM app_setting WHERE key = 'activeCycleId'")
    .get() as { value: string } | undefined;
  if (setting) {
    const id = Number.parseInt(setting.value, 10);
    if (Number.isInteger(id)) {
      const pinned = selectCycle.get(id) as ActiveCycle | undefined;
      if (pinned) return pinned;
    }
  }
  const fallback = db
    .prepare(
      "SELECT id, name, status, year FROM cycle WHERE status = 'active' ORDER BY id DESC LIMIT 1",
    )
    .get() as ActiveCycle | undefined;
  if (!fallback) return null;
  db.prepare("INSERT OR REPLACE INTO app_setting (key, value) VALUES ('activeCycleId', ?)").run(
    String(fallback.id),
  );
  return fallback;
}
