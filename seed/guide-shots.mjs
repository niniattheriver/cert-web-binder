#!/usr/bin/env node
/**
 * 사용 안내 화면 캡처 다시 찍기 → web/public/guide/*.png
 *
 * 버려도 되는 시험 서버에서만 실행한다. 이 스크립트는 데모 자료에 채점, 지적사항, 첨부, 링크,
 * 자유형식 문서, 기관 지표, 계정, 근거자료 새 판본, 2027년 문항 가져오기를 실제로 써 넣는다.
 * 그래서 로그인 뒤 데모 시드(분야 50, 60, 문항 55개, 제목이 '가상기관'으로 시작하는 근거자료 5개,
 * 손대지 않은 2026년 주기 하나)가 아니면 아무것도 쓰지 않고 멈춘다.
 *
 * 준비(저장소 뿌리에서):
 *   1) 빈 data/ 로 데모 시드:   npm run seed:demo
 *   2) 서버와 웹 띄우기:         npm run dev        (또는 빌드한 서버 하나)
 * 실행:
 *   node seed/guide-shots.mjs --base http://localhost:5173 [--out web/public/guide] [--scale 1.5] [--channel chrome]
 *   Playwright 전용 Chromium 을 받지 않은 PC 는 --channel chrome 으로 설치된 Chrome 을 쓴다.
 *
 * 찍는 순서가 곧 자료 상태다:
 *   A. 데모 활동을 써 넣은 뒤: login, questions, detail, evidence, docs, summary, org, users, search
 *   B. 개인정보 처리지침 2027 개정판을 새 판본으로 올린 뒤: dashboard(빨간 알림), review, reconnect
 *   C. 2027년 문항 PDF 를 가져온 뒤: import, import-preview, year2027-detail, home
 * 화면 크기는 1280×800, 배율은 --scale(기본 1.5). 마지막에 캡처마다 CSS 크기(픽셀 ÷ 배율)를 출력한다.
 * 사용 안내 Guide.tsx 의 SHOT_SIZE 에 붙여 넣는다: 그림이 늦게 읽혀도 자리가 흔들리지 않고, 작은 캡처는 제 크기로 보인다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = arg('base', 'http://localhost:5173').replace(/\/$/, '');
const OUT = path.resolve(repoRoot, arg('out', 'web/public/guide'));
const SCALE = Number(arg('scale', '1.5'));
const CHANNEL = arg('channel', undefined);
const VIEW = { width: 1280, height: 800 };
const DEMO_2027 = path.join(repoRoot, 'seed', 'demo-pdfs', '2027');

const log = (...a) => console.log('[guide-shots]', ...a);
const sizes = {};

/** PNG 머리에서 픽셀 크기를 읽는다 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function shot(page, name, opts = {}) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(opts.settle ?? 600);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...(opts.clip ? { clip: opts.clip } : {}) });
  sizes[name] = pngSize(file);
  log(`${name}.png ${sizes[name].w}×${sizes[name].h}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const api = page.request;

  const json = async (res, what) => {
    if (!res.ok()) throw new Error(`${what}: HTTP ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const get = async (url) => json(await api.get(`${BASE}${url}`), `GET ${url}`);
  const send = async (method, url, data) =>
    json(await api.fetch(`${BASE}${url}`, { method, data }), `${method} ${url}`);

  // ── 0. 로그인 전 화면 ──
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('.login-card');
  await page.waitForTimeout(400);
  const card = await page.locator('.login-card').boundingBox();
  const pad = 56;
  await shot(page, 'login', {
    clip: {
      x: Math.max(0, card.x - pad),
      y: Math.max(0, card.y - pad),
      width: Math.min(VIEW.width, card.width + pad * 2),
      height: Math.min(VIEW.height, card.height + pad * 2),
    },
  });

  await json(
    await api.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'day1pass' } }),
    '로그인',
  );

  // ── 안전장치: 손대지 않은 데모 시드인지 확인 ──
  const boot = await get('/api/bootstrap');
  const cats = boot.categories ?? [];
  const docs = (await get('/api/docs')).docs ?? [];
  const total = cats.reduce((n, c) => n + c.questionCount, 0);
  const answered = cats.reduce((n, c) => n + c.answeredCount, 0);
  const isDemo =
    cats.map((c) => c.code).sort().join(',') === '50,60' &&
    total === 55 &&
    answered <= 1 &&
    docs.length === 5 &&
    docs.every((d) => d.title.startsWith('가상기관')) &&
    (boot.cycles ?? []).length <= 1;
  if (!isDemo) {
    throw new Error(
      `데모 시드 상태가 아닙니다(분야 ${cats.map((c) => c.code).join(',')}, 문항 ${total}, 채점 ${answered}, 지침서 ${docs.length}). ` +
        '빈 data/ 에서 npm run seed:demo 한 서버에서만 실행하세요.',
    );
  }
  const cat50 = cats.find((c) => c.code === '50');
  const cat60 = cats.find((c) => c.code === '60');
  const qs50 = (await get(`/api/categories/${cat50.id}/questions`)).questions;
  const qs60 = (await get(`/api/categories/${cat60.id}/questions`)).questions;
  const byNo = new Map([...qs50, ...qs60].map((q) => [q.questionNo, q]));
  const qid = (no) => {
    const q = byNo.get(no);
    if (!q) throw new Error(`문항 없음: ${no}`);
    return q.id;
  };

  // ── A. 데모 활동 써 넣기 (모두 가상 내용) ──
  const score = async (no, choice, delta = 0, extra = {}) => {
    const full = await get(`/api/questions/${qid(no)}`);
    const max = full.maxScore ?? 0;
    const body = { rowVersion: full.rowVersion, answerChoice: choice, ...extra };
    if (choice === 'yes') body.score = Math.max(0, max - delta);
    if (choice === 'no') body.score = 0;
    if (choice === 'na') body.score = null;
    await send('PATCH', `/api/questions/${qid(no)}`, body);
  };
  await score('50.010.010', 'yes');
  await score('50.010.020', 'yes');
  await score('50.010.030', 'no', 0, { findingsText: '2025년 정기 교육을 받지 않은 부서 1곳: 재교육 일정 수립 필요' });
  await score('50.020.010', 'yes', 0.5, { findingsText: '동의서 서식의 보유기간 문구 보완 권고' });
  await score('50.030.020', 'yes');
  await score('50.040.010', 'yes', 0, { reviewed: true });
  await score('50.040.040', 'yes', 0, { reviewed: true });
  await score('60.020.010', 'yes');
  await score('60.020.030', 'yes');
  await score('60.030.010', 'no', 0, { findingsText: '퇴직자 계정 잠금이 늦어진 사례 2건' });
  await score('60.060.010', 'yes', 0, { reviewed: true });
  await score('60.060.020', 'yes');

  await send('POST', `/api/questions/${qid('50.010.020')}/links`, {
    url: 'https://example.org/privacy-policy',
    label: '개인정보 처리방침 게시 화면',
  });
  const csv = '파기일,대상,방법,확인자\r\n2026-03-04,보유기간 지난 검사의뢰서,문서 세단,가상직원A\r\n';
  await json(
    await api.post(`${BASE}/api/questions/${qid('50.030.010')}/attachments`, {
      multipart: { file: { name: '파기대장_2026.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + csv, 'utf8') } },
    }),
    '첨부',
  );
  await send('POST', '/api/richdocs', {
    title: '개인정보 파기 이행 현황',
    questionId: qid('50.030.010'),
    contentPlain: '보유기간이 지난 검사의뢰서는 분기마다 세단하고 파기대장에 기록한다.',
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '파기 이행 현황' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '보유기간이 지난 검사의뢰서는 분기마다 세단하고 파기대장에 기록한다.' }],
        },
      ],
    },
  });
  await send('PATCH', '/api/org/settings', { orgName: '가상기관 진단검사의학과' });
  await send('POST', '/api/org/metrics', {
    metricKey: 'annual_tests',
    label: '전년도 검사 건수',
    unit: '건',
    valueType: 'integer',
    value: 128450,
  });
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
  await send('POST', '/api/admin/users', { username: 'kim.editor', displayName: '김편집', role: 'editor' });
  await send('POST', '/api/admin/users', { username: 'lee.viewer', displayName: '이열람', role: 'viewer' });
  await send('POST', '/api/admin/users', {
    username: 'audit.2026',
    displayName: '심사위원(가상)',
    role: 'viewer',
    expiresAt: inDays(14),
  });
  log('A. 데모 활동을 써 넣었습니다');

  // 카드 보기, 근거자료 연도 '전체'로 고정
  await page.goto(`${BASE}/`);
  await page.evaluate(() => {
    localStorage.setItem('dash-view', 'card');
    localStorage.setItem('docs-year', 'all');
  });

  await page.goto(`${BASE}/c/${cat50.id}`);
  await page.waitForSelector('.qrow-body');
  await shot(page, 'questions');

  await page.goto(`${BASE}/q/${qid('50.030.010')}`);
  await page.waitForSelector('.evd-map-btn');
  await page.waitForSelector('.qd3-pane-title');
  await page.waitForTimeout(1500);
  await shot(page, 'detail', { settle: 1200 });

  await page.locator('.evd-map-btn').click();
  await page.waitForSelector('.qpick-panel .omni-item');
  await shot(page, 'evidence');
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/docs`);
  await page.waitForSelector('.doclib-card');
  await shot(page, 'docs');

  await page.goto(`${BASE}/summary`);
  await page.waitForSelector('.summary-table');
  await shot(page, 'summary');

  await page.goto(`${BASE}/org`);
  await page.waitForSelector('.org-section');
  await shot(page, 'org');

  await page.goto(`${BASE}/users`);
  await page.waitForSelector('table');
  await shot(page, 'users');

  await page.goto(`${BASE}/y/2026`);
  await page.waitForSelector('.dash-card');
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.omni-input');
  await page.locator('.omni-input').fill('파기');
  await page.waitForSelector('.omni-list li');
  await page.waitForTimeout(800);
  await shot(page, 'search');
  await page.keyboard.press('Escape');

  // ── B. 개인정보 처리지침 2027 개정판을 같은 문서의 새 판본으로 ──
  const privacy = docs.find((d) => d.title === '가상기관 개인정보 처리지침');
  if (!privacy) throw new Error('가상기관 개인정보 처리지침 문서가 없습니다');
  const rev = await json(
    await api.post(`${BASE}/api/docs`, {
      multipart: {
        file: {
          name: '가상지침서-개인정보처리지침.pdf',
          mimeType: 'application/pdf',
          buffer: fs.readFileSync(path.join(DEMO_2027, '가상지침서-개인정보처리지침.pdf')),
        },
        documentId: String(privacy.id),
        versionLabel: '2027-1',
        year: '2027',
      },
    }),
    '근거자료 새 버전',
  );
  log(`B. 새 버전 올림: 자동 이관 ${rev.reanchor?.auto ?? '?'}건, 확인 필요 ${rev.reanchor?.needsReview ?? '?'}건`);

  await page.goto(`${BASE}/y/2026`);
  await page.waitForSelector('.dash-flags');
  await shot(page, 'dashboard');

  await page.goto(`${BASE}/review`);
  await page.waitForSelector('h1');
  await shot(page, 'review');

  await page.goto(`${BASE}/docs/${privacy.id}`);
  await page.waitForSelector('.docv-rail-item');
  await page.waitForTimeout(1500);
  await shot(page, 'reconnect', { settle: 1000 });

  // ── C. 2027년 문항 PDF 가져오기 (분야 코드는 파일 이름에서 읽는다) ──
  await page.goto(`${BASE}/import`);
  await page.waitForSelector('.import-year-row select');
  await page.locator('.import-year-row select').selectOption('2027');
  await page.locator('input[type=file]').setInputFiles([
    {
      name: '2027_50.pdf',
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(path.join(DEMO_2027, '가상문항-50-개인정보보호.pdf')),
    },
    {
      name: '2027_60.pdf',
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(path.join(DEMO_2027, '가상문항-60-정보보안.pdf')),
    },
  ]);
  await page.waitForSelector('.file-list li');
  await shot(page, 'import');

  await page.getByRole('button', { name: '업로드하고 미리보기' }).click();
  await page.waitForSelector('h1:has-text("가져오기 미리보기")', { timeout: 60_000 });
  await shot(page, 'import-preview');

  await page.getByRole('button', { name: '가져오기 실행' }).click();
  await page.waitForSelector('h1:has-text("가져오기 완료")', { timeout: 60_000 });

  const boot27 = await get('/api/bootstrap');
  const cycle27 = (boot27.cycles ?? []).find((c) => c.year === 2027);
  if (!cycle27) throw new Error('2027년 주기가 만들어지지 않았습니다');
  const cats27 = (await get(`/api/bootstrap?cycle=${cycle27.id}`)).categories;
  // 60.060.010: 2027년판에서 설명이 바뀐 문항(변경 표시)이고 PDF, Word 근거 두 개를 물려받는다
  const c27 = cats27.find((c) => c.code === '60');
  const q27 = (await get(`/api/categories/${c27.id}/questions`)).questions.find((q) => q.questionNo === '60.060.010');
  await page.goto(`${BASE}/q/${q27.id}`);
  await page.waitForSelector('.qd3-pane-title');
  await page.waitForTimeout(1500);
  await shot(page, 'year2027-detail', { settle: 1200 });

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.year-card');
  await shot(page, 'home');

  await browser.close();
  if (errors.length > 0) log(`화면 오류 ${errors.length}건: ${errors.join(' | ')}`);
  // Guide.tsx 의 SHOT_SIZE 에 붙여 넣을 CSS 크기(픽셀 ÷ 배율): 작은 캡처는 늘리지 않고 제 크기로 보인다
  log('Guide.tsx SHOT_SIZE (CSS px):');
  for (const [k, v] of Object.entries(sizes)) {
    console.log(`  '/guide/${k}.png': [${Math.round(v.w / SCALE)}, ${Math.round(v.h / SCALE)}],`);
  }
}

main().catch((e) => {
  console.error('[guide-shots 실패]', e);
  process.exit(1);
});
