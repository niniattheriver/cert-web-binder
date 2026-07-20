import { defineConfig } from '@playwright/test';

// E2E 검증 — dev 서버(web:5173, api:8080)가 떠 있는 상태에서 실행: npx playwright test
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    locale: 'ko-KR',
  },
});
