/**
 * 문항 PDF 가져오기 화면의 끌어다 놓기 E2E.
 * 점선 칸에 놓거나 [PDF 파일 선택]으로 고를 때마다 목록에 더해지고(같은 이름이면 새 파일로), PDF 가 아닌 파일은 이름만 알린다.
 * 줄마다 [빼기]. 미리보기까지만 하고 [가져오기 실행]은 누르지 않는다(자료를 바꾸지 않는다).
 * 전제: 데모 시드가 들어간 서버 하나(E2E_BASE_URL), admin/day1pass, 저장소 루트에서 실행(seed/demo-pdfs/2027 을 읽는다).
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/import-drop.spec.ts --workers=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect, type Page } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots';
const USER = 'admin';
const PASS = 'day1pass';
const DEMO_2027 = path.join(process.cwd(), 'seed', 'demo-pdfs', '2027');

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

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

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

/** 가져오기 화면의 끌어다 놓기 칸에 파일들을 놓는다 (브라우저 안에서 DataTransfer 를 만든다) */
async function dropFiles(page: Page, files: FileSpec[]): Promise<void> {
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
  const zone = page.locator('.import-drop');
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(zone).toHaveClass(/is-over/);
  await expect(zone).toContainText('놓으면 아래 목록에 더해집니다');
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await expect(zone).not.toHaveClass(/is-over/);
}

const pdf = (name: string, source: string): FileSpec => ({
  name,
  mimeType: 'application/pdf',
  buffer: fs.readFileSync(path.join(DEMO_2027, source)),
});

test('문항 PDF 가져오기: 끌어다 놓거나 하나씩 골라도 목록에 더해지고, PDF 가 아니면 알리며, [빼기]로 뺀 뒤 두 파일로 미리보기', async ({
  page,
}) => {
  const p50 = pdf('2027_50.pdf', '가상문항-50-개인정보보호.pdf');
  const p60 = pdf('2027_60.pdf', '가상문항-60-정보보안.pdf');
  const rows = page.locator('.file-list li');

  await login(page);
  await page.goto('/import');
  await page.waitForSelector('.import-year-row select');
  await page.locator('.import-year-row select').selectOption('2027');
  await expect(page.getByText('선택한 파일 없음')).toBeVisible();

  // 1. PDF 와 텍스트 파일을 함께 놓는다: PDF 만 목록에, 텍스트는 이름만 알린다
  await dropFiles(page, [p50, { name: '메모.txt', mimeType: 'text/plain', buffer: Buffer.from('메모', 'utf8') }]);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('2027_50.pdf');
  await expect(page.locator('.import-skipped')).toContainText("PDF가 아니라 목록에 넣지 않은 파일: '메모.txt'");

  // 2. [PDF 파일 선택]으로 하나를 더 고르면 목록에 더해진다(바꾸지 않는다). 알림은 새 묶음 기준이라 사라진다
  await page.locator('.import-drop input[type=file]').setInputFiles([p60]);
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.import-skipped')).toHaveCount(0);

  // 3. 같은 이름을 다시 고르면 줄이 늘지 않는다
  await page.locator('.import-drop input[type=file]').setInputFiles([p60]);
  await expect(rows).toHaveCount(2);

  // 4. [빼기]로 빼고 다시 놓는다
  await rows.filter({ hasText: '2027_50.pdf' }).getByRole('button', { name: '2027_50.pdf 목록에서 빼기' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('2027_60.pdf');
  await dropFiles(page, [p50]);
  await expect(rows).toHaveCount(2);
  await page.screenshot({ path: `${SHOT}/import-drop-1-list.png` });

  // 5. 두 파일로 미리보기(가져오기 실행은 하지 않는다)
  await page.getByRole('button', { name: '업로드하고 미리보기' }).click();
  await expect(page.getByRole('heading', { name: '가져오기 미리보기' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('main')).toContainText('2027년 심사, 파일 2개, 문항 55개');
});
