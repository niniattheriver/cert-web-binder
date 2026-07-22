/**
 * Day 3 신규 기능 스모크 (설계서 §10 Day 3): 자유형식 근거문서(Tiptap) · 엑셀 내보내기 · 인쇄 뷰.
 * 전제: dev 서버(8080+5173) + 데모 시드(개인정보 보호=분야 id 1, Q8=50.030.010).
 */
import { test, expect, type Page } from '@playwright/test';

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots'; // 확인용 캡처 저장 위치

async function login(page: Page) {
  await page.goto('/');
  const idField = page.locator('label', { hasText: '아이디' }).locator('input');
  const yearRow = page.locator('.year-row.is-current');
  await expect(idField.or(yearRow).first()).toBeVisible({ timeout: 15_000 });
  if (await idField.count()) {
    await idField.fill('admin');
    await page.locator('label', { hasText: '비밀번호' }).locator('input').fill('day1pass');
    await page.getByRole('button', { name: /로그인/ }).click();
  }
  // 연도 홈 → 현재 연도의 대시보드
  await yearRow.click();
  await expect(page.locator('.cat-card').first()).toBeVisible();
}

test('자유형식: 생성 → 문항 연결 → Tiptap 편집기 렌더', async ({ page }) => {
  await login(page);

  // Q8(50.030.010) 상세 → 근거 영역 [+ 자유형식]
  await page.goto('/q/8');
  await expect(page.locator('body')).toContainText('50.030.010');
  await page.getByRole('button', { name: /자유형식/ }).click();

  // 새 자유형식 문서가 이 문항에 연결되고 편집기(/rich/:id)로 이동
  await expect(page).toHaveURL(/\/rich\/\d+/, { timeout: 10_000 });
  await expect(page.locator('.ProseMirror, [contenteditable="true"]').first()).toBeVisible({
    timeout: 10_000,
  });
  await page.screenshot({ path: `${SHOT}/day3-1-richeditor.png` });

  // 문항 상세로 복귀 → 자유형식 근거 카드가 연결되어 보여야
  await page.goto('/q/8');
  await expect(page.locator('.evd-rich-badge').first()).toBeVisible({ timeout: 10_000 });
});

test('엑셀 내보내기: /api/export/category/:id.xlsx → 200 xlsx', async ({ page }) => {
  await login(page);
  const res = await page.request.get('/api/export/category/1.xlsx');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type'] ?? '').toContain('spreadsheet');
  const body = await res.body();
  expect(body.length).toBeGreaterThan(1000);
  // XLSX = ZIP 컨테이너 → 매직넘버 'PK'
  expect(body[0]).toBe(0x50);
  expect(body[1]).toBe(0x4b);
});

test('인쇄 뷰: /print/:id 렌더', async ({ page }) => {
  await login(page);
  await page.goto('/print/1');
  // 툴바: "인쇄 뷰 · 개인정보 보호" + [인쇄] 버튼
  await expect(page.locator('body')).toContainText('개인정보 보호');
  await expect(page.getByRole('button', { name: '인쇄' })).toBeVisible({ timeout: 10_000 });
  // 표지: 시스템명 인쇄본 + 문항 블록(번호)
  await expect(page.locator('body')).toContainText('인쇄본');
  await expect(page.locator('body')).toContainText('50.030.010', { timeout: 10_000 });
  await page.screenshot({ path: `${SHOT}/day3-2-print.png` });
});
