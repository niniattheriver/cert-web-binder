/**
 * v1.5 Phase 1 E2E (설계서 §4 — 네비 5메뉴·결과 요약·기관 정보·검수 큐·대시보드 리스트뷰)
 * 전제: dev 서버 기동(8080+5173), admin/day1pass. 읽기 전용 상호작용만 수행(실DB 비오염).
 */
import { test, expect } from '@playwright/test';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.locator('label', { hasText: '아이디' }).locator('input').fill('admin');
  await page.locator('label', { hasText: '비밀번호' }).locator('input').fill('day1pass');
  await page.getByRole('button', { name: /로그인/ }).click();
  // 연도 홈 → 현재 연도의 대시보드
  await page.locator('.year-row.is-current').click();
  await expect(page.locator('.cycle-chip')).toContainText('2026년 심사');
}

test('Phase1: 네비 5메뉴 → 결과 요약 → 기관 정보 → 검수 큐 → 리스트뷰 토글', async ({ page }) => {
  await login(page);

  // 상단 네비 5메뉴 (admin이므로 검수 큐 노출)
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  for (const label of ['인증심사', '결과 요약', '지침서', '기관 정보', '확인 필요']) {
    await expect(nav.getByRole('link', { name: new RegExp(label) })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: /인증심사/ })).toHaveClass(/is-active/);

  // 결과 요약: 총계 헤드노트 + 필터 칩. (실DB에 감점 문항이 있으면 표가, 없으면 빈 상태가 렌더)
  await nav.getByRole('link', { name: /결과 요약/ }).click();
  await expect(page).toHaveURL(/\/summary/);
  await expect(page.locator('h1')).toContainText('결과 요약');
  await expect(page.locator('.head-note')).toContainText('감점');
  await page.locator('.chip', { hasText: '감점만' }).click();
  await page.locator('.chip', { hasText: '전체' }).click();

  // 감점 문항이 있으면 행 클릭 → 문항 상세로 이동 후 복귀
  const firstRow = page.locator('.summary-table tbody tr').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await expect(page).toHaveURL(/\/q\/\d+/);
    await page.goBack();
    await expect(page).toHaveURL(/\/summary/);
  }

  // 기관 정보: 설정 폼 + 지표 섹션 (편집은 하지 않는다)
  await nav.getByRole('link', { name: /기관 정보/ }).click();
  await expect(page).toHaveURL(/\/org/);
  await expect(page.locator('h1')).toContainText('기관 정보');
  await expect(page.locator('.org-section h2', { hasText: '기관 설정' })).toBeVisible();
  await expect(page.locator('.org-section h2', { hasText: '기관 지표' })).toBeVisible();
  await expect(page.getByRole('button', { name: /지표 추가/ })).toBeVisible();

  // 검수 큐: 요약 화면 (0건이면 빈 상태)
  await nav.getByRole('link', { name: /확인 필요/ }).click();
  await expect(page).toHaveURL(/\/review/);
  await expect(page.locator('h1')).toContainText('확인 필요');
  await expect(page.locator('.head-note')).toContainText('미처리');

  // 대시보드 리스트뷰 토글 + localStorage 지속 (준비도 진단 표와 구분 — :not(.readiness-table))
  // 인증심사 메뉴는 연도 홈으로 간다 → 현재 연도 행으로 대시보드 재진입
  const listTable = page.locator('.simple-table:not(.readiness-table)');
  await nav.getByRole('link', { name: /인증심사/ }).click();
  await page.locator('.year-row.is-current').click();
  await expect(page.locator('.card-grid')).toBeVisible();
  await page.getByRole('button', { name: '리스트' }).click();
  await expect(listTable).toBeVisible();
  await expect(page.locator('.card-grid')).not.toBeVisible();
  await page.reload();
  await expect(listTable).toBeVisible(); // 새로고침 후에도 리스트뷰 유지
  const row = listTable.locator('tbody tr').first();
  await row.click();
  await expect(page).toHaveURL(/\/c\/\d+/); // 행 클릭 → 문항 목록
  await page.goBack();
  await page.getByRole('button', { name: '카드' }).click();
  await expect(page.locator('.card-grid')).toBeVisible();
});
