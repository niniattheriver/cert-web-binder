/**
 * 구형 Word(doc) 문단 번호: 목록 정의(PlfLst), 목록 재정의(PlfLfo) 해석과 번호 세기
 *
 * 구조 (MS-DOC 2.9.147 LSTF, 2.9.150 LVL, 2.9.151 LVLF, 2.9.131 LFO, 2.9.132 LFOLVL)
 * - PlfLst: cLst(2) + LSTF[cLst](28바이트: lsid, tplc, rgistdPara[9], 표지(fSimpleList 0x01), grfhic).
 *   LVL 들은 표 스트림에서 PlfLst 바로 뒤(fcPlfLst + lcbPlfLst)에 목록 순서대로 9개씩(fSimpleList 면 1개) 이어진다.
 * - LVL: LVLF(28바이트: iStartAt(4), nfc(1), 표지(1: jc 2비트, fLegal 0x04, fNoRestart 0x08), rgbxchNums(9),
 *   ixchFollow(1), dxaIndentSav(4), unused(4), cbGrpprlChpx(1), cbGrpprlPapx(1), ilvlRestartLim(1), grfhic(1))
 *   + grpprlPapx + grpprlChpx + xst(cch 2바이트 + 글자). xst 안 rgbxchNums 위치(1-기준)의 글자는 단계 자리표시자
 *   (값 = 0-기준 단계).
 * - PlfLfo: lfoMac(4) + LFO[lfoMac](16바이트: lsid, 미사용 8, clfolvl(1), ...) + LFOData[lfoMac]
 *   (cp(4) + LFOLVL[clfolvl]: iStartAt(4), 비트(iLvl 4비트, fStartAt 0x10, fFormatting 0x20) + fFormatting 이면 LVL).
 * - 문단: sprmPIlfo(1-기준 LFO 번호, 0 = 번호 없음), sprmPIlvl(0-기준 단계).
 *
 * 셈 규칙 (MS-DOC 2.4.7 Determining Level Number of a Paragraph): 같은 lsid 목록끼리 센다. 단계를 하나 쓰면 더 깊은
 * 단계는 처음으로 돌아간다. 깊은 단계의 fNoRestart 가 켜져 있으면 쓰인 단계가 ilvlRestartLim 보다 작을 때만 돌아간다.
 * LFOLVL.fStartAt 은 그 LFO 의 그 단계가 처음 쓰일 때 시작 값으로 되돌린다. docx 의 NumberingState 와 같은 셈이다.
 * 번호 형식 nfc 는 MSONFC(MS-OSHARED 2.2.1.3) → ST_NumberFormat 이름으로 바꿔 docx 의 formatNumber 를 쓴다.
 */
import { formatNumber } from '../docx/units.js';

/** MSONFC 0x00..0x3B → ST_NumberFormat (MS-OSHARED 2.2.1.3 표 그대로. 0x28 은 decimal) */
const NFC: readonly string[] = [
  'decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter', 'ordinal', 'cardinalText', 'ordinalText',
  'hex', 'chicago', 'ideographDigital', 'japaneseCounting', 'aiueo', 'iroha', 'decimalFullWidth', 'decimalHalfWidth',
  'japaneseLegal', 'japaneseDigitalTenThousand', 'decimalEnclosedCircle', 'decimalFullWidth2', 'aiueoFullWidth',
  'irohaFullWidth', 'decimalZero', 'bullet', 'ganada', 'chosung', 'decimalEnclosedFullstop', 'decimalEnclosedParen',
  'decimalEnclosedCircleChinese', 'ideographEnclosedCircle', 'ideographTraditional', 'ideographZodiac',
  'ideographZodiacTraditional', 'taiwaneseCounting', 'ideographLegalTraditional', 'taiwaneseCountingThousand',
  'taiwaneseDigital', 'chineseCounting', 'chineseLegalSimplified', 'chineseCountingThousand', 'decimal',
  'koreanDigital', 'koreanCounting', 'koreanLegal', 'koreanDigital2', 'hebrew1', 'arabicAlpha', 'hebrew2',
  'arabicAbjad', 'hindiVowels', 'hindiConsonants', 'hindiNumbers', 'hindiCounting', 'thaiLetters', 'thaiNumbers',
  'thaiCounting', 'vietnameseCounting', 'numberInDash', 'russianLower', 'russianUpper',
];

export function nfcName(nfc: number): string {
  if (nfc === 0xff) return 'none';
  return NFC[nfc] ?? 'decimal';
}

export interface DocLevel {
  start: number;
  /** ST_NumberFormat 이름 ('bullet', 'none' 포함) */
  fmt: string;
  legal: boolean;
  /** fNoRestart 가 켜졌을 때 ilvlRestartLim. 꺼져 있으면 undefined(더 얕은 단계가 쓰이면 늘 돌아간다) */
  restartLim?: number;
  /** 0 탭, 1 빈칸, 2 없음 */
  follow: number;
  /** 번호 글: 글자 조각 또는 자리표시자(0-기준 단계 번호) */
  text: (string | number)[];
  papx: Buffer;
  chpx: Buffer;
}

interface ListDef {
  lsid: number;
  simple: boolean;
  levels: (DocLevel | undefined)[];
}

interface LfoDef {
  lsid: number;
  /** 단계별 재정의: 시작 값, 단계 정의 */
  startAt: Map<number, number>;
  levels: Map<number, DocLevel>;
}

export interface DocLabel {
  /** 번호 글자 + 뒤붙임 */
  text: string;
  level: DocLevel;
}

const MAX_LISTS = 4096;
const MAX_LFO = 32_767;

/** LVL 하나를 읽는다. 다음 LVL 위치와 함께. 읽을 수 없으면 null */
function readLvl(b: Buffer, p: number, end: number): { lvl: DocLevel; next: number } | null {
  if (p + 28 > end) return null;
  const start = b.readInt32LE(p);
  const nfc = b[p + 4]!;
  const flags = b[p + 5]!;
  const nums = [...b.subarray(p + 6, p + 15)];
  const follow = b[p + 15]!;
  const cbChpx = b[p + 24]!;
  const cbPapx = b[p + 25]!;
  const restartLim = b[p + 26]!;
  let q = p + 28;
  if (q + cbPapx + cbChpx + 2 > end) return null;
  const papx = b.subarray(q, q + cbPapx);
  q += cbPapx;
  const chpx = b.subarray(q, q + cbChpx);
  q += cbChpx;
  const cch = b.readUInt16LE(q);
  q += 2;
  if (q + cch * 2 > end) return null;
  const chars: number[] = [];
  for (let i = 0; i < cch; i += 1) chars.push(b.readUInt16LE(q + i * 2));
  q += cch * 2;
  // 자리표시자 위치 (1-기준, 0 에서 끝)
  const holders = new Set<number>();
  for (const n of nums) {
    if (n === 0) break;
    holders.add(n - 1);
  }
  const text: (string | number)[] = [];
  let lit = '';
  chars.forEach((c, i) => {
    if (holders.has(i) && c <= 8) {
      if (lit) text.push(lit);
      lit = '';
      text.push(c);
    } else lit += String.fromCharCode(c);
  });
  if (lit) text.push(lit);
  const lvl: DocLevel = {
    start: Math.max(0, Math.min(0x7fff, start)),
    fmt: nfcName(nfc),
    legal: (flags & 0x04) !== 0,
    follow,
    text,
    papx,
    chpx,
  };
  if (flags & 0x08) lvl.restartLim = restartLim;
  return { lvl, next: q };
}

export class DocLists {
  private readonly lists = new Map<number, ListDef>();
  private readonly lfos: LfoDef[] = [];
  private readonly counters = new Map<number, (number | undefined)[]>();
  private readonly startUsed = new Set<string>();

  /** 표 스트림에서 PlfLst, PlfLfo 를 읽는다. 구조가 깨졌으면 읽은 데까지 쓴다 (번호는 보조 정보) */
  static read(table: Buffer, lst: { fc: number; lcb: number }, lfo: { fc: number; lcb: number }): DocLists {
    const out = new DocLists();
    try {
      out.readLst(table, lst);
    } catch {
      // 읽은 데까지
    }
    try {
      out.readLfo(table, lfo);
    } catch {
      // 읽은 데까지
    }
    return out;
  }

  private readLst(b: Buffer, { fc, lcb }: { fc: number; lcb: number }): void {
    if (lcb < 2 || fc + lcb > b.length) return;
    const n = b.readInt16LE(fc);
    if (n <= 0 || n > MAX_LISTS || 2 + n * 28 > lcb) return;
    const defs: ListDef[] = [];
    for (let i = 0; i < n; i += 1) {
      const p = fc + 2 + i * 28;
      defs.push({ lsid: b.readInt32LE(p), simple: (b[p + 26]! & 0x01) !== 0, levels: [] });
    }
    let p = fc + lcb;
    for (const d of defs) {
      const count = d.simple ? 1 : 9;
      for (let k = 0; k < count; k += 1) {
        const r = readLvl(b, p, b.length);
        if (!r) return;
        d.levels.push(r.lvl);
        p = r.next;
      }
      if (!this.lists.has(d.lsid)) this.lists.set(d.lsid, d);
    }
  }

  private readLfo(b: Buffer, { fc, lcb }: { fc: number; lcb: number }): void {
    if (lcb < 4 || fc + lcb > b.length) return;
    const n = b.readInt32LE(fc);
    if (n <= 0 || n > MAX_LFO || 4 + n * 16 > lcb) return;
    const heads: { lsid: number; clfolvl: number }[] = [];
    for (let i = 0; i < n; i += 1) {
      const p = fc + 4 + i * 16;
      heads.push({ lsid: b.readInt32LE(p), clfolvl: b[p + 12]! });
    }
    for (const h of heads) this.lfos.push({ lsid: h.lsid, startAt: new Map(), levels: new Map() });
    // LFOData: 재정의가 있는 LFO 만 쓴다 (clfolvl 이 0 이어도 cp 4바이트는 있다)
    let p = fc + 4 + n * 16;
    const end = fc + lcb;
    for (let i = 0; i < n; i += 1) {
      const h = heads[i]!;
      if (p + 4 > end) return;
      p += 4;
      for (let k = 0; k < h.clfolvl; k += 1) {
        if (p + 8 > end) return;
        const startAt = b.readInt32LE(p);
        const bits = b.readUInt32LE(p + 4);
        p += 8;
        const ilvl = bits & 0x0f;
        const fStartAt = (bits & 0x10) !== 0;
        const fFormatting = (bits & 0x20) !== 0;
        const lfo = this.lfos[i]!;
        if (fFormatting) {
          const r = readLvl(b, p, end);
          if (!r) return;
          p = r.next;
          if (ilvl <= 8) {
            lfo.levels.set(ilvl, r.lvl);
            if (fStartAt) lfo.startAt.set(ilvl, r.lvl.start);
          }
        } else if (fStartAt && ilvl <= 8) lfo.startAt.set(ilvl, Math.max(0, Math.min(0x7fff, startAt)));
      }
    }
  }

  /** 1-기준 LFO 번호와 단계의 단계 정의 (LFO 재정의 우선) */
  level(ilfo: number, ilvl: number): DocLevel | undefined {
    const lfo = this.lfos[ilfo - 1];
    if (!lfo) return undefined;
    const list = this.lists.get(lfo.lsid);
    const L = list?.simple ? 0 : ilvl;
    return lfo.levels.get(L) ?? list?.levels[L];
  }

  /** 이 문단의 번호 이름표를 만들고 셈을 한 칸 올린다. 번호가 없으면 null */
  next(ilfo: number, ilvl0: number): DocLabel | null {
    const lfo = this.lfos[ilfo - 1];
    if (!lfo) return null;
    const list = this.lists.get(lfo.lsid);
    if (!list) return null;
    const ilvl = list.simple ? 0 : Math.max(0, Math.min(8, ilvl0));
    const level = this.level(ilfo, ilvl);
    if (!level) return null;
    let ctr = this.counters.get(lfo.lsid);
    if (!ctr) {
      ctr = new Array<number | undefined>(9).fill(undefined);
      this.counters.set(lfo.lsid, ctr);
    }
    const skey = `${ilfo}:${ilvl}`;
    const so = lfo.startAt.get(ilvl);
    if (so !== undefined && !this.startUsed.has(skey)) {
      ctr[ilvl] = so;
      this.startUsed.add(skey);
    } else {
      ctr[ilvl] = (ctr[ilvl] ?? level.start - 1) + 1;
    }
    for (let L = ilvl + 1; L < 9; L += 1) {
      const lim = this.level(ilfo, L)?.restartLim ?? L;
      if (ilvl < lim) ctr[L] = undefined;
    }
    let body = '';
    if (level.fmt === 'bullet') {
      body = level.text.map((t) => (typeof t === 'string' ? t : '')).join('');
    } else {
      for (const t of level.text) {
        if (typeof t === 'string') {
          body += t;
          continue;
        }
        const ref = this.level(ilfo, t);
        const v = ctr[t] ?? ref?.start ?? 1;
        if (!level.legal && ref?.fmt === 'none') continue;
        if (!level.legal && ref?.fmt === 'bullet') {
          body += ref.text.map((x) => (typeof x === 'string' ? x : '')).join('');
          continue;
        }
        // fLegal: 모든 자리표시자를 십진으로 (decimalZero 는 그대로. MS-DOC LVLF.fLegal)
        const fmt = level.legal ? (ref?.fmt === 'decimalZero' ? 'decimalZero' : 'decimal') : (ref?.fmt ?? 'decimal');
        body += formatNumber(v, fmt);
      }
    }
    const suffix = level.follow === 0 ? '\t' : level.follow === 1 ? ' ' : '';
    return { text: body + suffix, level };
  }
}
