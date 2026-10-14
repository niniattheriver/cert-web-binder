import { describe, expect, it } from 'vitest';
import { cropFromSrcRect, cropFromVml } from './crop.js';
import { processDocx } from './docx/index.js';
import { makeDocx, PNG_1X1, pt, sectPr } from './docx/testkit.js';
import type { FlowImage, FlowModel } from './model.js';
import { parseXml } from './xml.js';

const el = (xml: string) => parseXml(xml).root;

describe('cropFromSrcRect (DrawingML, 1/1000 퍼센트)', () => {
  it('l, t, r, b 를 비율로, 빠진 값은 0', () => {
    expect(cropFromSrcRect(el('<a:srcRect l="12500" b="50000"/>'))).toEqual({ l: 0.125, t: 0, r: 0, b: 0.5 });
  });
  it('없거나 모두 0 이면 undefined', () => {
    expect(cropFromSrcRect(undefined)).toBeUndefined();
    expect(cropFromSrcRect(el('<a:srcRect/>'))).toBeUndefined();
    expect(cropFromSrcRect(el('<a:srcRect l="0" t="0" r="0" b="0"/>'))).toBeUndefined();
  });
  it('음수(바깥 여백)는 0 으로, 거의 다 잘라 내는 값과 숫자가 아닌 값은 무시', () => {
    expect(cropFromSrcRect(el('<a:srcRect l="-5000" r="20000"/>'))).toEqual({ l: 0, t: 0, r: 0.2, b: 0 });
    expect(cropFromSrcRect(el('<a:srcRect l="60000" r="40000"/>'))).toBeUndefined();
    expect(cropFromSrcRect(el('<a:srcRect l="abc" t="x"/>'))).toBeUndefined();
  });
});

describe('cropFromVml (v:imagedata)', () => {
  it('소수와 65536 분의 값(f)을 읽는다', () => {
    expect(cropFromVml(el('<v:imagedata cropleft="0.25" cropbottom="32768f"/>'))).toEqual({ l: 0.25, t: 0, r: 0, b: 0.5 });
  });
  it('crop 속성이 없으면 undefined', () => {
    expect(cropFromVml(el('<v:imagedata r:id="rId1"/>'))).toBeUndefined();
  });
});

describe('docx 그림 잘라 내기 → FlowImage.crop', () => {
  const blip = (rid: string, srcRect = ''): string =>
    `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><a:graphicData uri="x"><pic:pic>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></pic:blipFill></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const vml = (rid: string, crop: string): string =>
    `<w:r><w:pict><v:shape style="width:100pt;height:50pt"><v:imagedata r:id="${rid}" ${crop}/></v:shape></w:pict></w:r>`;

  it('DrawingML srcRect 와 VML crop 은 crop 으로, 잘라 내지 않은 그림에는 없다. 틀 크기와 정본 글자는 그대로', () => {
    const r = processDocx(
      makeDocx({
        rels: [{ id: 'rImg', type: 'image', target: 'media/a.png' }],
        files: { 'word/media/a.png': PNG_1X1 },
        body:
          `<w:p>${blip('rImg', '<a:srcRect t="20000" r="10000"/>')}</w:p>` +
          `<w:p>${blip('rImg')}</w:p>` +
          `<w:p>${vml('rImg', 'croptop="0.1" cropright="6554f"')}</w:p>` +
          pt('본문') +
          sectPr(),
      }),
      '그림.docx',
    );
    const model = JSON.parse(r.render.toString('utf8')) as FlowModel;
    const imgs = model.pages.flatMap((p) => p.blocks).filter((b): b is FlowImage => b.type === 'img');
    expect(imgs).toHaveLength(3);
    expect(imgs[0]).toMatchObject({ w: 100, h: 50, crop: { l: 0, t: 0.2, r: 0.1, b: 0 } });
    expect(imgs[1]).not.toHaveProperty('crop');
    expect(imgs[2]!.crop).toEqual({ l: 0, t: 0.1, r: 0.10001, b: 0 });
    expect(r.pages.map((p) => p.text).join('\n')).toBe('본문');
  });
});
