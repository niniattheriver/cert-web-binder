import { describe, expect, it } from 'vitest';
import type { FlowModel, FlowPara, FlowTable, OfficeExtractResult } from '../model.js';
import { processDocx } from './index.js';
import { BR_PAGE, LRPB, checkInvariants, makeDocx, p, parseModel, pt, r, sectPr, tbl, tc, tr, type Fixture } from './testkit.js';

interface Out {
  res: OfficeExtractResult;
  model: FlowModel;
  texts: string[];
  labels: (string | null)[];
}

function run(f: Fixture): Out {
  const res = processDocx(makeDocx(f), '지침서.docx');
  expect(checkInvariants(res)).toEqual([]);
  return { res, model: parseModel(res), texts: res.pages.map((x) => x.text), labels: res.pages.map((x) => x.label) };
}

const APP = (n: number): string =>
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>${n}</Pages></Properties>`;

const numbering =
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
  '<w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';

describe('쪽 경계 (a) lrpb', () => {
  it('문단 가운데 lrpb: 문단을 가르고 뒷부분은 이어지는 문단(번호, 첫 줄 들여쓰기, 앞 간격 없음)', () => {
    const pPr =
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:before="150" w:after="150"/><w:ind w:left="600" w:firstLine="300"/>';
    const o = run({ numbering, body: pt('첫 쪽 글') + p(r('앞 ') + LRPB + r('뒤'), pPr) + sectPr() });
    expect(o.texts).toEqual(['첫 쪽 글\n1.\t앞 ', '뒤']);
    expect(o.labels).toEqual([null, null]);
    const a = o.model.pages[0]!.blocks[1] as FlowPara;
    const b = o.model.pages[1]!.blocks[0] as FlowPara;
    expect(a).toMatchObject({ spaceBefore: 10, indent: 20, marginLeft: 40 });
    expect(a.spaceAfter).toBeUndefined();
    expect(b).toMatchObject({ spaceAfter: 10, marginLeft: 40 });
    expect(b.spaceBefore).toBeUndefined();
    expect(b.indent).toBeUndefined();
    expect(b.runs.some((x) => x.lbl)).toBe(false);
  });

  it('한 문단에 경계가 여럿이면 여러 조각, 문단 맨 앞 lrpb 는 문단 앞 경계(번호 이름표와 함께 넘어간다)', () => {
    const o = run({
      numbering,
      body:
        pt('가') +
        p(r('a') + LRPB + r('b') + LRPB + r('c')) +
        p(LRPB + r('번호 문단'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    });
    expect(o.texts).toEqual(['가\na', 'b', 'c', '1.\t번호 문단']);
  });

  it('처음 보이는 내용 앞의 경계는 버린다 (빈 첫 쪽 없음)', () => {
    const o = run({ body: p('') + p(LRPB + r('처음')) + pt('둘째') });
    expect(o.texts).toEqual(['처음\n둘째']);
  });

  it('글상자, 각주 안의 lrpb 는 무시한다', () => {
    const box =
      '<w:r><w:pict><v:shape style="width:100pt;height:50pt"><v:textbox><w:txbxContent>' +
      p(LRPB + r('상자')) +
      '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>';
    const o = run({ body: pt('가') + p(r('기준') + box) + p(LRPB + r('다음 쪽')) });
    expect(o.texts).toEqual(['가\n기준\n상자', '다음 쪽']);
  });
});

describe('쪽 경계 (b)(c)(d)', () => {
  it('(b) 최상위 문단의 쪽 나눔', () => {
    const o = run({ body: pt('A') + p(r('B') + BR_PAGE + r('C')) + sectPr() });
    expect(o.texts).toEqual(['A\nB', 'C']);
  });

  it('(c) 스타일을 거친 pageBreakBefore. 문서 첫 문단이면 빈 쪽을 만들지 않는다', () => {
    const styles = '<w:style w:type="paragraph" w:styleId="H1"><w:pPr><w:pageBreakBefore/></w:pPr></w:style>';
    const o = run({ styles, body: pt('표지', '<w:pStyle w:val="H1"/>') + pt('글') + pt('1장', '<w:pStyle w:val="H1"/>') + pt('본문') });
    expect(o.texts).toEqual(['표지\n글', '1장\n본문']);
  });

  it('(d) 다음 구역이 nextPage(기본)면 새 쪽, continuous 면 이어서, 용지가 바뀌면 continuous 라도 새 쪽', () => {
    const first = p(r('1구역'), sectPr());
    expect(run({ body: first + pt('2구역') + sectPr('', 'continuous') }).texts).toEqual(['1구역\n2구역']);
    expect(run({ body: first + pt('2구역') + sectPr() }).texts).toEqual(['1구역', '2구역']);
    expect(run({ body: first + pt('2구역') + sectPr('', 'evenPage') }).texts).toEqual(['1구역', '2구역']);
    const landscape =
      '<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
    const o = run({ body: first + pt('가로') + landscape });
    expect(o.texts).toEqual(['1구역', '가로']);
    expect(o.model.pages[1]!.w).toBeGreaterThan(o.model.pages[1]!.h);
  });

  it('명시적 쪽 나눔 바로 뒤의 lrpb 는 같은 경계 (빈 문단을 사이에 두어도), 문서 끝 쪽 나눔은 빈 쪽을 만들지 않는다', () => {
    expect(run({ body: pt('A') + p(r('B') + BR_PAGE) + p(LRPB + r('C')) }).texts).toEqual(['A\nB', 'C']);
    expect(run({ body: pt('A') + p(BR_PAGE) + p('') + p(LRPB + r('C')) }).texts).toEqual(['A', 'C']);
    expect(run({ body: pt('A') + p(r('B') + BR_PAGE) + sectPr() }).texts).toEqual(['A\nB']);
  });
});

describe('표 쪽 나눔', () => {
  const head = tr([tc(pt('구분')), tc(pt('내용'))], '<w:tblHeader/>');

  it('행 맨 앞 lrpb: 그 행 앞에서 표를 가르고 머리글 행을 되풀이, 세로 병합 이어지는 칸은 새 시작 칸', () => {
    const o = run({
      body: tbl(
        [
          head,
          tr([tc(pt('A'), '<w:vMerge w:val="restart"/>'), tc(pt('a1'))]),
          tr([tc('', '<w:vMerge/>'), tc(p(LRPB + r('a2')))]),
          tr([tc('', '<w:vMerge/>'), tc(pt('a3'))]),
          tr([tc(pt('B')), tc(pt('b'))]),
        ],
        [2000, 4000],
      ),
    });
    expect(o.texts).toEqual(['구분\t내용\nA\ta1', '구분\t내용\na2\na3\nB\tb']);
    const t1 = o.model.pages[0]!.blocks[0] as FlowTable;
    expect(t1.rows[1]!.cells[0]!.rowSpan).toBeUndefined();
    const t2 = o.model.pages[1]!.blocks[0] as FlowTable;
    expect(t2.rows[0]!.header).toBe(true);
    expect(t2.rows[1]!.cells).toHaveLength(2);
    expect(t2.rows[1]!.cells[0]!.rowSpan).toBe(2);
    expect(t2.rows[2]!.cells).toHaveLength(1);
  });

  it('행 가운데 lrpb: 행을 R_a(표지 앞 내용, 표지 없는 칸은 전부)와 R_b(표지 뒤 내용)로 가른다', () => {
    const o = run({
      body: tbl([head, tr([tc(pt('c1') + p(LRPB + r('c2'))), tc(pt('d'))]), tr([tc(pt('e')), tc(pt('f'))])], [2000, 4000]),
    });
    expect(o.texts).toEqual(['구분\t내용\nc1\td', '구분\t내용\nc2\ne\tf']);
  });

  it('빈 열 규칙: 행이 갈라진 뒤 새 쪽에 아직 내용이 없던 열의 다음 행 맨 앞 lrpb 는 같은 경계', () => {
    const o = run({
      body: tbl(
        [
          tr([tc(pt('x')), tc(pt('y'))]),
          tr([tc(pt('p1')), tc(pt('q1') + p(LRPB + r('q2')))]),
          tr([tc(p(LRPB + r('p3'))), tc(pt('q3'))]),
          tr([tc(p(LRPB + r('p4'))), tc(p(LRPB + r('q4')))]),
        ],
        [3000, 3000],
      ),
    });
    expect(o.texts).toEqual(['x\ty\np1\tq1', 'q2\np3\tq3', 'p4\tq4']);
  });

  it('표 칸 맨 앞의 쪽 나눔은 그 행 앞 경계 (바로 앞 lrpb 와 같은 경계)', () => {
    const o = run({
      body:
        pt('앞 글') +
        tbl([tr([tc(p(BR_PAGE + r('양식')))]), tr([tc(pt('줄'))])], [6000]) +
        tbl([tr([tc(pt('가'))]), tr([tc(p(LRPB + BR_PAGE + r('나')))])], [6000]),
    });
    expect(o.texts).toEqual(['앞 글', '양식\n줄\n가', '나']);
  });

  it('되풀이한 머리글 행의 세로 병합에 본문의 이어지는 칸을 잇지 않는다 (본문 칸은 빈 새 시작 칸)', () => {
    const VR = '<w:vMerge w:val="restart"/>';
    const VC = '<w:vMerge/>';
    const HDR = '<w:tblHeader/>';
    const o = run({
      body: tbl(
        [
          tr([tc(pt('구분'), VR), tc(pt('결과'), '<w:gridSpan w:val="2"/>')], HDR),
          tr([tc('', VC), tc(pt('양성')), tc(pt('음성'))], HDR),
          tr([tc(pt('A군'), VR), tc(pt('a1')), tc(pt('b1'))]),
          tr([tc('', VC), tc(pt('a2')), tc(pt('b2'))]),
          tr([tc('', VC), tc(p(LRPB + r('a3'))), tc(p(LRPB + r('b3')))]),
          tr([tc(pt('B군')), tc(pt('a4')), tc(pt('b4'))]),
        ],
        [2000, 2000, 2000],
      ),
    });
    expect(o.texts).toEqual(['구분\t결과\n양성\t음성\nA군\ta1\tb1\na2\tb2', '구분\t결과\n양성\t음성\na3\tb3\nB군\ta4\tb4']);
    const t2 = o.model.pages[1]!.blocks[0] as FlowTable;
    expect(t2.rows[0]!.cells[0]!.rowSpan).toBe(2);
    const body = t2.rows[2]!;
    expect(body.header).toBeUndefined();
    expect(body.cells).toHaveLength(3);
    expect(body.cells[0]!.rowSpan).toBeUndefined();
    expect(body.cells[0]!.blocks.every((b) => b.type === 'p' && b.runs.length === 0)).toBe(true);
  });

  it('빈 열 규칙은 세로 병합으로 이어지는 빈 칸의 열에만: 그냥 빈 칸의 열에서 뒤에 나온 lrpb 는 새 쪽이다', () => {
    const VR = '<w:vMerge w:val="restart"/>';
    const VC = '<w:vMerge/>';
    // 2행이 새 쪽을 시작하고 오른쪽은 그냥 빈 칸(빈 문단이 그 열의 첫 줄). 4행 오른쪽 칸의 lrpb 는 셋째 쪽
    const plain = run({
      body: tbl(
        [
          tr([tc(pt('1L')), tc(pt('1R'))]),
          tr([tc(p(LRPB + r('2L'))), tc('')]),
          tr([tc(pt('3L')), tc('')]),
          tr([tc(''), tc(p(LRPB + r('4R')))]),
        ],
        [3000, 3000],
      ),
    });
    expect(plain.texts).toEqual(['1L\t1R', '2L\n3L', '4R']);
    // 바로 다음 행이어도 같다: 2행 오른쪽 빈 칸이 그 열의 첫 줄이었으므로 3행 오른쪽 칸의 lrpb 는 셋째 쪽
    const next = run({
      body: tbl(
        [tr([tc(pt('1L')), tc(pt('1R'))]), tr([tc(p(LRPB + r('2L'))), tc('')]), tr([tc(''), tc(p(LRPB + r('3R')))])],
        [3000, 3000],
      ),
    });
    expect(next.texts).toEqual(['1L\t1R', '2L', '3R']);
    // 왼쪽 열이 세로 병합으로 이어지는 채 2행이 새 쪽을 시작: 그 열의 다음 내용 칸 lrpb 는 같은 경계
    const merged = run({
      body: tbl(
        [tr([tc(pt('A'), VR), tc(pt('x1'))]), tr([tc('', VC), tc(p(LRPB + r('x2')))]), tr([tc(p(LRPB + r('B'))), tc(pt('x3'))])],
        [3000, 3000],
      ),
    });
    expect(merged.texts).toEqual(['A\tx1', 'x2\nB\tx3']);
    // 병합 열 다음 행에 그냥 빈 칸이 오면 그 열의 첫 줄이 나온 것: 그 뒤 lrpb 는 새 쪽
    const after = run({
      body: tbl(
        [
          tr([tc(pt('A'), VR), tc(pt('x1'))]),
          tr([tc('', VC), tc(p(LRPB + r('x2')))]),
          tr([tc(''), tc(pt('x3'))]),
          tr([tc(p(LRPB + r('C'))), tc(pt('x4'))]),
        ],
        [3000, 3000],
      ),
    });
    expect(after.texts).toEqual(['A\tx1', 'x2\nx3', 'C\tx4']);
  });

  it('행 맨 앞이지만 그 행에 세로 병합 칸이 있고 가운데 lrpb 도 있으면 행 앞에서 가른다', () => {
    const o = run({
      body: tbl(
        [
          tr([tc(pt('M'), '<w:vMerge w:val="restart"/>'), tc(pt('1'))]),
          tr([tc('', '<w:vMerge/>'), tc(pt('2a') + p(LRPB + r('2b')))]),
        ],
        [3000, 3000],
      ),
    });
    expect(o.texts).toEqual(['M\t1', '2a\n2b']);
  });
});

describe('쪽 정보가 없는 문서', () => {
  it('lrpb 가 하나도 없으면 6000자 넘는 쪽을 블록 경계에서 약 4500자씩 가르고 구간 N 이름표를 단다', () => {
    const para = (ch: string): string => pt(ch.repeat(3000));
    const o = run({ body: para('가') + para('나') + para('다') });
    expect(o.texts.map((x) => x.length)).toEqual([3000, 3000, 3000]);
    expect(o.labels).toEqual(['구간 1', '구간 2', '구간 3']);
  });

  it('큰 표는 행 사이에서 가르고 머리글 행을 되풀이한다', () => {
    const rows = [tr([tc(pt('머리'))], '<w:tblHeader/>')];
    for (let i = 0; i < 40; i += 1) rows.push(tr([tc(pt(`${i}`.padStart(2, '0') + '라'.repeat(198)))]));
    const o = run({ body: tbl(rows, [6000]) });
    expect(o.texts.length).toBeGreaterThan(1);
    for (const t of o.texts) {
      expect(t.startsWith('머리\n')).toBe(true);
      expect(t.length).toBeLessThan(6000);
    }
    expect(o.texts.join('\n').split('\n').filter((l) => l !== '머리')).toHaveLength(40);
  });
});

describe('Word 쪽 정보가 모자랄 때 어림', () => {
  const many = (n: number): string => Array.from({ length: n }, (_, i) => pt(`${i} 가나다라마바사아자차`)).join('');

  it('app.xml 쪽 수가 표지 쪽 수보다 많으면 그 수에 맞춰 넘치는 쪽을 가른다 (이름표 null)', () => {
    const o = run({ body: pt('표지') + p(LRPB + r('본문 시작')) + many(300), files: { 'docProps/app.xml': APP(5) } });
    expect(o.texts).toHaveLength(5);
    expect(o.labels).toEqual([null, null, null, null, null]);
    expect(o.texts[0]).toBe('표지');
    expect(o.texts.join('\n').split('\n')).toHaveLength(302);
  });

  it('app.xml 이 없으면(또는 1) 쪽마다 어림 비율로 가른다', () => {
    const o = run({ body: pt('표지') + p(LRPB + r('본문 시작')) + many(300) });
    expect(o.texts.length).toBeGreaterThanOrEqual(4);
    expect(o.texts.length).toBeLessThanOrEqual(7);
    const one = run({ body: pt('표지') + p(LRPB + r('본문 시작')) + many(300), files: { 'docProps/app.xml': APP(1) } });
    expect(one.texts).toHaveLength(o.texts.length);
  });

  it('app.xml 쪽 수가 더 많아도 거의 찬 쪽(어림 0.9 이상)만 가른다: 덜 찬 쪽을 갈라 한 줄짜리 쪽을 만들지 않는다', () => {
    const lines = (k: number, n: number, pre = ''): string =>
      Array.from({ length: n }, (_, i) => p((i === 0 ? pre : '') + r(`쪽${k} 줄${i + 1}`))).join('');
    // 첫 쪽은 글자 영역의 약 34%. 고치기 전에는 높이를 6배까지 부풀려 [19, 1, 12, 12] 줄로 갈랐다
    const body = lines(1, 20) + lines(2, 12, LRPB) + lines(3, 12, LRPB);
    for (const app of [4, 5]) {
      const o = run({ body, files: { 'docProps/app.xml': APP(app) } });
      expect(o.texts.map((t) => t.split('\n').length)).toEqual([20, 12, 12]);
    }
  });

  it('evenPage/oddPage 구역 앞에 Word 가 넣는 빈 쪽은 app.xml 쪽 수에서 빼고 비교한다', () => {
    // 첫 쪽은 글자 영역의 약 96% (16px 줄 56개 / 930px)
    const page1 = Array.from({ length: 55 }, (_, i) => pt(`줄${i + 1}`)).join('') + p(r('구역 끝'), sectPr());
    const body = (type: string): string => page1 + p(LRPB + r('둘째 구역')) + sectPr('', type);
    // 둘째 구역은 2쪽(짝수)에서 시작한다: oddPage 면 Word 가 빈 쪽을 넣어 3쪽으로 센다 → 표지 2쪽이 맞다
    expect(run({ body: body('oddPage'), files: { 'docProps/app.xml': APP(3) } }).texts).toHaveLength(2);
    expect(run({ body: body('evenPage'), files: { 'docProps/app.xml': APP(3) } }).texts).toHaveLength(3);
    // 빈 쪽이 없는 nextPage 면 거의 찬 첫 쪽을 갈라 Word 의 3쪽을 맞춘다
    const next = run({ body: body('nextPage'), files: { 'docProps/app.xml': APP(3) } });
    expect(next.texts).toHaveLength(3);
    expect(next.texts[2]).toBe('둘째 구역');
  });

  it('표지 쪽 수가 app.xml 과 같으면 어림하지 않는다', () => {
    const o = run({ body: pt('표지') + p(LRPB + r('본문 시작')) + many(300), files: { 'docProps/app.xml': APP(2) } });
    expect(o.texts).toHaveLength(2);
  });

  it('표지 쪽 수가 app.xml 보다 많으면 lrpb 로 시작한 아주 작은 쪽을 이웃 쪽에 합치고 갈라진 행을 다시 잇는다', () => {
    const table = tbl(
      [
        tr([tc(pt('r1a') + p(LRPB + r('r1b'))), tc(pt('s1'))]),
        tr([tc(p(LRPB + r('r2'))), tc(pt('s2'))]),
        tr([tc(pt('r3')), tc(pt('s3'))]),
      ],
      [3000, 3000],
    );
    const body = many(40) + table;
    const markers = run({ body });
    expect(markers.texts).toHaveLength(3);
    const o = run({ body, files: { 'docProps/app.xml': APP(2) } });
    expect(o.texts).toHaveLength(2);
    expect(o.texts[1]).toBe('r1b\nr2\ts2\nr3\ts3');
    expect((o.model.pages[1]!.blocks[0] as FlowTable).rows).toHaveLength(3);
  });
});
