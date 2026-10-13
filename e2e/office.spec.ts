/**
 * 검사실 자료 PDF 외 형식 E2E (설계서 §3.5, §11-10): 실제 브라우저로 사용자 경로를 따라간다.
 *
 * 전제: 데모 시드가 들어간 서버 하나(dev 서버 또는 빌드한 서버, E2E_BASE_URL), admin/day1pass.
 *   시드 문서: '가상기관 개인정보 처리지침'(PDF), '가상기관 정보보안 점검 절차서'(docx),
 *   '가상기관 정보자산 목록'(xlsx), '가상기관 접근권한 검토 기록'(csv)과 그 텍스트 앵커
 *   (60.060.010, 60.020.010, 60.030.010 등).
 *
 * 다른 사람이 같은 서버를 함께 쓸 수 있다고 본다.
 * - 이 파일이 만드는 문서는 모두 이번 실행의 합성 자료다(seed/office-fixtures.ts 생성기 + 아래 작은 pptx,
 *   hwpx 생성기 + 구형 hwp, doc, xls 합성기 server/src/office/legacy/testdocs.ts). 제목은 'V-e2e <실행 표지>' 로
 *   시작해 다른 자료와 섞이지 않는다.
 * - 전체 개수는 단언하지 않는다. 이번 실행이 만든 문서와 그 문서의 판본, 앵커만 정확히 센다.
 * - 시드 문서에는 읽기만 한다. 예외는 PDF 회귀(시드 PDF 에 앵커 하나를 만든다)이고, 그 앵커와 이 파일이
 *   만든 문항 연결은 끝에서 지운다(연결 해제, 마지막 연결이면 하이라이트도 함께 지움).
 * - 모든 시험에서 외부(localhost 밖) 요청과 페이지 예외(pageerror)가 0건이어야 한다.
 *
 * 구성: [시드 읽기] 종류 칩과 단위, 미리보기 창, 뷰어 레일, 문항 상세 C 창
 *       [업로드 경로, 순서대로] [근거자료 파일 업로드] 단추, 끌어다 놓기(구형 hwp, doc, xls 포함, .ppt 건너뜀),
 *       본문 검색, docx/xlsx 매핑,
 *       pptx/hwpx/csv 매핑과 문항 상세 출처 줄, 새 판본 재앵커링(자동 이관, 확인 필요)과 판본 비교,
 *       형식이 다른 판본 비교
 *       [PDF 회귀] 시드 PDF 매핑
 *       [쪽 수 단위] 첫 쪽 이름표를 따르는 단위(쪽, 구간, 시트)
 *
 * 실행 예 (빌드한 서버, 설치된 Chrome):
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/office.spec.ts --workers=1
 */
import { test as base, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { buildDemoCsv, buildDemoDocx, buildDemoXlsx } from '../seed/office-fixtures.js';
import { buildDoc, buildHwp, buildXls } from '../server/src/office/legacy/testdocs.js';
import { readZipDirectory, readZipEntry } from '../server/src/files/unzip.js';
import { zipEntries } from '../server/src/jobs/zip.js';

// 함께 쓰는 서버는 다른 사람의 큰 업로드(추출)로 잠깐 느려질 수 있다: 단언 대기를 기본 5초보다 넉넉히 둔다
const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots'; // 확인용 캡처 저장 위치
const USER = 'admin';
const PASS = 'day1pass';

/** 이번 실행 표지: 제목과 검색어를 다른 실행, 다른 사람의 자료와 가른다 */
const RUN = Date.now().toString(36);
const TAG = `V-e2e ${RUN}`;

// ── 시드 문서와 문항 (데모 시드 seed/seed-demo.ts) ─────────────────────────────
const SEED = {
  pdf: '가상기관 개인정보 처리지침',
  pdf2: '가상기관 정보보안 운영지침',
  docx: '가상기관 정보보안 점검 절차서',
  xlsx: '가상기관 정보자산 목록',
  csv: '가상기관 접근권한 검토 기록',
} as const;
/** 이 파일이 새 앵커를 거는 문항: 시드 앵커가 없는 문항을 고른다 */
const MAP_Q = { no: '60.080.020', typed: '60080020' };
const PDF_Q = { no: '60.070.010', typed: '60070010' };

// ── 합성 문서 내용 ──────────────────────────────────────────────────────────
const PURPOSE = '이 절차서는 가상기관의 정보시스템 점검 방법과 기록 관리 기준을 정한다.';
/** docx 매핑 대상 문장 (구간 2) */
const SENTENCE_A = '주요 데이터는 매일 자동 백업하고, 백업 매체는 월 1회 복구 시험으로 확인한다.';
/** 새 판본에서 바꾸는 문장의 일부 ('7일' → '5일') */
const DAYS_OLD = '7일 안에';
/** 본문 검색어 (단추로 올리는 docx 의 구간 1 에만 넣는다) */
const SEARCH_TOKEN = `검색표지${RUN}`;
/** xlsx 매핑 대상 칸 (자산목록 시트 B3) */
const CELL_TEXT = '검사정보시스템 서버';
/** PDF 회귀 매핑 대상 (시드 PDF 1쪽, 제3조 ①의 글자 조각 안) */
const PDF_SENTENCE = '이 지침은 기관의 모든 임직원과 기관의 업무를 수행하는 외부 인력에게 적용한다.';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/hwp+zip',
  csv: 'text/csv',
  txt: 'text/plain',
  hwp: 'application/x-hwp',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
} as const;

// ── 외부 요청, 페이지 예외 감시 (모든 시험에 자동 적용) ──────────────────────
const test = base.extend<{ guard: void }>({
  guard: [
    async ({ context, baseURL }, use) => {
      const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
      if (baseURL) local.add(new URL(baseURL).hostname);
      const external: string[] = [];
      const errors: string[] = [];
      context.on('request', (r) => {
        const u = new URL(r.url());
        if (u.protocol === 'data:' || u.protocol === 'blob:') return;
        if (!local.has(u.hostname)) external.push(r.url());
      });
      const watch = (p: Page) => p.on('pageerror', (e) => errors.push(e.message));
      context.pages().forEach(watch);
      context.on('page', watch);
      await use();
      expect(external, `외부 요청: ${external.join(', ')}`).toEqual([]);
      expect(errors, `페이지 예외: ${errors.join(' | ')}`).toEqual([]);
    },
    { auto: true },
  ],
});

// ── 합성 파일 만들기 (새 의존성 없이 저장소의 ZIP 도구로) ─────────────────────

function replaceOnce(s: string, from: string, to: string): string {
  const i = s.indexOf(from);
  if (i < 0) throw new Error(`생성기 출력에서 '${from}' 을 찾지 못했다 (seed/office-fixtures.ts 가 바뀌었나?)`);
  return s.slice(0, i) + to + s.slice(i + from.length);
}

/** ZIP 항목을 하나씩 고쳐 다시 묶는다 (폴더 항목은 뺀다) */
function rewriteZip(buf: Buffer, edit: (name: string, data: Buffer) => Buffer): Buffer {
  const dir = readZipDirectory(buf);
  if (!dir) throw new Error('ZIP 이 아니다');
  return zipEntries(
    dir
      .filter((e) => !e.name.endsWith('/'))
      .map((e) => {
        const data = readZipEntry(buf, e);
        if (!data) throw new Error(`ZIP 항목을 읽지 못했다: ${e.name}`);
        return { name: e.name, data: edit(e.name, data), date: new Date(2026, 0, 1) };
      }),
  );
}

/**
 * 시드와 같은 docx 에 검색 표지를 넣는다.
 * markers=false 면 Word 쪽 나눔 표지(w:lastRenderedPageBreak)를 지워 '구간 N' 문서로 만든다
 * (명시적 쪽 나누기 하나만 남아 2구간). days 를 주면 '7일 안에' 를 그 값으로 바꾼다(새 판본용).
 */
function procedureDocx(o: { markers: boolean; token: string; days?: number }): Buffer {
  return rewriteZip(buildDemoDocx(), (name, data) => {
    if (name !== 'word/document.xml') return data;
    let xml = data.toString('utf8');
    if (!o.markers) xml = xml.split('<w:lastRenderedPageBreak/>').join('');
    xml = replaceOnce(xml, PURPOSE, `${PURPOSE} 검색 표지 ${o.token}.`);
    if (o.days != null) xml = replaceOnce(xml, DAYS_OLD, `${o.days}일 안에`);
    return Buffer.from(xml, 'utf8');
  });
}

/** 시드와 같은 xlsx 의 제목 칸(A1)을 이번 실행 제목으로 바꾼다. cell 을 주면 B3 칸 글자도 바꾼다(새 판본용) */
async function assetXlsx(token: string, cell?: string): Promise<Buffer> {
  return rewriteZip(await buildDemoXlsx(), (name, data) => {
    if (name !== 'xl/sharedStrings.xml') return data;
    let xml = replaceOnce(data.toString('utf8'), '가상기관 정보자산 목록 (2026년)', `V-e2e 정보자산 목록 ${token}`);
    if (cell != null) xml = replaceOnce(xml, `<t>${CELL_TEXT}</t>`, `<t>${xmlEsc(cell)}</t>`);
    return Buffer.from(xml, 'utf8');
  });
}

const xmlEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const zipText = (files: [string, string][]): Buffer =>
  zipEntries(files.map(([name, body]) => ({ name, data: Buffer.from(body, 'utf8'), date: new Date(2026, 0, 1) })));
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** 작은 pptx: 슬라이드마다 글상자 하나, 문단 여러 개 (마스터 없음) */
function tinyPptx(slides: string[][]): Buffer {
  const ns =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const rt = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (list: [string, string, string][]): string =>
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${rt}/${type}" Target="${target}"/>`).join('') +
    '</Relationships>';
  const slideXml = (paras: string[]): string =>
    `${XML_HEAD}<p:sld ${ns}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="본문"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="4572000"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' +
    paras.map((t) => `<a:p><a:r><a:rPr lang="ko-KR" sz="2400"/><a:t>${xmlEsc(t)}</a:t></a:r></a:p>`).join('') +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  return zipText([
    [
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '</Types>',
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    [
      'ppt/presentation.xml',
      `${XML_HEAD}<p:presentation ${ns}><p:sldIdLst>` +
        slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('') +
        '</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    ],
    ['ppt/_rels/presentation.xml.rels', rels(slides.map((_, i) => [`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]))],
    ...slides.map((s, i): [string, string] => [`ppt/slides/slide${i + 1}.xml`, slideXml(s)]),
  ]);
}

/** 작은 hwpx: 구역 하나, 문단 여러 개 (글자 모양, 문단 모양 하나씩) */
function tinyHwpx(paras: string[]): Buffer {
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
  const ns =
    'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
    'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
    'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:opf="http://www.idpf.org/2007/opf/"';
  const langs = (v: number): string =>
    ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'].map((l) => `${l}="${v}"`).join(' ');
  const header =
    `${decl}<hh:head ${ns} version="1.5" secCnt="1"><hh:refList>` +
    '<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>' +
    '<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
    ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="NONE" width="0.12 mm" color="#000000"/>`).join('') +
    '</hh:borderFill></hh:borderFills>' +
    '<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" useFontSpace="0" ' +
    'useKerning="0" symMark="NONE" borderFillIDRef="1">' +
    `<hh:fontRef ${langs(0)}/><hh:ratio ${langs(100)}/><hh:spacing ${langs(0)}/><hh:relSz ${langs(100)}/><hh:offset ${langs(0)}/>` +
    '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/></hh:charPr></hh:charProperties>' +
    '<hh:paraProperties itemCnt="1"><hh:paraPr id="0" tabPrIDRef="0" condense="0"><hh:align horizontal="JUSTIFY" vertical="BASELINE"/>' +
    '<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hh:paraPr></hh:paraProperties>' +
    '</hh:refList></hh:head>';
  const section =
    `${decl}<hs:sec ${ns}>` +
    paras
      .map(
        (t) =>
          '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
          `<hp:run charPrIDRef="0"><hp:t>${xmlEsc(t)}</hp:t></hp:run></hp:p>`,
      )
      .join('') +
    '</hs:sec>';
  const hpf =
    `${decl}<opf:package ${ns} version="" unique-identifier="" id=""><opf:metadata><opf:language>ko</opf:language></opf:metadata>` +
    '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
    '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest>' +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>';
  return zipText([
    ['mimetype', 'application/hwp+zip'],
    ['Contents/header.xml', header],
    ['Contents/section0.xml', section],
    ['Contents/content.hpf', hpf],
  ]);
}

/** 구형 PowerPoint(ppt) 흉내: OLE2 머리. 화면이 확장자로 먼저 거르므로 서버로 가지 않아야 한다 */
function fakePpt(): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
}

/** 근거자료 라이브러리의 끌어다 놓기 영역에 파일들을 놓는다 (브라우저 안에서 DataTransfer 를 만든다) */
async function dropFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const dt = await page.evaluateHandle(
    (list) => {
      const d = new DataTransfer();
      for (const f of list) {
        const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        d.items.add(new File([bin], f.name, { type: f.mimeType }));
      }
      return d;
    },
    files.map((f) => ({ name: f.name, mimeType: f.mimeType, b64: f.buffer.toString('base64') })),
  );
  const zone = page.locator('.doclib-drop');
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(zone).toHaveClass(/is-over/);
  await expect(zone).toContainText('놓으면 바로 올라갑니다');
  await zone.dispatchEvent('drop', { dataTransfer: dt });
}

// ── API 응답 모양 (필요한 필드만) ────────────────────────────────────────────
interface DocRow {
  id: number;
  title: string;
  currentVersion: { id: number; fileKind?: string; pageCount: number; firstPageLabel?: string | null } | null;
}
interface AnchorRow {
  anchorId: number;
  passageId: number;
  status: string;
  pageStart: number | null;
  pageLabel: string | null;
  startOffset: number | null;
  rects: unknown;
  quote: string;
  questions: { id: number; questionNo: string }[];
}
interface PageTextRow {
  pageNo: number;
  label: string | null;
  text: string;
}

// ── 도우미 ──────────────────────────────────────────────────────────────────

/** 로그인 화면이면 로그인하고, 연도 홈(현재 연도 카드)이 보일 때까지 기다린다 */
async function login(page: Page): Promise<void> {
  await page.goto('/');
  const idField = page.locator('label', { hasText: '아이디' }).locator('input');
  const yearCard = page.locator('.year-card.is-current');
  await expect(idField.or(yearCard).first()).toBeVisible({ timeout: 30_000 });
  if (await idField.isVisible()) {
    await idField.fill(USER);
    await page.locator('label', { hasText: '비밀번호' }).locator('input').fill(PASS);
    await page.getByRole('button', { name: /로그인/ }).click();
  }
  await expect(yearCard).toBeVisible({ timeout: 30_000 });
}

/**
 * 같은 요청을 다시 보내도 되는 API 호출(GET, 연결 해제)을 연결 끊김에만 두 번까지 다시 보낸다.
 * Node 서버는 쉬는 연결을 5초 뒤 닫는데, 그 순간 그 연결로 보낸 요청은 ECONNRESET 으로 끝날 수 있다.
 */
async function retryOnReset<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= 3 || !/ECONNRESET|socket hang up/i.test(msg)) throw e;
    }
  }
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await retryOnReset(() => page.request.get(path));
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** 제목이 정확히 같은 문서 (여럿이면 가장 먼저 만든 것: 시드 문서는 id 가 가장 작다) */
async function docByTitle(page: Page, title: string): Promise<DocRow> {
  const { docs } = await getJson<{ docs: DocRow[] }>(page, '/api/docs');
  const hit = docs.filter((d) => d.title === title).sort((a, b) => a.id - b.id)[0];
  expect(hit, `문서 '${title}' 이 서버에 없다`).toBeTruthy();
  return hit!;
}

async function anchorsOf(page: Page, versionId: number): Promise<AnchorRow[]> {
  return (await getJson<{ anchors: AnchorRow[] }>(page, `/api/docs/versions/${versionId}/anchors`)).anchors;
}

async function pagesOf(page: Page, versionId: number): Promise<PageTextRow[]> {
  return (await getJson<{ pages: PageTextRow[] }>(page, `/api/docs/versions/${versionId}/page-text`)).pages;
}

/** 인용이 quote 와 같은 앵커가 그 판본에 'resolved' 로 생길 때까지 기다려 돌려준다 */
async function waitAnchor(page: Page, versionId: number, quote: string): Promise<AnchorRow> {
  let found: AnchorRow | undefined;
  await expect
    .poll(async () => {
      found = (await anchorsOf(page, versionId)).find((a) => a.quote === quote);
      return found?.status;
    })
    .toBe('resolved');
  return found!;
}

/** 정규식 특수 문자 이스케이프 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 파일 이름에서 끝 확장자를 뗀다 (일괄 업로드가 만드는 제목) */
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** 라이브러리 카드 (제목 정확히 일치) */
function libraryCard(page: Page, title: string): Locator {
  return page
    .locator('.doclib-card')
    .filter({ has: page.locator('.doclib-title').getByText(title, { exact: true }) })
    .first();
}

/** 문항 상세의 근거 카드 (출처 줄이 '<문서 제목> ' 으로 시작) */
function evidenceCard(page: Page, docTitle: string): Locator {
  return page
    .locator('.evd-card')
    .filter({ has: page.locator('.evd-source', { hasText: new RegExp(`^${escapeRe(docTitle)} `) }) })
    .first();
}

/**
 * 쪽 수 단위 규칙 (설계서 §3.5 위치 표기, 538be88): 단위는 첫 쪽 이름표와 맞춘다.
 * 이름표가 있는 텍스트(csv, tsv: 시트 이름)는 '시트', Word 쪽 정보가 없어 '구간 N' 으로 나눈 docx 는 '구간'.
 */
function unitFor(kind: string | undefined, firstPageLabel: string | null | undefined): string {
  const named = typeof firstPageLabel === 'string' && firstPageLabel.trim() !== '';
  switch (kind) {
    case 'xlsx':
      return '시트';
    case 'pptx':
      return '슬라이드';
    case 'hwpx':
      return '구간';
    case 'text':
      return named ? '시트' : '구간';
    case 'docx':
      return named ? '구간' : '쪽';
    default:
      return '쪽';
  }
}

/**
 * 카드의 형식 칩과 쪽 수(단위 포함)가 서버 판본 정보와 맞는지 본다.
 * 단위는 서버가 알려 준 첫 쪽 이름표로 정한다(그 필드가 없는 예전 서버면 형식 기본 단위).
 */
async function expectCardKindAndUnit(page: Page, title: string, chip: string): Promise<DocRow> {
  const doc = await docByTitle(page, title);
  const cv = doc.currentVersion!;
  const card = libraryCard(page, title);
  await expect(card, `카드 '${title}'`).toBeVisible();
  await expect(card.locator('.kind-chip')).toHaveText(chip);
  const unit = unitFor(cv.fileKind, cv.firstPageLabel);
  await expect(card.locator('.doclib-nowrap').filter({ hasText: new RegExp(`^\\d+${unit}$`) })).toHaveText(
    `${cv.pageCount}${unit}`,
  );
  return doc;
}

/** 문항 번호 퀵피커로 연결할 문항을 정하고 근거 연결 모드를 켠다 (문서 뷰어) */
async function enterMapMode(page: Page, q: { no: string; typed: string }): Promise<void> {
  await page.getByRole('button', { name: '근거 연결 모드(M)' }).click();
  const picker = page.getByRole('dialog', { name: /근거를 연결할 문항 고르기/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: '문항 번호 또는 검색어' }).fill(q.typed);
  await expect(picker.locator('[role="option"]').first()).toContainText(q.no, { timeout: 10_000 });
  await picker.getByRole('textbox', { name: '문항 번호 또는 검색어' }).press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.locator('.pvp-mapbar')).toContainText(`「${q.no}」`);
}

/**
 * 글자 조각 요소(글자 노드 하나를 가진 요소) 안의 부분 문자열 sub 를 마우스로 끌어 고른다.
 * 첫 글자 왼쪽 끝 조금 안에서 눌러 마지막 글자 오른쪽 끝 조금 안에서 놓는다.
 */
async function dragSelect(page: Page, piece: Locator, sub: string): Promise<void> {
  await piece.scrollIntoViewIfNeeded();
  const pts = await piece.evaluate((el, s) => {
    const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(s));
    if (!node) throw new Error(`글자 노드에서 '${s}' 를 찾지 못했다`);
    const from = (node.textContent ?? '').indexOf(s);
    const to = from + s.length;
    const r = document.createRange();
    r.setStart(node, from);
    r.setEnd(node, from + 1);
    const a = r.getClientRects()[0] ?? r.getBoundingClientRect();
    r.setStart(node, to - 1);
    r.setEnd(node, to);
    const rs = r.getClientRects();
    const b = rs[rs.length - 1] ?? r.getBoundingClientRect();
    return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 };
  }, sub);
  await page.mouse.move(pts.x0, pts.y0);
  await page.mouse.down();
  await page.mouse.move((pts.x0 + pts.x1) / 2, (pts.y0 + pts.y1) / 2, { steps: 6 });
  await page.mouse.move(pts.x1, pts.y1, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(sub.slice(0, 6));
}

/** 두 상자가 겹치는가 (겹친 넓이가 작은 쪽 넓이의 frac 이상) */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  frac = 0.3,
): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return false;
  return w * h >= frac * Math.min(a.width * a.height, b.width * b.height);
}

/** POST /api/docs 응답 (필요한 필드만) */
interface UploadBody {
  documentId: number;
  versionId: number;
  pageCount: number;
  fileKind?: string;
  firstPageLabel?: string | null;
  reanchor?: { auto: number; needsReview: number };
}

/**
 * 카드의 [새 판본 업로드] 폼에 파일을 고르고 올린다.
 * 화면의 업로드 결과 안내 문구와 서버 응답을 함께 돌려주고, 안내 문구의 쪽 수와 단위가 응답과 맞는지 본다.
 */
async function submitUploadForm(
  page: Page,
  o: { title?: string; label: string; file: { name: string; mimeType: string; buffer: Buffer }; kindChip: string },
): Promise<{ notice: string; body: UploadBody }> {
  const form = page.locator('form.doclib-upload');
  await expect(form).toBeVisible();
  if (o.title != null) await form.locator('label.field', { hasText: '제목' }).locator('input').fill(o.title);
  await form.locator('label.field', { hasText: '버전 이름' }).locator('input').fill(o.label);
  const chooserP = page.waitForEvent('filechooser');
  await form.getByRole('button', { name: '파일 선택' }).first().click();
  await (await chooserP).setFiles(o.file);
  await expect(form.getByText(o.file.name, { exact: true })).toBeVisible();
  await expect(form.locator('.kind-chip')).toHaveText(o.kindChip);
  const respP = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/docs',
    { timeout: 30_000 },
  );
  await form.getByRole('button', { name: '업로드', exact: true }).click();
  const resp = await respP;
  expect(resp.status(), `업로드 응답 ${resp.status()}`).toBe(201);
  const body = (await resp.json()) as UploadBody;
  const notice = page.locator('.doclib-notice');
  await expect(notice).toContainText(
    `업로드 완료: ${body.pageCount}${unitFor(body.fileKind, body.firstPageLabel)} 처리.`,
    { timeout: 30_000 },
  );
  await expect(form).toBeHidden();
  return { notice: (await notice.textContent()) ?? '', body };
}

// 이 파일이 만든 문항 연결: 끝에서 지운다 (passageId, questionId)
const createdLinks: { passageId: number; questionId: number }[] = [];

async function removeLinks(page: Page): Promise<void> {
  while (createdLinks.length > 0) {
    const l = createdLinks.pop()!;
    const res = await retryOnReset(() =>
      page.request.delete(`/api/passages/${l.passageId}/links/${l.questionId}?confirm=1`),
    );
    expect([200, 404], `연결 해제 ${l.passageId}/${l.questionId} → ${res.status()}`).toContain(res.status());
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. 시드 문서 읽기 (자료를 바꾸지 않는다)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('검사실 자료: 시드 문서 읽기', () => {
  test('라이브러리: 형식 칩과 형식별 쪽 단위', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    // 칩은 형식 이름, 쪽 수 단위는 첫 쪽 이름표를 따른다 (쪽 수와 단위는 서버 판본 정보와 같아야 한다)
    for (const [title, chip] of [
      [SEED.pdf, 'PDF'],
      [SEED.docx, 'Word'],
      [SEED.xlsx, 'Excel'],
      [SEED.csv, '텍스트'],
    ] as const) {
      await expectCardKindAndUnit(page, title, chip);
    }
    // 받는 형식 안내 (머리 설명 아래 줄)
    await expect(page.locator('.doclib-formats')).toContainText('Word (docx, doc)');
    await expect(page.locator('.doclib-formats')).toContainText('한글(hwpx, hwp)');
    await page.screenshot({ path: `${SHOT}/office-1-library.png` });
  });

  test('미리보기 창: PDF, Word, Excel, CSV 가 그려지고 내려받기 링크가 있으며 Esc 로 닫힌다', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    const kinds: [string, string, 'pdf' | 'office'][] = [
      [SEED.pdf, 'PDF', 'pdf'],
      [SEED.docx, 'Word', 'office'],
      [SEED.xlsx, 'Excel', 'office'],
      [SEED.csv, '텍스트', 'office'],
    ];
    for (const [title, chip, mode] of kinds) {
      const card = libraryCard(page, title);
      const opener = card.getByRole('button', { name: '미리보기' });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: `근거자료 미리보기: ${title}` });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.attach-preview-head .kind-chip')).toHaveText(chip);
      if (mode === 'pdf') {
        await expect
          .poll(() => dialog.locator('.textLayer').first().textContent(), { timeout: 30_000 })
          .toMatch(/[가-힣]{2,}/);
      } else {
        await expect(dialog.locator('.ovp-root [data-page] [data-o]').first()).toBeVisible({ timeout: 30_000 });
      }
      // 내려받기: ?dl=1 링크, 서버는 attachment + nosniff 로 보낸다
      const dl = dialog.getByRole('link', { name: /내려받기/ });
      await expect(dl).toHaveAttribute('href', /^\/api\/docs\/versions\/\d+\/file\?dl=1$/);
      const href = (await dl.getAttribute('href'))!;
      const res = await retryOnReset(() => page.request.get(href));
      expect(res.status()).toBe(200);
      expect(res.headers()['content-disposition'] ?? '').toMatch(/^attachment/);
      expect(res.headers()['x-content-type-options'] ?? '').toBe('nosniff');
      // 뷰어에서 열기 링크도 있다
      await expect(dialog.getByRole('link', { name: '뷰어에서 열기' })).toHaveAttribute('href', /^\/docs\/\d+\?v=\d+$/);
      await page.screenshot({ path: `${SHOT}/office-2-preview-${mode}-${chip}.png` });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      // 창을 닫으면 연 단추로 포커스가 돌아온다
      await expect(opener).toBeFocused();
    }
  });

  test('문서 뷰어: 시드 docx 쪽이 모두 그려지고 레일 p.N, 레일을 누르면 하이라이트가 펄스', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    const doc = await docByTitle(page, SEED.docx);
    await libraryCard(page, SEED.docx).getByRole('link', { name: '뷰어 열기' }).click();
    await expect(page).toHaveURL(new RegExp(`/docs/${doc.id}$`));
    const pane = page.locator('.docv-viewer .ovp-root[data-file-kind="docx"]');
    await expect(pane.locator('.ofv-page').first()).toBeVisible({ timeout: 30_000 });
    await expect(pane.locator('.ofv-page')).toHaveCount(doc.currentVersion!.pageCount);
    await expect(page.locator('.docv-head .badge', { hasText: 'Word' })).toBeVisible();
    await expect(page.getByRole('link', { name: '원본 내려받기' })).toHaveAttribute('href', /\/file\?dl=1$/);

    // 레일: Word 쪽 나눔 표지가 있는 docx 라 'p.N' (시드 앵커가 있다. 개수는 다른 사용자 때문에 세지 않는다)
    const items = page.locator('.docv-rail-list .docv-rail-item');
    await expect(items.first()).toBeVisible();
    for (const label of await items.locator('.docv-rail-page').allTextContents()) expect(label).toMatch(/^p\.\d+$/);

    // 레일 항목 클릭: 주소에 ?hl=<앵커>, 그 앵커 하이라이트가 펄스
    await page.locator('.docv-rail-item:not([disabled])').first().click();
    await expect(page).toHaveURL(/[?&]hl=\d+/);
    const hl = new URL(page.url()).searchParams.get('hl');
    await expect(pane.locator(`.pvp-part.hl-pulse[data-anchor="${hl}"]`).first()).toBeVisible({ timeout: 3_000 });
    await expect(pane.locator('.pvp-badge').first()).toBeVisible();
    await page.screenshot({ path: `${SHOT}/office-3-viewer-rail-pulse.png` });
  });

  test('문항 상세: 출처 줄이 형식별 표기, C 창이 docx 를 펄스와 함께 열고 원본 내려받기', async ({ page }) => {
    await login(page);
    // 3초 룩업 경로: 옴니박스 번호 패스트패스
    await page.keyboard.press('ControlOrMeta+k');
    const omni = page.getByRole('dialog', { name: '검색' });
    await expect(omni).toBeVisible();
    await omni.getByRole('textbox').fill('60060010');
    await expect(omni.locator('[role="option"]').first()).toContainText('60.060.010', { timeout: 5_000 });
    await omni.getByRole('textbox').press('Enter');
    await expect(page).toHaveURL(/\/q\/\d+/);
    await expect(page.locator('.qd3-head')).toContainText('60.060.010');

    const docxCard = evidenceCard(page, SEED.docx);
    const pdfCard = evidenceCard(page, SEED.pdf2);
    await expect(docxCard.locator('.evd-source')).toHaveText(new RegExp(`^${escapeRe(SEED.docx)} \\S+, p\\.\\d+$`));
    await expect(pdfCard.locator('.evd-source')).toHaveText(new RegExp(`^${escapeRe(SEED.pdf2)} \\S+, p\\.\\d+$`));

    await docxCard.getByRole('button', { name: '상세보기' }).click();
    const paneC = page.locator('.qd3-pane');
    await expect(paneC.locator('.ovp-root[data-file-kind="docx"]')).toBeVisible({ timeout: 30_000 });
    await expect(paneC.locator('.pvp-part.hl-pulse').first()).toBeVisible({ timeout: 5_000 });
    await expect(paneC.locator('.qd3-pane-title')).toContainText(SEED.docx);
    await expect(paneC.locator('.qd3-pane-head').getByRole('link', { name: '원본 내려받기' })).toHaveAttribute(
      'href',
      /^\/api\/docs\/versions\/\d+\/file\?dl=1$/,
    );
    await page.screenshot({ path: `${SHOT}/office-4-question-paneC-docx.png` });

    // 엑셀 근거(60.020.010)와 CSV 근거(60.030.010)의 출처 줄은 '시트 이름'
    for (const [typed, no, title] of [
      ['60020010', '60.020.010', SEED.xlsx],
      ['60030010', '60.030.010', SEED.csv],
    ] as const) {
      await page.keyboard.press('ControlOrMeta+k');
      await omni.getByRole('textbox').fill(typed);
      await expect(omni.locator('[role="option"]').first()).toContainText(no, { timeout: 5_000 });
      await omni.getByRole('textbox').press('Enter');
      await expect(page.locator('.qd3-head')).toContainText(no);
      const card = evidenceCard(page, title);
      await expect(card.locator('.evd-source')).toHaveText(new RegExp(`^${escapeRe(title)} \\S+, 시트 \\S.*$`));
      // 첫 근거가 자동으로 C 창에 열린다: 형식에 맞는 뷰어
      await expect(paneC.locator('.ovp-root [data-o]').first()).toBeVisible({ timeout: 30_000 });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. 업로드에서 매핑, 새 판본, 비교까지 (앞 단계가 만든 문서를 뒤 단계가 쓴다: 순서대로)
// ═════════════════════════════════════════════════════════════════════════════

/** [근거자료 파일 업로드] 단추로 올리는 문서 제목 (파일 이름에서 확장자를 뗀 것) */
const DOCX_TITLE = `${TAG} 점검 절차서`;
const XLSX_TITLE = `${TAG} 정보자산 목록`;
/** 끌어다 놓기로 올리는 파일 이름 (확장자를 뗀 이름이 제목이 된다) */
const BULK = {
  docx: `${TAG} 일괄 절차서.docx`,
  xlsx: `${TAG} 일괄 자산목록.xlsx`,
  pptx: `${TAG} 일괄 교육자료.pptx`,
  hwpx: `${TAG} 일괄 한글문서.hwpx`,
  csv: `${TAG} 일괄 접근기록.csv`,
  hwp: `${TAG} 구형 한글문서.hwp`,
  doc: `${TAG} 구형 워드문서.doc`,
  xls: `${TAG} 구형 엑셀문서.xls`,
  ppt: `${TAG} 구형 발표자료.ppt`,
};

test.describe('검사실 자료: 업로드에서 매핑, 새 버전, 버전 비교까지', () => {
  test.describe.configure({ mode: 'serial' });

  const S: {
    docxId?: number;
    docxV1?: number;
    docxV2?: number;
    xlsxId?: number;
    xlsxV1?: number;
    /** MAP_Q 의 문항 id (docx 매핑 단계가 앵커 응답에서 채운다) */
    mapQid?: number;
  } = {};

  test.afterAll(async ({ browser }, testInfo) => {
    if (createdLinks.length === 0) return;
    const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const p = await ctx.newPage();
    const res = await retryOnReset(() => p.request.post('/api/auth/login', { data: { username: USER, password: PASS } }));
    expect(res.ok(), `정리용 로그인 → ${res.status()}`).toBeTruthy();
    await removeLinks(p);
    await ctx.close();
  });

  test('[근거자료 파일 업로드] 단추: docx, xlsx 를 함께 고르면 파일 이름이 제목, 형식 칩과 단위가 맞다', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    // 머리의 올리기 단추는 이것 하나다 (예전 [일괄 업로드], [새 지침서 업로드]를 합쳤다)
    await expect(page.locator('.doclib-head-actions button')).toHaveText(['근거자료 파일 업로드']);
    await expect(page.locator('.doclib-year select')).toHaveValue(String(new Date().getFullYear()));

    const docxFile = { name: `${DOCX_TITLE}.docx`, mimeType: MIME.docx, buffer: procedureDocx({ markers: false, token: SEARCH_TOKEN }) };
    const xlsxFile = { name: `${XLSX_TITLE}.xlsx`, mimeType: MIME.xlsx, buffer: await assetXlsx(RUN) };
    // 업로드 응답을 모은다 (multipart 본문은 요청에서 읽을 수 없어 응답의 제목으로 가른다)
    const responses: { status: number; body: UploadBody & { title: string } }[] = [];
    page.on('response', async (r) => {
      if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/docs/auto') return;
      responses.push({ status: r.status(), body: (await r.json()) as UploadBody & { title: string } });
    });
    const chooserP = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '근거자료 파일 업로드' }).click();
    const chooser = await chooserP;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([docxFile, xlsxFile]);
    await expect(page.locator('.doclib-bulk')).toContainText('업로드 완료: 새 자료 2', { timeout: 60_000 });
    await expect.poll(() => responses.length).toBe(2);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const up1 = responses.find((r) => r.body.title === DOCX_TITLE)!.body;
    const up2 = responses.find((r) => r.body.title === XLSX_TITLE)!.body;

    expect(up1.fileKind).toBe('docx');
    S.docxId = up1.documentId;
    S.docxV1 = up1.versionId;
    // Word 쪽 나눔 표지가 없는 docx: 논리 쪽 이름표는 '구간 N' (명시적 쪽 나누기 하나라 2구간)
    const docxPages = await pagesOf(page, S.docxV1);
    expect(docxPages.length).toBeGreaterThanOrEqual(2);
    for (const p of docxPages) expect(p.label).toBe(`구간 ${p.pageNo}`);

    expect(up2.pageCount).toBe(2);
    S.xlsxId = up2.documentId;
    S.xlsxV1 = up2.versionId;
    expect((await pagesOf(page, S.xlsxV1)).map((p) => p.label)).toEqual(['자산목록', '점검이력']);

    const docx = await expectCardKindAndUnit(page, DOCX_TITLE, 'Word');
    expect(docx.id).toBe(S.docxId);
    await expectCardKindAndUnit(page, XLSX_TITLE, 'Excel');
    await page.screenshot({ path: `${SHOT}/office-5-single-upload.png` });
  });

  test('끌어다 놓기: Office 다섯 형식과 구형 hwp, doc, xls 는 신규 등록, 함께 놓은 .ppt 는 건너뜀 목록에 이름과 이유', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page);
    await page.goto('/docs');
    const files = [
      // 표지 없는 docx (이름표 '구간 N'): 쪽 표지가 있는 docx 는 시드 문서가 맡는다
      { name: BULK.docx, mimeType: MIME.docx, buffer: procedureDocx({ markers: false, token: `일괄표지${RUN}` }) },
      { name: BULK.xlsx, mimeType: MIME.xlsx, buffer: await assetXlsx(`일괄${RUN}`) },
      { name: BULK.pptx, mimeType: MIME.pptx, buffer: tinyPptx([[`${TAG} 정보보안 교육`, '백업 점검 결과 공유'], ['둘째 슬라이드', '접근권한 검토 일정']]) },
      { name: BULK.hwpx, mimeType: MIME.hwpx, buffer: tinyHwpx([`${TAG} 한글 문서`, '복구 시험 기록은 3년간 보존한다.']) },
      { name: BULK.csv, mimeType: MIME.csv, buffer: Buffer.concat([buildDemoCsv(), Buffer.from(`2026-07-15,${TAG},1,시험 행,정보보안팀\r\n`, 'utf8')]) },
      { name: BULK.hwp, mimeType: MIME.hwp, buffer: buildHwp({ paras: [{ text: `${TAG} 구형 한글 본문` }, { table: [['장비', '주기'], ['원심분리기', '매월']] }] }) },
      { name: BULK.doc, mimeType: MIME.doc, buffer: buildDoc({ paras: [{ text: `${TAG} 구형 워드 본문`, bold: [0, 6] }] }) },
      { name: BULK.xls, mimeType: MIME.xls, buffer: buildXls([{ name: '시약', rows: [[`${TAG} 구형 엑셀`, 12]] }]) },
      { name: BULK.ppt, mimeType: MIME.ppt, buffer: fakePpt() },
    ];
    // 서버로 간 업로드 요청 (받을 수 없는 형식은 화면이 보내지 않아야 한다)
    const autoPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/docs/auto') {
        autoPosts.push(r.postDataBuffer()?.toString('latin1') ?? '');
      }
    });
    await dropFiles(page, files);

    const bulk = page.locator('.doclib-bulk');
    await expect(bulk).toContainText('업로드 완료', { timeout: 120_000 });
    // 이번 실행의 여덟 파일은 제목이 새것이라 모두 새 자료, 실패 없음
    await expect(bulk).toContainText('새 자료 8');
    await expect(bulk.locator('.doclib-bulk-failed')).toHaveCount(0);
    const skipped = bulk.locator('.doclib-bulk-skipped li').filter({ hasText: BULK.ppt });
    await expect(skipped).toHaveCount(1);
    await expect(skipped).toContainText('구형 PowerPoint (ppt) 파일은 올릴 수 없습니다');
    expect(autoPosts).toHaveLength(8);
    expect(autoPosts.some((b) => b.includes('.ppt"'))).toBe(false);
    await page.screenshot({ path: `${SHOT}/office-6-bulk.png` });

    for (const [name, chip] of [
      [BULK.docx, 'Word'],
      [BULK.xlsx, 'Excel'],
      [BULK.pptx, 'PowerPoint'],
      [BULK.hwpx, '한글'],
      [BULK.csv, '텍스트'],
      [BULK.hwp, '한글'],
      [BULK.doc, 'Word'],
      [BULK.xls, 'Excel'],
    ] as const) {
      await expectCardKindAndUnit(page, stripExt(name), chip);
    }
    // 구형은 같은 계열 형식으로 저장하고 추출기만 다르다
    for (const [name, kind] of [
      [BULK.hwp, 'hwpx'],
      [BULK.doc, 'docx'],
      [BULK.xls, 'xlsx'],
    ] as const) {
      expect((await docByTitle(page, stripExt(name))).currentVersion?.fileKind).toBe(kind);
    }
    // 쪽 수는 형식 규칙대로: 시트 2장, 슬라이드 2장
    expect((await docByTitle(page, stripExt(BULK.xlsx))).currentVersion?.pageCount).toBe(2);
    expect((await docByTitle(page, stripExt(BULK.pptx))).currentVersion?.pageCount).toBe(2);
    // .ppt 는 문서가 되지 않았다
    const { docs } = await getJson<{ docs: DocRow[] }>(page, '/api/docs');
    expect(docs.some((d) => d.title === stripExt(BULK.ppt))).toBe(false);

    // PowerPoint, 한글(hwpx, hwp), 구형 Word 도 미리보기 창에 그려진다
    for (const title of [stripExt(BULK.pptx), stripExt(BULK.hwpx), stripExt(BULK.hwp), stripExt(BULK.doc)]) {
      await libraryCard(page, title).getByRole('button', { name: '미리보기' }).click();
      const dialog = page.getByRole('dialog', { name: `근거자료 미리보기: ${title}` });
      await expect(dialog.locator('.ovp-root [data-page] [data-o]').first()).toBeVisible({ timeout: 30_000 });
      await expect(dialog.locator('.ovp-root')).toContainText(TAG);
      const shotName = title === stripExt(BULK.pptx) ? 'pptx' : title === stripExt(BULK.hwpx) ? 'hwpx' : title === stripExt(BULK.hwp) ? 'hwp' : 'doc';
      await page.screenshot({ path: `${SHOT}/office-6-preview-${shotName}.png` });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });

  test('본문 검색: 결과를 누르면 뷰어가 ?q= 로 열리고 검색어 자리에 표시가 보인다', async ({ page }) => {
    expect(S.docxId, '단추 업로드 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await page.goto('/docs');
    await page.getByRole('textbox', { name: '근거자료 본문 검색' }).fill(SEARCH_TOKEN);
    await page.getByRole('button', { name: '본문 검색' }).click();
    const hit = page.locator('.doclib-hit-list li button').filter({ hasText: DOCX_TITLE });
    await expect(hit).toHaveCount(1, { timeout: 10_000 });
    await expect(hit.locator('.doclib-hit-meta')).toContainText('Word');
    await expect(hit.locator('.doclib-hit-meta')).toContainText('구간 1');
    await hit.click();
    await expect(page).toHaveURL(new RegExp(`/docs/${S.docxId}\\?.*q=`));
    expect(new URL(page.url()).searchParams.get('q')).toBe(SEARCH_TOKEN);
    const pane = page.locator('.docv-viewer .ovp-root[data-file-kind="docx"]');
    const mark = pane.locator('.ovp-search').first();
    await expect(mark).toBeVisible({ timeout: 30_000 });
    // 표시는 검색어가 든 글자 조각 위에 있다
    const piece = pane.locator('[data-o]').filter({ hasText: SEARCH_TOKEN }).first();
    await expect(piece).toBeInViewport();
    expect(overlaps((await mark.boundingBox())!, (await piece.boundingBox())!, 0.5)).toBe(true);
    await page.screenshot({ path: `${SHOT}/office-7-search-mark.png` });
  });

  test('docx 매핑: 마우스로 문장을 끌어 고르고 Enter, 앵커 생성(API), 하이라이트, 레일 갱신', async ({ page }) => {
    expect(S.docxV1, '단추 업로드 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await page.goto(`/docs/${S.docxId}`);
    const pane = page.locator('.docv-viewer .ovp-root[data-file-kind="docx"]');
    await expect(pane.locator('.ofv-page').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.docv-rail-msg')).toContainText('아직 연결된 근거가 없습니다');
    await enterMapMode(page, MAP_Q);

    const piece = pane.locator('[data-o]').filter({ hasText: SENTENCE_A }).first();
    await dragSelect(page, piece, SENTENCE_A);
    const toolbar = page.getByRole('toolbar', { name: '근거 연결' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toContainText(`「${MAP_Q.no}」`);
    await page.keyboard.press('Enter');
    await expect(page.locator('.pvp-toast')).toContainText(`「${MAP_Q.no}」에 연결됨`);

    // 서버: 오프셋만 받은 앵커(좌표 없음), 인용은 고른 문장 그대로
    const anchor = await waitAnchor(page, S.docxV1!, SENTENCE_A);
    expect(anchor.rects).toBeNull();
    expect(anchor.pageLabel).toMatch(/^구간 \d+$/);
    const qRef = anchor.questions.find((q) => q.questionNo === MAP_Q.no);
    expect(qRef, `앵커가 ${MAP_Q.no} 에 연결돼야 한다`).toBeTruthy();
    createdLinks.push({ passageId: anchor.passageId, questionId: qRef!.id });
    S.mapQid = qRef!.id;

    // 하이라이트: 그 앵커의 조각이 고른 문장 위에 그려진다
    const part = pane.locator(`.pvp-part[data-anchor="${anchor.anchorId}"]`).first();
    await expect(part).toBeVisible();
    expect(overlaps((await part.boundingBox())!, (await piece.boundingBox())!)).toBe(true);
    // 레일: 새 항목, 위치 표기 '구간 N', 문항 번호
    const item = page.locator('.docv-rail-item').filter({ hasText: SENTENCE_A.slice(0, 12) });
    await expect(item).toHaveCount(1);
    await expect(item.locator('.docv-rail-page')).toHaveText(anchor.pageLabel!);
    await expect(item.locator('.docv-rail-nos')).toContainText(MAP_Q.no);
    await page.screenshot({ path: `${SHOT}/office-8-docx-mapped.png` });

    // Esc 로 근거 연결 모드 끝내기
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '근거 연결 모드(M)' })).toBeVisible();
    await expect(page.locator('.pvp-mapbar')).toHaveCount(0);
  });

  test('xlsx 매핑: 칸 하나 안의 글자를 골라 연결, 격자 위 하이라이트', async ({ page }) => {
    expect(S.xlsxV1, '단추 업로드 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await page.goto(`/docs/${S.xlsxId}`);
    const pane = page.locator('.docv-viewer .ovp-root[data-file-kind="xlsx"]');
    const piece = pane.locator('.osv-grid [data-o]').filter({ hasText: CELL_TEXT }).first();
    await expect(piece).toBeVisible({ timeout: 30_000 });
    await enterMapMode(page, MAP_Q);

    await dragSelect(page, piece, CELL_TEXT);
    const toolbar = page.getByRole('toolbar', { name: '근거 연결' });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: /^연결/ }).click();
    await expect(page.locator('.pvp-toast')).toContainText(`「${MAP_Q.no}」에 연결됨`);

    const anchor = await waitAnchor(page, S.xlsxV1!, CELL_TEXT);
    expect(anchor.rects).toBeNull();
    expect(anchor.pageLabel).toBe('자산목록');
    createdLinks.push({ passageId: anchor.passageId, questionId: anchor.questions.find((q) => q.questionNo === MAP_Q.no)!.id });

    // 하이라이트는 그 칸 안에 그려진다
    const part = pane.locator(`.pvp-part[data-anchor="${anchor.anchorId}"]`).first();
    await expect(part).toBeVisible();
    const cellBox = (await piece.locator('xpath=ancestor::td[1]').boundingBox())!;
    const partBox = (await part.boundingBox())!;
    expect(partBox.x).toBeGreaterThanOrEqual(cellBox.x - 1);
    expect(partBox.x + partBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 1);
    expect(partBox.y).toBeGreaterThanOrEqual(cellBox.y - 1);
    expect(partBox.y + partBox.height).toBeLessThanOrEqual(cellBox.y + cellBox.height + 1);
    const item = page.locator('.docv-rail-item').filter({ hasText: CELL_TEXT });
    await expect(item.locator('.docv-rail-page')).toHaveText('시트 자산목록');
    await page.screenshot({ path: `${SHOT}/office-9-xlsx-mapped.png` });
  });

  test('PowerPoint, 한글, CSV 매핑과 문항 상세: 출처 줄이 슬라이드, 구간, 시트로 적히고 C 창이 펄스', async ({ page }) => {
    expect(S.mapQid, 'docx 매핑 단계가 먼저 성공해야 한다').toBeTruthy();
    test.setTimeout(120_000);
    await login(page);
    const cases = [
      { title: stripExt(BULK.pptx), kind: 'pptx', text: '백업 점검 결과 공유', loc: '슬라이드 1' },
      { title: stripExt(BULK.hwpx), kind: 'hwpx', text: '복구 시험 기록은 3년간 보존한다.', loc: '구간 1' },
      { title: stripExt(BULK.csv), kind: 'text', text: '시험 행', loc: `시트 ${stripExt(BULK.csv)}` },
    ];
    for (const c of cases) {
      const doc = await docByTitle(page, c.title);
      await page.goto(`/docs/${doc.id}`);
      const pane = page.locator(`.docv-viewer .ovp-root[data-file-kind="${c.kind}"]`);
      const piece = pane.locator('[data-o]').filter({ hasText: c.text }).first();
      await expect(piece).toBeVisible({ timeout: 30_000 });
      await enterMapMode(page, MAP_Q);
      await dragSelect(page, piece, c.text);
      await expect(page.getByRole('toolbar', { name: '근거 연결' })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.locator('.pvp-toast')).toContainText(`「${MAP_Q.no}」에 연결됨`);
      const anchor = await waitAnchor(page, doc.currentVersion!.id, c.text);
      expect(anchor.rects).toBeNull();
      createdLinks.push({ passageId: anchor.passageId, questionId: S.mapQid! });
      const part = pane.locator(`.pvp-part[data-anchor="${anchor.anchorId}"]`).first();
      await expect(part).toBeVisible();
      expect(overlaps((await part.boundingBox())!, (await piece.boundingBox())!)).toBe(true);
      await expect(page.locator('.docv-rail-item').filter({ hasText: c.text }).locator('.docv-rail-page')).toHaveText(c.loc);
      await page.keyboard.press('Escape');
    }

    // 문항 상세: 이번 실행이 이 문항에 건 근거(Word, Excel, PowerPoint, 한글, CSV)의 출처 줄과 C 창
    await page.goto(`/q/${S.mapQid}`);
    await expect(page.locator('.qd3-head')).toContainText(MAP_Q.no);
    const sources: [string, string, string][] = [
      [DOCX_TITLE, 'docx', '구간 2'],
      [XLSX_TITLE, 'xlsx', '시트 자산목록'],
      ...cases.map((c): [string, string, string] => [c.title, c.kind, c.loc]),
    ];
    for (const [title, kind, loc] of sources) {
      const card = evidenceCard(page, title);
      await expect(card.locator('.evd-source')).toHaveText(new RegExp(`^${escapeRe(title)} \\S+, ${escapeRe(loc)}$`));
      await card.getByRole('button', { name: '상세보기' }).click();
      const paneC = page.locator('.qd3-pane');
      await expect(paneC.locator(`.ovp-root[data-file-kind="${kind}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(paneC.locator('.pvp-part.hl-pulse').first()).toBeVisible({ timeout: 5_000 });
      await expect(paneC.locator('.qd3-pane-head').getByRole('link', { name: '원본 내려받기' })).toBeVisible();
    }
    await page.screenshot({ path: `${SHOT}/office-9b-question-all-kinds.png` });
  });

  test('새 버전(docx, 문장 수정): 재앵커링 요약, 버전 비교(줄 단위)', async ({ page }) => {
    expect(createdLinks.length, 'docx 매핑 단계가 먼저 성공해야 한다').toBeGreaterThan(0);
    await login(page);
    await page.goto('/docs');
    await libraryCard(page, DOCX_TITLE).getByRole('button', { name: '새 버전 업로드' }).click();
    await expect(page.locator('form.doclib-upload .card-title')).toContainText(DOCX_TITLE);
    const up = await submitUploadForm(page, {
      label: 'v2',
      file: { name: `${TAG} 점검 절차서 v2.docx`, mimeType: MIME.docx, buffer: procedureDocx({ markers: false, token: SEARCH_TOKEN, days: 5 }) },
      kindChip: 'Word',
    });
    // 이 문서의 앵커는 하나이고 그 문장은 그대로다: 정확 일치로 자동 이관
    expect(up.body.reanchor).toEqual({ auto: 1, needsReview: 0 });
    expect(up.notice).toContain('근거 위치 옮김: 자동 1건, 확인 필요 0건.');
    expect(up.body.documentId).toBe(S.docxId);
    S.docxV2 = up.body.versionId;
    expect(S.docxV2).not.toBe(S.docxV1);
    const moved = (await anchorsOf(page, S.docxV2)).filter((a) => a.quote === SENTENCE_A);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.status).toMatch(/^resolved/);
    expect(moved[0]!.rects).toBeNull();

    // 판본 비교: 같은 형식이라 줄 단위, '7일' 줄이 빠지고 '5일' 줄이 들어온다
    await libraryCard(page, DOCX_TITLE).getByRole('link', { name: '버전 비교' }).click();
    await expect(page).toHaveURL(new RegExp(`/docs/${S.docxId}/compare`));
    await expect(page.locator('.doccmp-line.doccmp-del')).toContainText('7일 안에');
    await expect(page.locator('.doccmp-line.doccmp-add')).toContainText('5일 안에');
    await expect(page.locator('.doccmp-stats .doccmp-add')).toHaveText('+1줄');
    await expect(page.locator('.doccmp-stats .doccmp-del')).toHaveText('−1줄');
    await expect(page.locator('.doccmp-kind-note')).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/office-10-compare-lines.png` });
  });

  test('새 버전(xlsx, 연결한 칸 글자 수정): 몰래 옮기지 않고 확인 필요로 남긴다', async ({ page }) => {
    expect(S.xlsxV1, 'xlsx 매핑 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await page.goto('/docs');
    await libraryCard(page, XLSX_TITLE).getByRole('button', { name: '새 버전 업로드' }).click();
    const up = await submitUploadForm(page, {
      label: 'v2',
      // 연결한 글자가 새 판본 어디에도 그대로 남지 않게 바꾼다('검사정보시스템 서버' → '검사정보시스템 주 서버')
      file: { name: `${TAG} 정보자산 목록 v2.xlsx`, mimeType: MIME.xlsx, buffer: await assetXlsx(RUN, '검사정보시스템 주 서버') },
      kindChip: 'Excel',
    });
    expect(up.body.reanchor).toEqual({ auto: 0, needsReview: 1 });
    expect(up.notice).toContain('근거 위치 옮김: 자동 0건, 확인 필요 1건.');
    const doc = await docByTitle(page, XLSX_TITLE);
    const v2 = up.body.versionId;
    expect(doc.currentVersion?.id).toBe(v2);
    expect(v2).not.toBe(S.xlsxV1);
    const pending = (await anchorsOf(page, v2)).find((a) => a.quote === CELL_TEXT);
    expect(pending?.status).toBe('needs_review');
    expect(pending?.startOffset ?? null).toBeNull();

    await page.goto(`/docs/${doc.id}`);
    await expect(page.locator('.docv-viewer .ovp-root[data-file-kind="xlsx"] [data-o]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.docv-head .badge-recheck')).toContainText('위치 확인 필요 1건');
    const item = page.locator('.docv-rail-item').filter({ hasText: CELL_TEXT });
    await expect(item).toBeDisabled();
    await expect(item.locator('.badge')).toHaveText('확인 필요');
    await expect(page.locator(`.pvp-part[data-anchor="${pending!.anchorId}"]`)).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/office-10b-xlsx-needs-review.png` });
  });

  test('형식이 다른 새 버전(docx 다음 txt): 형식 변경 안내, 버전 비교는 단어 단위 안내', async ({ page }) => {
    expect(S.docxV2, '새 버전 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    // 새 판본 txt: 직전 판본 글자에서 낱말 하나만 바꾼다
    const prev = await pagesOf(page, S.docxV2!);
    const text = prev
      .map((p) => p.text)
      .join('\n')
      .replace('5일 안에', '3일 안에');
    await page.goto('/docs');
    await libraryCard(page, DOCX_TITLE).getByRole('button', { name: '새 버전 업로드' }).click();
    const form = page.locator('form.doclib-upload');
    await form.locator('label.field', { hasText: '버전 이름' }).locator('input').fill('v3');
    const chooserP = page.waitForEvent('filechooser');
    await form.getByRole('button', { name: '파일 선택' }).first().click();
    await (await chooserP).setFiles({ name: `${TAG} 점검 절차서 v3.txt`, mimeType: MIME.txt, buffer: Buffer.from(text, 'utf8') });
    await expect(form.locator('.doclib-kind-note')).toContainText('현재 버전은 Word, 고른 파일은 텍스트입니다');
    await form.getByRole('button', { name: '업로드', exact: true }).click();
    const notice = page.locator('.doclib-notice');
    await expect(notice).toContainText(/업로드 완료: \d+구간 처리\./, { timeout: 30_000 });
    await expect(notice).toContainText('근거 위치 옮김');

    await libraryCard(page, DOCX_TITLE).getByRole('link', { name: '버전 비교' }).click();
    await expect(page.locator('.doccmp-kind-note')).toContainText('형식이 다른 버전끼리는 줄 단위 대신 단어 단위로 비교합니다');
    await expect(page.locator('.doccmp-words')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.doccmp-words del').first()).toContainText('5일');
    await expect(page.locator('.doccmp-words ins').first()).toContainText('3일');
    await expect(page.locator('.doccmp-stats')).toContainText('단어');
    // 선택지에 형식이 함께 적힌다
    await expect(page.locator('.doccmp-toolbar select').first().locator('option:checked')).toHaveText(/\(Word\)$/);
    await expect(page.locator('.doccmp-toolbar select').nth(1).locator('option:checked')).toHaveText(/\(텍스트\)$/);
    await page.screenshot({ path: `${SHOT}/office-11-compare-words.png` });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PDF 회귀: 시드 PDF 에서 매핑 (만든 연결은 끝에서 지운다)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('PDF 회귀', () => {
  test('시드 PDF: 매핑 모드에서 문장을 끌어 연결하면 하이라이트가 보인다', async ({ page }) => {
    await login(page);
    const doc = await docByTitle(page, SEED.pdf);
    const vid = doc.currentVersion!.id;
    const before = new Set((await anchorsOf(page, vid)).map((a) => a.anchorId));
    try {
      await page.goto(`/docs/${doc.id}`);
      const span = page.locator('.textLayer span').filter({ hasText: PDF_SENTENCE }).first();
      await expect(span).toBeVisible({ timeout: 30_000 });
      await enterMapMode(page, PDF_Q);
      await dragSelect(page, span, PDF_SENTENCE);
      await expect(page.locator('.pvp-toolbar').first()).toBeVisible();
      await page.keyboard.press('Enter');
      // 이전 실행이 지우지 못한 같은 자리 앵커가 있으면 겹침 제안이 뜬다: 새로 만든다
      const overlap = page.locator('.pvp-overlap');
      const toast = page.locator('.pvp-toast');
      await expect(overlap.or(toast).first()).toBeVisible();
      if (await overlap.isVisible()) await overlap.getByRole('button', { name: '새로 만들기' }).click();
      await expect(toast).toContainText(`「${PDF_Q.no}」에 연결됨`);

      let created: AnchorRow | undefined;
      await expect
        .poll(async () => {
          created = (await anchorsOf(page, vid)).find(
            (a) => !before.has(a.anchorId) && a.quote.includes(PDF_SENTENCE.slice(0, 10)),
          );
          return created?.status;
        })
        .toBe('resolved');
      createdLinks.push({ passageId: created!.passageId, questionId: created!.questions.find((q) => q.questionNo === PDF_Q.no)!.id });
      expect(created!.rects).not.toBeNull(); // PDF 는 좌표를 함께 저장한다

      // 하이라이트: 고른 글자 조각과 겹치는 조각이 있다
      const spanBox = (await span.boundingBox())!;
      await expect
        .poll(async () => {
          const boxes = await page.locator('.pvp-part').evaluateAll((els) =>
            els.map((e) => {
              const r = e.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            }),
          );
          return boxes.some((b) => overlaps(b, spanBox, 0.5));
        })
        .toBe(true);
      await expect(page.locator('.docv-rail-item').filter({ hasText: PDF_SENTENCE.slice(0, 12) }).first()).toBeVisible();
      await page.screenshot({ path: `${SHOT}/office-12-pdf-mapped.png` });
    } finally {
      await removeLinks(page);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. 쪽 수 단위 규칙 (538be88): 단위가 첫 쪽 이름표를 따른다.
//    위의 시험들은 서버가 알려 준 이름표로 단위를 맞춰 보므로, 서버가 이름표를 보내는지는 여기서 따로 못 박는다.
//    이번 실행의 일괄 업로드 단계가 만든 표지 없는 docx 를 쓴다(같은 파일 안에서 순서대로 돈다).
// ═════════════════════════════════════════════════════════════════════════════

test.describe('쪽 수 단위: 첫 쪽 이름표를 따른다', () => {
  test('쪽 정보 없는 docx 는 구간, 이름 있는 csv 는 시트, 쪽 표지 있는 docx 는 쪽', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    const unitCell = (title: string, unit: string) =>
      libraryCard(page, title).locator('.doclib-nowrap').filter({ hasText: new RegExp(`^\\d+${unit}$`) });

    const csv = await docByTitle(page, SEED.csv);
    expect(csv.currentVersion?.firstPageLabel, '목록 응답에 첫 쪽 이름표(firstPageLabel)가 있어야 한다').toBe(SEED.csv);
    await expect(unitCell(SEED.csv, '시트')).toHaveCount(1);

    const docx = await docByTitle(page, SEED.docx);
    expect(docx.currentVersion?.firstPageLabel ?? null).toBeNull();
    await expect(unitCell(SEED.docx, '쪽')).toHaveCount(1);

    const bulkDocx = await docByTitle(page, stripExt(BULK.docx));
    expect(bulkDocx.currentVersion?.firstPageLabel).toBe('구간 1');
    await expect(unitCell(stripExt(BULK.docx), '구간')).toHaveCount(1);
  });
});
