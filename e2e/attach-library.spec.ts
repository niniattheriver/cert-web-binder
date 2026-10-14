/**
 * 문항 첨부를 근거자료 메뉴에도 올리기 E2E.
 * 문항 화면의 [+ 근거자료 연결] → [내 PC에서 선택]으로 첨부한 파일이 근거자료 메뉴(라이브러리)에도 문항의 연도로 올라간다.
 * 같은 이름, 같은 형식의 근거자료가 있으면 새 버전을 만들지 않고 안내만 하고, 근거자료로 받지 않는 형식은 첨부로만 남는다.
 * 전제: 데모 시드가 들어간 서버 하나(E2E_BASE_URL), admin/day1pass.
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/attach-library.spec.ts --workers=1
 * 만든 첨부는 끝에서 지운다. 근거자료 문서는 지우는 기능이 없어 남는다(이름에 실행마다 다른 표지를 붙인다).
 */
import { test as base, expect as baseExpect, type Page } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots';
const USER = 'admin';
const PASS = 'day1pass';
/** 다른 시험이 쓰지 않는 문항 */
const ATT_Q = { no: '50.020.020', typed: '50020020' };

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

interface DocRow {
  id: number;
  title: string;
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

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
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

/** [+ 근거자료 연결] 창의 [내 PC에서 선택]으로 파일을 고른다 */
async function pickFromPc(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  await page.locator('.evd-map-btn').click();
  const picker = page.getByRole('dialog', { name: '연결할 근거자료 선택' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    picker.getByRole('button', { name: '내 PC에서 선택' }).click(),
  ]);
  await chooser.setFiles(files);
}

test('문항에서 첨부한 파일: 근거자료 메뉴에도 올라가고, 같은 이름이면 새 버전 없이 안내, 받지 않는 형식은 첨부로만', async ({
  page,
}) => {
  const tag = `${Date.now()}`;
  const txtName = `문항 첨부 시험 ${tag}.txt`;
  const zipName = `문항 첨부 압축 ${tag}.zip`; // 제목이 텍스트 파일과 겹치지 않게 다른 이름
  const title = txtName.replace(/\.txt$/, '');
  const first = Buffer.from('문항에서 첨부한 시험 자료의 첫 내용입니다.', 'utf8');

  await login(page);
  await openQuestion(page, ATT_Q);
  const qid = Number(/\/q\/(\d+)/.exec(page.url())![1]);
  const note = page.locator('.attach-note');
  try {
    // 1. 새 텍스트 파일과 근거자료로 받지 않는 zip
    await pickFromPc(page, [
      { name: txtName, mimeType: 'text/plain', buffer: first },
      { name: zipName, mimeType: 'application/zip', buffer: Buffer.from('zip 이 아닌 시험 바이트', 'utf8') },
    ]);
    await expect(note).toContainText(/근거자료 메뉴\(\d{4}년\)에도 올렸습니다: 1건\./, { timeout: 30_000 });
    await expect(note).toContainText(`근거자료로 받지 않는 형식이라 첨부로만 두었습니다: '${zipName}'.`);
    await expect(page.locator('.save-status.is-error')).toHaveCount(0);
    await expect(page.locator('.attach-row', { hasText: txtName })).toBeVisible();
    await expect(page.locator('.attach-row', { hasText: zipName })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/attach-library-1-question.png` });

    const docs = await getJson<{ docs: DocRow[] }>(page, '/api/docs');
    const doc = docs.docs.find((d) => d.title === title);
    expect(doc, `근거자료 목록에 '${title}'`).toBeTruthy();
    expect(docs.docs.some((d) => d.title === zipName.replace(/\.zip$/, ''))).toBe(false);

    // 2. 같은 이름, 다른 내용: 새 버전을 만들지 않고 안내
    await pickFromPc(page, [{ name: txtName, mimeType: 'text/plain', buffer: Buffer.from('내용이 다른 둘째 파일입니다.', 'utf8') }]);
    await expect(note).toContainText(`같은 이름의 근거자료가 있어 근거자료 메뉴에는 올리지 않았습니다: '${title}'.`, {
      timeout: 30_000,
    });
    await expect(note).toContainText('[새 버전 업로드]');
    const detail = await getJson<{ versions: unknown[] }>(page, `/api/docs/${doc!.id}`);
    expect(detail.versions).toHaveLength(1);

    // 3. 같은 내용을 다시: 이미 있음
    await pickFromPc(page, [{ name: txtName, mimeType: 'text/plain', buffer: first }]);
    await expect(note).toContainText('근거자료 메뉴에 이미 있는 파일: 1건.', { timeout: 30_000 });

    // 근거자료 화면(목록 보기)에도 그 제목의 줄이 있다
    await page.goto('/docs');
    const row = page.locator('.doclib-row', { hasText: title });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/attach-library-2-docs.png` });
  } finally {
    // 만든 첨부는 지운다(근거자료 문서는 지우는 기능이 없어 남는다)
    const files = await getJson<{ attachments: { id: number; origName: string }[] }>(page, `/api/questions/${qid}/files`);
    for (const a of files.attachments.filter((x) => x.origName.includes(tag))) {
      const res = await page.request.delete(`/api/questions/attachments/${a.id}`);
      expect(res.ok(), `첨부 ${a.id} 지우기 → ${res.status()}`).toBeTruthy();
    }
  }
});
