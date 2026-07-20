/**
 * v1.5 Phase 3a E2E — 준비도 진단 블록·목록 ?f= 딥링크·채점 방식 선택기·검수 큐.
 * 전제: dev 서버 기동(8080+5173), admin/day1pass. 읽기 전용(실DB 비오염 — 모드 전환·채점 안 함).
 */
import { test, expect } from '@playwright/test';

test('Phase3a: 준비도 진단 → ?f= 딥링크 → 채점 방식 선택기(읽기만) → 검수 큐', async ({ page }) => {
  await page.goto('/');
  await page.locator('label', { hasText: '아이디' }).locator('input').fill('admin');
  await page.locator('label', { hasText: '비밀번호' }).locator('input').fill('day1pass');
  await page.getByRole('button', { name: /로그인/ }).click();
  // 연도 홈 → 현재 연도의 대시보드
  await page.locator('.year-row.is-current').click();
  await expect(page.locator('.cycle-chip')).toContainText('2026년 심사');

  // 준비도 진단 블록 (분야별 표)
  await expect(page.locator('.readiness-block h2')).toContainText('준비도 진단');
  const rows = page.locator('.readiness-table tbody tr');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);

  // 근거 연결 전 숫자 클릭 → 분야 목록이 '근거 연결 전' 필터로 열림 (실DB에 근거0 문항이 있으면)
  const firstWarn = page.locator('a.readiness-num').first();
  if (await firstWarn.isVisible().catch(() => false)) {
    await firstWarn.click();
    await expect(page).toHaveURL(/\/(c\/\d+\?f=|summary\?f=)/);
    if (page.url().includes('/c/')) {
      await expect(page.locator('.chip.is-on')).not.toContainText('전체'); // 딥링크 필터 적용됨
    }
    await page.goBack();
  }

  // 문항 상세 — 채점 방식 선택기 노출 (전환은 하지 않는다: 실DB 보호)
  await page.locator('.cat-card').first().click();
  await page.locator('.qrow-body').first().click();
  await expect(page).toHaveURL(/\/q\/\d+/);
  const modeSelect = page.locator('.scoring-mode-select');
  await expect(modeSelect).toBeVisible();
  await expect(modeSelect).toHaveValue('simple');

  // 분야 목록 필터 칩에 근거 연결 전·재확인 추가됨
  await page.goBack();
  await expect(page.locator('.chip', { hasText: '근거 연결 전' })).toBeVisible();
  await expect(page.locator('.chip', { hasText: '재확인' })).toBeVisible();

  // 검수 큐 — 자동배점 섹션 구조 렌더 (stale 0건이면 빈 상태 or 문서 섹션만)
  await page
    .getByRole('navigation', { name: '주 메뉴' })
    .getByRole('link', { name: /확인 필요/ })
    .click();
  await expect(page.locator('h1')).toContainText('확인 필요');
});
