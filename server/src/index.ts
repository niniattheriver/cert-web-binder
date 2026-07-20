/**
 * 웹 바인더 서버 진입점 (설계서 §1)
 * 단일 Node 프로세스가 JSON API와 (프로덕션에서) 정적 SPA를 한 포트로 서빙한다.
 * 기동 순서: DB 열기+마이그레이션(db/index) → 부트스트랩 시드 → 미들웨어/라우터 → listen.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, dataDir, rootDir } from './config.js';
import { ensureBootstrapData } from './db/bootstrap.js';
import { sweepTmpDir } from './files/upload-util.js';
import { db, dbPath } from './db/index.js';
import { startBackupScheduler } from './jobs/backup.js';
import { startIntegrityScheduler } from './jobs/integrity.js';
import { requireAdmin, requireEditor } from './middleware/auth.js';
import { createSessionMiddleware } from './middleware/session.js';
import { createAdminRouter } from './routes/admin.js';
import { createUsersRouter } from './routes/users.js';
import { createAnchorsRouter } from './routes/anchors.js';
import { createAuthRouter, createMeHandler } from './routes/auth.js';
import { createDocsRouter } from './routes/docs.js';
import { createExportRouter } from './routes/export.js';
import importRouter from './routes/import.js';
import { createOrgRouter } from './routes/org.js';
import { createQuestionFilesRouter } from './routes/question-files.js';
import { createQuestionsRouter } from './routes/questions.js';
import { createReadinessRouter } from './routes/readiness.js';
import { createScoringRouter } from './routes/scoring.js';
import { createReviewRouter } from './routes/review.js';
import { createRichDocsRouter } from './routes/richdocs.js';
import { createSearchRouter } from './routes/search.js';
import { createSummaryRouter } from './routes/summary.js';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const filesDir = path.join(dataDir, 'files');
const backupsDir = path.join(dataDir, 'backups');

// 최초 기동 시드: admin 계정·active 주기·app_setting 기본값
ensureBootstrapData(db, dataDir);

export const app = express();

// HTTPS 종단 프록시(Nginx/Caddy 등) 뒤 구동 지원 — X-Forwarded-* 를 신뢰해야
// req.secure 판정과 secure 세션 쿠키가 동작한다. 무조건 신뢰하지 않도록 설정값으로만 켠다.
if (config.trustProxy !== undefined && config.trustProxy !== false) {
  app.set('trust proxy', config.trustProxy);
}

// 공통 보안 헤더 (내부망 전제라도 기본 방어선은 유지)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(createSessionMiddleware(db, dataDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: pkg.version });
});

// 라우터 마운트 (계약: /api/auth만 공개, GET류 viewer 가능, 변경류 editor 이상)
app.use('/api/auth', createAuthRouter(db));
app.get('/api/me', createMeHandler(db)); // 공개 — 미로그인 시 user:null + 설정 반환
app.use('/api/search', createSearchRouter(db));
app.use('/api/docs', createDocsRouter(db)); // 업로드 파이프라인·라이브러리·판본 파일/페이지텍스트/앵커·전문검색
app.use('/api/import', requireEditor(db), importRouter);
app.use('/api', createQuestionsRouter(db));
app.use('/api', createAnchorsRouter(db)); // /api/anchors · /api/passages · /api/docs/versions/:vid/anchors
app.use('/api', createExportRouter(db)); // /api/export/all.xlsx · /category/:id.xlsx · /template.xlsx (editor↑)
app.use('/api', createRichDocsRouter(db)); // /api/richdocs(CRUD·링크) · /api/attachments(내용주소 이미지)
app.use('/api', createSummaryRouter(db)); // /api/summary — 결과 요약 (v1.5 Phase 1)
app.use('/api', createOrgRouter(db)); // /api/org — 기관 설정·지표 (v1.5 Phase 1)
app.use('/api', createReviewRouter(db)); // /api/review/summary — 검수 큐 집계 (v1.5 Phase 1)
app.use('/api', createQuestionFilesRouter(db, { filesDir })); // 문항 첨부·링크 (v1.5 Phase 2)
app.use('/api', createScoringRouter(db)); // 합산/자동 채점 (v1.5 Phase 3a)
app.use('/api', createReadinessRouter(db)); // 준비도 진단 C-2 (v1.5 Phase 3a)
app.use('/api/admin/users', requireAdmin(db), createUsersRouter(db)); // 사용자 계정 관리(admin) — 더 구체적 경로 먼저
app.use('/api/admin', requireAdmin(db), createAdminRouter(db, { dataDir, filesDir, backupsDir })); // 백업·무결성·상태(admin)

// API 404 (알 수 없는 /api 경로)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// 프로덕션: 빌드된 SPA 정적 서빙 + SPA 폴백 (API 경로 제외)
if (process.env.NODE_ENV === 'production') {
  const webDist = path.join(rootDir, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// JSON 에러 핸들러 (라우터에서 next(err)로 넘어온 예외 포함)
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // body-parser JSON 파싱 실패 → 400
    if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    console.error('[에러]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal' });
    }
  },
);

const server = app.listen(config.port, () => {
  const userVersion = db.pragma('user_version', { simple: true }) as number;
  console.log(`[우수검사실 인증심사 웹 바인더] http://localhost:${config.port} (v${pkg.version})`);
  console.log(`[db] ${dbPath} 연결됨 (WAL, foreign_keys=ON, user_version=${userVersion})`);

  // 백업(매일 03:00)·무결성(기동+주간) 잡 등록 — process 로컬 타이머, cron 불요.
  // 테스트 환경에서는 타이머를 걸지 않는다.
  if (process.env.NODE_ENV !== 'test') {
    startBackupScheduler(db, backupsDir);
    startIntegrityScheduler(db, filesDir);
    // 업로드 임시 파일 고아 스윕 — 프로세스 비정상 종료 잔존분 (Phase 2)
    const swept = sweepTmpDir(filesDir);
    if (swept > 0) console.log(`[정리] 업로드 임시 파일 ${swept}건 삭제 (files/tmp)`);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[기동 실패] 포트 ${config.port} 가 이미 사용 중입니다. config.json의 port를 바꾸거나 기존 프로세스를 종료하세요.`);
    process.exit(1);
  }
  throw err;
});

// 종료 시그널: 새 연결을 닫고 DB를 정리한 뒤 종료 (WAL 체크포인트 유실 방지)
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[종료] ${signal} 수신 — 정리 후 종료합니다.`);
  server.close(() => {
    try {
      db.close();
    } catch { /* 이미 닫힘 */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
