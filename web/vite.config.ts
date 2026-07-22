import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발: vite(5173) → API는 로컬 서버(8080)로 프록시.
// 프로덕션: server가 web/dist를 같은 포트로 정적 서빙하므로 프록시 불필요.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
