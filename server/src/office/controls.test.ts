import { describe, expect, it } from 'vitest';
import { stripControls } from './controls.js';
import { processDocx } from './docx/index.js';
import { makeDocx, pt, sectPr } from './docx/testkit.js';
import { processText } from './text.js';

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85); // C1
const CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

describe('stripControls', () => {
  it('탭, 줄바꿈, 복귀는 남기고 나머지 C0, DEL, C1 은 지운다', () => {
    expect(stripControls(`a${NUL}b${BEL}c\td\ne\rf${DEL}g${NEL}h`)).toBe('abc\td\ne\rfgh');
    expect(stripControls('한글과 English 그대로')).toBe('한글과 English 그대로');
  });
});

describe('Office, 텍스트 정본에 제어 문자가 남지 않는다', () => {
  it('docx: run 글자의 NUL, BEL 은 빠지고 오프셋 불변식은 그대로', () => {
    const r = processDocx(makeDocx({ body: pt(`가${NUL}나${BEL}다`) + pt('라') + sectPr() }), 'a.docx');
    expect(r.pages[0]!.text).toBe('가나다\n라');
    expect(CONTROLS.test(r.pages[0]!.text)).toBe(false);
  });

  it('txt: 해독한 글자의 NUL, BEL 은 빠진다', () => {
    const r = processText(Buffer.from(`첫 줄${NUL}\n둘째${BEL} 줄\n`, 'utf8'), 'txt', 'a.txt');
    expect(r.pages.map((p) => p.text).join('\n')).toBe('첫 줄\n둘째 줄\n');
  });

  it('csv: 칸 글자의 제어 문자는 빠지고 칸 사이 탭은 남는다', () => {
    const r = processText(Buffer.from(`이름,값\n가${NUL}나,1${BEL}2\n`, 'utf8'), 'csv', '목록.csv');
    const text = r.pages[0]!.text;
    expect(text).toContain('가나\t12');
    expect(CONTROLS.test(text)).toBe(false);
  });
});
