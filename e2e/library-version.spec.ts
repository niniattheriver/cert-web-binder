/**
 * 근거자료 목록에서 연도를 골랐을 때 여는 버전 E2E.
 * 목록 줄과 카드는 고른 연도의 버전을 보이고 [미리보기]도 그 버전을 연다. 제목, 줄 두 번 누르기, 카드의 제목과
 * [뷰어 열기]도 같은 버전을 연다. 연도를 고른 목록에서도 현재 버전이 보이는 줄에는 스캔 의심 표시가 나온다.
 * 전제: 데모 시드가 들어간 서버 하나(E2E_BASE_URL), admin/day1pass.
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/library-version.spec.ts --workers=1
 * 근거자료 문서는 지우는 기능이 없어 남는다(제목에 실행마다 다른 표지를 붙인다).
 */
import { test as base, expect as baseExpect, type Page } from '@playwright/test';
import { buildTestPdf } from '../server/src/docs/test-pdf-util.js';

const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots';
const USER = 'admin';
const PASS = 'day1pass';
const RUN = Date.now().toString(36);
const THIS_YEAR = new Date().getFullYear();
const LAST_YEAR = THIS_YEAR - 1;

/** 외부 요청과 페이지 예외가 없어야 한다 */
const test = base.extend<{ guard: void }>({
  guard: [
    async ({ context, baseURL }, use) => {
      const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
      if (baseURL) local.add(new URL(baseURL).hostname);
      const external: string[] = [];
      const errors: string[] = [];
      context.on('request', (r) => {
        const u = new URL(r.url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return;
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

interface UploadBody {
  documentId: number;
  versionId: number;
}

/** POST /api/docs 로 올린다 (documentId 를 주면 그 문서의 새 버전) */
async function upload(
  page: Page,
  o: { name: string; mimeType: string; buffer: Buffer; title?: string; label: string; year: number; documentId?: number },
): Promise<UploadBody> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    file: { name: o.name, mimeType: o.mimeType, buffer: o.buffer },
    versionLabel: o.label,
    year: String(o.year),
  };
  if (o.title) multipart.title = o.title;
  if (o.documentId != null) multipart.documentId = String(o.documentId);
  const res = await page.request.post('/api/docs', { multipart });
  expect(res.status(), `업로드 ${o.name} → ${res.status()}`).toBe(201);
  return (await res.json()) as UploadBody;
}

/** 목록 줄 (이름 정확히 일치) */
function libraryRow(page: Page, title: string) {
  return page
    .locator('tr.doclib-row')
    .filter({ has: page.locator('.doclib-row-title').getByText(title, { exact: true }) })
    .first();
}

/** 카드 (제목 정확히 일치) */
function libraryCard(page: Page, title: string) {
  return page
    .locator('.doclib-card')
    .filter({ has: page.locator('.doclib-title').getByText(title, { exact: true }) })
    .first();
}

/** 뷰어가 그 버전을 열었다: 주소의 ?v=, 버전 고르기, 본문 글자 */
async function expectViewerAt(page: Page, docId: number, versionId: number | null, label: string, text: string): Promise<void> {
  if (versionId == null) await expect(page).toHaveURL(new RegExp(`/docs/${docId}$`));
  else await expect(page).toHaveURL(new RegExp(`/docs/${docId}\\?v=${versionId}$`));
  await expect(page.getByRole('combobox', { name: '버전 선택' }).locator('option:checked')).toContainText(label);
  await expect(page.locator('.docv-viewer')).toContainText(text, { timeout: 30_000 });
}

test('연도를 고른 목록과 카드: 제목, 두 번 누르기, [뷰어 열기]가 그 연도의 버전을 연다', async ({ page }) => {
  await login(page);
  const title = `V-lib ${RUN} 연도 버전`;
  const oldText = `작년 버전 본문 ${RUN}`;
  const newText = `올해 버전 본문 ${RUN}`;
  const v1 = await upload(page, {
    name: `${title}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`${oldText}\n`, 'utf8'),
    title,
    label: `${LAST_YEAR}-1`,
    year: LAST_YEAR,
  });
  const v2 = await upload(page, {
    name: `${title}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`${newText}\n`, 'utf8'),
    label: `${THIS_YEAR}-1`,
    year: THIS_YEAR,
    documentId: v1.documentId,
  });

  await page.goto('/docs');
  await page.getByRole('combobox', { name: '근거자료 연도' }).selectOption(String(LAST_YEAR));
  const row = libraryRow(page, title);
  await expect(row.locator('.doclib-col-ver')).toContainText(`${LAST_YEAR}-1`);
  await expect(row.locator('.doclib-col-ver')).toContainText(`현재 버전 ${THIS_YEAR}-1`);

  // 제목
  await row.locator('.doclib-row-title').click();
  await expectViewerAt(page, v1.documentId, v1.versionId, `${LAST_YEAR}-1`, oldText);
  await expect(page.locator('.docv-head')).toContainText('이전 버전(보기만 가능)');
  await page.screenshot({ path: `${SHOT}/library-version-1-title.png` });

  // 줄 두 번 누르기 (글자 칸)
  await page.goBack();
  await libraryRow(page, title).locator('.doclib-col-date').dblclick();
  await expectViewerAt(page, v1.documentId, v1.versionId, `${LAST_YEAR}-1`, oldText);

  // 카드 보기의 제목과 [뷰어 열기]
  await page.goBack();
  await page.getByRole('button', { name: '카드', exact: true }).click();
  const card = libraryCard(page, title);
  await card.locator('.doclib-title').click();
  await expectViewerAt(page, v1.documentId, v1.versionId, `${LAST_YEAR}-1`, oldText);
  await page.goBack();
  await libraryCard(page, title).getByRole('link', { name: '뷰어 열기' }).click();
  await expectViewerAt(page, v1.documentId, v1.versionId, `${LAST_YEAR}-1`, oldText);

  // 올해를 고르면 현재 버전이 보이고 주소에 ?v= 가 붙지 않는다
  await page.goBack();
  await page.getByRole('combobox', { name: '근거자료 연도' }).selectOption(String(THIS_YEAR));
  await libraryCard(page, title).locator('.doclib-title').click();
  await expectViewerAt(page, v1.documentId, null, `${THIS_YEAR}-1`, newText);
  expect(v2.versionId).not.toBe(v1.versionId);
});

test('올해를 고른 목록에서도 현재 버전 PDF 의 스캔 의심 표시가 보인다', async ({ page }) => {
  await login(page);
  const title = `V-lib ${RUN} 스캔 의심`;
  // 2쪽은 글자가 거의 없다(공백 빼고 40자 미만): 스캔한 쪽으로 추정
  const pdf = Buffer.from(
    buildTestPdf([
      ['Article 1 purpose of this virtual guideline document for testing.', 'Article 2 scope applies to all staff.'],
      ['p2'],
    ]),
  );
  await upload(page, { name: `${title}.pdf`, mimeType: 'application/pdf', buffer: pdf, title, label: `${THIS_YEAR}-1`, year: THIS_YEAR });
  await page.goto('/docs');
  const yearSelect = page.getByRole('combobox', { name: '근거자료 연도' });
  await yearSelect.selectOption(String(THIS_YEAR));
  await expect(libraryRow(page, title).locator('.doclib-warn')).toHaveText('스캔으로 추정되는 페이지 있음');
  await yearSelect.selectOption('all');
  await expect(libraryRow(page, title).locator('.doclib-warn')).toHaveText('스캔으로 추정되는 페이지 있음');
});
