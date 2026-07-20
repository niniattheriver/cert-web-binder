/**
 * 엑셀 내보내기 라우트 (설계서 §6.3, §6.1) — 전부 editor 이상.
 *   GET /api/export/all.xlsx            → 활성 주기 전체(분야별 합계 + 전체 합계)
 *   GET /api/export/category/:id.xlsx   → 특정 분야
 *   GET /api/export/template.xlsx       → §6.1 가져오기 양식(+안내 시트)
 * 응답은 xlsx 스트림(Content-Disposition, 한글 파일명 RFC5987 filename*).
 * 마운트: index.ts 가 /api 아래 requireEditor 없이 마운트하고, 라우터가 자체적으로 editor 가드를 건다.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSettings } from '../db/settings.js';
import { collectExportCategories } from '../export/data.js';
import { buildExportWorkbook, buildTemplateWorkbook } from '../export/workbook.js';
import { requireEditor } from '../middleware/auth.js';
import { resolveCycleParam } from './questions.js';
import { computeReadiness } from './readiness.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function yyyymmdd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 한글 파일명 RFC5987 (filename* = UTF-8''…) + ASCII 폴백 */
function setDownloadHeaders(res: Response, koreanName: string): void {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(koreanName)}`,
  );
}

/** 파일명에서 쓸 수 없는 문자를 밑줄로 (Windows 예약 문자·경로 구분자) */
function safeFilePart(s: string): string {
  return s.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
}

export function createExportRouter(db: Database.Database): Router {
  const router = Router();
  const editor = requireEditor(db);

  // 전체 내보내기 (?cycle=<id> 로 다른 연도(주기) 내보내기 가능. 미지정이면 현재 주기)
  router.get('/export/all.xlsx', editor, async (req: Request, res: Response, next) => {
    try {
      const resolved = resolveCycleParam(db, req.query.cycle);
      if (!resolved.ok) {
        res.status(400).json({ error: '잘못된 주기입니다.' });
        return;
      }
      const cycle = resolved.cycle;
      if (!cycle) {
        res.status(404).json({ error: 'not_found', details: '활성 주기가 없습니다.' });
        return;
      }
      const categories = collectExportCategories(db, cycle.id);
      const wb = buildExportWorkbook(categories, {
        orgName: getSettings(db).orgName,
        cycleName: cycle.name,
        scopeLabel: '전체',
        readiness: computeReadiness(db, cycle.id), // '준비도 요약' 시트 (C-2 — 전체 내보내기 전용)
      });
      setDownloadHeaders(res, `전체_문항내보내기_${yyyymmdd()}.xlsx`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      next(err);
    }
  });

  // 분야별 내보내기
  router.get('/export/category/:id.xlsx', editor, async (req: Request, res: Response, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'validation', details: '분야 ID가 올바르지 않습니다.' });
        return;
      }
      // 분야가 속한 주기로 조회 — 다른 연도(주기)의 분야도 내보낼 수 있어야 한다
      const catRow = db
        .prepare('SELECT cycle_id FROM category WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { cycle_id: number } | undefined;
      const cycle = catRow
        ? ((db.prepare('SELECT id, name FROM cycle WHERE id = ?').get(catRow.cycle_id) as
            | { id: number; name: string }
            | undefined) ?? null)
        : null;
      if (!cycle) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const categories = collectExportCategories(db, cycle.id, id);
      const cat = categories[0];
      if (!cat) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const wb = buildExportWorkbook(categories, {
        orgName: getSettings(db).orgName,
        cycleName: cycle.name,
        scopeLabel: `${cat.code} ${cat.name}`,
      });
      const namePart = safeFilePart(`${cat.code}_${cat.name}`);
      setDownloadHeaders(res, `${namePart}_문항내보내기_${yyyymmdd()}.xlsx`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      next(err);
    }
  });

  // §6.1 가져오기 양식
  router.get('/export/template.xlsx', editor, async (_req: Request, res: Response, next) => {
    try {
      const wb = buildTemplateWorkbook();
      setDownloadHeaders(res, '문항_가져오기_양식.xlsx');
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
