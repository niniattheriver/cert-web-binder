/**
 * Day 2 종료 기준 E2E (설계서 §10 Day 2, §11-3): 문항↔PDF 양방향 + 채점 3초 룩업.
 * 전제: dev 서버(8080+5173), 시드된 매핑(제12조↔50.030.010/50.030.020, 제4조↔50.010.010, 백업↔60.060.010).
 */
import { test, expect, type Page } from '@playwright/test';

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots'; // 확인용 캡처 저장 위치

async function login(page: Page) {
  await page.goto('/');
  const idField = page.locator('label', { hasText: '아이디' }).locator('input');
  const yearRow = page.locator('.year-row.is-current');
  // 레이스 방지: React가 로그인 폼(미인증) 또는 연도 홈(인증됨)을 렌더할 때까지 대기
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

function trackExternal(page: Page): string[] {
  const ext: string[] = [];
  page.on('request', (r) => {
    const h = new URL(r.url()).hostname;
    if (!['localhost', '127.0.0.1'].includes(h)) ext.push(r.url());
  });
  return ext;
}

test('지침서 라이브러리 + 문서 뷰어 오버레이/배지', async ({ page }) => {
  const ext = trackExternal(page);
  await login(page);

  // /docs 라이브러리: 카드 2장
  await page.goto('/docs');
  await expect(page.locator('body')).toContainText('개인정보 처리지침');
  await expect(page.locator('body')).toContainText('정보보안 운영지침');
  await page.screenshot({ path: `${SHOT}/day2-1-doclib.png` });

  // /docs/1 뷰어: 텍스트레이어 + 앵커 오버레이(하이라이트) + 배지
  await page.goto('/docs/1');
  await page.waitForFunction(
    () => /[가-힣]{2,}/.test(document.querySelector('.textLayer')?.textContent ?? ''),
    null,
    { timeout: 30_000 },
  );
  // 앵커 오버레이(하이라이트) — 제12조/제4조 매핑이 렌더되어야
  await expect(page.locator('.TextHighlight, [class*="hl-"], .pvp-badge, [class*="badge"]').first()).toBeAttached({
    timeout: 10_000,
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT}/day2-2-docviewer.png` });

  expect(ext, `외부 요청: ${ext.join(', ')}`).toHaveLength(0);
});

test('3초 룩업: 옴니박스 번호→상세→근거 자동 로드 + 채점 위젯', async ({ page }) => {
  await login(page);

  // 옴니박스 번호 패스트패스 → Q8 상세로
  await page.keyboard.press('ControlOrMeta+k');
  const omni = page.getByRole('dialog', { name: '검색' });
  await expect(omni).toBeVisible();
  await omni.getByRole('textbox').fill('50030010');
  await expect(omni.locator('[role="option"]').first()).toContainText('50.030.010', { timeout: 5_000 });
  await omni.getByRole('textbox').press('Enter');

  // 3분할 상세: 본문 + 근거 카드(제12조 인용) + 채점 위젯
  await expect(page).toHaveURL(/\/q\/8\b/);
  await expect(page.locator('body')).toContainText('50.030.010');
  // 근거 카드: 인용문 미리보기 또는 출처행
  await expect(page.locator('body')).toContainText(/파기|제12조|p\.\d/);
  // 채점 위젯: 예/아니오 라디오
  await expect(page.locator('body')).toContainText('예');
  await expect(page.locator('body')).toContainText('아니오');
  await page.screenshot({ path: `${SHOT}/day2-3-detail.png` });

  // 근거 [상세보기] → C열 뷰어 교체 + 텍스트레이어 로드(양방향 확인)
  const detailBtn = page.getByRole('button', { name: /상세보기/ }).first();
  if (await detailBtn.count()) {
    await detailBtn.click();
    await page.waitForFunction(
      () => /[가-힣]{2,}/.test(document.querySelector('.textLayer')?.textContent ?? ''),
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1000); // 펄스 안착
    await page.screenshot({ path: `${SHOT}/day2-4-evidence-open.png` });
  }
});
