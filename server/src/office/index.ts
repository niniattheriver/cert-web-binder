/**
 * PDF 외 형식 추출 입구
 *
 * detectFileKind 가 정한 형식에 맞는 추출기를 불러 OfficeExtractResult 를 돌려준다.
 * 추출기는 page_text(정본)와 렌더 모델을 한 번의 해석에서 함께 만든다(model.ts 정합 원칙).
 * 형식별 모듈은 그 형식을 처음 올릴 때 불러온다(서버 기동 시간과 메모리를 아끼기 위함).
 * 구형 바이너리(doc, xls, hwp)는 같은 계열의 kind 로 오고 detected.legacy 로 추출기를 고른다.
 * 요청 처리(업로드, 첨부 미리보기)는 extractOfficeIsolated 로 작업 스레드에서 돌린다(jobs/isolated.ts).
 * 그림(image)은 해석할 것이 없어(글자를 읽지 않는다) 업로드가 작업 스레드 없이 extractOffice 를 바로 부른다.
 */
import zlib from 'node:zlib';
import { IsolatedBusyError, IsolatedMemoryError, IsolatedTimeoutError, runIsolated } from '../jobs/isolated.js';
import type { DetectedFile } from './detect.js';
import { OfficeLimitError, OfficeParseError } from './errors.js';
import { processImage } from './image.js';
import { RENDER_MODEL_VERSION, type OfficeExtractResult } from './model.js';
import { processText } from './text.js';

export { RENDER_MODEL_VERSION };

/** 파일 하나를 해석하는 시간 상한. 정상 파일은 길어야 수십 초다(상한에 걸린 큰 시트도 잘라 읽는다) */
export const OFFICE_PARSE_TIMEOUT_MS = 120_000;
/** 해석 스레드의 메모리 상한(MB). 시트 XML 상한(80MB)을 ExcelJS 가 10~15배로 늘려 읽어도 들어가는 크기 */
export const OFFICE_PARSE_MAX_HEAP_MB = 2048;

/** 형식별 추출기 실행. PDF 는 여기로 오지 않는다(기존 pdf.js 경로). */
export async function extractOffice(
  detected: DetectedFile,
  buf: Buffer,
  fileName: string,
): Promise<OfficeExtractResult> {
  switch (detected.kind) {
    case 'docx': {
      if (detected.legacy === 'doc') {
        const { processDoc } = await import('./legacy/doc.js');
        return processDoc(buf, fileName);
      }
      const { processDocx } = await import('./docx/index.js');
      return processDocx(buf, fileName);
    }
    case 'xlsx': {
      if (detected.legacy === 'xls') {
        const { processXls } = await import('./legacy/xls.js');
        return processXls(buf, fileName);
      }
      const { processXlsx } = await import('./xlsx.js');
      return processXlsx(buf, fileName);
    }
    case 'pptx': {
      const { processPptx } = await import('./pptx.js');
      return processPptx(buf, fileName);
    }
    case 'hwpx': {
      if (detected.legacy === 'hwp') {
        const { processHwp } = await import('./legacy/hwp.js');
        return processHwp(buf, fileName);
      }
      const { processHwpx } = await import('./hwpx.js');
      return processHwpx(buf, fileName);
    }
    case 'text':
      return processText(buf, detected.textFormat ?? 'txt', fileName);
    case 'image':
      // 글자를 읽지 않는다(OCR 없음): 빈 1쪽과 그림 한 장을 가리키는 모델
      if (!detected.imageMime) throw new OfficeParseError('그림 형식을 확인하지 못했습니다.');
      return processImage(detected.imageMime);
    case 'pdf':
      throw new Error('PDF는 extractOffice 대상이 아닙니다.');
  }
}

/** 작업 스레드 쪽 입구: 스레드로 건너오면 Buffer 가 Uint8Array 가 되므로 되돌려 extractOffice 를 부른다 */
export async function extractOfficeFromBytes(
  detected: DetectedFile,
  bytes: Uint8Array,
  fileName: string,
): Promise<OfficeExtractResult> {
  return extractOffice(detected, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), fileName);
}

/**
 * 요청 처리용 추출: extractOffice 를 작업 스레드에서 돌린다. 해석이 오래 걸리거나 메모리를 많이 써도 서버의 다른
 * 요청은 멈추지 않고, 상한을 넘기면 그 파일만 OfficeParseError(라우트에서 400) 로 끝난다.
 */
export async function extractOfficeIsolated(
  detected: DetectedFile,
  buf: Buffer,
  fileName: string,
): Promise<OfficeExtractResult> {
  try {
    const r = await runIsolated<OfficeExtractResult>(
      new URL(import.meta.url),
      'extractOfficeFromBytes',
      [detected, buf, fileName],
      { timeoutMs: OFFICE_PARSE_TIMEOUT_MS, maxOldGenerationSizeMb: OFFICE_PARSE_MAX_HEAP_MB },
      (e) => (e.name === 'OfficeParseError' ? new OfficeParseError(e.message) : undefined),
    );
    return { ...r, render: Buffer.from(r.render.buffer, r.render.byteOffset, r.render.byteLength) };
  } catch (e) {
    throw toOfficeLimit(e) ?? e;
  }
}

/** 작업 스레드의 시간, 메모리, 대기 줄 오류 → 사용자용 OfficeLimitError. 다른 오류면 null */
export function toOfficeLimit(e: unknown): OfficeLimitError | null {
  if (e instanceof OfficeLimitError) return e;
  if (e instanceof IsolatedTimeoutError) {
    return new OfficeLimitError(
      `파일을 읽는 데 ${Math.round(OFFICE_PARSE_TIMEOUT_MS / 60_000)}분이 넘게 걸려 멈췄습니다. 파일이 손상되지 않았는지 확인하고, 필요한 부분만 남겨 다시 올려 주세요.`,
      'timeout',
    );
  }
  if (e instanceof IsolatedMemoryError) {
    return new OfficeLimitError('파일이 너무 커서 읽지 못했습니다. 필요한 부분만 남기거나 나눠서 다시 올려 주세요.', 'memory');
  }
  if (e instanceof IsolatedBusyError) {
    return new OfficeLimitError('지금 다른 파일을 여럿 읽고 있어 이 파일을 받지 못했습니다. 잠시 뒤 다시 올려 주세요.', 'busy');
  }
  return null;
}

/** 렌더 모델 JSON → DB 보관용 gzip */
export function gzipRender(render: Buffer): Buffer {
  return zlib.gzipSync(render, { level: 9 });
}
