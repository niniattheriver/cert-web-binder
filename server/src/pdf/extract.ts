// 서버측 PDF 텍스트 추출 — 설계서 §3.1-2
// pdfjs-dist **legacy Node 빌드** 사용(클라이언트 뷰어와 동일 엔진·동일 버전 4.10.38).
// cMaps/standard_fonts는 node_modules 내 pdfjs-dist 동봉 자산을 로컬 경로로 지정(런타임 인터넷 0).
// 줄 구성: item.hasEOL + transform Y 변화로만 줄바꿈 판단(간격 기반 공백 추정은 과설계 — 하지 않음).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api.js';
import { normalizeText } from './normalize.js';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;

export interface PageText {
  pageNo: number; // 1-기준
  text: string; // 정규화(NFC·제로폭 제거·\n 통일)된 페이지 전체 텍스트
  charCount: number; // 공백 제외 문자수 — §3.1-5 텍스트 밀도(스캔 혼입) 위생 점검용
}

/** 암호화/열람제한 PDF — 즉시 거부용 명확한 에러 (§3.1-1) */
export class EncryptedPdfError extends Error {
  constructor() {
    super('암호화(열람제한)된 PDF입니다. 암호를 해제한 PDF로 다시 업로드하세요.');
    this.name = 'EncryptedPdfError';
  }
}

/** 파싱 불가(손상 등) PDF — 거부 + 원인 표시용 */
export class InvalidPdfError extends Error {
  constructor(cause: string) {
    super(`PDF를 해석할 수 없습니다(손상 가능성): ${cause}`);
    this.name = 'InvalidPdfError';
  }
}

function isTextItem(it: TextItem | TextMarkedContent): it is TextItem {
  return typeof (it as TextItem).str === 'string';
}

/** 같은 줄로 간주할 Y 좌표 허용 오차(pt) */
const SAME_LINE_Y_TOLERANCE = 2;

/**
 * PDF 파일(경로 또는 버퍼) → 페이지별 정규화 텍스트.
 * 암호화 PDF는 EncryptedPdfError, 손상 PDF는 InvalidPdfError로 거부.
 */
export async function extractPdfPages(input: string | Uint8Array): Promise<PageText[]> {
  const data = typeof input === 'string' ? new Uint8Array(fs.readFileSync(input)) : input;
  let pdf;
  try {
    pdf = await getDocument({
      data,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: false,
    }).promise;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === 'PasswordException') throw new EncryptedPdfError();
    throw new InvalidPdfError(e?.message ?? String(err));
  }
  try {
    const pages: PageText[] = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const tc = await page.getTextContent();
      const lines: string[] = [];
      let current = '';
      let currentY: number | null = null;
      let pendingEOL = false;
      for (const raw of tc.items) {
        if (!isTextItem(raw)) continue;
        const y = raw.transform[5] as number;
        const newLineByY = currentY !== null && Math.abs(y - currentY) > SAME_LINE_Y_TOLERANCE;
        if ((pendingEOL || newLineByY) && current.length > 0) {
          lines.push(current);
          current = '';
        }
        pendingEOL = false;
        if (raw.str.length > 0) {
          current += raw.str;
          currentY = y;
        }
        if (raw.hasEOL) pendingEOL = true;
      }
      if (current.length > 0) lines.push(current);
      const text = normalizeText(lines.join('\n'));
      pages.push({ pageNo, text, charCount: text.replace(/\s/g, '').length });
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}
