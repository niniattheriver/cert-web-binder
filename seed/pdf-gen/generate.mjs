// 가상 데모 PDF 생성기 — 재실행 가능.
//   기본 실행(npm run generate): 문항 PDF 2부(seed/demo-pdfs/가상문항-*.pdf)만 재생성한다.
//     → 지침서 PDF(가상지침서-*.pdf)는 "현행 유지" 원칙에 따라 건드리지 않는다.
//   전체 재생성이 필요하면 `node generate.mjs --all` (지침서 PDF까지 다시 만든다).
//   2027 가상 개정판: `node generate.mjs --y2027 [--all]` — content-2027.mjs를 읽어
//     seed/demo-pdfs/2027/ 에 같은 파일명으로 생성한다. 2026 출력물은 건드리지 않는다.
//
// 문항 PDF는 실물 서식(우수검사실 신임인증 심사점검표)의 텍스트 골격을 따른다:
//   표지 → 개정 요약표(• 신규 / • 수정 / • 삭제) → 문항분류체계 → 목차 → 본문 문항 블록.
//   문항 블록: "문항 [기본B|필요R|핵심C] [번호] [본문]" → "배점" → "(N) 아니오 [해당없음]" → "설명" → 불릿.
//
// 폰트: seed/fonts/NotoSansKR-{Regular,Bold}.otf (OFL).
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 연도 모드 — 2026(기본)과 2027 가상 개정판. 연도 리터럴(생성일·개정표 제목·부칙)은 전부
// 여기서 나오므로 2026 경로의 출력은 모드 추가와 무관하게 바이트 동일하다.
const Y2027 = process.argv.includes('--y2027');
const MODE = Y2027
  ? { year: '2027', contentFile: './content-2027.mjs', outDir: path.join(HERE, '..', 'demo-pdfs', '2027'), fixedDate: new Date('2027-01-01T00:00:00Z') }
  : { year: '2026', contentFile: './content.mjs', outDir: path.join(HERE, '..', 'demo-pdfs'), fixedDate: new Date('2026-01-01T00:00:00Z') };
const { guidelineA, guidelineB, questions50, questions60, COVER_TITLE } = await import(MODE.contentFile);

const FONT_DIR = path.join(HERE, '..', 'fonts');
const OUT_DIR = MODE.outDir;
const FONT_R = path.join(FONT_DIR, 'NotoSansKR-Regular.otf');
const FONT_B = path.join(FONT_DIR, 'NotoSansKR-Bold.otf');

const A4 = [595.28, 841.89];
const MARGIN_X = 62;
const CONTENT_W = A4[0] - MARGIN_X * 2;
const TOP_Y = 72; // 본문 시작 y
const BOTTOM_Y = 772; // 본문 하한 y
const FOOTER_Y = 800;
const HEADER_Y = 40;
// 재실행 시 바이트 재현성을 위해 PDF 생성일을 고정한다(타임스탬프 비결정성 제거).
const FIXED_DATE = MODE.fixedDate;

const nfc = (s) => s.normalize('NFC');
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const GRADE = {
  core: { ko: '핵심', letter: 'C' },
  required: { ko: '필요', letter: 'R' },
  basic: { ko: '기본', letter: 'B' },
};

/** 문자 단위 폭 측정 기반 줄바꿈(한국어는 음절 단위 개행 허용). 공백 경계를 우선한다. */
function wrapText(doc, text, font, size, width) {
  doc.font(font).fontSize(size);
  const lines = [];
  let line = '';
  let lineW = 0;
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    const tokW = doc.widthOfString(tok);
    if (lineW + tokW <= width) { line += tok; lineW += tokW; continue; }
    if (/^\s+$/.test(tok)) { // 줄 끝 공백은 버림
      if (line) { lines.push(line); line = ''; lineW = 0; }
      continue;
    }
    if (tokW <= width) {
      if (line) lines.push(line.replace(/\s+$/, ''));
      line = tok; lineW = tokW;
    } else { // 토큰 자체가 폭 초과 → 문자 단위 분할
      for (const ch of tok) {
        const chW = doc.widthOfString(ch);
        if (lineW + chW > width && line) { lines.push(line); line = ''; lineW = 0; }
        line += ch; lineW += chW;
      }
    }
  }
  if (line.replace(/\s+$/, '')) lines.push(line.replace(/\s+$/, ''));
  return lines;
}

/** 수동 흐름 배치 라이터: 헤더/푸터/페이지 나눔을 전부 직접 제어한다.
 *  decorate(doc, page): 각 페이지의 머리글/바닥글을 그리는 콜백(문항/지침서 서식별로 주입). */
class Writer {
  constructor(doc, decorate = () => {}) {
    this.doc = doc;
    this.page = 1;
    this.y = TOP_Y;
    this.decorate = decorate;
    this.decorate(doc, this.page);
  }
  newPage() {
    this.doc.addPage({ size: A4, margin: 0 });
    this.page += 1;
    this.y = TOP_Y;
    this.decorate(this.doc, this.page);
  }
  ensure(h) { if (this.y + h > BOTTOM_Y) this.newPage(); }
  space(h) { this.y = Math.min(this.y + h, BOTTOM_Y); }
  remaining() { return BOTTOM_Y - this.y; }
  /** 한 줄을 지정 위치에 그린다(자동 개행 없음). 반환: 그린 페이지 번호 */
  line(text, { font = 'KR', size = 10.5, x = MARGIN_X, color = '#000000', lh = null, align = null, width = CONTENT_W } = {}) {
    const lineH = lh ?? size * 1.55;
    this.ensure(lineH);
    const opts = align ? { width, align, lineBreak: false } : { lineBreak: false };
    this.doc.font(font).fontSize(size).fillColor(color).text(nfc(text), x, this.y, opts);
    const p = this.page;
    this.y += lineH;
    return p;
  }
  /** 문단: 직접 줄바꿈 + 행 단위 페이지 나눔(페이지 경계에 걸칠 수 있음). 반환: 사용한 페이지 목록 */
  paragraph(text, { font = 'KR', size = 10.5, x = MARGIN_X, width = CONTENT_W, color = '#000000', lh = null, hang = 0 } = {}) {
    const lines = wrapText(this.doc, nfc(text), font, size, width);
    const pages = [];
    lines.forEach((ln, i) => {
      pages.push(this.line(ln, { font, size, x: i === 0 ? x : x + hang, color, lh }));
    });
    return pages;
  }
}

function makeDoc(title) {
  const doc = new PDFDocument({
    size: A4,
    margin: 0,
    compress: true,
    pdfVersion: '1.7',
    lang: 'ko-KR',
    info: { Title: title, Producer: 'seed/pdf-gen (pdfkit)', Creator: 'seed/pdf-gen', CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
  });
  doc.registerFont('KR', FONT_R);
  doc.registerFont('KRB', FONT_B);
  return doc;
}

function finish(doc, file) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(file);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// 지침서 PDF (기존 서식 그대로 유지 — --all 일 때만 재생성)
// ---------------------------------------------------------------------------
function guidelineDecorate(doc, page) {
  doc.font('KR').fontSize(9).fillColor('#666666')
    .text(`- ${page} -`, MARGIN_X, FOOTER_Y, { width: CONTENT_W, align: 'center', lineBreak: false });
  doc.fillColor('#000000');
}

async function generateGuideline(g) {
  const doc = makeDoc(g.title);
  const w = new Writer(doc, guidelineDecorate);
  w.space(56);
  w.line(g.title, { font: 'KRB', size: 20, align: 'center', lh: 34 });
  w.line(g.subtitle, { font: 'KR', size: 10.5, color: '#555555', align: 'center', lh: 22 });
  w.space(10);
  doc.moveTo(MARGIN_X, w.y).lineTo(MARGIN_X + CONTENT_W, w.y).lineWidth(0.8).strokeColor('#333333').stroke();
  w.space(26);
  const PARA = { size: 11.5, lh: 23, x: MARGIN_X + 4, width: CONTENT_W - 4, hang: 16 };
  for (const art of g.articles) {
    w.ensure(29 + 23);
    w.line(`제${art.no}조(${art.title})`, { font: 'KRB', size: 13, lh: 29 });
    w.space(4);
    art.paras.forEach((p, i) => {
      const mark = CIRCLED[i] ?? `(${i + 1})`;
      w.paragraph(`${mark} ${p}`, PARA);
      w.space(10);
    });
    w.space(18);
  }
  w.ensure(29 + 23);
  w.line('부칙', { font: 'KRB', size: 13, lh: 29 });
  w.space(4);
  w.paragraph(`① 이 지침은 ${MODE.year}년 1월 1일부터 시행한다.`, PARA);
  w.space(8);
  w.paragraph('② 이 지침 시행 전에 처리된 사항은 이 지침에 따라 처리된 것으로 본다.', PARA);
  const file = path.join(OUT_DIR, `${g.fileBase}.pdf`);
  const pages = w.page;
  await finish(doc, file);
  return { file, pages };
}

// ---------------------------------------------------------------------------
// 문항 PDF — 실물 서식
// ---------------------------------------------------------------------------
function renderCover(w, q) {
  const { doc } = w;
  w.space(150);
  w.line(COVER_TITLE, { font: 'KRB', size: 26, align: 'center', lh: 44 });
  w.space(22);
  w.line(q.fieldName, { font: 'KRB', size: 20, align: 'center', lh: 36 });
  w.space(2);
  doc.moveTo(MARGIN_X + 150, w.y).lineTo(MARGIN_X + CONTENT_W - 150, w.y).lineWidth(0.8).strokeColor('#333333').stroke();
  doc.strokeColor('#000000');
  w.space(210);
  w.line(q.publisher, { font: 'KRB', size: 13, align: 'center', lh: 24 });
  w.space(4);
  w.line('이 책자는 데모용 가상 콘텐츠이며 실존 인증기관·심사문항과 무관한 무저작권 창작물입니다.', { size: 8.5, color: '#888888', align: 'center', lh: 15 });
  w.space(8);
  w.line(q.yearMonth, { font: 'KR', size: 13, align: 'center', lh: 24 });
}

function renderRevSection(w, title, colHeader, rows) {
  w.space(8);
  w.line(title, { font: 'KRB', size: 12, lh: 23 });
  w.line(colHeader, { font: 'KRB', size: 10.5, color: '#333333', x: MARGIN_X + 16, lh: 20 });
  if (rows.length === 0) {
    w.line('-', { size: 10.5, x: MARGIN_X + 26, lh: 19 });
  } else {
    for (const r of rows) w.line(`${r.num} ${r.note}`, { size: 10.5, x: MARGIN_X + 16, lh: 19 });
  }
}

function renderRevision(w, q) {
  w.space(28);
  w.line(`${MODE.year} 년 개정판 변경내역 요약`, { font: 'KRB', size: 15, align: 'center', lh: 28 });
  w.line('(Summary of Changes)', { font: 'KR', size: 10.5, color: '#555555', align: 'center', lh: 20 });
  w.space(6);
  w.line(q.fieldName, { font: 'KRB', size: 13, align: 'center', lh: 26 });
  w.space(16);
  w.line('아래 심사문항들은 본 개정판에 신규 도입, 주요 문항/설명 수정 또는 삭제된 문항들입니다.', { size: 10, lh: 20 });
  renderRevSection(w, '• 신규', '문항번호 사유', q.revision.new);
  renderRevSection(w, '• 수정', '문항번호 수정유형', q.revision.modified);
  renderRevSection(w, '• 삭제', '문항번호 사유', q.revision.deleted);
}

function renderClassification(w) {
  w.space(28);
  w.line('• 문항분류체계', { font: 'KRB', size: 14, lh: 28 });
  w.space(8);
  const rows = [
    ['핵심문항 : C  (Core standards)', '인증 유지에 결정적인 핵심 항목으로, 미충족 시 인증에 중대한 영향을 준다.'],
    ['필요문항 : R  (Required standards)', '적정 수준의 품질 확보를 위하여 갖추어야 하는 항목이다.'],
    ['기본문항 : B  (Basic standards)', '기본적으로 준수하여야 하는 항목으로 대부분의 문항이 이에 해당한다.'],
  ];
  for (const [h, d] of rows) {
    w.space(6);
    w.line(h, { font: 'KRB', size: 12, x: MARGIN_X + 14, lh: 24 });
    w.paragraph(d, { size: 10, x: MARGIN_X + 30, width: CONTENT_W - 30, color: '#555555', lh: 19 });
  }
}

function renderToc(w, q) {
  w.space(28);
  w.line('목 차', { font: 'KRB', size: 16, align: 'center', lh: 34 });
  w.space(14);
  q.sections.forEach((s, i) => {
    w.line(`${i + 1}. ${s.title}`, { size: 11.5, x: MARGIN_X + 20, lh: 26 });
  });
}

async function generateQuestions(q, { forceCrossFromIndex = null } = {}) {
  const doc = makeDoc(`${COVER_TITLE} — ${q.fieldName}`);
  // 본문 페이지(표지·개정표·분류체계·목차 이후)에만 상단 "쪽번호 + [분야명]" 머리글을 단다.
  const state = { headerOn: false, fieldName: q.fieldName };
  const decorate = (d, page) => {
    if (!state.headerOn) return;
    d.font('KR').fontSize(8.5).fillColor('#999999')
      .text(nfc(`${page}    ${state.fieldName}`), MARGIN_X, HEADER_Y, { width: CONTENT_W, align: 'left', lineBreak: false });
    d.fillColor('#000000');
  };
  const w = new Writer(doc, decorate);

  renderCover(w, q); // p.1
  w.newPage(); renderRevision(w, q); // p.2
  w.newPage(); renderClassification(w); // p.3
  w.newPage(); renderToc(w, q); // p.4
  state.headerOn = true; // 이후 페이지부터 본문 머리글 on
  w.newPage(); // p.5 본문 시작

  const HDR_LH = 17; // 문항 헤더/본문 줄 높이
  const LABEL_LH = 17;
  const EXPL_LH = 16;
  const BODY_X = MARGIN_X;
  const BODY_W = CONTENT_W;
  const placements = [];
  let curGroup = null;
  let sectionIndex = 0;
  let crossForced = false;

  q.items.forEach((item, idx) => {
    const group = item.num.split('.')[1];
    if (group !== curGroup) {
      curGroup = group;
      sectionIndex += 1;
      const sec = q.sections.find((s) => s.group === group);
      w.ensure(30 + HDR_LH * 2); // 절 제목 고립 방지(제목+문항 헤더 2줄)
      w.space(6);
      w.line(`${sectionIndex}. ${sec ? sec.title : group}`, { font: 'KRB', size: 12.5, lh: 26 });
      w.space(4);
    }

    const grade = GRADE[item.type];
    const headerText = `문항 ${grade.ko}${grade.letter} ${item.num} ${item.body}`;
    const headerLines = wrapText(doc, nfc(headerText), 'KR', 10.5, BODY_W);

    // 페이지 경계 걸침 강제: 지정 인덱스 이후, 본문이 2줄 이상인 문항의 첫 줄만 페이지 하단에
    // 남기고 나머지 본문을 다음 페이지로 넘긴다(본문이 페이지 경계에 걸치는 픽스처).
    if (forceCrossFromIndex !== null && !crossForced && idx >= forceCrossFromIndex && headerLines.length >= 2) {
      const need = HDR_LH + 2;
      const rem = w.remaining();
      if (rem >= need && rem <= need + 220) { w.space(rem - need); crossForced = true; }
    }

    const headerPages = w.paragraph(headerText, { font: 'KR', size: 10.5, x: BODY_X, width: BODY_W, lh: HDR_LH });
    w.line('배점', { font: 'KRB', size: 10, x: BODY_X, color: '#333333', lh: LABEL_LH });
    w.line(`(${item.score}) 아니오${item.na ? ' 해당없음' : ''}`, { font: 'KR', size: 10.5, x: BODY_X + 14, lh: LABEL_LH });
    w.line('설명', { font: 'KRB', size: 10, x: BODY_X, color: '#333333', lh: LABEL_LH });
    if (item.expl) {
      w.paragraph(`• ${item.expl}`, { font: 'KR', size: 10, x: BODY_X + 8, width: BODY_W - 8, color: '#333333', lh: EXPL_LH });
    } else {
      w.line('• 해당사항 없음', { font: 'KR', size: 10, x: BODY_X + 8, color: '#333333', lh: EXPL_LH });
    }
    w.space(12);
    placements.push({ num: item.num, headerPages: [...new Set(headerPages)] });
  });

  const file = path.join(OUT_DIR, `${q.fileBase}.pdf`);
  const pages = w.page;
  await finish(doc, file);
  const crossing = placements.filter((p) => p.headerPages.length > 1).map((p) => p.num);
  return { file, pages, crossing };
}

// ---------------------------------------------------------------------------
async function main() {
  const all = process.argv.includes('--all') || process.argv.includes('--guidelines');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of [FONT_R, FONT_B]) {
    if (!fs.existsSync(f)) { console.error(`폰트 없음: ${f} — seed/fonts/ 에 Noto Sans KR OTF를 배치하세요.`); process.exit(1); }
  }
  const results = [];
  if (all) {
    results.push({ name: guidelineA.fileBase, ...(await generateGuideline(guidelineA)) });
    results.push({ name: guidelineB.fileBase, ...(await generateGuideline(guidelineB)) });
  } else {
    console.log(`문항 PDF 2부만 재생성합니다(지침서 PDF는 현행 유지). 전체 재생성: node generate.mjs${Y2027 ? ' --y2027' : ''} --all\n`);
  }
  const q50 = await generateQuestions(questions50, { forceCrossFromIndex: 6 });
  results.push({ name: questions50.fileBase, ...q50 });
  const q60 = await generateQuestions(questions60);
  results.push({ name: questions60.fileBase, ...q60 });

  let total = 0;
  for (const r of results) {
    const size = fs.statSync(r.file).size;
    total += size;
    const cross = r.crossing ? `  본문 페이지 경계 걸침: ${r.crossing.length ? r.crossing.join(', ') : '없음'}` : '';
    console.log(`${path.basename(r.file)}  pages=${r.pages}  size=${(size / 1024).toFixed(1)}KB${cross}`);
  }
  console.log(`\n생성 파일 용량 합계: ${(total / 1024).toFixed(1)}KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
