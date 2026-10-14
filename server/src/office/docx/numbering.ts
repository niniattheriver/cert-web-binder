/**
 * 문단 번호(word/numbering.xml): 정의 해석과 번호 세기
 *
 * - abstractNum 의 단계(lvl): start, numFmt, lvlText(%1..%9), lvlRestart, isLgl, suff, pPr, rPr, pStyle.
 * - num → abstractNumId. num 의 lvlOverride 는 startOverride(시작 값)와 단계 재정의(w:lvl)를 담는다.
 * - numStyleLink 는 번호 스타일(pPr/numPr)을 거쳐 실제 정의(styleLink 를 가진 abstractNum)로 한 번 건너간다.
 * - 셈은 abstractNum 별로 한다(같은 정의를 쓰는 num 끼리는 번호가 이어진다). num 의 startOverride 는 그 num 이
 *   그 단계에서 처음 쓰일 때 그 단계를 시작 값으로 되돌린다.
 * - 단계 L 을 하나 올리면 더 깊은 단계는 처음으로 돌아간다. 다만 깊은 단계의 lvlRestart 가 v 이면
 *   (1-기준) 0-기준 단계 v-1 이하가 쓰일 때만, v = 0 이면 다시 시작하지 않는다.
 */
import { attr, childEl, type XElement } from '../xml.js';
import type { Styles } from './styles.js';
import { formatNumber, num } from './units.js';

export interface LevelDef {
  ilvl: number;
  start: number;
  numFmt: string;
  lvlText: string;
  lvlRestart?: number;
  isLgl: boolean;
  suff: 'tab' | 'space' | 'nothing';
  pPr?: XElement;
  rPr?: XElement;
  pStyle?: string;
}

interface AbstractDef {
  id: string;
  levels: Map<number, LevelDef>;
  numStyleLink?: string;
}

interface NumDef {
  abstractId: string;
  startOverrides: Map<number, number>;
  lvlDefs: Map<number, LevelDef>;
}

export interface ResolvedNum {
  /** 셈 열쇠 = abstractNumId */
  key: string;
  levels: Map<number, LevelDef>;
  startOverrides: Map<number, number>;
}

function readLevel(lvl: XElement): LevelDef | undefined {
  const ilvl = num(attr(lvl, 'w:ilvl'));
  if (ilvl === undefined || ilvl < 0 || ilvl > 8) return undefined;
  let numFmtEl = childEl(lvl, 'w:numFmt');
  if (!numFmtEl) {
    // Word 2010 이후: <mc:AlternateContent><mc:Choice><w:numFmt w:val="custom" .../></mc:Choice><mc:Fallback>...
    const alt = childEl(lvl, 'mc:AlternateContent');
    const fb = alt ? childEl(alt, 'mc:Fallback') : undefined;
    numFmtEl = fb ? childEl(fb, 'w:numFmt') : undefined;
  }
  const startEl = childEl(lvl, 'w:start');
  const textEl = childEl(lvl, 'w:lvlText');
  const suffEl = childEl(lvl, 'w:suff');
  const suffRaw = suffEl ? attr(suffEl, 'w:val') : undefined;
  const def: LevelDef = {
    ilvl,
    start: (startEl ? num(attr(startEl, 'w:val')) : undefined) ?? 0,
    numFmt: (numFmtEl ? attr(numFmtEl, 'w:val') : undefined) ?? 'decimal',
    lvlText: (textEl ? attr(textEl, 'w:val') : undefined) ?? '',
    isLgl: false,
    suff: suffRaw === 'space' || suffRaw === 'nothing' ? suffRaw : 'tab',
  };
  const restart = childEl(lvl, 'w:lvlRestart');
  const rv = restart ? num(attr(restart, 'w:val')) : undefined;
  if (rv !== undefined) def.lvlRestart = rv;
  const lgl = childEl(lvl, 'w:isLgl');
  if (lgl) {
    const v = attr(lgl, 'w:val');
    def.isLgl = v === undefined || !(v === '0' || v === 'false' || v === 'off');
  }
  const pPr = childEl(lvl, 'w:pPr');
  if (pPr) def.pPr = pPr;
  const rPr = childEl(lvl, 'w:rPr');
  if (rPr) def.rPr = rPr;
  const ps = childEl(lvl, 'w:pStyle');
  const psv = ps ? attr(ps, 'w:val') : undefined;
  if (psv !== undefined) def.pStyle = psv;
  return def;
}

export class NumberingDefs {
  private readonly abstracts = new Map<string, AbstractDef>();
  private readonly nums = new Map<string, NumDef>();
  private readonly cache = new Map<string, ResolvedNum | null>();

  constructor(root: XElement | null, private readonly styles: Styles) {
    if (!root) return;
    for (const c of root.children) {
      if (c.type !== 'el') continue;
      if (c.name === 'w:abstractNum') {
        const id = attr(c, 'w:abstractNumId');
        if (id === undefined || this.abstracts.has(id)) continue;
        const def: AbstractDef = { id, levels: new Map() };
        for (const l of c.children) {
          if (l.type !== 'el') continue;
          if (l.name === 'w:lvl') {
            const lv = readLevel(l);
            if (lv && !def.levels.has(lv.ilvl)) def.levels.set(lv.ilvl, lv);
          } else if (l.name === 'w:numStyleLink') {
            const v = attr(l, 'w:val');
            if (v) def.numStyleLink = v;
          }
        }
        this.abstracts.set(id, def);
      } else if (c.name === 'w:num') {
        const id = attr(c, 'w:numId');
        const absEl = childEl(c, 'w:abstractNumId');
        const abstractId = absEl ? attr(absEl, 'w:val') : undefined;
        if (id === undefined || abstractId === undefined || this.nums.has(id)) continue;
        const nd: NumDef = { abstractId, startOverrides: new Map(), lvlDefs: new Map() };
        for (const o of c.children) {
          if (o.type !== 'el' || o.name !== 'w:lvlOverride') continue;
          const ilvl = num(attr(o, 'w:ilvl'));
          if (ilvl === undefined || ilvl < 0 || ilvl > 8) continue;
          const so = childEl(o, 'w:startOverride');
          const sv = so ? num(attr(so, 'w:val')) : undefined;
          if (sv !== undefined) nd.startOverrides.set(ilvl, sv);
          const lv = childEl(o, 'w:lvl');
          const def = lv ? readLevel(lv) : undefined;
          if (def) nd.lvlDefs.set(ilvl, { ...def, ilvl });
        }
        this.nums.set(id, nd);
      }
    }
  }

  /** numId → 셈 열쇠와 단계 정의 (재정의 반영). 없거나 0 이면 null */
  resolve(numId: string): ResolvedNum | null {
    if (numId === '0') return null;
    const cached = this.cache.get(numId);
    if (cached !== undefined) return cached;
    let out: ResolvedNum | null = null;
    const nd = this.nums.get(numId);
    let abs = nd ? this.abstracts.get(nd.abstractId) : undefined;
    if (nd && abs) {
      if (abs.numStyleLink) {
        // 번호 스타일의 numPr → num → 실제 정의 (한 번만)
        const pPr = this.styles.pPrOf(abs.numStyleLink);
        const numPr = pPr ? childEl(pPr, 'w:numPr') : undefined;
        const idEl = numPr ? childEl(numPr, 'w:numId') : undefined;
        const linked = idEl ? this.nums.get(attr(idEl, 'w:val') ?? '') : undefined;
        const target = linked ? this.abstracts.get(linked.abstractId) : undefined;
        if (target && target !== abs) abs = target;
      }
      const levels = new Map(abs.levels);
      for (const [k, v] of nd.lvlDefs) levels.set(k, v);
      out = { key: abs.id, levels, startOverrides: nd.startOverrides };
    }
    this.cache.set(numId, out);
    return out;
  }
}

export interface Label {
  /** 번호 글자 + 뒤붙임(탭, 빈칸, 없음) */
  text: string;
  level: LevelDef;
}

/** 문서(이야기) 하나의 번호 셈 상태. 머리말/꼬리말은 본문과 따로 센다 */
export class NumberingState {
  private readonly counters = new Map<string, (number | undefined)[]>();
  private readonly overrideUsed = new Set<string>();

  constructor(readonly defs: NumberingDefs) {}

  /** 이 문단의 번호 이름표를 만들고 셈을 한 칸 올린다. 번호가 없으면 null */
  next(numId: string, ilvl: number): Label | null {
    const res = this.defs.resolve(numId);
    if (!res) return null;
    const level = res.levels.get(ilvl);
    if (!level) return null;
    let ctr = this.counters.get(res.key);
    if (!ctr) {
      ctr = new Array<number | undefined>(9).fill(undefined);
      this.counters.set(res.key, ctr);
    }
    const okey = `${numId}:${ilvl}`;
    const so = res.startOverrides.get(ilvl);
    if (so !== undefined && !this.overrideUsed.has(okey)) {
      ctr[ilvl] = so;
      this.overrideUsed.add(okey);
    } else {
      ctr[ilvl] = (ctr[ilvl] ?? level.start - 1) + 1;
    }
    for (let L = ilvl + 1; L < 9; L += 1) {
      const restart = res.levels.get(L)?.lvlRestart;
      if (restart === undefined || (restart !== 0 && ilvl <= restart - 1)) ctr[L] = undefined;
    }
    let body: string;
    if (level.numFmt === 'bullet') {
      body = level.lvlText;
    } else {
      body = level.lvlText.replace(/%([1-9])/g, (_m, d: string) => {
        const k = Number(d) - 1;
        const ref = res.levels.get(k);
        const v = ctr![k] ?? ref?.start ?? 1;
        if (!level.isLgl && ref?.numFmt === 'none') return '';
        if (!level.isLgl && ref?.numFmt === 'bullet') return ref.lvlText;
        return formatNumber(v, level.isLgl ? 'decimal' : (ref?.numFmt ?? 'decimal'));
      });
    }
    const suffix = level.suff === 'tab' ? '\t' : level.suff === 'space' ? ' ' : '';
    return { text: body + suffix, level };
  }
}
