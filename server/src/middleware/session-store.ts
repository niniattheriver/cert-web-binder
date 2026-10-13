/**
 * better-sqlite3 세션 스토어 (설계서 §5)
 * - session 테이블(001_init.sql)에 sid/sess(JSON)/expire(epoch ms) 저장.
 * - 만료 세션은 조회 시 걸러내고, 주기 청소(기본 10분)로 물리 삭제한다.
 * - now 주입은 테스트용(만료 검증).
 */
import type Database from 'better-sqlite3';
import session from 'express-session';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 유휴 만료
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

interface SessionRow {
  sid: string;
  sess: string;
  expire: number;
}

export interface SqliteSessionStoreOptions {
  /** 청소 주기(ms). 0이면 주기 청소 비활성(테스트용). */
  cleanupIntervalMs?: number;
  /** 현재 시각 함수 주입(테스트용) */
  now?: () => number;
}

export class SqliteSessionStore extends session.Store {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database.Database, options: SqliteSessionStoreOptions = {}) {
    super();
    this.db = db;
    this.now = options.now ?? Date.now;
    const interval = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => this.cleanupExpired(), interval);
      this.timer.unref?.();
    }
  }

  /** 세션의 만료 시각(epoch ms) 계산 — cookie.maxAge 우선, 없으면 기본 12h */
  private expireAt(sess: session.SessionData): number {
    const maxAge = sess.cookie?.maxAge;
    const ttl = typeof maxAge === 'number' ? maxAge : DEFAULT_TTL_MS;
    return this.now() + ttl;
  }

  override get(
    sid: string,
    callback: (err?: unknown, session?: session.SessionData | null) => void,
  ): void {
    try {
      const row = this.db
        .prepare('SELECT sid, sess, expire FROM session WHERE sid = ?')
        .get(sid) as SessionRow | undefined;
      if (!row) return callback(undefined, null);
      if (row.expire <= this.now()) {
        this.db.prepare('DELETE FROM session WHERE sid = ?').run(sid);
        return callback(undefined, null);
      }
      callback(undefined, JSON.parse(row.sess) as session.SessionData);
    } catch (err) {
      callback(err);
    }
  }

  override set(
    sid: string,
    sess: session.SessionData,
    callback?: (err?: unknown) => void,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO session (sid, sess, expire) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`,
        )
        .run(sid, JSON.stringify(sess), this.expireAt(sess));
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      this.db.prepare('DELETE FROM session WHERE sid = ?').run(sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  /** rolling 세션의 유휴 만료 연장 */
  override touch(
    sid: string,
    sess: session.SessionData,
    callback?: (err?: unknown) => void,
  ): void {
    try {
      this.db
        .prepare('UPDATE session SET expire = ? WHERE sid = ?')
        .run(this.expireAt(sess), sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  override length(callback: (err?: unknown, length?: number) => void): void {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM session WHERE expire > ?')
        .get(this.now()) as { n: number };
      callback(undefined, row.n);
    } catch (err) {
      callback(err);
    }
  }

  override clear(callback?: (err?: unknown) => void): void {
    try {
      this.db.prepare('DELETE FROM session').run();
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  /** 만료 세션 물리 삭제. @returns 삭제 행 수 */
  cleanupExpired(): number {
    const info = this.db.prepare('DELETE FROM session WHERE expire <= ?').run(this.now());
    return info.changes;
  }

  /** 주기 청소 타이머 중지(테스트·종료 시) */
  stopCleanup(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
