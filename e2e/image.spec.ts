/**
 * 근거자료 그림 파일 E2E (설계서 §3.6): 글자를 읽지 않는 그림 자료를 실제 브라우저로 따라간다.
 *
 * 전제: 데모 시드가 들어간 서버 하나(E2E_BASE_URL), admin/day1pass. 시드 그림 '가상기관 망 분리 구성도'(png)는
 *   60.040.010 의 그림 전체 근거로 이어져 있다(seed/seed-demo.ts 4-3).
 *
 * 다른 사람이 같은 서버를 함께 쓸 수 있다고 본다.
 * - 이 파일이 만드는 자료는 이번 실행의 합성 그림(seed/image-fixtures.ts)이고 제목이 'V-e2e-img <실행 표지>' 로 시작한다.
 * - 시드 자료는 읽기만 한다. 이 파일이 만든 문항 연결은 끝에서 지운다.
 * - 모든 시험에서 외부(localhost 밖) 요청과 페이지 예외(pageerror)가 0건이어야 한다.
 *
 * 실행 예 (빌드한 서버, 설치된 Chrome):
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/image.spec.ts --workers=1
 */
import { test as base, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { buildDemoPng } from '../seed/image-fixtures.js';

const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots';
const USER = 'admin';
const PASS = 'day1pass';
const RUN = Date.now().toString(36);
const TAG = `V-e2e-img ${RUN}`;

/** 시드 그림과 그 근거 문항 */
const SEED_IMG = '가상기관 망 분리 구성도';
const SEED_Q = { no: '60.040.010', typed: '60040010' };
/** 이 파일이 그림을 연결하는 문항: 시드 근거가 없는 문항 */
const LINK_Q = { no: '60.040.020', typed: '60040020' };
/** [내 PC에서 선택]으로 올리는 그림 (확장자를 뗀 이름이 제목) */
const IMG_TITLE = `${TAG} 서버실 배치도`;

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

interface DocRow {
  id: number;
  title: string;
  currentVersion: { id: number; fileKind?: string; pageCount: number } | null;
}
interface AnchorRow {
  anchorId: number;
  passageId: number;
  status: string;
  quote: string;
  geometryPrimary: boolean;
  questions: { id: number; questionNo: string }[];
}

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

/** 연결 끊김(ECONNRESET)에만 두 번까지 다시 보낸다 (같은 요청을 다시 보내도 되는 GET, 연결 해제) */
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

async function docByTitle(page: Page, title: string): Promise<DocRow> {
  const { docs } = await getJson<{ docs: DocRow[] }>(page, '/api/docs');
  const hit = docs.filter((d) => d.title === title).sort((a, b) => a.id - b.id)[0];
  expect(hit, `문서 '${title}' 이 서버에 없다`).toBeTruthy();
  return hit!;
}

async function anchorsOf(page: Page, versionId: number): Promise<AnchorRow[]> {
  return (await getJson<{ anchors: AnchorRow[] }>(page, `/api/docs/versions/${versionId}/anchors`)).anchors;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function libraryRow(page: Page, title: string): Locator {
  return page
    .locator('tr.doclib-row')
    .filter({ has: page.locator('.doclib-row-title').getByText(title, { exact: true }) })
    .first();
}

function evidenceCard(page: Page, docTitle: string): Locator {
  return page
    .locator('.evd-card')
    .filter({ has: page.locator('.evd-source', { hasText: new RegExp(`^${escapeRe(docTitle)} `) }) })
    .first();
}

/** 그림이 실제로 풀려 그려졌는가 (naturalWidth > 0) */
async function expectImageDrawn(img: Locator): Promise<void> {
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

/** 옴니박스 번호 패스트패스로 문항 상세를 연다 */
async function openQuestion(page: Page, q: { no: string; typed: string }): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const omni = page.getByRole('dialog', { name: '검색' });
  await expect(omni).toBeVisible();
  await omni.getByRole('textbox').fill(q.typed);
  await expect(omni.locator('[role="option"]').first()).toContainText(q.no, { timeout: 5_000 });
  await omni.getByRole('textbox').press('Enter');
  await expect(page).toHaveURL(/\/q\/\d+/);
  await expect(page.locator('.qd3-head')).toContainText(q.no);
}

// 이 파일이 만든 문항 연결: 끝에서 지운다
const createdLinks: { passageId: number; questionId: number }[] = [];

test.afterAll(async ({ browser }, testInfo) => {
  if (createdLinks.length === 0) return;
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const p = await ctx.newPage();
  const res = await retryOnReset(() => p.request.post('/api/auth/login', { data: { username: USER, password: PASS } }));
  expect(res.ok(), `정리용 로그인 → ${res.status()}`).toBeTruthy();
  while (createdLinks.length > 0) {
    const l = createdLinks.pop()!;
    const del = await retryOnReset(() => p.request.delete(`/api/passages/${l.passageId}/links/${l.questionId}?confirm=1`));
    expect([200, 404], `연결 해제 ${l.passageId}/${l.questionId} → ${del.status()}`).toContain(del.status());
  }
  await ctx.close();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. 시드 그림 읽기 (자료를 바꾸지 않는다)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('그림 자료: 시드 그림 읽기', () => {
  test('목록: 유형 png, 분량 1장, 크기, 연결 문항 1', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    const row = libraryRow(page, SEED_IMG);
    await expect(row).toBeVisible();
    await expect(row.locator('.doclib-col-type')).toHaveText('png');
    await expect(row.locator('.doclib-col-type')).toHaveAttribute('title', '그림 파일');
    await expect(row.locator('.doclib-col-amount')).toHaveText('1장');
    await expect(row.locator('.doclib-col-size')).toHaveText(/^\d+(\.\d)?(B|KB|MB)$/);
    await expect(row.locator('.doclib-col-linked')).toHaveText('1');
    // 올릴 수 있는 형식 안내에 그림과 '글자를 읽지 않음'
    await expect(page.locator('.doclib-formats')).toContainText('그림(png, jpg, gif, webp, bmp)');
    await expect(page.locator('.doclib-formats')).toContainText('글자를 읽지 않으므로');
  });

  test('미리보기 창: 그림이 그려지고 형식 칩은 그림, 연결 문항 배지, Esc 로 닫힌다', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    await libraryRow(page, SEED_IMG).getByRole('button', { name: '미리보기' }).click();
    const dialog = page.getByRole('dialog', { name: `근거자료 미리보기: ${SEED_IMG}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.attach-preview-head .kind-chip')).toHaveText('그림');
    await expectImageDrawn(dialog.locator('.ivp-root .ivp-figure img'));
    await expect(dialog.locator('.ivp-figure.is-linked')).toBeVisible();
    await expect(dialog.locator('.ivp-badge')).toContainText(SEED_Q.no);
    await page.screenshot({ path: `${SHOT}/image-1-preview.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('문항 상세: 근거 카드에 그림, C 창은 그림 뷰어(테두리, 배지), 원본 내려받기', async ({ page }) => {
    await login(page);
    await openQuestion(page, SEED_Q);
    const card = evidenceCard(page, SEED_IMG);
    await expect(card.locator('.evd-source')).toHaveText(new RegExp(`^${escapeRe(SEED_IMG)} \\S+, 그림$`));
    await expectImageDrawn(card.locator('.evd-thumb img'));
    await card.getByRole('button', { name: '상세보기' }).click();
    const paneC = page.locator('.qd3-pane');
    await expect(paneC.locator('.ivp-root[data-file-kind="image"]')).toBeVisible({ timeout: 30_000 });
    await expectImageDrawn(paneC.locator('.ivp-figure img'));
    await expect(paneC.locator('.ivp-figure.is-linked')).toBeVisible();
    await expect(paneC.locator('.ivp-figure.hl-pulse')).toBeVisible({ timeout: 5_000 });
    await expect(paneC.locator('.qd3-pane-head').getByRole('link', { name: '원본 내려받기' })).toHaveAttribute(
      'href',
      /^\/api\/docs\/versions\/\d+\/file\?dl=1$/,
    );
    await page.screenshot({ path: `${SHOT}/image-2-question.png` });
  });

  test('문서 뷰어: 형식 배지 그림, 레일에 그림 전체와 문항, 누르면 그림이 펄스', async ({ page }) => {
    await login(page);
    const doc = await docByTitle(page, SEED_IMG);
    await page.goto(`/docs/${doc.id}`);
    await expect(page.locator('.docv-head .badge-basic')).toHaveText('그림');
    const item = page.locator('.docv-rail-item').filter({ hasText: SEED_Q.no });
    await expect(item.locator('.docv-rail-page')).toHaveText('그림');
    await expect(item.locator('.docv-rail-quote')).toHaveText('그림 전체');
    await item.click();
    await expect(page.locator('.ivp-figure.hl-pulse')).toBeVisible({ timeout: 5_000 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. 올리기에서 연결, 새 버전, 확인, 버전 비교까지 (앞 단계가 만든 자료를 뒤 단계가 쓴다)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('그림 자료: 올리기에서 연결, 새 버전 확인, 버전 비교까지', () => {
  test.describe.configure({ mode: 'serial' });

  const S: { docId?: number; v1?: number; v2?: number; linkQid?: number } = {};

  test('[내 PC에서 선택]: png 는 그림으로 등록, 함께 고른 HEIC 는 건너뜀 목록에 바꾸는 방법', async ({ page }) => {
    await login(page);
    await page.goto('/docs');
    const responses: { status: number; body: { documentId: number; versionId: number; title: string; fileKind?: string; pageCount?: number } }[] = [];
    page.on('response', async (r) => {
      if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/docs/auto') return;
      responses.push({ status: r.status(), body: await r.json() });
    });
    const chooserP = page.waitForEvent('filechooser');
    await page.locator('.doclib-drop').getByRole('button', { name: '내 PC에서 선택' }).click();
    const chooser = await chooserP;
    const heicName = `${TAG} 아이폰 사진.HEIC`;
    await chooser.setFiles([
      { name: `${IMG_TITLE}.png`, mimeType: 'image/png', buffer: buildDemoPng() },
      { name: heicName, mimeType: 'image/heic', buffer: Buffer.from('not really heic') },
    ]);
    const bulk = page.locator('.doclib-bulk');
    await expect(bulk).toContainText('업로드 완료: 새 자료 1', { timeout: 60_000 });
    await expect(bulk).toContainText(heicName);
    await expect(bulk).toContainText('JPG로 바꿔');
    // HEIC 는 화면이 확장자로 먼저 걸러 서버로 보내지 않는다
    await expect.poll(() => responses.length).toBe(1);
    expect(responses[0]!.status).toBe(201);
    expect(responses[0]!.body).toMatchObject({ title: IMG_TITLE, fileKind: 'image', pageCount: 1 });
    S.docId = responses[0]!.body.documentId;
    S.v1 = responses[0]!.body.versionId;
    const row = libraryRow(page, IMG_TITLE);
    await expect(row.locator('.doclib-col-type')).toHaveText('png');
    await expect(row.locator('.doclib-col-amount')).toHaveText('1장');
    await expect(row.locator('.doclib-col-linked')).toHaveText('0');
  });

  test('문항 상세에서 연결: 근거자료 연결 창에서 그림을 고르고 [이 그림 연결](Enter), 근거 카드에 그림', async ({ page }) => {
    expect(S.v1, '올리기 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await openQuestion(page, LINK_Q);
    // 단추로 연결 창을 연다: 창이 닫힌 뒤 포커스가 그 단추(뷰어 밖)에 있어도 Enter 는 그림 연결이어야 한다
    await page.getByRole('button', { name: '+ 근거자료 연결' }).first().click();
    const picker = page.getByRole('dialog', { name: '연결할 근거자료 선택' });
    await expect(picker).toBeVisible();
    await picker.getByRole('textbox', { name: '근거자료 검색' }).fill(IMG_TITLE);
    const option = picker.locator('[role="option"]').filter({ hasText: IMG_TITLE }).first();
    await expect(option).toContainText('1장');
    await expect(option.locator('.kind-chip')).toHaveText('그림');
    await option.click();
    await expect(picker).toBeHidden();

    const paneC = page.locator('.qd3-pane');
    const mapbar = paneC.locator('.ivp-mapbar');
    await expect(mapbar).toContainText(`「${LINK_Q.no}」`);
    await expect(mapbar).toContainText('그림 전체');
    await expectImageDrawn(paneC.locator('.ivp-figure img'));
    await page.screenshot({ path: `${SHOT}/image-3-map-mode.png` });
    await page.keyboard.press('Enter');
    await expect(page.locator('.pvp-toast')).toContainText(`「${LINK_Q.no}」에 이 그림을 근거로 연결했습니다`);

    const anchors = await anchorsOf(page, S.v1!);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ status: 'resolved', quote: '', geometryPrimary: true });
    const q = anchors[0]!.questions.find((x) => x.questionNo === LINK_Q.no);
    expect(q, '연결한 문항이 앵커에 있어야 한다').toBeTruthy();
    S.linkQid = q!.id;
    createdLinks.push({ passageId: anchors[0]!.passageId, questionId: q!.id });

    // 같은 문항을 다시 이으면 새로 만들지 않는다
    await mapbar.getByRole('button', { name: /이 그림 연결/ }).click();
    await expect(page.locator('.pvp-toast')).toContainText('이미 이 그림이 연결되어 있습니다');
    expect(await anchorsOf(page, S.v1!)).toHaveLength(1);

    const card = evidenceCard(page, IMG_TITLE);
    await expect(card.locator('.evd-source')).toHaveText(new RegExp(`^${escapeRe(IMG_TITLE)} \\S+, 그림$`));
    await expectImageDrawn(card.locator('.evd-thumb img'));
    await expect(paneC.locator('.ivp-figure.is-linked')).toBeVisible();
    await expect(paneC.locator('.ivp-badge')).toContainText(LINK_Q.no);
    await page.screenshot({ path: `${SHOT}/image-4-linked.png` });
  });

  test('새 버전: 근거는 확인 필요로 넘어가고, 뷰어의 [이 그림으로 확인]으로 확정한다', async ({ page }) => {
    expect(S.linkQid, '연결 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await page.goto('/docs');
    await libraryRow(page, IMG_TITLE).getByRole('button', { name: '새 버전 업로드' }).click();
    const form = page.locator('form.doclib-upload');
    await expect(form).toBeVisible();
    await expect(form).toContainText('그림 버전은 글자로 비교할 수 없어');
    await form.locator('label.field', { hasText: '버전 이름' }).locator('input').fill('v2');
    const chooserP = page.waitForEvent('filechooser');
    await form.getByRole('button', { name: '파일 선택' }).first().click();
    const fileName = `${IMG_TITLE} 개정.png`;
    await (await chooserP).setFiles({ name: fileName, mimeType: 'image/png', buffer: buildDemoPng({ revised: true }) });
    await expect(form.getByText(fileName, { exact: true })).toBeVisible();
    await expect(form.locator('.kind-chip')).toHaveText('그림');
    const respP = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/docs');
    await form.getByRole('button', { name: '업로드', exact: true }).click();
    const resp = await respP;
    expect(resp.status()).toBe(201);
    const body = (await resp.json()) as { versionId: number; reanchor?: { auto: number; needsReview: number } };
    expect(body.reanchor).toEqual({ auto: 0, needsReview: 1 });
    S.v2 = body.versionId;
    const notice = page.locator('.doclib-notice');
    await expect(notice).toContainText('업로드 완료: 1장 처리.');
    await expect(notice).toContainText('확인 필요 1건');
    await expect(notice).toContainText('[이 그림으로 확인]');

    await libraryRow(page, IMG_TITLE).locator('.doclib-row-title').click();
    await expect(page).toHaveURL(new RegExp(`/docs/${S.docId}`));
    const review = page.locator('.ivp-review');
    await expect(review).toContainText('확인 필요 1건');
    await expect(review).toContainText(LINK_Q.no);
    await expect(page.locator('.ivp-figure.is-linked')).toHaveCount(0);
    await expect(page.locator('.docv-head .badge-recheck')).toContainText('위치 확인 필요 1건');
    await page.screenshot({ path: `${SHOT}/image-5-needs-review.png` });
    await review.getByRole('button', { name: '이 그림으로 확인' }).click();
    await expect(page.locator('.pvp-toast')).toContainText('이 그림을 근거로 확인했습니다');
    await expect(review).toBeHidden();
    await expect(page.locator('.ivp-figure.is-linked')).toBeVisible();
    await expect(page.locator('.ivp-badge')).toContainText(LINK_Q.no);
    const a2 = await anchorsOf(page, S.v2);
    expect(a2).toHaveLength(1);
    expect(a2[0]).toMatchObject({ status: 'resolved', quote: '', geometryPrimary: true });
  });

  test('버전 비교: 그림 버전은 글자 비교 대신 두 그림을 나란히', async ({ page }) => {
    expect(S.v2, '새 버전 단계가 먼저 성공해야 한다').toBeTruthy();
    await login(page);
    await page.goto('/docs');
    await libraryRow(page, IMG_TITLE).getByRole('link', { name: '버전 비교' }).click();
    await expect(page).toHaveURL(new RegExp(`/docs/${S.docId}/compare`));
    await expect(page.locator('.doccmp-kind-note')).toContainText('그림 버전은 글자를 읽지 않아');
    const imgs = page.locator('.doccmp-images img');
    await expect(imgs).toHaveCount(2);
    await expectImageDrawn(imgs.nth(0));
    await expectImageDrawn(imgs.nth(1));
    await expect(page.locator('.doccmp-stats')).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/image-6-compare.png` });
  });
});
