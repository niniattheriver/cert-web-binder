/**
 * docx 추출기 시험 도구: 손으로 만든 docx 꾸러미와 정합 불변식 검사.
 * 시험(*.test.ts)에서 쓴다. vitest 에 의존하지 않는다.
 */
import { zipEntries } from '../../jobs/zip.js';
import { normalizeText } from '../../pdf/normalize.js';
import type { FlowBlock, FlowDisplayRun, FlowModel, OfficeExtractResult } from '../model.js';
import { MAX_CHROME_JSON } from './limits.js';

export const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
].join(' ');

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface FixtureRel {
  id: string;
  /** 관계 종류 끝 이름 (header, footer, image, hyperlink ...) */
  type: string;
  target: string;
  external?: boolean;
}

export interface Fixture {
  /** w:body 안쪽 XML */
  body: string;
  styles?: string;
  numbering?: string;
  settings?: string;
  footnotes?: string;
  endnotes?: string;
  theme?: string;
  /** 추가 관계 (word/_rels/document.xml.rels) */
  rels?: FixtureRel[];
  /** 그 밖의 부분: ZIP 경로 → 내용 */
  files?: Record<string, string | Buffer>;
}

const xml = (s: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;

/** 손으로 만든 docx 바이트 */
export function makeDocx(f: Fixture): Buffer {
  const date = new Date(1980, 0, 1);
  const entries: { name: string; data: Buffer; date: Date }[] = [];
  const add = (name: string, data: string | Buffer): void => {
    entries.push({ name, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data, date });
  };
  const overrides: string[] = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  ];
  const rels: string[] = [];
  const part = (type: string, name: string, body: string | undefined, ct: string): void => {
    if (body === undefined) return;
    add(`word/${name}`, xml(body));
    overrides.push(`<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.${ct}"/>`);
    rels.push(`<Relationship Id="rId_${type}" Type="${REL}/${type}" Target="${name}"/>`);
  };
  part('styles', 'styles.xml', f.styles && `<w:styles ${NS}>${f.styles}</w:styles>`, 'wordprocessingml.styles+xml');
  part('numbering', 'numbering.xml', f.numbering && `<w:numbering ${NS}>${f.numbering}</w:numbering>`, 'wordprocessingml.numbering+xml');
  part('settings', 'settings.xml', f.settings !== undefined ? `<w:settings ${NS}>${f.settings}</w:settings>` : undefined, 'wordprocessingml.settings+xml');
  part('footnotes', 'footnotes.xml', f.footnotes && `<w:footnotes ${NS}>${f.footnotes}</w:footnotes>`, 'wordprocessingml.footnotes+xml');
  part('endnotes', 'endnotes.xml', f.endnotes && `<w:endnotes ${NS}>${f.endnotes}</w:endnotes>`, 'wordprocessingml.endnotes+xml');
  part('theme', 'theme/theme1.xml', f.theme, 'theme+xml');
  for (const r of f.rels ?? []) {
    rels.push(
      `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`,
    );
  }
  add(
    '[Content_Types].xml',
    xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Default Extension="emf" ContentType="image/x-emf"/>' +
        overrides.join('') +
        '</Types>',
    ),
  );
  add(
    '_rels/.rels',
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
        '</Relationships>',
    ),
  );
  add('word/document.xml', xml(`<w:document ${NS}><w:body>${f.body}</w:body></w:document>`));
  add(
    'word/_rels/document.xml.rels',
    xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`),
  );
  for (const [name, data] of Object.entries(f.files ?? {})) add(name, data);
  return zipEntries(entries);
}

// ─────────────────────────────── XML 조각 도우미 ───────────────────────────────

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 글자 조각 <w:r> (rPr 는 안쪽 XML) */
export function r(text: string, rPr = ''): string {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** 문단 <w:p> (pPr 는 안쪽 XML, inner 는 글자 조각들) */
export function p(inner: string, pPr = ''): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
}

/** 글자만 있는 문단 */
export function pt(text: string, pPr = ''): string {
  return p(r(text), pPr);
}

export const LRPB = '<w:r><w:lastRenderedPageBreak/></w:r>';
export const BR_PAGE = '<w:r><w:br w:type="page"/></w:r>';

/** 표 칸 */
export function tc(inner: string, tcPr = ''): string {
  return `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${inner || '<w:p/>'}</w:tc>`;
}

/** 표 행 */
export function tr(cells: string[], trPr = ''): string {
  return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells.join('')}</w:tr>`;
}

/** 표 (gridCols 는 twips) */
export function tbl(rows: string[], gridCols: number[], tblPr = ''): string {
  return `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${gridCols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

/** 구역 설정 (A4 세로, 여백 1440) */
export function sectPr(extra = '', type?: string): string {
  return `<w:sectPr>${extra}${type ? `<w:type w:val="${type}"/>` : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
}

/** 1x1 투명 PNG */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function parseModel(res: OfficeExtractResult): FlowModel {
  return JSON.parse(res.render.toString('utf8')) as FlowModel;
}

/**
 * 정합 불변식 검사. 어긋난 곳을 문장 목록으로 돌려준다(빈 목록 = 통과). 문서 글자는 담지 않는다.
 * - 쪽 번호 1..N, 결과 쪽과 모델 쪽 수가 같다
 * - 모든 조각: t 가 비어 있지 않고 text.slice(o, o + t.length) === t, 쪽 안에서 o 가 문서 순서대로 증가
 * - 조각이 덮지 않은 글자는 '\n', '\t' 구분자뿐
 * - 쪽 글자를 다시 정규화해도 바뀌지 않는다
 * - 머리말/꼬리말 조각에는 o 가 없다
 * - 쪽마다 되풀이되는 머리말/꼬리말 JSON 의 합이 상한(MAX_CHROME_JSON) 이하다
 */
export function checkInvariants(res: OfficeExtractResult): string[] {
  const errs: string[] = [];
  let model: FlowModel;
  try {
    model = parseModel(res);
  } catch {
    return ['렌더 JSON 해석 실패'];
  }
  if (model.kind !== 'flow') errs.push('kind 가 flow 가 아님');
  if (model.pages.length !== res.pages.length) errs.push(`쪽 수 불일치 모델 ${model.pages.length} / 글자 ${res.pages.length}`);
  if (res.pages.length === 0) errs.push('쪽이 없음');
  res.pages.forEach((p, i) => {
    if (p.pageNo !== i + 1) errs.push(`글자 쪽 번호 ${p.pageNo} != ${i + 1}`);
  });
  let chrome = 0;
  model.pages.forEach((pg, i) => {
    if (pg.pageNo !== i + 1) errs.push(`모델 쪽 번호 ${pg.pageNo} != ${i + 1}`);
    const text = res.pages[i]?.text ?? '';
    if (normalizeText(text) !== text) errs.push(`p${i + 1}: 쪽 글자 정규화 불안정`);
    const covered = new Uint8Array(text.length);
    let lastEnd = 0;
    const visit = (blocks: FlowBlock[]): void => {
      for (const b of blocks) {
        if (b.type === 'p') {
          for (const r of b.runs) {
            if (typeof r.o !== 'number') {
              errs.push(`p${i + 1}: o 없는 조각`);
              continue;
            }
            if (r.t.length === 0) errs.push(`p${i + 1}: 빈 조각 o=${r.o}`);
            if (text.slice(r.o, r.o + r.t.length) !== r.t) errs.push(`p${i + 1}: 오프셋 불일치 o=${r.o}`);
            if (r.o < lastEnd) errs.push(`p${i + 1}: 순서/겹침 o=${r.o}`);
            lastEnd = r.o + r.t.length;
            for (let k = r.o; k < r.o + r.t.length && k < covered.length; k += 1) covered[k] = 1;
          }
        } else if (b.type === 'table') {
          for (const row of b.rows) for (const c of row.cells) visit(c.blocks);
        } else if (b.type === 'box') {
          visit(b.blocks);
        }
      }
    };
    visit(pg.blocks);
    for (let k = 0; k < text.length; k += 1) {
      if (!covered[k] && text[k] !== '\n' && text[k] !== '\t') {
        errs.push(`p${i + 1}: 조각 밖 글자 위치 ${k}`);
        break;
      }
    }
    const display = (blocks: FlowBlock<FlowDisplayRun>[] | undefined): void => {
      for (const b of blocks ?? []) {
        if (b.type === 'p') {
          for (const r of b.runs) if ('o' in r) errs.push(`p${i + 1}: 머리말/꼬리말 조각에 o`);
        } else if (b.type === 'table') {
          for (const row of b.rows) for (const c of row.cells) display(c.blocks);
        } else if (b.type === 'box') {
          display(b.blocks);
        }
      }
    };
    display(pg.header);
    display(pg.footer);
    for (const part of [pg.header, pg.footer]) if (part) chrome += Buffer.byteLength(JSON.stringify(part), 'utf8');
  });
  if (chrome > MAX_CHROME_JSON) errs.push(`머리말/꼬리말 JSON 합 ${chrome} > 상한 ${MAX_CHROME_JSON}`);
  return errs;
}

/** 모델 쪽의 조각 글자를 문서 순서대로 (시험용) */
export function runsOf(blocks: FlowBlock[]): { t: string; o: number; lbl?: true; sup?: true }[] {
  const out: { t: string; o: number; lbl?: true; sup?: true }[] = [];
  const visit = (bs: FlowBlock[]): void => {
    for (const b of bs) {
      if (b.type === 'p') for (const r of b.runs) out.push(r);
      else if (b.type === 'table') for (const row of b.rows) for (const c of row.cells) visit(c.blocks);
      else if (b.type === 'box') visit(b.blocks);
    }
  };
  visit(blocks);
  return out;
}
