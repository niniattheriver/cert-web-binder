import { describe, expect, it } from 'vitest';
import { extForKind } from '../docs/store.js';
import { ACCEPTED_EXTENSIONS, stripDocExtension } from './detect.js';
import { IMAGE_EXTENSIONS, imageExtOfExtractor, imageExtractorLabel, imageMimeOfExtractor, processImage } from './image.js';

describe('그림 판본 (office/image.ts)', () => {
  it('형식 → 추출기 라벨 → 형식과 저장 확장자가 서로 맞물린다', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'] as const) {
      const label = imageExtractorLabel(mime);
      expect(imageMimeOfExtractor(label)).toBe(mime);
    }
    expect(imageExtOfExtractor('image-jpeg-v1')).toBe('jpg');
    expect(imageExtOfExtractor('image-webp-v1')).toBe('webp');
    // 그림 라벨이 아니면 모른다
    expect(imageMimeOfExtractor('pdfjs-4.10.38')).toBeNull();
    expect(imageMimeOfExtractor('image-svg-v1')).toBeNull();
    expect(imageExtOfExtractor(null)).toBeNull();
  });

  it('저장 확장자: 그림은 추출기 라벨, 라벨을 모르면 bin, 다른 형식은 그대로', () => {
    expect(extForKind('image', 'image-png-v1')).toBe('png');
    expect(extForKind('image', 'image-jpeg-v1')).toBe('jpg');
    expect(extForKind('image', null)).toBe('bin');
    expect(extForKind('docx', 'image-png-v1')).toBe('docx');
    expect(extForKind('text')).toBe('txt');
    expect(extForKind(null)).toBe('pdf');
  });

  it('해석 결과: 글자 없는 1쪽, 안내 없음, 그림 한 장을 가리키는 모델', () => {
    const r = processImage('image/webp');
    expect(r).toMatchObject({
      fileKind: 'image',
      extractor: 'image-webp-v1',
      pages: [{ pageNo: 1, text: '', label: null }],
      truncated: null,
    });
    expect(JSON.parse(r.render.toString('utf8'))).toEqual({
      v: 1,
      kind: 'image',
      media: [{ path: '', mime: 'image/webp' }],
      truncated: null,
      pages: [{ pageNo: 1 }],
    });
  });

  it('업로드 확장자 목록에 그림이 있고, 제목을 만들 때 그림 확장자도 뗀다', () => {
    for (const ext of IMAGE_EXTENSIONS) expect(ACCEPTED_EXTENSIONS).toContain(ext);
    expect(stripDocExtension('분자실 배치도.JPEG')).toBe('분자실 배치도');
    expect(stripDocExtension('냉장고.png')).toBe('냉장고');
    expect(stripDocExtension('도식.svg')).toBe('도식.svg');
  });
});
