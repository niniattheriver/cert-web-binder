/**
 * v1.5 Phase 2 E2E — 첨부·링크(근거 자료 카드 통합), 지적/권장 내용 파생 표시, 결과 요약 자동입력 미확정 필터.
 * 전제: dev 서버 기동(8080+5173), admin/day1pass. 읽기 전용(실DB 비오염 — 채점·업로드 안 함).
 */
import { test, expect } from '@playwright/test';

test('Phase2: 문항 상세 첨부·링크/지적 파생 UI + 요약 자동입력 미확정 필터', async ({ page }) => {
  await page.goto('/');
  await page.locator('label', { hasText: '아이디' }).locator('input').fill('admin');
  await page.locator('label', { hasText: '비밀번호' }).locator('input').fill('day1pass');
  await page.getByRole('button', { name: /로그인/ }).click();
  // 연도 홈 → 현재 연도의 대시보드
  await page.locator('.year-card.is-current').click();
  await expect(page.locator('.cycle-chip')).toContainText('2026년 심사');

  // 첫 분야 → 첫 문항 상세
  await page.locator('.cat-card').first().click();
  await expect(page).toHaveURL(/\/c\/\d+/);
  await page.locator('.qrow-body').first().click();
  await expect(page).toHaveURL(/\/q\/\d+/);

  // 근거 자료 카드 상단 단추 (편집자에겐 항상 렌더). 지침서 연결과 파일 첨부를 [근거자료 연결] 하나로
  await expect(page.locator('.evd-map-btn')).toHaveText('+ 근거자료 연결');
  await expect(page.getByRole('button', { name: '+ 파일 첨부' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ 링크 추가' })).toBeVisible();

  // [근거자료 연결] 창: 업로드한 자료 목록과 [내 PC에서 선택](여러 파일). 파일은 고르지 않고 창만 확인한다
  await page.locator('.evd-map-btn').click();
  const picker = page.getByRole('dialog', { name: '연결할 근거자료 선택' });
  await expect(picker.locator('.qpick-title')).toHaveText('연결할 근거자료 선택(업로드한 자료)');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    picker.getByRole('button', { name: '내 PC에서 선택' }).click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await expect(picker).toHaveCount(0);

  // 지적/권장 — 내용 파생: 내용이 있으면 textarea, 없으면 '+추가' 버튼 (둘 중 하나)
  const findingsArea = page.locator('.qd3-textarea');
  const addFindingsBtn = page.getByRole('button', { name: '+ 지적/권장사항 추가' });
  const hasArea = await findingsArea.isVisible().catch(() => false);
  if (!hasArea) await expect(addFindingsBtn).toBeVisible();

  // 채점 스테퍼 ±0.5 표기 (Phase 0 보정 회귀 확인 — 클릭하지 않음)
  await expect(page.getByRole('button', { name: '0.5점 올리기' })).toContainText('+0.5');

  // 결과 요약 — 자동입력 미확정 필터 칩
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: /결과 요약/ }).click();
  await expect(page).toHaveURL(/\/summary/);
  await expect(page.locator('.chip', { hasText: '자동 입력 미확정' })).toBeVisible();
  await expect(page.locator('.head-note')).toContainText('자동 입력 미확정');
});
