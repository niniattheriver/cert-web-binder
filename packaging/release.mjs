/**
 * 릴리스 패키징 스크립트 (설계서 §7 배포 구조)
 *
 * 산출물: dist/<name>-<version>-<platform>.zip
 * 압축 해제 시 "설치 루트" 레이아웃이 그대로 펼쳐진다:
 *
 *   설치루트/                     (예: /opt/qaevidence, C:\qaevidence)
 *   ├── server/                   ┐
 *   ├── web/dist/                 │ 설계서 §7의 app/ 묶음 = 업그레이드 시 교체 대상
 *   ├── node_modules/             │ (prod 의존성 + tsx 런타임, 이 플랫폼용으로 빌드됨)
 *   ├── runtime/                  │ (동봉 Node 실행 파일 — 사용자 PC에 Node 설치 불필요,
 *   │                             │  네이티브 모듈과 항상 같은 버전이라 ABI 불일치 없음)
 *   ├── package.json              ┘
 *   ├── config.example.json       ← config.json 으로 복사해 사용(port/dataDir/maxPdfMB)
 *   ├── packaging/                (systemd·WinSW·Dockerfile·설치 안내)
 *   ├── docs/                     (설치·운영 문서, 한국어)
 *   ├── config.json               ← 최초 기동 시 자동 생성(없으면). 업그레이드가 건드리지 않음
 *   └── data/                     ← 모든 런타임 상태. 업그레이드가 절대 건드리지 않음
 *
 * 실행(프로덕션):  NODE_ENV=production node --import tsx server/src/index.ts   (cwd=설치루트)
 * 업그레이드: 서비스 중지 → server/·web/·node_modules/·package.json 교체 → 시작
 *            (config.json·data/ 는 그대로 둔다). packaging/upgrade.* 스크립트가 이를 대신 수행.
 *
 * 원칙:
 *  - 새 npm 의존성을 설치하지 않는다. 이미 설치·빌드된 node_modules 에서 prod 의존성
 *    폐쇄집합(closure)만 복사한다 → 완전 오프라인, 이 플랫폼용 네이티브 바이너리 재사용.
 *  - data/·_로컬자료/·*.test.ts·config.json(실값)은 절대 담지 않는다.
 *  - cMaps/standard_fonts 는 web build(web/dist/pdfjs) 와 node_modules/pdfjs-dist(서버 추출)에 포함.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const log = (...a) => console.log('[release]', ...a);

// ── 메타 ────────────────────────────────────────────────────────────────
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'package.json'), 'utf8'));
const version = rootPkg.version ?? '0.0.0';
const name = rootPkg.name ?? 'cert-web-binder';
const platform = `${process.platform}-${process.arch}`;
const stageName = `${name}-${version}-${platform}`;

const distDir = path.join(repoRoot, 'dist');
const stageRoot = path.join(distDir, 'stage');
const stageDir = path.join(stageRoot, stageName);

// ── 유틸: 제외 패턴 있는 재귀 복사 ──────────────────────────────────────
function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (skip(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, skip);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

// ── node_modules prod 폐쇄집합 계산(오프라인) ──────────────────────────
const searchRoots = [
  path.join(repoRoot, 'node_modules'),
  path.join(repoRoot, 'server', 'node_modules'),
];
function resolvePkgDir(nameToFind) {
  for (const root of searchRoots) {
    const p = path.join(root, ...nameToFind.split('/'));
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
  }
  return null;
}
// 패키지가 자체 중첩 node_modules(디듀프 안 된 사본)를 갖고 있으면 — 사본 자체는 copyDir로
// 함께 복사되지만 그 사본이 요구하는 의존성은 최상위로 호이스팅되어 있을 수 있으므로,
// 중첩 사본들의 package.json 의존성도 폐쇄집합 큐에 넣는다. (미탐지 시 배포본이 부팅 실패 —
// 예: lazystream/node_modules/readable-stream@2 → process-nextick-args)
function enqueueNestedDeps(dir, queue) {
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return;
  const pkgDirs = [];
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) pkgDirs.push(path.join(nm, e.name, s.name));
      }
    } else {
      pkgDirs.push(path.join(nm, e.name));
    }
  }
  for (const pdir of pkgDirs) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8'));
      for (const set of [pj.dependencies, pj.optionalDependencies]) {
        if (set) for (const name of Object.keys(set)) queue.push(name);
      }
    } catch {
      /* noop */
    }
    enqueueNestedDeps(pdir, queue);
  }
}
function collectClosure(roots) {
  const found = new Map(); // name → src dir
  const queue = [...roots];
  const missing = new Set();
  while (queue.length) {
    const dep = queue.shift();
    if (found.has(dep) || missing.has(dep)) continue;
    const dir = resolvePkgDir(dep);
    if (!dir) {
      missing.add(dep); // 미설치 optional(다른 플랫폼 등) — 건너뜀
      continue;
    }
    found.set(dep, dir);
    let pj = {};
    try {
      pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      /* noop */
    }
    for (const set of [pj.dependencies, pj.optionalDependencies]) {
      if (set) for (const name of Object.keys(set)) queue.push(name);
    }
    enqueueNestedDeps(dir, queue);
  }
  return { found, missing };
}

// ── 실행 ────────────────────────────────────────────────────────────────
log(`패키징 시작: ${stageName}`);

// 0) 정리
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

// 1) 웹 빌드 (copy-pdf-assets(cmaps/standard_fonts) → vite build)
// Windows에서 npm은 npm.cmd(배치 파일)라 shell 없이는 스폰 불가(패치된 Node는 EINVAL) —
// 인자가 정적 문자열뿐이므로 win32에서만 shell 사용해도 이스케이프 위험 없음.
log('web 빌드 (npm run build -w web)…');
execFileSync('npm', ['run', 'build', '-w', 'web'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const webDist = path.join(repoRoot, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  throw new Error('web/dist/index.html 이 없습니다 — 웹 빌드 실패');
}

// 2) 서버 소스 (테스트 제외)
copyDir(
  path.join(repoRoot, 'server', 'src'),
  path.join(stageDir, 'server', 'src'),
  (s) => /\.test\.ts$/.test(s) || s.endsWith('.DS_Store'),
);
for (const f of ['package.json', 'tsconfig.json']) {
  fs.copyFileSync(path.join(repoRoot, 'server', f), path.join(stageDir, 'server', f));
}

// 3) 웹 dist
copyDir(webDist, path.join(stageDir, 'web', 'dist'), (s) => s.endsWith('.DS_Store'));

// 4) 설정 견본 + 런타임 package.json
fs.copyFileSync(
  path.join(repoRoot, 'config.example.json'),
  path.join(stageDir, 'config.example.json'),
);
fs.writeFileSync(
  path.join(stageDir, 'package.json'),
  JSON.stringify(
    {
      name,
      version,
      private: true,
      type: 'module',
      description: '인증 문항 근거자료 관리 웹 바인더 (배포 번들)',
      scripts: { start: 'node --import tsx server/src/index.ts' },
    },
    null,
    2,
  ) + '\n',
);

// 5) packaging(자기 자신 제외) + docs
copyDir(here, path.join(stageDir, 'packaging'), (s, e) => {
  const base = path.basename(s);
  return base === 'release.mjs' || base === '.DS_Store' || (e.isDirectory() && base === 'node_modules');
});
// 5-1) 간단 실행 스크립트는 zip 루트에도 — 압축 해제 후 더블클릭(윈도우)/sh 실행(리눅스)만으로 기동
for (const f of ['start-windows.bat', 'start-linux.sh']) {
  fs.copyFileSync(path.join(here, f), path.join(stageDir, f));
}
fs.chmodSync(path.join(stageDir, 'start-linux.sh'), 0o755);
if (fs.existsSync(path.join(repoRoot, 'docs'))) {
  copyDir(path.join(repoRoot, 'docs'), path.join(stageDir, 'docs'), (s) => s.endsWith('.DS_Store'));
}

// 6) node_modules (prod 폐쇄집합)
log('node_modules prod 폐쇄집합 복사…');
const roots = [...Object.keys(serverPkg.dependencies ?? {}), 'tsx'];
const { found, missing } = collectClosure(roots);
const nmDest = path.join(stageDir, 'node_modules');
for (const [dep, srcDir] of found) {
  copyDir(srcDir, path.join(nmDest, ...dep.split('/')), (s) => s.endsWith('.DS_Store'));
}
log(`  패키지 ${found.size}개 복사 (건너뛴 미설치 optional ${missing.size}개)`);
if (!found.has('better-sqlite3') || !found.has('tsx')) {
  throw new Error('필수 런타임 패키지(better-sqlite3/tsx)를 node_modules 에서 찾지 못했습니다');
}

// 6.5) Node 런타임 동봉 — 사용자 PC의 Node 설치·버전 불일치(네이티브 모듈 ABI) 원천 차단.
//      이 zip 의 node_modules 는 지금 이 Node 로 설치·검증된 것이라 항상 짝이 맞는다.
const runtimeDir = path.join(stageDir, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(runtimeDir, nodeBin));
if (process.platform !== 'win32') fs.chmodSync(path.join(runtimeDir, nodeBin), 0o755);
// 공식 Node 배포판은 단일 정적 바이너리(수십 MB). 수 MB 미만이면 homebrew 등
// 공유 라이브러리(libnode) 빌드라 다른 PC에서 단독 실행이 안 된다 — 배포 금지 경고.
const nodeSize = fs.statSync(path.join(runtimeDir, nodeBin)).size;
if (nodeSize < 20 * 1024 * 1024) {
  log(
    `  ⚠️ 동봉한 Node(${(nodeSize / 1024).toFixed(0)}KB)가 공유 라이브러리 빌드로 보입니다 — ` +
      '이 zip은 이 PC 밖에서 단독 실행되지 않을 수 있습니다. 배포용은 공식 Node 배포판(CI)에서 만드세요.',
  );
}
// Node.js 라이선스 원문 동봉(MIT) — 오프라인 빌드면 고지문으로 대체
try {
  const res = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(path.join(runtimeDir, 'NODE_LICENSE.txt'), await res.text());
} catch {
  fs.writeFileSync(
    path.join(runtimeDir, 'NODE_LICENSE.txt'),
    `Node.js v${process.versions.node} — MIT License\n` +
      `https://github.com/nodejs/node/blob/v${process.versions.node}/LICENSE\n`,
  );
}
log(`  런타임 동봉: Node v${process.versions.node} → runtime/${nodeBin}`);

// 7) ZIP (OS 기본 도구 — 대용량 node_modules는 네이티브 압축이 빠르다)
fs.mkdirSync(distDir, { recursive: true });
const zipPath = path.join(distDir, `${stageName}.zip`);
fs.rmSync(zipPath, { force: true });
log('압축…');
if (process.platform === 'win32') {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${stageName}' -DestinationPath '${zipPath}' -Force`],
    { cwd: stageRoot, stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-r', '-q', zipPath, stageName], { cwd: stageRoot, stdio: 'inherit' });
}

const zipSize = fs.statSync(zipPath).size;
log('완료.');
log(`  산출물: ${zipPath}`);
log(`  크기:   ${(zipSize / 1024 / 1024).toFixed(1)} MB`);
log(`  플랫폼: ${platform} (네이티브 바이너리 포함 — 다른 OS/arch는 해당 플랫폼에서 재패키징)`);
