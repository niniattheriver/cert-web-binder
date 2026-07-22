/**
 * SQLite 연결 (설계서 §1, §2 서두)
 * - better-sqlite3 동기 API, WAL, 외래키 강제.
 * - 기동 시 마이그레이션(PRAGMA user_version 추적) 자동 적용 — 실패하면 여기서 예외로 기동 중단.
 */
import type Database from 'better-sqlite3';
import path from 'node:path';
import { dataDir } from '../config.js';
import { openDatabase } from './migrate.js';

export const dbPath = path.join(dataDir, 'app.db');

export const db: Database.Database = openDatabase(dbPath);
