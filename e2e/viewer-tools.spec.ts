/**
 * 근거자료 뷰어 확대/축소와 근거자료 창 분리 E2E
 *
 * 전제: 데모 시드가 들어간 서버 하나(E2E_BASE_URL), admin/day1pass.
 *   60.060.010: docx 근거 '가상기관 정보보안 점검 절차서', PDF 근거 '가상기관 정보보안 운영지침'
 *   60.040.010: 그림 근거 '가상기관 망 분리 구성도'
 *   60.050.010: 시드 근거가 없는 문항. 떼어 낸 창에서 시드 그림을 이 문항에 잇고, 끝에서 그 연결을 지운다.
 *     연결 중 Esc 와 [자료 닫기] 시험도 이 문항에서 하되 근거는 만들지 않는다.
 *
 * - 시드 자료는 읽기만 한다. 이 파일이 만든 문항 연결은 끝에서 지운다.
 * - 배율은 브라우저에 기억하므로(localStorage) 시험마다 새 브라우저 문맥에서 시작한다(Playwright 기본).
 * - 모든 시험에서 외부(localhost 밖) 요청과 페이지 예외(pageerror)가 0건이어야 한다(떼어 낸 창 포함).
 *
 * 실행 예 (빌드한 서버, 설치된 Chrome):
 *   E2E_BASE_URL=http://localhost:8095 E2E_CHANNEL=chrome npx playwright test e2e/viewer-tools.spec.ts --workers=1
 */
import { test as base, expect as baseExpect, type Locator, type Page } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 15_000 });

const SHOT = process.env.E2E_SHOT_DIR ?? 'e2e/.screenshots';
const USER = 'admin';
const PASS = 'day1pass';

const SEED = {
  docx: '가상기관 정보보안 점검 절차서',
  pdf: '가상기관 정보보안 운영지침',
  img: '가상기관 망 분리 구성도',
} as const;
/** docx 와 PDF 근거가 함께 있는 문항 */
const BOTH_Q = { no: '60.060.010', typed: '60060010' };
/** 그림 근거가 있는 문항 */
const IMG_Q = { no: '60.040.010', typed: '60040010' };
/** 떼어 낸 창에서 그림을 잇는 문항 (시드 근거 없음) */
const LINK_Q = { no: '60.050.010', typed: '60050010' };
/** 시드 docx 에서 끌어 고를 글자 (근거로 쓰이지 않은 문장의 앞부분, seed/office-fixtures.ts) */
const DRAG_TEXT = '실패한 시험은 원인과 조치를 적고';

const test = base.extend<{ guard: void }>({
  guard: [
    async ({ context, baseURL }, use) => {
      const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
      if (baseURL) local.add(new URL(baseURL).hostname);
      const external: string[] = [];
      const errors: string[] = [];
      context.on('request', (r) => {
        const u = new URL(r.url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return;
        if (!local.has(u.hostname)) external.push(r.url());
      });
      const watch = (p: Page) =>
        p.on('pageerror', (e) => {
          // pdf.js 작업 스레드(pdf.worker.mjs ensureNotTerminated)가 문서를 읽는 중에 새로 고치거나 창을 닫으면 내는 종료 알림.
          // 화면 동작과 무관하고 시점에 따라 가끔만 난다(전체 실행에서 두 번 봄). 이 문구 하나만 뺀다
          if (e.message === 'Worker was terminated') return;
          errors.push(e.message);
        });
      context.pages().forEach(watch);
      context.on('page', watch);
      await use();
      expect(external, `외부 요청: ${external.join(', ')}`).toEqual([]);
      expect(errors, `페이지 예외: ${errors.join(' | ')}`).toEqual([]);
    },
    { auto: true },
  ],
});

interface DocRow {
  id: number;
  title: string;
  currentVersion: { id: number } | null;
}
interface AnchorRow {
  anchorId: number;
  passageId: number;
  questions: { id: number; questionNo: string }[];
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  const idField = page.locator('label', { hasText: '아이디' }).locator('input');
  const yearCard = page.locator('.year-card.is-current');
  await expect(idField.or(yearCard).first()).toBeVisible({ timeout: 30_000 });
  if (await idField.isVisible()) {
    await idField.fill(USER);
    await page.locator('label', { hasText: '비밀번호' }).locator('input').fill(PASS);
    await page.getByRole('button', { name: /로그인/ }).click();
  }
  await expect(yearCard).toBeVisible({ timeout: 30_000 });
}

/** 연결 끊김(ECONNRESET)에만 두 번까지 다시 보낸다 (같은 요청을 다시 보내도 되는 GET, 연결 해제) */
async function retryOnReset<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= 3 || !/ECONNRESET|socket hang up/i.test(msg)) throw e;
    }
  }
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await retryOnReset(() => page.request.get(path));
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function evidenceCard(page: Page, docTitle: string): Locator {
  return page
    .locator('.evd-card')
    .filter({ has: page.locator('.evd-source', { hasText: new RegExp(`^${escapeRe(docTitle)} `) }) })
    .first();
}

/** 옴니박스 번호 패스트패스로 문항 상세를 연다 */
async function openQuestion(page: Page, q: { no: string; typed: string }): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const omni = page.getByRole('dialog', { name: '검색' });
  await expect(omni).toBeVisible();
  await omni.getByRole('textbox').fill(q.typed);
  await expect(omni.locator('[role="option"]').first()).toContainText(q.no, { timeout: 5_000 });
  await omni.getByRole('textbox').press('Enter');
  await expect(page).toHaveURL(/\/q\/\d+/);
  await expect(page.locator('.qd3-head')).toContainText(q.no);
}

/** 그림이 실제로 풀려 그려졌는가 (naturalWidth > 0) */
async function expectImageDrawn(img: Locator): Promise<void> {
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

/** 글자 조각 안의 sub 를 마우스로 끌어 고른다 (office.spec.ts 의 dragSelect 와 같은 방식) */
async function dragSelect(page: Page, piece: Locator, sub: string): Promise<void> {
  await piece.scrollIntoViewIfNeeded();
  const pts = await piece.evaluate((el, s) => {
    const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(s));
    if (!node) throw new Error(`글자 노드에서 '${s}' 를 찾지 못했다`);
    const from = (node.textContent ?? '').indexOf(s);
    const to = from + s.length;
    const r = document.createRange();
    r.setStart(node, from);
    r.setEnd(node, from + 1);
    const a = r.getClientRects()[0] ?? r.getBoundingClientRect();
    r.setStart(node, to - 1);
    r.setEnd(node, to);
    const rs = r.getClientRects();
    const b = rs[rs.length - 1] ?? r.getBoundingClientRect();
    return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 };
  }, sub);
  await page.mouse.move(pts.x0, pts.y0);
  await page.mouse.down();
  await page.mouse.move((pts.x0 + pts.x1) / 2, (pts.y0 + pts.y1) / 2, { steps: 6 });
  await page.mouse.move(pts.x1, pts.y1, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(sub.slice(0, 6));
}

/** 확대/축소 줄의 퍼센트 (아직 모르면 NaN) */
async function readPct(bar: Locator): Promise<number> {
  const t = (await bar.locator('.vzb-pct').textContent()) ?? '';
  const m = /^(\d+)%$/.exec(t.trim());
  return m ? Number(m[1]) : Number.NaN;
}

/** 요소 한가운데 좌표 */
async function centerOf(loc: Locator): Promise<{ x: number; y: number }> {
  const b = await loc.boundingBox();
  expect(b, '요소가 화면에 있어야 한다').toBeTruthy();
  return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
}

/** Ctrl 을 누른 채 휠 (dy < 0 이면 위로 = 확대) */
async function ctrlWheel(page: Page, at: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, dy);
  await page.keyboard.up('Control');
}

/** Ctrl 을 누른 채 왼쪽 단추로 끌기 (dy < 0 이면 위로 = 확대) */
async function ctrlDrag(page: Page, at: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
}

/** 브라우저 화면 확대가 일어나지 않았는가: 뷰어만 커져야 한다 */
async function pageZoom(page: Page): Promise<number> {
  return page.evaluate(() => window.devicePixelRatio);
}

type Rel = { rx: number; ry: number };

/** 커서 밑 요소(sel 로 고른 조상)를 표시해 두고, 그 요소 안에서 커서가 놓인 상대 위치(0~1)를 돌려준다 */
async function markUnderCursor(page: Page, at: { x: number; y: number }, sel: string): Promise<Rel> {
  return page.evaluate(
    ({ p, s }) => {
      const el = document.elementFromPoint(p.x, p.y)?.closest(s) as HTMLElement | null;
      if (!el) throw new Error(`커서 밑에 ${s} 가 없다`);
      (window as unknown as { __zoomProbe: HTMLElement }).__zoomProbe = el;
      const r = el.getBoundingClientRect();
      return { rx: (p.x - r.left) / r.width, ry: (p.y - r.top) / r.height };
    },
    { p: at, s: sel },
  );
}

/** 배율을 바꾼 뒤에도 표시해 둔 요소의 같은 자리가 커서 밑에 남았는가 (크롬 PDF 뷰어처럼 커서 자리를 고정점으로) */
async function expectAnchored(page: Page, at: { x: number; y: number }, before: Rel): Promise<void> {
  await expect
    .poll(async () => {
      const a = await page.evaluate((p) => {
        const el = (window as unknown as { __zoomProbe: HTMLElement }).__zoomProbe;
        const r = el.getBoundingClientRect();
        return { rx: (p.x - r.left) / r.width, ry: (p.y - r.top) / r.height };
      }, at);
      return Math.max(Math.abs(a.rx - before.rx), Math.abs(a.ry - before.ry));
    })
    .toBeLessThan(0.03);
}

// 이 파일이 만든 문항 연결: 끝에서 지운다
const createdLinks: { passageId: number; questionId: number }[] = [];

test.afterAll(async ({ browser }, testInfo) => {
  if (createdLinks.length === 0) return;
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const p = await ctx.newPage();
  const res = await retryOnReset(() => p.request.post('/api/auth/login', { data: { username: USER, password: PASS } }));
  expect(res.ok(), `정리용 로그인 → ${res.status()}`).toBeTruthy();
  while (createdLinks.length > 0) {
    const l = createdLinks.pop()!;
    const del = await retryOnReset(() => p.request.delete(`/api/passages/${l.passageId}/links/${l.questionId}?confirm=1`));
    expect([200, 404], `연결 해제 ${l.passageId}/${l.questionId} → ${del.status()}`).toContain(del.status());
  }
  await ctx.close();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. 확대/축소: 위쪽 단추, Ctrl+휠, Ctrl+드래그, 기억
// ═════════════════════════════════════════════════════════════════════════════

test.describe('근거자료 뷰어 확대/축소', () => {
  test('Office(docx): [+][−], 퍼센트 단추 100%, 폭 맞춤, Ctrl+휠과 Ctrl+드래그, 새로 고침 뒤에도 같은 배율', async ({ page }) => {
    await login(page);
    await openQuestion(page, BOTH_Q);
    await evidenceCard(page, SEED.docx).getByRole('button', { name: '상세보기' }).click();
    const root = page.locator('.qd3-pane .ovp-root[data-file-kind="docx"]');
    await expect(root).toBeVisible({ timeout: 30_000 });
    const bar = root.getByRole('toolbar', { name: '확대와 축소' });
    await expect(bar).toBeVisible();
    await expect(bar.locator('.vzb-pct')).toHaveText(/^\d+%$/);
    await expect(bar).toHaveAttribute('data-zoom-mode', 'auto');
    const p0 = await readPct(bar);

    // 단추는 정해진 단계로
    await bar.getByRole('button', { name: '확대' }).click();
    await expect.poll(() => readPct(bar)).toBeGreaterThan(p0);
    const p1 = await readPct(bar);
    await bar.getByRole('button', { name: '축소' }).click();
    await expect.poll(() => readPct(bar)).toBeLessThan(p1);

    // 퍼센트 단추는 원래 크기
    await bar.locator('.vzb-pct').click();
    await expect(bar.locator('.vzb-pct')).toHaveText('100%');
    await expect(bar).toHaveAttribute('data-zoom-mode', '1');

    // 폭 맞춤: 한 번 더 누르면 기본 크기
    const fit = bar.getByRole('button', { name: '폭 맞춤' });
    await fit.click();
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    await expect(bar).toHaveAttribute('data-zoom-mode', 'width');
    await fit.click();
    await expect(fit).toHaveAttribute('aria-pressed', 'false');
    await expect(bar).toHaveAttribute('data-zoom-mode', 'auto');

    // Ctrl+휠: 뷰어만 커지고 브라우저 화면은 그대로
    await bar.locator('.vzb-pct').click();
    await expect(bar.locator('.vzb-pct')).toHaveText('100%');
    const zoom0 = await pageZoom(page);
    const mid = await centerOf(root.locator('.ovp-scroll'));
    // 기준은 쪽(.ofv-page): 확대 상자(.ovp-zoom)는 칸 폭으로 늘어나 있어 가로 크기가 배율을 따르지 않는다
    const before = await markUnderCursor(page, mid, '.ofv-page');
    await ctrlWheel(page, mid, -300);
    await expect.poll(() => readPct(bar)).toBeGreaterThan(120);
    expect(await pageZoom(page)).toBe(zoom0);
    await expectAnchored(page, mid, before);
    const afterWheel = await readPct(bar);
    await ctrlWheel(page, mid, 300);
    await expect.poll(() => readPct(bar)).toBeLessThan(afterWheel);

    // Ctrl+드래그: 위로 끌면 확대, 아래로 끌면 축소. 글자는 선택되지 않는다
    const beforeUp = await readPct(bar);
    await ctrlDrag(page, mid, -120);
    await expect.poll(() => readPct(bar)).toBeGreaterThan(beforeUp);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    const beforeDown = await readPct(bar);
    await ctrlDrag(page, mid, 80);
    await expect.poll(() => readPct(bar)).toBeLessThan(beforeDown);
    expect(await pageZoom(page)).toBe(zoom0);

    // 고른 배율은 이 브라우저에 남는다
    const kept = await readPct(bar);
    const stored = Number(await page.evaluate(() => localStorage.getItem('viewer-zoom:office')));
    expect(Math.abs(stored * 100 - kept)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOT}/zoom-1-docx.png` });

    await page.reload();
    await expect(page.locator('.qd3-head')).toContainText(BOTH_Q.no);
    await evidenceCard(page, SEED.docx).getByRole('button', { name: '상세보기' }).click();
    await expect(root).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readPct(bar)).toBe(kept);
  });

  test('PDF: [+]로 키우면 쪽이 넓어지고, 퍼센트 단추 100%, Ctrl+휠', async ({ page }) => {
    await login(page);
    await openQuestion(page, BOTH_Q);
    await evidenceCard(page, SEED.pdf).getByRole('button', { name: '상세보기' }).click();
    const root = page.locator('.qd3-pane .pvp-root').filter({ has: page.locator('.PdfHighlighter') });
    const firstPage = root.locator('.pdfViewer .page').first();
    await expect(firstPage).toBeVisible({ timeout: 30_000 });
    const bar = root.getByRole('toolbar', { name: '확대와 축소' });
    await expect.poll(() => readPct(bar)).toBeGreaterThan(0);
    const p0 = await readPct(bar);
    const w0 = (await firstPage.boundingBox())!.width;

    await bar.getByRole('button', { name: '확대' }).click();
    await expect.poll(() => readPct(bar)).toBeGreaterThan(p0);
    await expect.poll(async () => (await firstPage.boundingBox())!.width).toBeGreaterThan(w0 * 1.05);

    await bar.locator('.vzb-pct').click();
    await expect(bar.locator('.vzb-pct')).toHaveText('100%');

    const zoom0 = await pageZoom(page);
    const at = await centerOf(root.locator('.PdfHighlighter'));
    const before = await markUnderCursor(page, at, '.page');
    await ctrlWheel(page, at, -300);
    await expect.poll(() => readPct(bar)).toBeGreaterThan(120);
    expect(await pageZoom(page)).toBe(zoom0);
    // 뷰어가 화면 오른쪽 칸에 있어도 커서 밑 자리가 그대로 남는다(오른쪽으로 밀리지 않는다)
    await expectAnchored(page, at, before);
    // 쪽이 1280px 를 넘게 커져도 쪽 그림(canvas)과 글자층 폭이 같다: 형광 표시가 글자 위에 그대로 놓인다
    await bar.getByRole('button', { name: '확대' }).click();
    await expect.poll(() => readPct(bar)).toBeGreaterThanOrEqual(200);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const pg = (window as unknown as { __zoomProbe: HTMLElement }).__zoomProbe;
          const cv = pg.querySelector('canvas');
          const tl = pg.querySelector('.textLayer');
          if (!cv || !tl) return Number.POSITIVE_INFINITY;
          const w = pg.getBoundingClientRect().width;
          if (w <= 1300) return Number.POSITIVE_INFINITY; // 아직 1280px 를 넘지 않았다
          return Math.abs(cv.getBoundingClientRect().width - tl.getBoundingClientRect().width);
        }),
      )
      .toBeLessThanOrEqual(3);
    await page.screenshot({ path: `${SHOT}/zoom-2-pdf.png` });
  });

  test('그림: [+]로 그림이 커지고, 퍼센트 단추는 원래 픽셀 크기, 폭 맞춤은 칸 폭', async ({ page }) => {
    await login(page);
    await openQuestion(page, IMG_Q);
    await evidenceCard(page, SEED.img).getByRole('button', { name: '상세보기' }).click();
    const root = page.locator('.qd3-pane .ivp-root');
    const img = root.locator('.ivp-figure img');
    await expectImageDrawn(img);
    const bar = root.getByRole('toolbar', { name: '확대와 축소' });
    await expect.poll(() => readPct(bar)).toBeGreaterThan(0);
    const w0 = (await img.boundingBox())!.width;

    await bar.getByRole('button', { name: '확대' }).click();
    await expect.poll(async () => (await img.boundingBox())!.width).toBeGreaterThan(w0 * 1.05);

    await bar.locator('.vzb-pct').click();
    await expect(bar.locator('.vzb-pct')).toHaveText('100%');
    const natural = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    await expect.poll(async () => Math.round((await img.boundingBox())!.width)).toBe(natural);

    // Ctrl+휠: 커서 밑 자리가 그대로 남는다
    const at = await centerOf(root.locator('.ivp-scroll'));
    const before = await markUnderCursor(page, at, '.ivp-figure');
    await ctrlWheel(page, at, -300);
    await expect.poll(() => readPct(bar)).toBeGreaterThan(120);
    await expectAnchored(page, at, before);

    await bar.getByRole('button', { name: '폭 맞춤' }).click();
    const scrollW = await root.locator('.ivp-content').evaluate((el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });
    // 그림 틀 테두리(양쪽 1px)를 뺀 폭
    await expect.poll(async () => Math.abs((await img.boundingBox())!.width - (scrollW - 2))).toBeLessThanOrEqual(2);
    await page.screenshot({ path: `${SHOT}/zoom-3-image.png` });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. 창 분리: 근거자료 뷰어만 새 창으로 (듀얼 모니터)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('근거자료 창 분리', () => {
  test('떼어 내면 문항 화면이 넓어지고, 고르는 근거와 문항 이동이 새 창에 이어지며, 새로 고쳐도 다시 찾는다', async ({ page }) => {
    await login(page);
    await openQuestion(page, BOTH_Q);
    await evidenceCard(page, SEED.docx).getByRole('button', { name: '상세보기' }).click();
    const paneC = page.locator('.qd3-pane');
    await expect(paneC.locator('.ovp-root[data-file-kind="docx"]')).toBeVisible({ timeout: 30_000 });
    const mainW0 = (await page.locator('.qd3-main').boundingBox())!.width;
    await page.screenshot({ path: `${SHOT}/detach-0-before.png` });

    const popupP = page.waitForEvent('popup');
    await paneC.locator('.qd3-pane-head').getByRole('button', { name: '창 분리' }).click();
    const pw = await popupP;
    await expect(pw).toHaveURL(/\/pane-window\?owner=[a-z0-9]+$/);
    await expect(pw.locator('.ovp-root[data-file-kind="docx"]')).toBeVisible({ timeout: 30_000 });
    await expect(pw.locator('.pw-title')).toContainText(SEED.docx);
    await expect(pw.locator('.pw-q')).toHaveText(`문항 ${BOTH_Q.no}`);
    await expect(pw).toHaveTitle(`근거자료: ${SEED.docx}`);
    // 떼어 낸 창에도 확대/축소 줄
    await expect(pw.getByRole('toolbar', { name: '확대와 축소' })).toBeVisible();

    // 문항 화면: 오른쪽 칸과 폭 조절 막대가 빠지고 문항 칸이 그 자리를 쓴다
    await expect(paneC).toHaveCount(0);
    await expect(page.locator('.qd3-resizer:not(.qd3-resizer-rail)')).toHaveCount(0);
    await expect.poll(async () => (await page.locator('.qd3-main').boundingBox())!.width).toBeGreaterThan(mainW0 + 200);
    const dockBtn = page.getByRole('button', { name: '근거자료 창 합치기' });
    await expect(dockBtn).toBeVisible();
    await page.screenshot({ path: `${SHOT}/detach-1-main.png` });
    await pw.screenshot({ path: `${SHOT}/detach-2-pane-window.png` });

    // 문항 화면에서 다른 근거를 고르면 떼어 낸 창이 바뀐다
    await evidenceCard(page, SEED.pdf).getByRole('button', { name: '상세보기' }).click();
    await expect(pw.locator('.pw-title')).toContainText(SEED.pdf);
    await expect(pw.locator('.pvp-root .pdfViewer .page').first()).toBeVisible({ timeout: 30_000 });

    // 다른 문항으로 옮겨도 분리는 그대로이고, 그림 근거를 고르면 새 창에 그림
    await openQuestion(page, IMG_Q);
    await expect(page.locator('.qd3-pane')).toHaveCount(0);
    await expect(pw.locator('.pw-q')).toHaveText(`문항 ${IMG_Q.no}`);
    await evidenceCard(page, SEED.img).getByRole('button', { name: '상세보기' }).click();
    await expectImageDrawn(pw.locator('.ivp-figure img'));

    // 문항 화면을 새로 고쳐도 떼어 낸 창을 다시 찾아 이어진다
    await page.reload();
    await expect(page.locator('.qd3-head')).toContainText(IMG_Q.no);
    await expect(dockBtn).toBeVisible();
    await page.waitForTimeout(1_500); // 다시 찾기 대기(1.2초)가 지나도 분리가 유지되어야 한다
    await expect(page.locator('.qd3-pane')).toHaveCount(0);
    await evidenceCard(page, SEED.img).getByRole('button', { name: '상세보기' }).click();
    await expectImageDrawn(pw.locator('.ivp-figure img'));

    // 배지 [열기]: 떼어 낸 창에서 누르면 문항 화면이 그 문항을 연다
    await openQuestion(page, BOTH_Q);
    await evidenceCard(page, SEED.docx).getByRole('button', { name: '상세보기' }).click();
    await expect(pw.locator('.ovp-root[data-file-kind="docx"]')).toBeVisible({ timeout: 30_000 });
    const badge = pw.locator('.pvp-badge').filter({ hasText: '60.060.020' }).first();
    await badge.click();
    const pop = pw.locator('.pvp-popover');
    await expect(pop).toBeVisible();
    await pop.locator('.pvp-pop-q').filter({ hasText: '60.060.020' }).getByRole('button', { name: /열기/ }).click();
    await expect(page.locator('.qd3-head')).toContainText('60.060.020');
    await expect(pw.locator('.pw-q')).toHaveText('문항 60.060.020');
  });

  test('떼어 낸 창에서 근거를 이으면 문항 화면 근거 카드가 늘고, 합치거나 창을 닫으면 오른쪽 칸이 돌아온다', async ({ page }) => {
    await login(page);
    await openQuestion(page, LINK_Q);
    await expect(evidenceCard(page, SEED.img)).toHaveCount(0);
    const popupP = page.waitForEvent('popup');
    await page.locator('.qd3-pane-empty').getByRole('button', { name: '창 분리' }).click();
    const pw = await popupP;
    await expect(pw.locator('.pw-msg')).toContainText('[+ 근거자료 연결]');
    await expect(page.locator('.qd3-pane')).toHaveCount(0);

    // 문항 화면에서 연결을 시작하면 떼어 낸 창이 연결 모드가 된다
    await page.getByRole('button', { name: '+ 근거자료 연결' }).first().click();
    const picker = page.getByRole('dialog', { name: '연결할 근거자료 선택' });
    await expect(picker).toBeVisible();
    await picker.getByRole('textbox', { name: '근거자료 검색' }).fill(SEED.img);
    await picker.locator('[role="option"]').filter({ hasText: SEED.img }).first().click();
    await expect(picker).toBeHidden();
    await expect(pw.locator('.pw-head.is-map')).toContainText(`연결 중: ${SEED.img} → 「${LINK_Q.no}」`);
    const mapbar = pw.locator('.ivp-mapbar');
    await expect(mapbar).toContainText(`「${LINK_Q.no}」`);
    await expectImageDrawn(pw.locator('.ivp-figure img'));
    await pw.screenshot({ path: `${SHOT}/detach-3-map.png` });

    await mapbar.getByRole('button', { name: /이 그림 연결/ }).click();
    await expect(pw.locator('.pvp-toast')).toContainText(`「${LINK_Q.no}」에 이 그림을 근거로 연결했습니다`);
    // 문항 화면의 근거 카드가 다시 읽혀 그림 근거가 보인다
    const card = evidenceCard(page, SEED.img);
    await expect(card).toBeVisible();
    await expectImageDrawn(card.locator('.evd-thumb img'));
    const { docs } = await getJson<{ docs: DocRow[] }>(page, '/api/docs');
    const imgDoc = docs.find((d) => d.title === SEED.img);
    expect(imgDoc?.currentVersion, '시드 그림 판본').toBeTruthy();
    const { anchors } = await getJson<{ anchors: AnchorRow[] }>(page, `/api/docs/versions/${imgDoc!.currentVersion!.id}/anchors`);
    const linkedTo = anchors.flatMap((a) => a.questions.filter((q) => q.questionNo === LINK_Q.no).map((q) => ({ passageId: a.passageId, questionId: q.id })));
    expect(linkedTo).toHaveLength(1);
    createdLinks.push(linkedTo[0]!);

    // 떼어 낸 창의 Esc 는 연결을 끝내지 않는다(문항 화면과 같다): 연결 중 그대로
    await pw.locator('.ivp-scroll').click({ position: { x: 5, y: 5 } });
    await pw.keyboard.press('Escape');
    await pw.waitForTimeout(300);
    await expect(pw.locator('.pw-head.is-map')).toHaveCount(1);
    await expect(mapbar).toContainText('다른 자료를 고르려면 [자료 닫기]');

    // [근거자료 창 합치기]: 새 창이 닫히고 오른쪽 칸이 지금 보던 근거(연결 중)로 돌아온다
    const closed = pw.waitForEvent('close');
    await page.getByRole('button', { name: '근거자료 창 합치기' }).click();
    await closed;
    await expect(page.locator('.qd3-pane .ivp-root')).toBeVisible();
    await expect(page.locator('.qd3-pane-head.is-map')).toBeVisible();
    await expect(page.locator('.qd3-resizer:not(.qd3-resizer-rail)')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '근거자료 창 합치기' })).toHaveCount(0);

    // 다시 떼어 내고, 새 창의 [자료 닫기]로 근거자료만 닫은 뒤(창은 남는다) 새 창을 직접 닫는다
    const popup2P = page.waitForEvent('popup');
    await page.locator('.qd3-pane-head').getByRole('button', { name: '창 분리' }).click();
    const pw2 = await popup2P;
    await expect(pw2.locator('.ivp-root')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.qd3-pane')).toHaveCount(0);
    await pw2.locator('.pw-head').getByRole('button', { name: '자료 닫기' }).click();
    await expect(pw2.locator('.pw-msg')).toContainText('[+ 근거자료 연결]');
    await expect(pw2.locator('.ivp-root')).toHaveCount(0);
    await expect(page.locator('.qd3-pane')).toHaveCount(0);
    await pw2.close();
    await expect(page.locator('.qd3-pane-empty')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: '근거자료 창 합치기' })).toHaveCount(0);
  });

  test('탭 복제(같은 탭 표지)여도 두 문항 화면이 한 창을 두고 다투지 않는다', async ({ page, context }) => {
    await login(page);
    await openQuestion(page, BOTH_Q);
    await evidenceCard(page, SEED.docx).getByRole('button', { name: '상세보기' }).click();
    const popupP = page.waitForEvent('popup');
    await page.locator('.qd3-pane-head').getByRole('button', { name: '창 분리' }).click();
    const pw = await popupP;
    await expect(pw.locator('.ovp-root[data-file-kind="docx"]')).toBeVisible({ timeout: 30_000 });

    // 탭 복제처럼 sessionStorage(탭 표지, 분리 표시)를 그대로 옮긴 두 번째 탭
    const session = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
    const tab2 = await context.newPage();
    await tab2.addInitScript((s) => {
      if (sessionStorage.getItem('cwb-pane-owner')) return;
      for (const [k, v] of JSON.parse(s) as [string, string][]) sessionStorage.setItem(k, v);
    }, session);
    await tab2.goto(page.url());
    await expect(tab2.locator('.qd3-head')).toContainText(BOTH_Q.no);
    // 두 번째 탭은 표지를 새로 만들고 자기 오른쪽 칸을 쓴다
    await expect(tab2.locator('.qd3-pane')).toBeVisible();
    await expect(tab2.getByRole('button', { name: '근거자료 창 합치기' })).toHaveCount(0);
    const owner1 = await page.evaluate(() => sessionStorage.getItem('cwb-pane-owner'));
    const owner2 = await tab2.evaluate(() => sessionStorage.getItem('cwb-pane-owner'));
    expect(owner2).not.toBe(owner1);
    // 두 번째 탭에서 PDF 근거를 골라도 첫 탭의 떼어 낸 창은 그대로 docx
    await evidenceCard(tab2, SEED.pdf).getByRole('button', { name: '상세보기' }).click();
    await expect(tab2.locator('.qd3-pane .pdfViewer .page').first()).toBeVisible({ timeout: 30_000 });
    await expect(pw.locator('.pw-title')).toContainText(SEED.docx);
    // 첫 탭은 여전히 분리 상태로 이어져 있다
    await evidenceCard(page, SEED.pdf).getByRole('button', { name: '상세보기' }).click();
    await expect(pw.locator('.pw-title')).toContainText(SEED.pdf);
    await tab2.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. 연결 중 근거자료: Esc 뒤에도 드래그하면 [연결], [자료 닫기]로 닫고 다른 자료 고르기 (근거는 만들지 않는다)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('연결 중 근거자료', () => {
  test('Esc 는 고른 부분만 지우고 연결은 그대로라 다시 드래그하면 [연결]이 뜨고, [자료 닫기]로 닫은 뒤 다른 자료를 고른다', async ({ page }) => {
    await login(page);
    await openQuestion(page, LINK_Q);
    const picker = page.getByRole('dialog', { name: '연결할 근거자료 선택' });
    // 문항 화면이 근거를 다시 읽는 사이에 누르면 클릭이 묻힐 수 있다(전체 실행에서 한 번 봄): 창이 뜰 때까지 다시 누른다
    await expect(async () => {
      if (!(await picker.isVisible())) await page.getByRole('button', { name: '+ 근거자료 연결' }).first().click();
      await expect(picker).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await picker.getByRole('textbox', { name: '근거자료 검색' }).fill(SEED.docx);
    await picker.locator('[role="option"]').filter({ hasText: SEED.docx }).first().click();
    await expect(picker).toBeHidden();

    const head = page.locator('.qd3-pane-head.is-map');
    await expect(head).toContainText(`연결 중: ${SEED.docx} → 「${LINK_Q.no}」`);
    await expect(head.getByRole('button', { name: /연결 끝내기/ })).toHaveCount(0);
    const mapbar = page.locator('.qd3-pane .pvp-mapbar');
    await expect(mapbar).toHaveText(`드래그한 부분이 「${LINK_Q.no}」에 연결됩니다. 다른 자료를 고르려면 [자료 닫기]`);
    const pane = page.locator('.qd3-pane .ovp-root[data-file-kind="docx"]');
    const piece = pane.locator('[data-o]').filter({ hasText: DRAG_TEXT }).first();
    await expect(piece).toBeVisible({ timeout: 30_000 });
    const toolbar = page.getByRole('toolbar', { name: '근거 연결' });

    await dragSelect(page, piece, DRAG_TEXT);
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toContainText(`「${LINK_Q.no}」`);
    // Esc 한 번: 고른 부분과 툴바만 지운다
    await page.keyboard.press('Escape');
    await expect(toolbar).toBeHidden();
    await expect(head).toBeVisible();
    // 고른 것이 없을 때 Esc 한 번 더: 그래도 연결은 끝나지 않아 드래그하면 [연결]이 뜬다
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(head).toBeVisible();
    await expect(mapbar).toBeVisible();
    await dragSelect(page, piece, DRAG_TEXT);
    await expect(toolbar).toBeVisible();
    await page.screenshot({ path: `${SHOT}/close-1-map-after-esc.png` });
    await page.keyboard.press('Escape');
    await expect(toolbar).toBeHidden();

    // [자료 닫기]: 근거를 만들지 않고 닫히며, 빈 칸에서 다른 자료를 고른다
    await head.getByRole('button', { name: '자료 닫기' }).click();
    const empty = page.locator('.qd3-pane-empty');
    await expect(empty).toBeVisible();
    await expect(page.locator('.qd3-pane-head')).toHaveCount(0);
    await empty.getByRole('button', { name: '+ 근거자료 연결' }).click();
    await expect(picker).toBeVisible();
    await picker.getByRole('textbox', { name: '근거자료 검색' }).fill(SEED.pdf);
    await picker.locator('[role="option"]').filter({ hasText: SEED.pdf }).first().click();
    await expect(head).toContainText(`연결 중: ${SEED.pdf} → 「${LINK_Q.no}」`);
    await expect(page.locator('.qd3-pane .pdfViewer .page').first()).toBeVisible({ timeout: 30_000 });
    await expect(mapbar).toContainText('다른 자료를 고르려면 [자료 닫기]');
    await expect(evidenceCard(page, SEED.docx)).toHaveCount(0);
    await expect(evidenceCard(page, SEED.pdf)).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/close-2-other-doc.png` });

    // 상세보기로 연 근거(열람)에도 [자료 닫기]
    await openQuestion(page, BOTH_Q);
    await evidenceCard(page, SEED.docx).getByRole('button', { name: '상세보기' }).click();
    const viewHead = page.locator('.qd3-pane-head');
    await expect(viewHead).toContainText(SEED.docx);
    await expect(viewHead).not.toHaveClass(/is-map/);
    await viewHead.getByRole('button', { name: '자료 닫기' }).click();
    await expect(empty).toBeVisible();
  });
});
