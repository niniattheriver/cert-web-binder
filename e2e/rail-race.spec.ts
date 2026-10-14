/**
 * 문항을 옮길 때 응답 순서가 뒤바뀌어도 왼쪽 문항 목록(레일) 행에 다른 문항의 근거 개수가 섞이지 않는다.
 * 문항 상세와 근거는 따로 받는다. 새 문항의 근거가 문항 상세보다 먼저 와도 아직 화면에 남아 있는 이전 문항의 행에
 * 새 문항의 개수를 적지 않아야 한다(같은 분야에서는 목록을 다시 받지 않아 잘못된 준비 상태가 그대로 남는다).
 * 전제: 데모 시드. 60.030.020 은 근거, 답변, 점수가 없고(시작 전), 60.030.030 은 근거가 있다(진행 중).
 * 다른 시험이 고치지 않는 문항이다.
 */
import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  const idField = page.locator('label', { hasText: '아이디' }).locator('input');
  const yearRow = page.locator('.year-card.is-current');
  await expect(idField.or(yearRow).first()).toBeVisible({ timeout: 15_000 });
  if (await idField.count()) {
    await idField.fill('admin');
    await page.locator('label', { hasText: '비밀번호' }).locator('input').fill('day1pass');
    await page.getByRole('button', { name: /로그인/ }).click();
  }
  await expect(yearRow).toBeVisible();
}

async function openByNumber(page: Page, no: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const omni = page.getByRole('dialog', { name: '검색' });
  await expect(omni).toBeVisible();
  await omni.getByRole('textbox').fill(no.replace(/\./g, ''));
  await expect(omni.locator('.omni-list [role="option"]').first()).toContainText(no, { timeout: 5_000 });
  await omni.getByRole('textbox').press('Enter');
  await expect(page.locator('.qd3-rail-item.is-active .qd3-rail-no')).toHaveText(no);
}

test('문항 이동: 근거 응답이 문항 상세보다 먼저 와도 이전 문항 행의 상태는 그대로다', async ({ page }) => {
  await login(page);
  await openByNumber(page, '60.030.020');
  const row = (no: string) => page.locator('.qd3-rail-item', { has: page.locator('.qd3-rail-no', { hasText: no }) });
  const rowA = row('60.030.020');
  const rowB = row('60.030.030');
  await expect(rowA.locator('.status-glyph')).toHaveClass(/st-none/);
  await expect(rowB.locator('.status-glyph')).toHaveClass(/st-partial/);

  // B 의 문항 상세만 1.5초 늦춘다: 근거가 먼저 도착한다
  const idB = Number((await rowB.getAttribute('id'))!.replace('rail-q-', ''));
  await page.route(new RegExp(`/api/questions/${idB}(\\?.*)?$`), async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const evidenceB = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/questions/${idB}/evidence`);
  const detailB = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/questions/${idB}`);
  await rowB.click();
  await evidenceB;
  // 근거는 왔고 문항 상세는 아직인 사이: 이전 문항(A) 행은 그대로여야 한다
  await page.waitForTimeout(300);
  await expect(rowA.locator('.status-glyph')).toHaveClass(/st-none/);

  // 문항 상세까지 온 뒤에도 두 행 모두 제 상태
  await detailB;
  await expect(page.locator('.qd3-rail-item.is-active .qd3-rail-no')).toHaveText('60.030.030');
  await expect(rowA.locator('.status-glyph')).toHaveClass(/st-none/);
  await expect(rowB.locator('.status-glyph')).toHaveClass(/st-partial/);
});
