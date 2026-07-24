/**
 * app_setting 조회 헬퍼 — 기관명·시스템 표시명 (R2: 하드코딩 금지)
 * 미설정 시 기본값: systemName='웹 바인더', orgName=''.
 */
import type Database from 'better-sqlite3';

export interface AppSettings {
  orgName: string;
  systemName: string;
}

export function getSettings(db: Database.Database): AppSettings {
  const rows = db
    .prepare("SELECT key, value FROM app_setting WHERE key IN ('orgName','systemName')")
    .all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const systemName = map.get('systemName');
  return {
    orgName: map.get('orgName') ?? '',
    systemName: systemName && systemName.length > 0 ? systemName : '우수검사실 인증심사 웹 바인더',
  };
}
