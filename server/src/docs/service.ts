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
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { logChange } from '../db/change-log.js';
import { extractPdfPages } from '../pdf/extract.js';
import {
  buildPageOffsets,
  fullTextOf,
  rangeToPageRanges,
  type PageOffsetEntry,
} from '../pdf/offsets.js';
import { computePageGeometries, rectsForLocalRange, type PageGeometry } from './geometry.js';
import { planReanchor, type OldAnchorInput, type ReanchorPlanItem } from './reanchor.js';
import { contentPath, saveContentAddressed, sha256Hex } from './store.js';

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
    super(`이미 존재하는 판 라벨입니다: ${label}`);
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
    };

interface PrevVersionRow {
  id: number;
  version_label: string;
}

interface OldAnchorRow {
  id: number;
  passage_id: number;
  quote_exact: string;
  quote_prefix: string | null;
  quote_suffix: string | null;
  geometry_primary: number;
  status: string;
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

  // 추출 (암호화 → EncryptedPdfError, 손상 → InvalidPdfError — 라우트에서 400 매핑)
  // pdfjs가 버퍼 소유권을 가져갈 수 있으므로 복사본을 넘긴다.
  const pages = await extractPdfPages(new Uint8Array(input.buffer));
  const entries = buildPageOffsets(pages.map((p) => ({ pageNo: p.pageNo, text: p.text })));
  const fullText = fullTextOf(entries);

  // §3.1-5 위생 점검: 저밀도(스캔 혼입 의심) 페이지
  const lowDensityPages = pages.filter((p) => p.charCount < LOW_DENSITY_MIN_CHARS).map((p) => p.pageNo);
  const textWarning =
    lowDensityPages.length > 0
      ? `텍스트 밀도가 낮은 페이지(스캔 혼입 의심): ${lowDensityPages.join(', ')}`
      : null;

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
          'SELECT id, version_label FROM document_version WHERE document_id = ? AND is_current = 1',
        )
        .get(existingDocId) as PrevVersionRow | undefined) ?? null;
    if (prev) {
      const oldAnchors = db
        .prepare(
          `SELECT pa.id, pa.passage_id, pa.quote_exact, pa.quote_prefix, pa.quote_suffix,
                  pa.geometry_primary, pa.status
           FROM passage_anchor pa
           JOIN passage p ON p.id = pa.passage_id AND p.deleted_at IS NULL AND p.obsolete = 0
           WHERE pa.document_version_id = ?
             AND pa.status IN ('resolved','resolved_auto','resolved_fuzzy',
                               'needs_review','unresolved')
           ORDER BY pa.id`,
        )
        .all(prev.id) as OldAnchorRow[];
      const planInputs: OldAnchorInput[] = oldAnchors.map((a) => ({
        anchorId: a.id,
        passageId: a.passage_id,
        quoteExact: a.quote_exact,
        geometryPrimary: a.geometry_primary === 1,
      }));
      plan = planReanchor(planInputs, fullText);

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
      if (neededPages.size > 0) {
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
  saveContentAddressed(input.filesDir, sha256, input.buffer);

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
            extractor, canon_norm, status, is_current, text_warning, uploaded_by, uploaded_at, year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        input.versionLabel,
        sha256,
        input.fileName,
        input.buffer.byteLength,
        pages.length,
        EXTRACTOR_LABEL,
        CANON_NORM,
        textWarning,
        input.userId,
        now,
        year,
      );
    const versionId = Number(vInfo.lastInsertRowid);

    // page_text + FTS(kind='page_text', ref_id=page_text rowid) — 트리거 아닌 서비스 코드 유지(§2)
    const insertPage = db.prepare(
      'INSERT INTO page_text (document_version_id, page_no, start_offset, text) VALUES (?, ?, ?, ?)',
    );
    const insertFts = db.prepare("INSERT INTO fts (kind, ref_id, content) VALUES ('page_text', ?, ?)");
    for (const e of entries) {
      const pInfo = insertPage.run(versionId, e.pageNo, e.startOffset, e.text);
      insertFts.run(Number(pInfo.lastInsertRowid), e.text);
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
        pageCount: pages.length,
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
            old.geometry_primary,
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
            old.geometry_primary,
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
      pageCount: pages.length,
      year,
      textWarning,
      reanchor,
    };
  });

  return run();
}

/** 판본 PDF 절대 경로 (스트리밍용). 파일이 없으면 null. */
export function versionFilePath(filesDir: string, sha256: string): string | null {
  const p = contentPath(filesDir, sha256);
  return fs.existsSync(p) ? p : null;
}
