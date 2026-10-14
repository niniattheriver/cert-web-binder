/**
 * pdfjs-dist의 cmaps(Adobe-Korea1 계열 포함)·standard_fonts를 web/public/pdfjs/로 복사.
 * 내부망 전제 — CDN 참조 금지(설계서 §1 오프라인 원칙). 뷰어에서
 * cMapUrl: '/pdfjs/cmaps/', standardFontDataUrl: '/pdfjs/standard_fonts/' 로 지정한다.
 * predev/prebuild 훅으로 자동 실행된다.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // web/
const rootDir = path.dirname(webDir);

// npm workspaces 호이스팅(루트 node_modules) 우선, 로컬 폴백
const candidates = [
  path.join(rootDir, 'node_modules', 'pdfjs-dist'),
  path.join(webDir, 'node_modules', 'pdfjs-dist'),
];
const pdfjsDir = candidates.find((p) => existsSync(p));
if (!pdfjsDir) {
  console.error('[copy-pdf-assets] pdfjs-dist를 찾을 수 없습니다. npm install을 먼저 실행하세요.');
  process.exit(1);
}

const dest = path.join(webDir, 'public', 'pdfjs');
mkdirSync(dest, { recursive: true });
for (const sub of ['cmaps', 'standard_fonts']) {
  const from = path.join(pdfjsDir, sub);
  if (!existsSync(from)) {
    console.error(`[copy-pdf-assets] 누락: ${from}`);
    process.exit(1);
  }
  cpSync(from, path.join(dest, sub), { recursive: true });
}
console.log(`[copy-pdf-assets] ${pdfjsDir} → ${dest} (cmaps, standard_fonts)`);
