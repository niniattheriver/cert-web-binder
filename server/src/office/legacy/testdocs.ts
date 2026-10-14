/**
 * 구형 형식 합성 시험 파일: 한글 5.0(hwp), 엑셀 97~2003(xls), Word 97~2003(doc)
 *
 * 실제 프로그램이 만든 파일과의 대조(doc↔docx, xls↔xlsx, hwp↔hwpx 결과가 같은지)는 저장소 밖에서 따로 확인했다.
 * 프로그램이 만든 파일은 작성자 이름 같은 메타데이터를 담고 있어 저장소에 넣지 않고, 시험은 여기서 합성한 파일로 한다.
 * vitest 에 의존하지 않는다.
 */
import { hwpCompress, hwpFileHeader, hwpRecord, writeCfb } from './testkit.js';

const u16le = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
};
const u32le = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};
const i32le = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
};
const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

/** 4글자 조판 부호 id DWORD (예: 'tbl ') */
function ctrl4(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

// ─────────────────────────────── 한글 5.0 ───────────────────────────────

export type HwpPara =
  | { text: string; bold?: [number, number]; pageBreak?: boolean; center?: boolean }
  | { table: string[][] }
  | { picture: true };

export interface HwpSpec {
  paras: HwpPara[];
  compressed?: boolean;
  /** FileHeader 속성 (암호, 배포용, 판) */
  header?: Parameters<typeof hwpFileHeader>[0];
  landscape?: boolean;
  /** 그림 바이트 (BinData/BIN0001.png). 그림 문단이 있으면 쓴다 */
  png?: Buffer;
  /** 그림 스트림을 raw deflate 로 압축해 넣는다 */
  compressPicture?: boolean;
  /** 배포용 문서처럼 ViewText 저장소를 둔다 */
  viewText?: boolean;
}

/** 확장 조판 부호 8글자: [부호, id 아래, id 위, 0, 0, 0, 0, 부호] */
function extCtrl(code: number, id: string): Buffer {
  const v = ctrl4(id);
  return Buffer.concat([u16le(code), u16le(v & 0xffff), u16le(v >>> 16), Buffer.alloc(8), u16le(code)]);
}

function hwpPara(
  level: number,
  o: { text: Buffer; paraShape: number; shapes: [number, number][]; brk?: number; last?: boolean },
  ctrls: Buffer[] = [],
): Buffer {
  const nchars = o.text.length / 2;
  const header = Buffer.concat([
    u32le((nchars | (o.last ? 0x80000000 : 0)) >>> 0),
    u32le(0),
    u16le(o.paraShape),
    Buffer.from([0, o.brk ?? 0]),
    u16le(o.shapes.length),
    u16le(0),
    u16le(0),
    u32le(0),
  ]);
  const shapeBody = Buffer.concat(o.shapes.flatMap(([p, id]) => [u32le(p), u32le(id)]));
  return Buffer.concat([hwpRecord(66, level, header), hwpRecord(67, level + 1, o.text), hwpRecord(68, level + 1, shapeBody), ...ctrls]);
}

/** 개체 공통 속성 (CTRL_HEADER): id, 속성, 오프셋 2개, 너비, 높이, z, 바깥 여백, id, 쪽나눔, 설명 길이 0 */
function objectCommon(id: string, attr: number, w: number, h: number): Buffer {
  return Buffer.concat([u32le(ctrl4(id)), u32le(attr), i32le(0), i32le(0), u32le(w), u32le(h), i32le(0), Buffer.alloc(8), u32le(1), i32le(0), u16le(0)]);
}

/**
 * 한글 5.0 시험 파일: 글꼴 1개(언어마다), 테두리 2개(2 = 실선), 글자 모양 2개(1 = 굵게),
 * 문단 모양 2개(1 = 가운데, 왼쪽 여백 10pt = 2배 값 2000).
 */
export function buildHwp(spec: HwpSpec): Buffer {
  const compressed = spec.compressed ?? true;
  const pack = (b: Buffer): Buffer => (compressed ? hwpCompress(b) : b);
  const hasPic = spec.paras.some((p) => 'picture' in p);

  // ── DocInfo
  const face = Buffer.concat([Buffer.from([0]), u16le(5), utf16('함초롬바탕')]);
  const noBorder = Buffer.concat([u16le(0), Buffer.alloc(30), u32le(0)]);
  const solid = Buffer.concat([
    u16le(0),
    ...[0, 1, 2, 3].map(() => Buffer.concat([Buffer.from([1, 1]), u32le(0)])),
    Buffer.from([1, 0]),
    u32le(0),
    u32le(0),
  ]);
  const charShape = (bold: boolean): Buffer =>
    Buffer.concat([
      Buffer.alloc(14),
      Buffer.alloc(7, 100),
      Buffer.alloc(7, 0),
      Buffer.alloc(7, 100),
      Buffer.alloc(7, 0),
      i32le(1000),
      u32le(bold ? 0x02 : 0),
      Buffer.from([10, 10]),
      u32le(0),
      u32le(0),
      u32le(0xffffffff),
      u32le(0xb2b2b2),
      u16le(0),
      u32le(0),
    ]);
  const paraShape = (center: boolean, left: number): Buffer =>
    Buffer.concat([
      u32le(center ? 3 << 2 : 0),
      i32le(left),
      i32le(0),
      i32le(0),
      i32le(0),
      i32le(0),
      i32le(160),
      u16le(0),
      u16le(0),
      u16le(0),
      Buffer.alloc(8),
      u32le(0),
      u32le(0),
      i32le(160),
    ]);
  const idMappings = Buffer.concat([
    i32le(hasPic ? 1 : 0),
    ...Array.from({ length: 7 }, () => i32le(1)),
    i32le(2),
    i32le(2),
    i32le(0),
    i32le(0),
    i32le(0),
    i32le(2),
    i32le(0),
    i32le(0),
    i32le(0),
    i32le(0),
  ]);
  const binData = Buffer.concat([u16le(0x0001 | (spec.compressPicture ? 0x10 : 0x20)), u16le(1), u16le(3), utf16('png')]);
  const docInfo = Buffer.concat([
    hwpRecord(16, 0, Buffer.concat([u16le(1), Buffer.alloc(24)])),
    hwpRecord(17, 0, idMappings),
    ...(hasPic ? [hwpRecord(18, 1, binData)] : []),
    ...Array.from({ length: 7 }, () => hwpRecord(19, 1, face)),
    hwpRecord(20, 1, noBorder),
    hwpRecord(20, 1, solid),
    hwpRecord(21, 1, charShape(false)),
    hwpRecord(21, 1, charShape(true)),
    hwpRecord(25, 1, paraShape(false, 0)),
    hwpRecord(25, 1, paraShape(true, 2000)),
  ]);

  // ── 본문: 첫 문단에 구역 정의(secd + PAGE_DEF)
  const parts: Buffer[] = [];
  const pageDef = Buffer.concat([
    u32le(59528),
    u32le(84188),
    u32le(8504),
    u32le(8504),
    u32le(5668),
    u32le(4252),
    u32le(4252),
    u32le(4252),
    u32le(0),
    u32le(spec.landscape ? 1 : 0),
  ]);
  const first = spec.paras[0];
  const firstText = first && 'text' in first ? first.text : '';
  parts.push(
    hwpPara(0, { text: Buffer.concat([extCtrl(2, 'secd'), utf16(firstText), u16le(13)]), paraShape: 0, shapes: [[0, 0]] }, [
      hwpRecord(71, 1, Buffer.concat([u32le(ctrl4('secd')), Buffer.alloc(32)])),
      hwpRecord(73, 2, pageDef),
    ]),
  );
  spec.paras.forEach((p, idx) => {
    if (idx === 0 && 'text' in p) return;
    if ('text' in p) {
      const shapes: [number, number][] = [[0, 0]];
      if (p.bold) shapes.push([p.bold[0], 1], [p.bold[1], 0]);
      parts.push(
        hwpPara(0, {
          text: Buffer.concat([utf16(p.text), u16le(13)]),
          paraShape: p.center ? 1 : 0,
          shapes,
          brk: p.pageBreak ? 0x04 : 0,
        }),
      );
    } else if ('table' in p) {
      const rows = p.table.length;
      const cols = Math.max(...p.table.map((r) => r.length));
      const cellW = 6000;
      const table = Buffer.concat([
        u32le(0x04),
        u16le(rows),
        u16le(cols),
        u16le(0),
        u16le(510),
        u16le(510),
        u16le(141),
        u16le(141),
        ...p.table.map((r) => u16le(r.length)),
        u16le(2),
        u16le(0),
      ]);
      const cells: Buffer[] = [];
      p.table.forEach((r, ri) =>
        r.forEach((txt, ci) => {
          const list = Buffer.concat([
            u16le(1),
            u16le(0),
            u32le(0x20),
            u16le(ci),
            u16le(ri),
            u16le(1),
            u16le(1),
            u32le(cellW),
            u32le(282),
            u16le(510),
            u16le(510),
            u16le(141),
            u16le(141),
            u16le(2),
            u32le(cellW),
            Buffer.alloc(9),
          ]);
          cells.push(hwpRecord(72, 2, list));
          cells.push(hwpPara(2, { text: Buffer.concat([utf16(txt), u16le(13)]), paraShape: 0, shapes: [[0, 0]], last: true }));
        }),
      );
      parts.push(
        hwpPara(0, { text: Buffer.concat([extCtrl(11, 'tbl '), u16le(13)]), paraShape: 0, shapes: [[0, 0]] }, [
          hwpRecord(71, 1, objectCommon('tbl ', 0x082a2210, cellW * cols, 282 * rows)),
          hwpRecord(77, 2, table),
          ...cells,
        ]),
      );
    } else {
      const comp = Buffer.concat([
        u32le(ctrl4('$pic')),
        u32le(ctrl4('$pic')),
        i32le(0),
        i32le(0),
        u16le(0),
        u16le(1),
        u32le(4500),
        u32le(2250),
        u32le(4500),
        u32le(2250),
        u32le(0),
      ]);
      const pic = Buffer.alloc(91);
      pic.writeUInt16LE(1, 71); // BinItem id
      parts.push(
        hwpPara(0, { text: Buffer.concat([extCtrl(11, 'gso '), u16le(13)]), paraShape: 0, shapes: [[0, 0]] }, [
          hwpRecord(71, 1, objectCommon('gso ', 0x042a2211, 4500, 2250)),
          hwpRecord(76, 2, comp),
          hwpRecord(85, 3, pic),
        ]),
      );
    }
  });
  const files: { path: string; data: Buffer }[] = [
    { path: 'FileHeader', data: hwpFileHeader({ compressed, ...spec.header }) },
    { path: 'DocInfo', data: pack(docInfo) },
    { path: 'BodyText/Section0', data: pack(Buffer.concat(parts)) },
  ];
  if (spec.viewText) files.push({ path: 'ViewText/Section0', data: Buffer.alloc(16) });
  if (hasPic) {
    const png = spec.png ?? Buffer.alloc(16);
    files.push({ path: 'BinData/BIN0001.png', data: spec.compressPicture ? hwpCompress(png) : png });
  }
  return writeCfb(files);
}

// ─────────────────────────────── 엑셀 97~2003 (BIFF8) ───────────────────────────────

function biff(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16le(type), u16le(data.length), data]);
}

/** 시트마다 행 배열(글자, 숫자, 빈 칸 null). 숫자는 NUMBER, 글자는 공유 문자열(LABELSST) */
export function buildXls(sheets: { name: string; rows: (string | number | null)[][] }[], opts: { encrypted?: boolean } = {}): Buffer {
  const sst: string[] = [];
  const sstIndex = new Map<string, number>();
  let sstTotal = 0;
  for (const s of sheets)
    for (const r of s.rows)
      for (const v of r) {
        if (typeof v !== 'string') continue;
        sstTotal += 1;
        if (!sstIndex.has(v)) {
          sstIndex.set(v, sst.length);
          sst.push(v);
        }
      }
  const bof = (dt: number): Buffer =>
    biff(0x0809, Buffer.concat([u16le(0x0600), u16le(dt), u16le(0x0dbb), u16le(0x07cc), u32le(0), u32le(0x06)]));
  const font = biff(
    0x0031,
    Buffer.concat([u16le(220), u16le(0), u16le(0x7fff), u16le(400), u16le(0), Buffer.from([0, 0, 0, 0]), Buffer.from([7, 0]), Buffer.from('Calibri', 'latin1')]),
  );
  const xf = biff(0x00e0, Buffer.concat([u16le(0), u16le(0), u16le(0x0001), Buffer.alloc(14)]));
  const sstRec = biff(
    0x00fc,
    Buffer.concat([u32le(sstTotal), u32le(sst.length), ...sst.map((s) => Buffer.concat([u16le(s.length), Buffer.from([1]), utf16(s)]))]),
  );
  const sheetName = (n: string): Buffer => Buffer.concat([Buffer.from([n.length, 1]), utf16(n)]);
  const globalsHead = Buffer.concat([
    bof(0x0005),
    ...(opts.encrypted ? [biff(0x002f, Buffer.alloc(54))] : []),
    biff(0x0042, u16le(1200)),
    font,
    xf,
  ]);
  const boundLen = (n: string): number => 4 + 4 + 2 + 2 + n.length * 2;
  const globalsLen = globalsHead.length + sheets.reduce((s, sh) => s + boundLen(sh.name), 0) + sstRec.length + 4;
  const sheetStreams = sheets.map((sh) => {
    const cells: Buffer[] = [];
    sh.rows.forEach((r, ri) =>
      r.forEach((v, ci) => {
        if (v === null) return;
        if (typeof v === 'number') {
          const d = Buffer.alloc(8);
          d.writeDoubleLE(v, 0);
          cells.push(biff(0x0203, Buffer.concat([u16le(ri), u16le(ci), u16le(0), d])));
        } else cells.push(biff(0x00fd, Buffer.concat([u16le(ri), u16le(ci), u16le(0), u32le(sstIndex.get(v)!)])));
      }),
    );
    const cols = Math.max(0, ...sh.rows.map((r) => r.length));
    return Buffer.concat([
      bof(0x0010),
      biff(0x0200, Buffer.concat([u32le(0), u32le(sh.rows.length), u16le(0), u16le(cols), u16le(0)])),
      ...cells,
      biff(0x000a, Buffer.alloc(0)),
    ]);
  });
  let pos = globalsLen;
  const bounds = sheets.map((sh, i) => {
    const rec = biff(0x0085, Buffer.concat([u32le(pos), Buffer.from([0, 0]), sheetName(sh.name)]));
    pos += sheetStreams[i]!.length;
    return rec;
  });
  const workbook = Buffer.concat([globalsHead, ...bounds, sstRec, biff(0x000a, Buffer.alloc(0)), ...sheetStreams]);
  return writeCfb([{ path: 'Workbook', data: workbook }]);
}

// ─────────────────────────────── Word 97~2003 ───────────────────────────────

export interface DocSpecPara {
  text: string;
  /** 굵게 구간 [시작, 끝) (문단 안 글자 위치) */
  bold?: [number, number];
  center?: boolean;
  /** 문단 앞에 쪽 나눔 글자(0x0C) */
  pageBreakBefore?: boolean;
}

/**
 * Word 97 시험 파일: FIB(표 스트림 1Table), 압축하지 않은 조각 하나, 글자 FKP 와 문단 FKP 한 쪽씩, 구역 하나(A4),
 * 문서 속성(DOP, 기본 탭 0.5인치). table 을 주면 문단 뒤에 표(칸 0x07, 행 끝 문단 sprmPFTtp + sprmTDefTable)를 둔다.
 */
export function buildDoc(spec: { paras: DocSpecPara[]; table?: string[][]; encrypted?: boolean; nFib?: number }): Buffer {
  // ── 글자와 문단 경계
  let text = '';
  const paraRuns: { end: number; papx: Buffer }[] = []; // end = 문단 표지 다음 CP
  const boldRuns: [number, number][] = [];
  const istd0 = u16le(0);
  const plain = Buffer.concat([istd0, Buffer.from([0])]); // istd + 채움 (cb = 2)
  for (const p of spec.paras) {
    if (p.pageBreakBefore) text += '\u000c';
    const start = text.length;
    text += p.text;
    if (p.bold) boldRuns.push([start + p.bold[0], start + p.bold[1]]);
    text += '\r';
    paraRuns.push({ end: text.length, papx: p.center ? Buffer.concat([istd0, Buffer.from([0x03, 0x24, 0x01])]) : plain });
  }
  if (spec.table) {
    const cols = Math.max(...spec.table.map((r) => r.length));
    const centers: number[] = [];
    for (let c = 0; c <= cols; c += 1) centers.push(c * 3000);
    const rest = Buffer.concat([Buffer.from([cols]), ...centers.map((x) => u16le(x)), Buffer.alloc(20 * cols)]);
    const tdef = Buffer.concat([u16le(0xd608), u16le(rest.length + 1), rest]);
    const inTable = Buffer.concat([istd0, Buffer.from([0x16, 0x24, 0x01])]);
    const rowEnd = Buffer.concat([istd0, Buffer.from([0x16, 0x24, 0x01, 0x17, 0x24, 0x01]), tdef]);
    for (const r of spec.table) {
      for (const cell of r) {
        text += `${cell}\u0007`;
        paraRuns.push({ end: text.length, papx: inTable });
      }
      text += '\u0007';
      paraRuns.push({ end: text.length, papx: rowEnd });
    }
    text += '\r';
    paraRuns.push({ end: text.length, papx: plain });
  }
  const ccp = text.length;

  // ── WordDocument 배치: FIB(0..0x400), 글자(0x400..), 글자 FKP, 문단 FKP, SEPX
  const fcText = 0x400;
  const textBytes = utf16(text);
  const pageAfter = (n: number): number => Math.ceil(n / 512) * 512;
  const chpPage = pageAfter(fcText + textBytes.length);
  const papPage = chpPage + 512;
  const sepxAt = papPage + 512;
  const fc = (cp: number): number => fcText + cp * 2;

  // 글자 FKP: 굵게 구간마다 나눈다
  const edges = new Set<number>([0, ccp]);
  for (const [a, b] of boldRuns) {
    edges.add(a);
    edges.add(b);
  }
  const cuts = [...edges].sort((x, y) => x - y);
  const chpFkp = Buffer.alloc(512);
  const crunC = cuts.length - 1;
  cuts.forEach((cp, i) => chpFkp.writeUInt32LE(fc(cp), i * 4));
  const chpxAt = 480; // 쪽 안 위치 (2의 배수)
  Buffer.from([3, 0x35, 0x08, 0x01]).copy(chpFkp, chpxAt); // cb + sprmCFBold 1
  for (let i = 0; i < crunC; i += 1) {
    const isBold = boldRuns.some(([a, b]) => cuts[i]! >= a && cuts[i + 1]! <= b);
    chpFkp[(crunC + 1) * 4 + i] = isBold ? chpxAt / 2 : 0;
  }
  chpFkp[511] = crunC;

  // 문단 FKP: 문단마다 한 구간, PAPX 는 쪽 끝에서 앞으로 채운다
  const papFkp = Buffer.alloc(512);
  const crunP = paraRuns.length;
  papFkp.writeUInt32LE(fc(0), 0);
  paraRuns.forEach((r, i) => papFkp.writeUInt32LE(fc(r.end), (i + 1) * 4));
  let tail = 510;
  paraRuns.forEach((r, i) => {
    const cb = Math.ceil((r.papx.length + 1) / 2);
    const len = cb * 2 - 1;
    tail -= 1 + len;
    if (tail % 2) tail -= 1;
    papFkp[tail] = cb;
    r.papx.copy(papFkp, tail + 1);
    papFkp[(crunP + 1) * 4 + i * 13] = tail / 2;
  });
  if ((crunP + 1) * 4 + crunP * 13 > tail) throw new Error('testdocs: 문단 FKP 가 넘친다');
  papFkp[511] = crunP;

  // SEPX: A4 용지(11906 x 16838 twips)
  const sepGrpprl = Buffer.concat([u16le(0xb01f), u16le(11906), u16le(0xb020), u16le(16838)]);
  const sepx = Buffer.concat([u16le(sepGrpprl.length), sepGrpprl]);

  // ── 표 스트림: Clx, PlcfBteChpx, PlcfBtePapx, PlcfSed, Dop
  const clx = Buffer.concat([Buffer.from([0x02]), u32le(16), u32le(0), u32le(ccp), u16le(0), u32le(fcText), u16le(0)]);
  const bteChpx = Buffer.concat([u32le(fc(0)), u32le(fc(ccp)), u32le(chpPage / 512)]);
  const btePapx = Buffer.concat([u32le(fc(0)), u32le(fc(ccp)), u32le(papPage / 512)]);
  const sed = Buffer.concat([u32le(0), u32le(ccp), u16le(0), u32le(sepxAt), u16le(0), u32le(0xffffffff)]);
  const dop = Buffer.alloc(0x200);
  dop.writeUInt16LE(720, 0x0a);
  const tableParts: [number, Buffer][] = [
    [33, clx],
    [12, bteChpx],
    [13, btePapx],
    [6, sed],
    [31, dop],
  ];
  let tpos = 0;
  const fcLcb = new Map<number, [number, number]>();
  const tbl = Buffer.concat(
    tableParts.map(([k, b]) => {
      fcLcb.set(k, [tpos, b.length]);
      tpos += b.length;
      return b;
    }),
  );

  // ── FIB
  const wd = Buffer.alloc(sepxAt + 512);
  wd.writeUInt16LE(0xa5ec, 0);
  wd.writeUInt16LE(spec.nFib ?? 0x00c1, 2);
  wd.writeUInt16LE(0x0200 | (spec.encrypted ? 0x0100 : 0), 0x0a);
  wd.writeUInt16LE(14, 0x20);
  wd.writeUInt16LE(22, 0x3e);
  wd.writeInt32LE(ccp, 0x4c);
  wd.writeUInt16LE(0x5d, 0x98);
  for (const [k, [f, l]] of fcLcb) {
    wd.writeUInt32LE(f, 0x9a + k * 8);
    wd.writeUInt32LE(l, 0x9a + k * 8 + 4);
  }
  textBytes.copy(wd, fcText);
  chpFkp.copy(wd, chpPage);
  papFkp.copy(wd, papPage);
  sepx.copy(wd, sepxAt);
  return writeCfb([
    { path: 'WordDocument', data: wd },
    { path: '1Table', data: tbl },
  ]);
}
