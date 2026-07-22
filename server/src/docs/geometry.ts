/**
 * 앵커 rects 재계산용 페이지 geometry — 설계서 §3.1-4, §3.4-3단계
 * 아이템 geometry는 DB에 저장하지 않으므로(비대) 재앵커링 시 PDF에서 재추출해
 * rects_json([{page, rects:[[x0,y0,x1,y1],…]}], 페이지 크기 대비 0..1 정규화, 좌상단 원점)을 캐시한다.
 *
 * 텍스트 구성은 pdf/extract.ts와 동일 규칙(hasEOL·Y 변화 줄바꿈, 줄 '\n' 연결)을 아이템 단위로
 * 재현하되 각 아이템의 정규화 텍스트 구간(span)을 기록한다. 아이템별 NFC와 전체 NFC가 경계에서
 * 어긋나는 희귀 케이스에 대비해 호출측(service)이 재현 텍스트 == 저장 page_text 를 검증하고,
 * 불일치 페이지는 rects 없이(null) 진행한다 — rects는 3순위 파생 캐시일 뿐이다(§2).
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api.js';
import { normalizeText } from '../pdf/normalize.js';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;

/** extract.ts와 동일한 같은 줄 Y 허용 오차(pt) — 두 파일이 항상 같은 값이어야 한다 */
const SAME_LINE_Y_TOLERANCE = 2;

function isTextItem(it: TextItem | TextMarkedContent): it is TextItem {
  return typeof (it as TextItem).str === 'string';
}

export interface ItemSpan {
  start: number; // 페이지 정규화 텍스트 내 시작 오프셋
  end: number; // exclusive
  x0: number; // 0..1 정규화 (좌상단 원점)
  y0: number;
  x1: number;
  y1: number;
}

export interface PageGeometry {
  pageNo: number;
  /** 아이템 단위로 재현한 정규화 페이지 텍스트 — 저장 page_text와 대조용 */
  text: string;
  spans: ItemSpan[];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * 지정 페이지들의 아이템 span+사각형을 추출한다.
 * 반환 Map에는 요청 페이지 전부가 들어간다(추출 실패 페이지는 누락될 수 있음 — 호출측 fallback).
 */
export async function computePageGeometries(
  data: Uint8Array,
  pageNos: number[],
): Promise<Map<number, PageGeometry>> {
  const result = new Map<number, PageGeometry>();
  if (pageNos.length === 0) return result;
  const pdf = await getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useSystemFonts: false,
  }).promise;
  try {
    for (const pageNo of [...new Set(pageNos)].sort((a, b) => a - b)) {
      if (pageNo < 1 || pageNo > pdf.numPages) continue;
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();

      // extract.ts와 동일한 줄 구성 — 단, 아이템 조각과 사각형을 함께 축적
      interface Piece {
        norm: string;
        rect: [number, number, number, number]; // 뷰포트 0..1, 좌상단 원점
      }
      const lines: Piece[][] = [];
      let current: Piece[] = [];
      let currentLen = 0;
      let currentY: number | null = null;
      let pendingEOL = false;
      for (const raw of tc.items) {
        if (!isTextItem(raw)) continue;
        const y = raw.transform[5] as number;
        const newLineByY = currentY !== null && Math.abs(y - currentY) > SAME_LINE_Y_TOLERANCE;
        if ((pendingEOL || newLineByY) && currentLen > 0) {
          lines.push(current);
          current = [];
          currentLen = 0;
        }
        pendingEOL = false;
        if (raw.str.length > 0) {
          current.push({ norm: normalizeText(raw.str), rect: itemRect(raw, viewport) });
          currentLen += raw.str.length;
          currentY = y;
        }
        if (raw.hasEOL) pendingEOL = true;
      }
      if (currentLen > 0) lines.push(current);

      let text = '';
      const spans: ItemSpan[] = [];
      for (let li = 0; li < lines.length; li++) {
        if (li > 0) text += '\n';
        for (const piece of lines[li]!) {
          const start = text.length;
          text += piece.norm;
          if (piece.norm.length > 0) {
            spans.push({
              start,
              end: text.length,
              x0: piece.rect[0],
              y0: piece.rect[1],
              x1: piece.rect[2],
              y1: piece.rect[3],
            });
          }
        }
      }
      result.set(pageNo, { pageNo, text, spans });
    }
    return result;
  } finally {
    await pdf.destroy();
  }
}

/** TextItem → 뷰포트 기준 0..1 정규화 사각형 [x0,y0,x1,y1] (좌상단 원점) */
function itemRect(
  item: TextItem,
  viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] },
): [number, number, number, number] {
  const tx = item.transform as number[];
  const x = tx[4] ?? 0;
  const yBase = tx[5] ?? 0; // 텍스트 베이스라인
  const h = item.height || Math.hypot(tx[2] ?? 0, tx[3] ?? 0);
  const w = item.width || 0;
  const p1 = viewport.convertToViewportPoint(x, yBase + h); // 좌상
  const p2 = viewport.convertToViewportPoint(x + w, yBase); // 우하
  const vx0 = Math.min(p1[0] ?? 0, p2[0] ?? 0) / viewport.width;
  const vx1 = Math.max(p1[0] ?? 0, p2[0] ?? 0) / viewport.width;
  const vy0 = Math.min(p1[1] ?? 0, p2[1] ?? 0) / viewport.height;
  const vy1 = Math.max(p1[1] ?? 0, p2[1] ?? 0) / viewport.height;
  return [clamp01(vx0), clamp01(vy0), clamp01(vx1), clamp01(vy1)];
}

/**
 * 페이지 지역 범위 [start, end) → 정규화 사각형 목록.
 * 아이템을 부분적으로만 덮으면 가로 방향을 문자 비율로 보간(v1 근사 — 폭 균등 가정).
 */
export function rectsForLocalRange(
  geom: PageGeometry,
  start: number,
  end: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const s of geom.spans) {
    if (s.end <= start || s.start >= end) continue;
    const len = s.end - s.start;
    const f0 = (Math.max(start, s.start) - s.start) / len;
    const f1 = (Math.min(end, s.end) - s.start) / len;
    const x0 = s.x0 + (s.x1 - s.x0) * f0;
    const x1 = s.x0 + (s.x1 - s.x0) * f1;
    out.push([round4(x0), round4(s.y0), round4(x1), round4(s.y1)]);
  }
  return out;
}
