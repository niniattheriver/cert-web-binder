/**
 * 지침서 업로드 파이프라인 + 재앵커링 v1 적용 — 설계서 §3.1, §3.4(v1 최소), API 계약 POST /api/docs
 *
 * 순서: 검증(암호화/손상은 extract.ts 예외) → 추출(기존 extract.ts) → NFC(추출기 내장) →
 *       page_text(+start_offset 누적) → 저밀도 페이지 text_warning → FTS(kind='page_text').
 * 파일은 내용주소 저장(data/files/sha256/..). 동일 (documentId, sha256, 연도) 재업로드는
 * 무동작(중복 안내) — 같은 파일이라도 다른 연도로 올리면 그 연도 판본을 새로 만든다
 * (연도 탭에 문서가 보여야 하므로. 내용이 같으니 재앵커링은 전건 정확 일치 → resolved_auto).
 * documentId 지정 시 새 판본: 직전 판본 supersede + 재앵커링 v1(정확 1건만 auto, 나머지 needs_review).
 * 구판 앵커 행은 그대로 보존(historical) — 아무것도 버리지 않고, 조용히 넘어가지 않는다(§3.4).
 *
 * 비동기 작업(추출·geometry)은 전부 트랜잭션 밖에서 끝내고, DB 쓰기는 단일 동기 트랜잭션.
 *
 * PDF 외 형식(설계서 §3.5): 파일 내용으로 형식을 정해(office/detect.ts) Word, Excel,
 * PowerPoint, 한글(hwpx), 텍스트는 형식별 추출기(office/index.ts)가 논리 쪽 글자와 렌더 모델을 함께
 * 만든다. 그 뒤 page_text, FTS, 재앵커링은 PDF 와 같은 길을 탄다. 좌표(rects)는 PDF 판본에만 있다.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { logChange } from '../db/change-log.js';
import { detectFileKind } from '../office/detect.js';
import { extractOfficeIsolated, gzipRender, RENDER_MODEL_VERSION } from '../office/index.js';
import type { FileKind, RenderModel } from '../office/model.js';
import { extractPdfPages } from '../pdf/extract.js';
import {
  buildPageOffsets,
  fullTextOf,
  rangeToPageRanges,
  type PageOffsetEntry,
} from '../pdf/offsets.js';
import { computePageGeometries, rectsForLocalRange, type PageGeometry } from './geometry.js';
import { buildCellIndex, quoteCells, type CellIndex } from './cells.js';
import { planReanchor, type OldAnchorInput, type ReanchorPlanItem } from './reanchor.js';
import { contentPath, extForKind, saveContentAddressed, sha256Hex } from './store.js';

type DB = Database.Database;

const require = createRequire(import.meta.url);
const PDFJS_VERSION = (require('pdfjs-dist/package.json') as { version: string }).version;
/** 추출기 라벨 — pdfjs 메이저 갱신 시 재추출·재검증 트리거의 기준 (§3.4) */
export const EXTRACTOR_LABEL = `pdfjs-${PDFJS_VERSION}`;
export const CANON_NORM = 'nfc-v1';
/** §3.1-5 저밀도 판정: 공백 제외 문자수가 이 값 미만이면 스캔 혼입 의심 페이지 */
export const LOW_DENSITY_MIN_CHARS = 40;
/** 앵커 문맥(prefix/suffix) 길이 (§2 passage_anchor) */
const CONTEXT_LEN = 64;

export class DocumentNotFoundError extends Error {
  constructor(documentId: number) {
    super(`문서를 찾을 수 없습니다: ${documentId}`);
    this.name = 'DocumentNotFoundError';
  }
}

export class DuplicateVersionLabelError extends Error {
  constructor(label: string) {
    super(`이미 있는 버전 이름입니다: ${label}`);
    this.name = 'DuplicateVersionLabelError';
  }
}

export class DuplicateCodeError extends Error {
  constructor(code: string) {
    super(`이미 존재하는 문서 코드입니다: ${code}`);
    this.name = 'DuplicateCodeError';
  }
}

export interface UploadGuidelineInput {
  buffer: Uint8Array;
  fileName: string;
  title?: string | null;
  versionLabel: string;
  code?: string | null;
  documentId?: number | null;
  kind?: 'manual' | 'question_source';
  /** 판본 연도 태그(④) — 미지정 시 업로드한 해(로컬). 판본 사슬은 연도와 무관하게 유지 */
  year?: number | null;
  userId: number | null;
  /** data/files 절대 경로 */
  filesDir: string;
}

/** 업로드 결과 안내: PDF 외 형식에서 상한에 걸렸거나 글자가 없을 때 */
const EMPTY_TEXT_WARNING =
  '문서에서 글자를 찾지 못했습니다(그림 위주 문서일 수 있습니다). 미리보기는 되지만 검색과 근거 연결은 할 수 없습니다.';

export interface ReanchorSummary {
  auto: number;
  needsReview: number;
}

export type UploadGuidelineResult =
  | { duplicate: true; documentId: number; versionId: number }
  | {
      duplicate: false;
      documentId: number;
      versionId: number;
      pageCount: number;
      year: number;
      textWarning: string | null;
      reanchor: ReanchorSummary | null;
      /** 판본 원본 형식 */
      fileKind: FileKind;
      /** 첫 쪽의 이름표. 화면이 쪽 수의 단위를 고르는 데 쓴다 (쪽 정보가 없는 docx 는 '구간 1', csv 는 시트 이름) */
      firstPageLabel: string | null;
    };

interface PrevVersionRow {
  id: number;
  version_label: string;
  file_kind: string;
  file_name: string;
}

interface OldAnchorRow {
  id: number;
  passage_id: number;
  quote_exact: string;
  quote_prefix: string | null;
  quote_suffix: string | null;
  /** 이관 대상 조회에서만 읽는다 (확인 필요로 옮겨진 앵커는 NULL) */
  start_offset?: number | null;
  end_offset?: number | null;
  geometry_primary: number;
  status: string;
}

/** 시트 판본(xlsx, xls, csv, tsv)인가: 재앵커링에서 줄바꿈도 행 경계로 지키고 칸 단위로 맞춘다 (reanchor.ts) */
function isSheetVersion(fileKind: string, fileName: string): boolean {
  return fileKind === 'xlsx' || (fileKind === 'text' && /\.(csv|tsv)$/i.test(fileName));
}

/** 쪽 번호 → 그 쪽의 전문 시작 오프셋 */
function pageStartOf(entries: { pageNo: number; startOffset: number }[]): (pageNo: number) => number | undefined {
  const m = new Map(entries.map((e) => [e.pageNo, e.startOffset]));
  return (pageNo) => m.get(pageNo);
}

type VersionCells = { kind: 'cells'; full: string; cells: CellIndex } | { kind: 'none' } | { kind: 'unknown' };

/**
 * 판본 id → 그 판본의 전문과 표 칸 색인(재연결 칸 판정용, 한 업로드 안에서 판본마다 한 번만 읽는다).
 * PDF 는 칸 구조가 없어 'none', PDF 외 판본인데 렌더 모델을 읽지 못하면 'unknown'.
 */
function versionCellsLoader(db: DB): (versionId: number) => VersionCells {
  const cache = new Map<number, VersionCells>();
  return (versionId) => {
    const hit = cache.get(versionId);
    if (hit) return hit;
    let out: VersionCells = { kind: 'unknown' };
    const kind = (db.prepare('SELECT file_kind FROM document_version WHERE id = ?').get(versionId) as { file_kind: string } | undefined)
      ?.file_kind;
    if (kind === 'pdf') out = { kind: 'none' };
    else if (kind) {
      const row = db.prepare('SELECT json_gz FROM document_render WHERE document_version_id = ?').get(versionId) as
        | { json_gz: Buffer }
        | undefined;
      if (row) {
        try {
          const entries = buildPageOffsets(
            db
              .prepare('SELECT page_no AS pageNo, text FROM page_text WHERE document_version_id = ? ORDER BY page_no')
              .all(versionId) as { pageNo: number; text: string }[],
          );
          const full = fullTextOf(entries);
          const model = JSON.parse(zlib.gunzipSync(row.json_gz).toString('utf8')) as RenderModel;
          out = { kind: 'cells', full, cells: buildCellIndex(model, full, pageStartOf(entries)) };
        } catch {
          out = { kind: 'unknown' };
        }
      }
    }
    cache.set(versionId, out);
    return out;
  };
}

export async function uploadGuideline(
  db: DB,
  input: UploadGuidelineInput,
): Promise<UploadGuidelineResult> {
  const sha256 = sha256Hex(input.buffer);
  const now = new Date().toISOString();
  const year = input.year ?? new Date().getFullYear();

  // 대상 문서 확인 + (documentId, sha256, 연도) 중복 제거 — §3.1-1 "동일 sha256 재업로드는
  // 무동작"은 요청 연도까지 같을 때만이다. 같은 파일을 다른 연도로 올리면 새 판본을 만든다 —
  // 안 그러면 무변경 지침서를 새해 연도로 올려도 조용히 무동작되어 그 연도 탭에 영영 안 보인다.
  let existingDocId: number | null = null;
  if (input.documentId != null) {
    const doc = db
      .prepare('SELECT id FROM document WHERE id = ? AND deleted_at IS NULL')
      .get(input.documentId) as { id: number } | undefined;
    if (!doc) throw new DocumentNotFoundError(input.documentId);
    existingDocId = doc.id;
    const dup = db
      .prepare(
        `SELECT id FROM document_version
         WHERE document_id = ? AND file_sha256 = ? AND year = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(existingDocId, sha256, year) as { id: number } | undefined;
    if (dup) return { duplicate: true, documentId: existingDocId, versionId: dup.id };
  }

  // 형식 판별(내용 기준). 지원하지 않는 형식은 UnsupportedFormatError (라우트에서 400 매핑)
  const detected = detectFileKind(input.buffer, input.fileName);
  const fileKind: FileKind = detected.kind;

  // 추출. PDF: 암호화 → EncryptedPdfError, 손상 → InvalidPdfError (라우트에서 400 매핑).
  //   pdfjs가 버퍼 소유권을 가져갈 수 있으므로 복사본을 넘긴다.
  // 그 외 형식: 형식별 추출기가 논리 쪽 글자 + 렌더 모델을 함께 만든다. 못 읽으면 OfficeParseError.
  let pageInputs: { pageNo: number; text: string; label: string | null }[];
  let extractor: string;
  let textWarning: string | null;
  let renderGz: Buffer | null = null;
  let newRender: Buffer | null = null; // PDF 외 판본의 렌더 모델 JSON (재연결 칸 판정용)
  if (fileKind === 'pdf') {
    const pdfPages = await extractPdfPages(new Uint8Array(input.buffer));
    pageInputs = pdfPages.map((p) => ({ pageNo: p.pageNo, text: p.text, label: null }));
    extractor = EXTRACTOR_LABEL;
    // §3.1-5 위생 점검: 저밀도(스캔 혼입 의심) 페이지. 스캔 PDF 전용 규칙이라 다른 형식에는 쓰지 않는다
    const lowDensityPages = pdfPages
      .filter((p) => p.charCount < LOW_DENSITY_MIN_CHARS)
      .map((p) => p.pageNo);
    textWarning =
      lowDensityPages.length > 0
        ? `글자가 거의 없는 쪽(스캔한 쪽일 수 있음): ${lowDensityPages.join(', ')}`
        : null;
  } else {
    const buf = Buffer.isBuffer(input.buffer)
      ? input.buffer
      : Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength);
    const office = await extractOfficeIsolated(detected, buf, input.fileName); // 작업 스레드에서 (jobs/isolated.ts)
    pageInputs = office.pages;
    extractor = office.extractor;
    newRender = office.render;
    renderGz = gzipRender(office.render);
    const hasText = office.pages.some((p) => p.text.trim().length > 0);
    textWarning = office.truncated ?? (hasText ? null : EMPTY_TEXT_WARNING);
  }
  // 판본마다 page_text 는 최소 1행 (pdf/offsets.ts 계약: 빈 목록이면 오프셋 변환이 실패한다)
  if (pageInputs.length === 0) pageInputs = [{ pageNo: 1, text: '', label: null }];
  const entries = buildPageOffsets(pageInputs.map((p) => ({ pageNo: p.pageNo, text: p.text })));
  const labelByPage = new Map(pageInputs.map((p) => [p.pageNo, p.label]));
  const fullText = fullTextOf(entries);

  // 재앵커링 v1 준비 — 직전 현재판본의 이관 대상 앵커 분류 + auto건 rects 재계산(비동기, 트랜잭션 밖).
  // resolved* 뿐 아니라 needs_review/unresolved 도 포함 — 미해결 상태에서 연속 개정해도
  // 추적이 새 판본으로 이어져야 §2 첫 불변식("비-obsolete 연결 passage는 현재 판본에 앵커 존재,
  // 상태 불문")이 유지된다. 신판에서 정확 1건 일치하면 자동 복구(resolved_auto).
  let prev: PrevVersionRow | null = null;
  let plan: ReanchorPlanItem[] = [];
  const autoRects = new Map<number, string | null>(); // anchorId → rects_json (재계산 실패 시 null)
  const autoPages = new Map<number, { pageStart: number; pageEnd: number }>();
  if (existingDocId != null) {
    prev =
      (db
        .prepare(
          'SELECT id, version_label, file_kind, file_name FROM document_version WHERE document_id = ? AND is_current = 1',
        )
        .get(existingDocId) as PrevVersionRow | undefined) ?? null;
    if (prev) {
      const oldAnchors = db
        .prepare(
          `SELECT pa.id, pa.passage_id, pa.quote_exact, pa.quote_prefix, pa.quote_suffix,
                  pa.start_offset, pa.end_offset, pa.geometry_primary, pa.status
           FROM passage_anchor pa
           JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL AND p.obsolete = 0
           WHERE pa.document_version_id = ?
             AND pa.status IN ('resolved','resolved_auto','resolved_fuzzy',
                               'needs_review','unresolved')
           ORDER BY pa.id`,
        )
        .all(prev.id) as OldAnchorRow[];
      // 옛 인용과 표 칸의 관계(reanchor.ts 머리 주석): 그 인용의 위치가 있는 마지막 앵커의 판본 글자와 렌더 모델로 구한다.
      // 지금 판본에 위치가 있으면 그것을, 확인 필요로 옮겨져 위치가 없으면 같은 발췌가 위치를 가졌던 마지막 판본을 본다.
      // 위치를 찾지 못하거나 렌더 모델이 없으면 'unknown'(자동으로 정하지 않는다). PDF 는 칸 구조가 없다('none').
      const versionCells = versionCellsLoader(db);
      const lastPlaced = db.prepare(
        `SELECT document_version_id AS versionId, start_offset AS s, end_offset AS e FROM passage_anchor
         WHERE passage_id = ? AND quote_exact = ? AND start_offset IS NOT NULL AND end_offset IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      );
      const planInputs: OldAnchorInput[] = oldAnchors.map((a) => {
        const placed =
          a.start_offset != null && a.end_offset != null
            ? { versionId: prev!.id, s: a.start_offset, e: a.end_offset }
            : (lastPlaced.get(a.passage_id, a.quote_exact) as { versionId: number; s: number; e: number } | undefined);
        let cells: OldAnchorInput['cells'] = 'unknown';
        if (placed) {
          const v = versionCells(placed.versionId);
          if (v.kind === 'cells') cells = quoteCells(v.cells, v.full, placed.s, placed.e);
          else if (v.kind === 'none') cells = 'none';
        }
        return {
          anchorId: a.id,
          passageId: a.passage_id,
          quoteExact: a.quote_exact,
          geometryPrimary: a.geometry_primary === 1,
          cells,
        };
      });
      const newCells =
        newRender != null && planInputs.length > 0
          ? buildCellIndex(JSON.parse(newRender.toString('utf8')) as RenderModel, fullText, pageStartOf(entries))
          : null;
      plan = planReanchor(planInputs, fullText, { sheet: isSheetVersion(fileKind, input.fileName), cells: newCells });

      // auto 건들의 페이지 범위 → 필요한 페이지 geometry만 재추출
      const neededPages = new Set<number>();
      const autoRanges = new Map<number, ReturnType<typeof rangeToPageRanges>>();
      for (const item of plan) {
        if (item.decision.kind !== 'auto') continue;
        const ranges = rangeToPageRanges(entries, item.decision.startOffset, item.decision.endOffset);
        autoRanges.set(item.anchor.anchorId, ranges);
        for (const r of ranges) neededPages.add(r.pageNo);
      }
      let geoms = new Map<number, PageGeometry>();
      // 좌표(rects)는 PDF 판본에만 있다. 다른 형식은 오프셋으로 화면이 위치를 다시 찾는다
      if (fileKind === 'pdf' && neededPages.size > 0) {
        try {
          geoms = await computePageGeometries(new Uint8Array(input.buffer), [...neededPages]);
        } catch {
          geoms = new Map(); // rects는 파생 캐시 — 실패해도 앵커 자체는 성립
        }
      }
      const pageTextByNo = new Map<number, PageOffsetEntry>(entries.map((e) => [e.pageNo, e]));
      for (const item of plan) {
        if (item.decision.kind !== 'auto') continue;
        const ranges = autoRanges.get(item.anchor.anchorId) ?? [];
        if (ranges.length === 0) {
          autoRects.set(item.anchor.anchorId, null);
          continue;
        }
        autoPages.set(item.anchor.anchorId, {
          pageStart: ranges[0]!.pageNo,
          pageEnd: ranges[ranges.length - 1]!.pageNo,
        });
        if (fileKind !== 'pdf') {
          autoRects.set(item.anchor.anchorId, null);
          continue;
        }
        let ok = true;
        const rectsByPage: { page: number; rects: [number, number, number, number][] }[] = [];
        for (const r of ranges) {
          const geom = geoms.get(r.pageNo);
          // 아이템 단위 재현 텍스트가 저장 page_text와 다르면(경계 NFC 등) rects 포기 — 조용한 오표시 방지
          if (!geom || geom.text !== pageTextByNo.get(r.pageNo)?.text) {
            ok = false;
            break;
          }
          rectsByPage.push({ page: r.pageNo, rects: rectsForLocalRange(geom, r.start, r.end) });
        }
        autoRects.set(item.anchor.anchorId, ok ? JSON.stringify(rectsByPage) : null);
      }
    }
  }

  // 파일 저장(내용주소) — 트랜잭션 밖 (DB 실패 시 고아 파일은 무해: 내용주소라 재업로드가 재사용)
  saveContentAddressed(input.filesDir, sha256, input.buffer, extForKind(fileKind));

  // 단일 동기 트랜잭션: 문서/판본/page_text/FTS/재앵커링/change_log
  const run = db.transaction((): UploadGuidelineResult => {
    let documentId = existingDocId;
    if (documentId == null) {
      const code = input.code?.trim() || null;
      if (code) {
        const codeDup = db
          .prepare('SELECT id FROM document WHERE code = ?')
          .get(code) as { id: number } | undefined;
        if (codeDup) throw new DuplicateCodeError(code);
      }
      const info = db
        .prepare('INSERT INTO document (code, title, kind) VALUES (?, ?, ?)')
        .run(code, input.title ?? input.fileName, input.kind ?? 'manual');
      documentId = Number(info.lastInsertRowid);
      logChange(db, {
        actorId: input.userId,
        entity: 'document',
        entityId: documentId,
        action: 'create',
        after: { code, title: input.title ?? input.fileName, kind: input.kind ?? 'manual' },
      });
    }

    const labelDup = db
      .prepare('SELECT id FROM document_version WHERE document_id = ? AND version_label = ?')
      .get(documentId, input.versionLabel) as { id: number } | undefined;
    if (labelDup) throw new DuplicateVersionLabelError(input.versionLabel);

    // 직전 판본 supersede + is_current 이관
    if (prev) {
      db.prepare(
        "UPDATE document_version SET status = 'superseded', is_current = 0 WHERE id = ? AND is_current = 1",
      ).run(prev.id);
      logChange(db, {
        actorId: input.userId,
        entity: 'document_version',
        entityId: prev.id,
        action: 'supersede',
        before: { status: 'active', isCurrent: true },
        after: { status: 'superseded', isCurrent: false, supersededBy: input.versionLabel },
      });
    }

    const vInfo = db
      .prepare(
        `INSERT INTO document_version
           (document_id, version_label, file_sha256, file_name, file_size, page_count,
            extractor, canon_norm, status, is_current, text_warning, uploaded_by, uploaded_at, year,
            file_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        input.versionLabel,
        sha256,
        input.fileName,
        input.buffer.byteLength,
        entries.length,
        extractor,
        CANON_NORM,
        textWarning,
        input.userId,
        now,
        year,
        fileKind,
      );
    const versionId = Number(vInfo.lastInsertRowid);

    // page_text + FTS(kind='page_text', ref_id=page_text rowid) — 트리거 아닌 서비스 코드 유지(§2)
    const insertPage = db.prepare(
      'INSERT INTO page_text (document_version_id, page_no, start_offset, text, label) VALUES (?, ?, ?, ?, ?)',
    );
    const insertFts = db.prepare("INSERT INTO fts (kind, ref_id, content) VALUES ('page_text', ?, ?)");
    for (const e of entries) {
      const pInfo = insertPage.run(versionId, e.pageNo, e.startOffset, e.text, labelByPage.get(e.pageNo) ?? null);
      insertFts.run(Number(pInfo.lastInsertRowid), e.text);
    }

    // PDF 외 형식: 같은 해석에서 만든 렌더 모델을 판본과 함께 불변 저장
    if (renderGz) {
      db.prepare(
        `INSERT INTO document_render (document_version_id, model_version, extractor, json_gz, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(versionId, RENDER_MODEL_VERSION, extractor, renderGz, now);
    }

    logChange(db, {
      actorId: input.userId,
      entity: 'document_version',
      entityId: versionId,
      action: 'create',
      after: {
        documentId,
        versionLabel: input.versionLabel,
        sha256,
        fileName: input.fileName,
        fileKind,
        pageCount: entries.length,
        year,
        textWarning,
      },
    });

    // 재앵커링 v1 적용 — 전이는 전부 새 앵커 행 + change_log (구판 행은 그대로 = historical 보존)
    let reanchor: ReanchorSummary | null = null;
    if (prev) {
      reanchor = { auto: 0, needsReview: 0 };
      const insertAnchor = db.prepare(
        `INSERT INTO passage_anchor
           (passage_id, document_version_id, quote_exact, quote_prefix, quote_suffix,
            start_offset, end_offset, page_start, page_end, rects_json, geometry_primary,
            status, method, confidence, resolved_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const oldById = new Map(
        (
          db
            .prepare(
              `SELECT id, quote_exact, quote_prefix, quote_suffix, geometry_primary, status
               FROM passage_anchor WHERE document_version_id = ?`,
            )
            .all(prev.id) as OldAnchorRow[]
        ).map((r) => [r.id, r]),
      );
      for (const item of plan) {
        const old = oldById.get(item.anchor.anchorId);
        if (!old) continue;
        let newId: number;
        if (item.decision.kind === 'auto') {
          const { startOffset, endOffset } = item.decision;
          const pagesOf = autoPages.get(item.anchor.anchorId);
          const info = insertAnchor.run(
            item.anchor.passageId,
            versionId,
            old.quote_exact,
            fullText.slice(Math.max(0, startOffset - CONTEXT_LEN), startOffset) || null,
            fullText.slice(endOffset, endOffset + CONTEXT_LEN) || null,
            startOffset,
            endOffset,
            pagesOf?.pageStart ?? null,
            pagesOf?.pageEnd ?? null,
            autoRects.get(item.anchor.anchorId) ?? null,
            fileKind === 'pdf' ? old.geometry_primary : 0, // 박스 앵커는 PDF 에만 있다
            'resolved_auto',
            'exact',
            1.0,
            null, // 시스템 자동 해결 — 사람 확인자는 없음
            now,
          );
          newId = Number(info.lastInsertRowid);
          reanchor.auto++;
        } else {
          const info = insertAnchor.run(
            item.anchor.passageId,
            versionId,
            old.quote_exact,
            old.quote_prefix,
            old.quote_suffix,
            null,
            null,
            null,
            null,
            null, // rects NULL — 계약
            fileKind === 'pdf' ? old.geometry_primary : 0,
            'needs_review',
            null,
            null,
            null,
            null,
          );
          newId = Number(info.lastInsertRowid);
          reanchor.needsReview++;
        }
        logChange(db, {
          actorId: input.userId,
          entity: 'passage_anchor',
          entityId: newId,
          action: 'reanchor',
          before: {
            fromAnchorId: item.anchor.anchorId,
            fromVersionId: prev.id,
            status: old.status,
          },
          after: {
            toVersionId: versionId,
            status: item.decision.kind === 'auto' ? 'resolved_auto' : 'needs_review',
            reason: item.decision.kind === 'auto' ? 'exact_unique' : item.decision.reason,
          },
        });
      }
    }

    return {
      duplicate: false,
      documentId: documentId!,
      versionId,
      pageCount: entries.length,
      year,
      textWarning,
      reanchor,
      fileKind,
      firstPageLabel: pageInputs[0]?.label ?? null,
    };
  });

  return run();
}

/** 판본 원본 파일 절대 경로 (스트리밍용). 파일이 없으면 null. */
export function versionFilePath(
  filesDir: string,
  sha256: string,
  fileKind: string | null = 'pdf',
): string | null {
  const p = contentPath(filesDir, sha256, extForKind(fileKind));
  return fs.existsSync(p) ? p : null;
}
