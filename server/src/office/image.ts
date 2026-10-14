/**
 * 그림 파일(png, jpg, gif, webp, bmp) 판본: 글자를 읽지 않는다
 *
 * 근거자료 라이브러리는 사진, 스캔 그림도 받는다. OCR 은 하지 않으므로 판본의 page_text 는 빈 1쪽이고, 본문 검색에는
 * 걸리지 않는다. 문항 근거는 글자 대신 그림 전체로 연결한다(anchors/service.ts createWholeImageMapping).
 *
 * - 형식은 확장자가 아니라 앞머리 바이트로 정한다(image-sniff.ts). 브라우저가 그릴 수 있는 래스터만 받는다.
 * - 판정한 형식은 추출기 라벨(document_version.extractor, 'image-png-v1' 등)에 남긴다. 저장 확장자(docs/store.ts)와
 *   내려받기 형식(detect.ts downloadMime)을 이 라벨에서 정한다: 같은 바이트는 언제나 같은 라벨이 된다.
 * - 렌더 모델(ImageModel)은 그림 한 장을 가리킨다. media[0].path 는 빈 문자열이고, 판본 그림 라우트는 원본 파일을
 *   그대로 내준다(routes/docs.ts /media/0).
 */
import type { ImageModel, MediaRef, OfficeExtractResult } from './model.js';
import { RENDER_MODEL_VERSION } from './model.js';

export type ImageMime = MediaRef['mime'];

/** 그림 형식 → 저장 확장자와 추출기 라벨 (라벨의 형식 이름은 MIME 의 뒷부분과 같다) */
const IMAGE_FORMATS: Readonly<Record<ImageMime, { ext: string; extractor: string }>> = {
  'image/png': { ext: 'png', extractor: 'image-png-v1' },
  'image/jpeg': { ext: 'jpg', extractor: 'image-jpeg-v1' },
  'image/gif': { ext: 'gif', extractor: 'image-gif-v1' },
  'image/webp': { ext: 'webp', extractor: 'image-webp-v1' },
  'image/bmp': { ext: 'bmp', extractor: 'image-bmp-v1' },
};

const EXTRACTOR_RE = /^image-(png|jpeg|gif|webp|bmp)-v\d+$/;

/** 업로드 화면과 같은 그림 확장자 목록 (점 없이) */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] as const;

/** 그림 판본의 추출기 라벨 */
export function imageExtractorLabel(mime: ImageMime): string {
  return IMAGE_FORMATS[mime].extractor;
}

/** 추출기 라벨 → 그림 형식. 그림 라벨이 아니면 null */
export function imageMimeOfExtractor(extractor: string | null | undefined): ImageMime | null {
  const m = extractor ? EXTRACTOR_RE.exec(extractor) : null;
  return m ? (`image/${m[1]}` as ImageMime) : null;
}

/** 추출기 라벨 → 저장 확장자('image-jpeg-v1' → 'jpg'). 그림 라벨이 아니면 null */
export function imageExtOfExtractor(extractor: string | null | undefined): string | null {
  const mime = imageMimeOfExtractor(extractor);
  return mime ? IMAGE_FORMATS[mime].ext : null;
}

/**
 * 그림 판본의 해석 결과: 빈 1쪽(글자 없음)과 그림 한 장을 가리키는 렌더 모델.
 * 업로드 안내(truncated)도 없다: 글자를 읽지 않는 것은 그림 형식의 정해진 동작이다.
 */
export function processImage(mime: ImageMime): OfficeExtractResult {
  const model: ImageModel = {
    v: RENDER_MODEL_VERSION,
    kind: 'image',
    media: [{ path: '', mime }],
    truncated: null,
    pages: [{ pageNo: 1 }],
  };
  return {
    fileKind: 'image',
    extractor: imageExtractorLabel(mime),
    pages: [{ pageNo: 1, text: '', label: null }],
    render: Buffer.from(JSON.stringify(model), 'utf8'),
    renderMime: 'application/json',
    truncated: null,
  };
}
