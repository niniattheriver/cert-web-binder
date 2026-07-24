// 생성 PDF 검증 — pdfjs-dist(legacy 빌드)로 실제 텍스트를 추출해 "실물 문항 서식 계약"을
// 파서 의존 없이 자체 정규식으로 확인한다.
//   문항 PDF: 표지 / 개정 요약표(• 신규·수정·삭제) / 문항분류체계 / 목차 / 본문 문항 블록.
//   블록 계약: "문항 [핵심C|필요R|기본B] [번호] [본문]" → "배점" → "(N) 아니오 [해당없음]" → "설명" → 불릿.
//   본문 페이지 경계 걸침, 삭제 문항(개정표에만 있고 본문에 없음), 유형 분포, 배점/해당없음, 원문 왕복.
//   `--y2027`: seed/demo-pdfs/2027/ 의 2027 가상 개정판을 content-2027.mjs 기준으로 검증하고,
//   demo-anchors.json의 근거 인용문이 신판에서 유지/불일치되는지(자동 이관 데모 전제)도 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const Y2027 = process.argv.includes('--y2027');
const OUT_DIR = Y2027 ? path.join(HERE, '..', 'demo-pdfs', '2027') : path.join(HERE, '..', 'demo-pdfs');
const YEAR = Y2027 ? '2027' : '2026';
const { guidelineA, guidelineB, questions50, questions60, COVER_TITLE } =
  await import(Y2027 ? './content-2027.mjs' : './content.mjs');
const QNUM_RE = /\d{2}\.[0-9A-Z]{3}\.\d{3}/g;
const QHEADER_RE = /^문항\s+(핵심C|필요R|기본B)\s+(\d{2}\.[0-9A-Z]{3}\.\d{3})\b/;
const SCORE_LINE_RE = /^\((\d+(?:\.\d+)?)\)\s*아니오(\s*해당없음)?\s*$/;
const GRADE_LABEL = { core: '핵심C', required: '필요R', basic: '기본B' };
const strip = (s) => s.normalize('NFC').replace(/\s+/g, '');

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
}

async function extract(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str.length > 0)
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
    const lines = [];
    let curY = null;
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) > 2) { lines.push(it.str); curY = it.y; }
      else lines[lines.length - 1] += it.str;
    }
    pages.push({ lines, text: lines.join('\n') });
  }
  await pdf.destroy();
  return { numPages: pdf.numPages, pages };
}

function reportPages(ex) {
  const counts = ex.pages.map((pg, i) => `p${i + 1}:${pg.text.replace(/\s/g, '').length}`);
  console.log(`  페이지 수: ${ex.pages.length} / 페이지별 문자수(공백 제외): ${counts.join(' ')}`);
}

function commonChecks(ex) {
  const all = ex.pages.map((p) => p.text).join('\n');
  check(/[가-힣]/.test(all), '한국어 문자열 포함');
  check(all === all.normalize('NFC'), '추출 텍스트가 NFC 상태(정규화 불변)');
  return all;
}

// ---------------------------------------------------------------------------
// 지침서 (현행 유지 — 기존 서식 그대로 검증)
// ---------------------------------------------------------------------------
function cleanedGuideline(ex) {
  return ex.pages.map((pg) => pg.lines.filter((l) => !/^\s*-\s*\d+\s*-\s*$/.test(l.trim())));
}

async function verifyGuideline(g, expectPages) {
  const file = path.join(OUT_DIR, `${g.fileBase}.pdf`);
  console.log(`\n== ${path.basename(file)} ==`);
  const ex = await extract(file);
  reportPages(ex);
  commonChecks(ex);
  check(ex.pages.every((p, i) => p.lines.some((l) => l.trim() === `- ${i + 1} -`)), '모든 페이지에 "- N -" 페이지 번호');
  const sAll = strip(cleanedGuideline(ex).flat().join('\n'));
  check(ex.pages.length >= expectPages[0] && ex.pages.length <= expectPages[1], `쪽수 ${expectPages[0]}~${expectPages[1]} 범위 (실제 ${ex.pages.length})`);
  const miss = [];
  for (const art of g.articles) {
    if (!sAll.includes(strip(`제${art.no}조(${art.title})`))) miss.push(`제${art.no}조 제목`);
    for (const p of art.paras) if (!sAll.includes(strip(p))) miss.push(`제${art.no}조 항`);
  }
  const total = g.articles.length + g.articles.reduce((n, a) => n + a.paras.length, 0);
  check(miss.length === 0, `생성 원문 ${total}건(조 제목+항 전부)이 추출 텍스트에 존재 (누락 ${miss.length}: ${miss.slice(0, 3).join(', ')})`);
}

// ---------------------------------------------------------------------------
// 문항 (실물 서식)
// ---------------------------------------------------------------------------
/** 본문 상단 running header "쪽번호 + [분야명]" 을 제거한 줄 목록(페이지별). */
function stripRunHeader(ex, fieldName) {
  const re = new RegExp(`^\\d+\\s+${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return ex.pages.map((pg) => pg.lines.filter((l) => !re.test(l.trim())));
}

/** 본문 줄 스트림을 걸어 문항 블록(번호/유형/배점/해당없음)을 재구성한다(파서 비의존). */
function parseBlocks(lines) {
  const parsed = [];
  let i = 0;
  while (i < lines.length) {
    const hm = QHEADER_RE.exec(lines[i].trim());
    if (!hm) { i += 1; continue; }
    const grade = hm[1];
    const num = hm[2];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '배점' && !QHEADER_RE.test(lines[j].trim())) j += 1;
    if (j >= lines.length || lines[j].trim() !== '배점') { parsed.push({ num, grade, score: null, na: null }); i = j; continue; }
    const sm = SCORE_LINE_RE.exec((lines[j + 1] ?? '').trim());
    parsed.push({ num, grade, score: sm ? sm[1] : null, na: sm ? !!sm[2] : null });
    i = j + 2;
  }
  return parsed;
}

/** 개정표 페이지에서 각 구획의 데이터행을 수집. */
function pageWith(ex, needle) {
  return ex.pages.find((pg) => pg.lines.some((l) => l.trim() === needle || l.includes(needle)));
}

async function verifyQuestions(q, { expectCross = false } = {}) {
  const file = path.join(OUT_DIR, `${q.fileBase}.pdf`);
  console.log(`\n== ${path.basename(file)} ==`);
  const ex = await extract(file);
  reportPages(ex);
  const all = commonChecks(ex);

  // --- 표지(p.1) ---
  const cover = ex.pages[0].lines.map((l) => l.trim());
  check(cover.includes(COVER_TITLE), `표지 제목 "${COVER_TITLE}"`);
  check(cover.includes(q.fieldName), `표지 분야명 "${q.fieldName}"`);
  check(cover.includes(q.yearMonth), `표지 발행 시기 "${q.yearMonth}"`);

  // --- 개정 요약표(p.2) ---
  const rev = pageWith(ex, `${YEAR} 년 개정판 변경내역 요약`);
  check(!!rev, `개정 요약표 페이지 존재("${YEAR} 년 개정판 변경내역 요약")`);
  const rl = rev ? rev.lines.map((l) => l.trim()) : [];
  check(rl.includes('(Summary of Changes)'), '개정표 부제 "(Summary of Changes)"');
  check(rl.includes('• 신규') && rl.includes('• 수정') && rl.includes('• 삭제'), '개정표 3구획 "• 신규 / • 수정 / • 삭제"');
  const secExpect = [
    ['신규', q.revision.new, '문항번호 사유'],
    ['수정', q.revision.modified, '문항번호 수정유형'],
    ['삭제', q.revision.deleted, '문항번호 사유'],
  ];
  const revText = strip(rl.join('\n'));
  let revMiss = 0;
  for (const [name, rows, colHeader] of secExpect) {
    if (!rl.includes(colHeader)) revMiss += 1;
    if (rows.length === 0) continue;
    for (const r of rows) if (!revText.includes(strip(`${r.num} ${r.note}`))) revMiss += 1;
    void name;
  }
  const emptyDash = secExpect.filter(([, rows]) => rows.length === 0).length;
  check(revMiss === 0, `개정표 열 헤더 + 데이터행 전부 존재 (누락 ${revMiss})`);
  check(emptyDash === 0 || rl.filter((l) => l === '-').length >= emptyDash, `빈 구획 "-" 표기 ${emptyDash}개 이상`);

  // --- 문항분류체계 / 목차 페이지 존재(파서 스킵 대상이지만 서식 구성요소) ---
  check(!!pageWith(ex, '• 문항분류체계'), '문항분류체계 페이지 존재');
  check(ex.pages.some((pg) => pg.lines.some((l) => l.trim() === '목 차')), '목차 페이지 존재("목 차")');
  const clf = pageWith(ex, '• 문항분류체계');
  const clfOk = clf && ['핵심문항 : C', '필요문항 : R', '기본문항 : B'].every((s) => clf.lines.some((l) => l.includes(s)));
  check(!!clfOk, '분류체계 표기 "핵심문항 : C / 필요문항 : R / 기본문항 : B"');

  // --- 본문 running header "쪽번호 + [분야명]" 존재 + 제거 후 블록 파싱 ---
  const bodyPages = ex.pages.filter((pg) => pg.lines.some((l) => QHEADER_RE.test(l.trim())));
  const runHeaderRe = new RegExp(`^\\d+\\s+${q.fieldName}$`);
  check(bodyPages.every((pg) => runHeaderRe.test(pg.lines[0]?.trim() ?? '')), '모든 본문 페이지 상단에 "쪽번호 + 분야명" 머리글');

  const cleaned = stripRunHeader(ex, q.fieldName);
  const bodyLines = cleaned.flat();
  const blocks = parseBlocks(bodyLines);

  // 문항 수 = 본문 블록 수
  check(blocks.length === q.items.length, `본문 문항 블록 수 = ${q.items.length} (실제 ${blocks.length})`);

  // 번호/유형/배점/해당없음 순서 일치
  let mismatch = 0;
  const detail = [];
  q.items.forEach((it, i) => {
    const b = blocks[i];
    if (!b) { mismatch += 1; return; }
    if (b.num !== it.num) { mismatch += 1; detail.push(`#${i} 번호 ${b.num}≠${it.num}`); return; }
    if (b.grade !== GRADE_LABEL[it.type]) { mismatch += 1; detail.push(`${it.num} 유형 ${b.grade}≠${GRADE_LABEL[it.type]}`); }
    if (b.score !== String(it.score)) { mismatch += 1; detail.push(`${it.num} 배점 ${b.score}≠${it.score}`); }
    if (b.na !== it.na) { mismatch += 1; detail.push(`${it.num} 해당없음 ${b.na}≠${it.na}`); }
  });
  check(mismatch === 0, `번호·유형(C/R/B)·배점·해당없음 순서/값 일치 (불일치 ${mismatch}: ${detail.slice(0, 4).join(' / ')})`);

  // 유형 분포
  const dist = { 핵심C: 0, 필요R: 0, 기본B: 0 };
  for (const b of blocks) if (dist[b.grade] !== undefined) dist[b.grade] += 1;
  const expDist = { 핵심C: 0, 필요R: 0, 기본B: 0 };
  for (const it of q.items) expDist[GRADE_LABEL[it.type]] += 1;
  check(JSON.stringify(dist) === JSON.stringify(expDist), `유형 분포 핵심C=${dist.핵심C} 필요R=${dist.필요R} 기본B=${dist.기본B} (기대 ${expDist.핵심C}/${expDist.필요R}/${expDist.기본B})`);

  // 해당없음 개수
  const naCount = blocks.filter((b) => b.na).length;
  const expNa = q.items.filter((i) => i.na).length;
  check(naCount === expNa, `해당없음 문항 ${expNa}개 (실제 ${naCount})`);

  // 삭제 문항은 본문에 없음
  const bodyNums = new Set(blocks.map((b) => b.num));
  const delLeak = q.revision.deleted.filter((d) => bodyNums.has(d.num)).map((d) => d.num);
  check(delLeak.length === 0, `삭제 문항이 본문에 없음 (누출 ${delLeak.join(', ') || '없음'})`);

  // 문항번호 총 등장 = 문항 + 개정표 번호
  const revNums = q.revision.new.length + q.revision.modified.length + q.revision.deleted.length;
  const totalNums = (all.match(QNUM_RE) ?? []).length;
  check(totalNums === q.items.length + revNums, `문항번호 패턴 총 등장 ${totalNums} = 문항 ${q.items.length} + 개정표 ${revNums}`);

  // 본문/설명 원문 왕복(러닝헤더 제거·공백 제거 후 substring)
  const sBody = strip(bodyLines.join('\n'));
  let miss = 0;
  const missList = [];
  for (const it of q.items) {
    if (!sBody.includes(strip(it.body))) { miss += 1; missList.push(`${it.num} 본문`); }
    if (it.expl && !sBody.includes(strip(it.expl))) { miss += 1; missList.push(`${it.num} 설명`); }
  }
  check(miss === 0, `문항 본문/설명 원문 전부 추출 텍스트에 존재 (누락 ${miss}: ${missList.slice(0, 4).join(', ')})`);

  // 본문 페이지 경계 걸침(러닝헤더 제거 후 페이지 누적 오프셋으로 판정)
  const pageS = cleaned.map((lines) => strip(lines.join('\n')));
  const cum = [];
  let off = 0;
  for (const t of pageS) { cum.push(off); off += t.length; }
  const joined = pageS.join('');
  const pageOf = (idx) => { let p = 0; while (p + 1 < cum.length && cum[p + 1] <= idx) p += 1; return p; };
  const crossed = [];
  for (const it of q.items) {
    const s = strip(it.body);
    const i0 = joined.indexOf(s);
    if (i0 !== -1 && pageOf(i0 + s.length - 1) > pageOf(i0)) crossed.push(it.num);
  }
  if (expectCross) check(crossed.length >= 1, `본문이 페이지 경계에 걸치는 문항 ≥1 (${crossed.join(', ') || '없음'})`);
  else console.log(`  INFO  본문 페이지 경계 걸침: ${crossed.join(', ') || '없음'}`);
}

// 2027 모드 전용 — demo-anchors.json의 근거 인용문(quote_exact)이 2027 개정판 전문에서
// 그대로 유지되는지(자동 이관 대상) / 더 이상 정확히 일치하지 않는지(검토 목록 대상) 확인한다.
// 공백을 제거한 전문에서 부분 문자열 등장 횟수로 판정한다(추출기 줄바꿈 차이 무시).
async function verifyAnchorQuotes2027() {
  console.log('\n== 2027 개정판 × demo-anchors.json 근거 인용문 ==');
  const { anchors } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'demo-anchors.json'), 'utf8'));
  const fullText = async (g) => {
    const ex = await extract(path.join(OUT_DIR, `${g.fileBase}.pdf`));
    return strip(ex.pages.map((p) => p.text).join('\n'));
  };
  const countOcc = (hay, needle) => {
    let n = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n += 1;
    return n;
  };
  const textA = await fullText(guidelineA);
  const textB = await fullText(guidelineB);
  const quote = (id) => strip(anchors.find((a) => a.id === id).quote_exact);
  check(countOcc(textA, quote(1)) === 0, '제12조(파기) 인용문 — 2027 지침서A에서 정확 일치 없음(문구 개정 → 검토 대상)');
  check(countOcc(textA, quote(2)) === 1, '제4조(보호책임자) 인용문 — 2027 지침서A에 정확히 1회 존재(자동 이관 대상)');
  check(countOcc(textB, quote(3)) === 1, '제13조(백업 및 복구) 인용문 — 2027 지침서B에 정확히 1회 존재(자동 이관 대상)');
}

async function main() {
  await verifyGuideline(guidelineA, [8, 12]);
  await verifyGuideline(guidelineB, [6, 10]);
  await verifyQuestions(questions50, { expectCross: true });
  await verifyQuestions(questions60);
  if (Y2027) await verifyAnchorQuotes2027();
  const total = [guidelineA, guidelineB, questions50, questions60]
    .map((d) => fs.statSync(path.join(OUT_DIR, `${d.fileBase}.pdf`)).size)
    .reduce((a, b) => a + b, 0);
  console.log(`\n총 용량: ${(total / 1024).toFixed(1)}KB`);
  check(total <= 2 * 1024 * 1024, '총 용량 2MB 이하');
  console.log(failures === 0 ? '\n검증 전체 통과' : `\n검증 실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
