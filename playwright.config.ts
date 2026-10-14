import { defineConfig } from '@playwright/test';

// E2E 검증. 기본은 dev 서버(web:5173, api:8080)가 떠 있는 상태에서 실행한다: npx playwright test
// 다른 서버(예: 빌드한 서버 하나, 포트 8095)로 돌릴 때는 주소를 준다:
//   E2E_BASE_URL=http://localhost:8095 npx playwright test
// Playwright 전용 Chromium 을 받지 않은 PC 에서는 설치된 Chrome 으로 돌린다: E2E_CHANNEL=chrome
const baseURL = process.env.E2E_BASE_URL?.trim() || 'http://localhost:5173';
const channel = process.env.E2E_CHANNEL?.trim() || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    ...(channel ? { channel } : {}),
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    locale: 'ko-KR',
  },
});
