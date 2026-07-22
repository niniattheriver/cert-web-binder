/**
 * Day 1 종료 기준 E2E (설계서 §10 Day 1, §11-2)
 * 로그인 → 연도 홈(현재 연도) → 대시보드(분야 카드·주기 칩) → 문항 목록(가상화 30건) → 상세
 * → 옴니박스(번호 패스트패스 4형식 + FTS) → 로그아웃.
 * 전제: dev 서버 기동(8080+5173), data/에 데모 55문항 + admin/day1pass.
 */
import { test, expect } from '@playwright/test';

test('Day1: 로그인→연도 홈→대시보드→목록→상세→옴니박스 검색→로그아웃', async ({ page }) => {
  // 로그인 (미인증 → /login 리다이렉트)
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.locator('label', { hasText: '아이디' }).locator('input').fill('admin');
  await page.locator('label', { hasText: '비밀번호' }).locator('input').fill('day1pass');
  await page.getByRole('button', { name: /로그인/ }).click();

  // 연도 홈: 현재 연도 행('현재' 배지) 클릭 → 그 해의 대시보드
  const currentYearRow = page.locator('.year-row.is-current');
  await expect(currentYearRow).toBeVisible();
  await currentYearRow.click();
  await expect(page).toHaveURL(/\/y\/\d{4}/);

  // 대시보드: 주기 칩 + 분야 카드 (데모 시드 2개 이상 — 실물 인입 DB에서도 통과하도록 개수 고정 안 함)
  await expect(page.locator('.cycle-chip')).toContainText('2026년 심사');
  const cards = page.locator('.cat-card');
  expect(await cards.count()).toBeGreaterThanOrEqual(2);
  // 카드 위치에 의존하지 않도록 텍스트로 특정한다.
  const privCard = page.locator('.cat-card', { hasText: '개인정보 보호' });
  await expect(privCard).toHaveCount(1);
  await expect(privCard).toContainText('30');

  // 문항 목록 (가상화): 50분야 30건
  await privCard.click();
  await expect(page).toHaveURL(/\/c\/\d+/);
  await expect(page.locator('body')).toContainText('50.010.010');
  // 가상화 테이블 — 마지막 문항은 스크롤 후에만 DOM에 존재.
  // 스크롤 컨테이너는 페이지가 아니라 .table-scroll 이므로 컨테이너를 직접 스크롤한다.
  const tableScroll = page.locator('.table-scroll');
  await tableScroll.hover();
  await tableScroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('body')).toContainText('50.090.010', { timeout: 5_000 });

  // 상세: 첫 문항으로
  await tableScroll.evaluate((el) => { el.scrollTop = 0; });
  await page.locator('text=50.010.010').first().click();
  await expect(page).toHaveURL(/\/q\/\d+/);
  await expect(page.locator('body')).toContainText('50.010.010');
  await expect(page.locator('body')).toContainText('배점');

  // 옴니박스: 번호 패스트패스 (구분자 없는 8자리)
  await page.keyboard.press('ControlOrMeta+k');
  const omni = page.getByRole('dialog', { name: '검색' });
  await expect(omni).toBeVisible();
  await omni.getByRole('textbox').fill('50010030');
  await expect(omni.locator('.omni-list [role="option"]').first()).toContainText('50.010.030', {
    timeout: 5_000,
  });
  await omni.getByRole('textbox').press('Enter');
  await expect(page).toHaveURL(/\/q\/\d+/);
  await expect(page.locator('body')).toContainText('50.010.030');

  // 옴니박스: FTS 한국어 (부분문자열)
  await page.keyboard.press('ControlOrMeta+k');
  await omni.getByRole('textbox').fill('개인정보');
  await expect(omni.locator('[role="option"]').first()).toBeVisible({ timeout: 5_000 });
  const optionCount = await omni.locator('[role="option"]').count();
  expect(optionCount).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await expect(omni).not.toBeVisible();

  // 로그아웃 → 로그인 화면 (사용자 아이콘 드롭다운 안으로 이동)
  await page.getByRole('button', { name: '사용자 메뉴' }).click();
  await page.getByRole('menuitem', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
});
