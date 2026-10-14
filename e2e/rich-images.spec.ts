/**
 * 자유형식 문서의 그림 주소 E2E.
 * 이 앱에 올린 첨부 그림은 그대로 보이고, 웹 문서를 붙여 넣을 때 딸려 온 바깥 주소 그림은 들어오지 않으며(안내가 뜬다),
 * 예전에 저장된 바깥 주소 그림도 화면이 그 주소로 요청하지 않는다. 서버는 바깥 주소 그림을 담은 저장을 400 으로 거절한다.
 * 전제: 데모 시드가 들어간 서버 하나(E2E_BASE_URL), admin/day1pass.
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/rich-images.spec.ts --workers=1
 * 만든 자유형식 문서는 끝에서 지운다(소프트 삭제).
 */
import { test as base, expect as baseExpect, type Page } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots';
const USER = 'admin';
const PASS = 'day1pass';
/** 바깥 주소 (요청이 나가면 아래 감시가 잡는다. .invalid 는 실제로 풀리지 않는 이름) */
const EXTERNAL = 'https://images.example.invalid/chart.png';
// 1x1 투명 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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

const docWith = (nodes: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '그림 시험' }] }, ...nodes] });

/** 첨부 그림 하나를 올리고, 그 그림을 담은 자유형식 문서를 만든다 */
async function docWithInternalImage(page: Page): Promise<{ id: number; src: string }> {
  const up = await page.request.post('/api/attachments', { multipart: { file: { name: 'dot.png', mimeType: 'image/png', buffer: PNG } } });
  expect(up.status()).toBe(201);
  const { url } = (await up.json()) as { url: string };
  const res = await page.request.post('/api/richdocs', {
    data: { title: 'V-e2e 그림 주소 시험', contentJson: docWith([{ type: 'image', attrs: { src: url } }]), contentPlain: '그림 시험' },
  });
  expect(res.status()).toBe(201);
  return { id: ((await res.json()) as { id: number }).id, src: url };
}

test('바깥 주소 그림: 서버는 저장을 거절하고, 붙여 넣으면 들어오지 않으며 안내가 뜬다', async ({ page }) => {
  await login(page);
  const rejected = await page.request.post('/api/richdocs', {
    data: { title: 'V-e2e 바깥 그림', contentJson: docWith([{ type: 'image', attrs: { src: EXTERNAL } }]) },
  });
  expect(rejected.status()).toBe(400);
  expect(((await rejected.json()) as { details: string }).details).toContain('이 프로그램에 올린 파일만');

  const { id, src } = await docWithInternalImage(page);
  try {
    await page.goto(`/rich/${id}`);
    const editor = page.locator('.re-editor .ProseMirror');
    // 이 앱의 첨부 그림은 그대로 보인다
    await expect(editor.locator(`img[src="${src}"]`)).toBeVisible();
    await expect.poll(() => editor.locator('img').first().evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);

    // 웹 문서를 붙여 넣는다: 글은 들어오고 바깥 주소 그림은 들어오지 않는다
    await editor.locator('p').first().click();
    await page.keyboard.press('End');
    await editor.evaluate((el, ext) => {
      const dt = new DataTransfer();
      dt.setData('text/html', `<p>붙여 넣은 글</p><img src="${ext}" alt="바깥 그림"><p>뒤 문단</p>`);
      dt.setData('text/plain', '붙여 넣은 글\n뒤 문단');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, EXTERNAL);
    await expect(editor).toContainText('붙여 넣은 글');
    await expect(editor).toContainText('뒤 문단');
    await expect(editor.locator('img')).toHaveCount(1);
    await expect(page.locator('.re-banner.is-error')).toContainText('바깥 주소의 그림 1개는 넣지 않았습니다');
    // 자동 저장이 성공하고 서버본에도 바깥 주소가 없다
    await expect(page.locator('.save-status')).toContainText('저장됨', { timeout: 10_000 });
    const saved = (await (await page.request.get(`/api/richdocs/${id}`)).json()) as { contentJson: string };
    expect(saved.contentJson).toContain('붙여 넣은 글');
    expect(saved.contentJson).not.toContain('example.invalid');
    await page.screenshot({ path: `${SHOT}/rich-images-1-paste.png` });
  } finally {
    await page.request.delete(`/api/richdocs/${id}`);
  }
});

test('예전에 저장된 바깥 주소 그림: 편집기가 그 주소로 요청하지 않고 안내한다', async ({ page }) => {
  await login(page);
  const { id, src } = await docWithInternalImage(page);
  // 예전 서버가 저장해 둔 문서를 흉내 낸다: 상세 응답의 본문에 바깥 주소 그림을 끼워 넣는다
  await page.route(`**/api/richdocs/${id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { contentJson: string };
    const doc = JSON.parse(body.contentJson) as { content: unknown[] };
    doc.content.push({ type: 'image', attrs: { src: EXTERNAL } });
    await route.fulfill({ response: res, json: { ...body, contentJson: JSON.stringify(doc) } });
  });
  try {
    await page.goto(`/rich/${id}`);
    const editor = page.locator('.re-editor .ProseMirror');
    await expect(editor.locator(`img[src="${src}"]`)).toBeVisible();
    await expect(editor.locator('img')).toHaveCount(1);
    await expect(page.locator('.re-banner.is-warn')).toContainText('바깥 주소의 그림 1개는 표시하지 않았습니다');
    await page.screenshot({ path: `${SHOT}/rich-images-2-legacy.png` });
  } finally {
    await page.unroute(`**/api/richdocs/${id}`);
    await page.request.delete(`/api/richdocs/${id}`);
  }
});
