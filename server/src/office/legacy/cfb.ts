/**
 * OLE 복합 문서(Compound File Binary, MS-CFB) 읽기
 *
 * 구형 한글(hwp 5.0), Word 97~2003(doc), Excel 97~2003(xls)은 모두 이 그릇 안에 스트림(파일)과
 * 저장소(폴더)를 담는다. 여기서는 그릇만 연다: 디렉터리를 읽고 이름으로 스트림 바이트를 꺼낸다.
 *
 * 구조 (MS-CFB)
 * - 머리(512바이트): 서명 D0 CF 11 E0 A1 B1 1A E1, 섹터 크기(2^9 또는 2^12), 미니 섹터 크기(2^6),
 *   FAT 섹터 수, 디렉터리 첫 섹터, 미니 FAT 첫 섹터, DIFAT 첫 섹터, 머리 안 DIFAT 109칸.
 * - 섹터 n 은 파일의 (n + 1) × 섹터 크기 위치에 있다. FAT 는 섹터마다 다음 섹터 번호를 적은 사슬표다.
 * - 디렉터리 항목(128바이트): 이름(UTF-16LE), 종류(저장소 1, 스트림 2, 뿌리 5), 왼쪽/오른쪽 형제와 자식
 *   번호(적흑 나무), 첫 섹터, 크기. 기준 크기(보통 4096바이트)보다 작은 스트림은 뿌리 항목의 사슬에 담긴
 *   미니 스트림 안에 64바이트 미니 섹터로 들어 있고 미니 FAT 로 잇는다.
 *
 * 깨진 파일과 악의적인 파일을 견디도록: 사슬마다 이미 지난 섹터를 기억해 고리를 끊고, 사슬 길이는 파일의
 * 섹터 수를, 디렉터리 항목은 MAX_ENTRIES 를 넘지 못하게 한다. 스트림 크기는 사슬이 실제로 담을 수 있는
 * 크기와 호출자가 준 상한 중 작은 쪽까지만 읽는다. 문제가 있으면 OfficeParseError(사용자용 한국어 문장).
 */
import { OfficeParseError } from '../errors.js';

export const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const MAXREGSECT = 0xfffffffa;
const NOSTREAM = 0xffffffff;

/** 디렉터리 항목 수 상한 */
const MAX_ENTRIES = 200_000;
/** 디렉터리 나무 깊이 상한 (저장소 안 저장소) */
const MAX_DEPTH = 32;

export const ERR_CFB = '문서 구조(복합 문서)를 읽지 못했습니다(손상 가능성). 원래 프로그램에서 다시 저장해 올려 주세요.';

export type CfbEntryType = 'storage' | 'stream' | 'root';

export interface CfbEntry {
  /** 항목 이름 (예: 'WordDocument', 'Section0', '\u0005SummaryInformation') */
  name: string;
  /** 뿌리부터 '/' 로 이은 경로 (예: 'BodyText/Section0'). 뿌리는 '' */
  path: string;
  type: CfbEntryType;
  /** 스트림 크기 바이트 (저장소는 0) */
  size: number;
  start: number;
}

interface RawEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

export function isCfb(buf: Uint8Array): boolean {
  if (buf.length < 512) return false;
  for (let i = 0; i < 8; i += 1) if (buf[i] !== CFB_MAGIC[i]) return false;
  return true;
}

function fail(): never {
  throw new OfficeParseError(ERR_CFB);
}

export class Cfb {
  private readonly sectorSize: number;
  private readonly sectorCount: number;
  private readonly fat: Uint32Array;
  private readonly miniFat: Uint32Array;
  private readonly miniCutoff: number;
  private miniStream: Buffer | null = null;
  private readonly raw: RawEntry[];
  private readonly list: CfbEntry[];
  private readonly byPath = new Map<string, CfbEntry>();

  private constructor(private readonly buf: Buffer) {
    const major = buf.readUInt16LE(0x1a);
    const shift = buf.readUInt16LE(0x1e);
    if (buf.readUInt16LE(0x1c) !== 0xfffe) fail();
    if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) fail();
    if (buf.readUInt16LE(0x20) !== 6) fail();
    this.sectorSize = 1 << shift;
    this.sectorCount = Math.max(0, Math.floor((buf.length - this.sectorSize) / this.sectorSize));
    this.miniCutoff = buf.readUInt32LE(0x38) || 4096;

    // ── FAT: 머리 DIFAT 109칸 + DIFAT 섹터 사슬
    const nFat = buf.readUInt32LE(0x2c);
    if (nFat > this.sectorCount + 1) fail();
    const fatSectors: number[] = [];
    for (let i = 0; i < 109 && fatSectors.length < nFat; i += 1) {
      const s = buf.readUInt32LE(0x4c + i * 4);
      if (s === FREESECT || s === ENDOFCHAIN) continue;
      fatSectors.push(s);
    }
    let dif = buf.readUInt32LE(0x44);
    const seenDif = new Set<number>();
    const perDif = this.sectorSize / 4 - 1;
    while (fatSectors.length < nFat && dif <= MAXREGSECT) {
      if (seenDif.has(dif) || dif >= this.sectorCount) fail();
      seenDif.add(dif);
      const off = this.offsetOf(dif);
      for (let i = 0; i < perDif && fatSectors.length < nFat; i += 1) {
        const s = buf.readUInt32LE(off + i * 4);
        if (s === FREESECT || s === ENDOFCHAIN) continue;
        fatSectors.push(s);
      }
      dif = buf.readUInt32LE(off + perDif * 4);
    }
    const per = this.sectorSize / 4;
    this.fat = new Uint32Array(fatSectors.length * per);
    fatSectors.forEach((s, k) => {
      if (s >= this.sectorCount) fail();
      const off = this.offsetOf(s);
      for (let i = 0; i < per; i += 1) this.fat[k * per + i] = buf.readUInt32LE(off + i * 4);
    });

    // ── 디렉터리
    const dirStart = buf.readUInt32LE(0x30);
    const dirBytes = this.chainBytes(dirStart, this.fat, false, Infinity);
    const nEntries = Math.min(Math.floor(dirBytes.length / 128), MAX_ENTRIES);
    this.raw = [];
    for (let i = 0; i < nEntries; i += 1) {
      const o = i * 128;
      const nameLen = dirBytes.readUInt16LE(o + 0x40);
      const n = Math.max(0, Math.min(64, nameLen) - 2);
      const name = dirBytes.toString('utf16le', o, o + n);
      const type = dirBytes[o + 0x42]!;
      const sizeLo = dirBytes.readUInt32LE(o + 0x78);
      const sizeHi = major === 4 ? dirBytes.readUInt32LE(o + 0x7c) : 0;
      this.raw.push({
        name,
        type,
        left: dirBytes.readUInt32LE(o + 0x44),
        right: dirBytes.readUInt32LE(o + 0x48),
        child: dirBytes.readUInt32LE(o + 0x4c),
        start: dirBytes.readUInt32LE(o + 0x74),
        size: sizeHi > 0 ? Number.MAX_SAFE_INTEGER : sizeLo,
      });
    }
    if (this.raw.length === 0 || this.raw[0]!.type !== 5) fail();

    // ── 미니 FAT
    const miniStart = buf.readUInt32LE(0x3c);
    const miniBytes = miniStart <= MAXREGSECT ? this.chainBytes(miniStart, this.fat, false, Infinity) : Buffer.alloc(0);
    this.miniFat = new Uint32Array(Math.floor(miniBytes.length / 4));
    for (let i = 0; i < this.miniFat.length; i += 1) this.miniFat[i] = miniBytes.readUInt32LE(i * 4);

    // ── 나무를 훑어 경로를 만든다 (형제는 적흑 나무: 왼쪽, 자신, 오른쪽 순서로 펼친다)
    this.list = [];
    const root = this.raw[0]!;
    this.list.push({ name: root.name, path: '', type: 'root', size: root.size, start: root.start });
    const visited = new Set<number>([0]);
    const walk = (id: number, parentPath: string, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      let cur = id;
      // 형제 나무를 중위 순회 (재귀 대신 쌓기)
      const order: number[] = [];
      const pending: number[] = [];
      while (cur !== NOSTREAM || pending.length > 0) {
        while (cur !== NOSTREAM) {
          if (cur >= this.raw.length || visited.has(cur)) {
            cur = NOSTREAM;
            break;
          }
          visited.add(cur);
          pending.push(cur);
          cur = this.raw[cur]!.left;
        }
        const top = pending.pop();
        if (top === undefined) break;
        order.push(top);
        cur = this.raw[top]!.right;
      }
      for (const k of order) {
        const e = this.raw[k]!;
        if (e.type !== 1 && e.type !== 2) continue;
        const path = parentPath ? `${parentPath}/${e.name}` : e.name;
        const entry: CfbEntry = {
          name: e.name,
          path,
          type: e.type === 1 ? 'storage' : 'stream',
          size: e.type === 2 ? e.size : 0,
          start: e.start,
        };
        this.list.push(entry);
        if (!this.byPath.has(path.toLowerCase())) this.byPath.set(path.toLowerCase(), entry);
        if (e.type === 1 && e.child !== NOSTREAM) walk(e.child, path, depth + 1);
      }
    };
    if (root.child !== NOSTREAM) walk(root.child, '', 0);
  }

  /** CFB 가 아니면 null. CFB 인데 구조가 깨졌으면 OfficeParseError */
  static open(buf: Buffer): Cfb | null {
    if (!isCfb(buf)) return null;
    try {
      return new Cfb(buf);
    } catch (e) {
      if (e instanceof OfficeParseError) throw e;
      throw new OfficeParseError(ERR_CFB);
    }
  }

  entries(): CfbEntry[] {
    return this.list;
  }

  /** 이름 비교는 대소문자를 가리지 않는다(MS-CFB 이름 비교 규칙) */
  entry(path: string): CfbEntry | undefined {
    return this.byPath.get(path.toLowerCase());
  }

  has(path: string): boolean {
    return this.byPath.has(path.toLowerCase());
  }

  /** 저장소 바로 아래 항목들 (경로 순서 그대로) */
  children(storagePath: string): CfbEntry[] {
    const prefix = storagePath ? `${storagePath.toLowerCase()}/` : '';
    return this.list.filter((e) => {
      if (e.type === 'root') return false;
      const p = e.path.toLowerCase();
      return p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
    });
  }

  /**
   * 스트림 바이트. 없거나 저장소면 null. maxBytes 를 넘는 스트림은 OfficeParseError(tooBig 문구)로 거부한다.
   */
  read(path: string, maxBytes: number, tooBig: string = ERR_CFB): Buffer | null {
    const e = this.entry(path);
    if (!e || e.type !== 'stream') return null;
    if (e.size > maxBytes) throw new OfficeParseError(tooBig);
    if (e.size === 0) return Buffer.alloc(0);
    if (e.size < this.miniCutoff) {
      const mini = this.mini();
      return this.chainBytes(e.start, this.miniFat, true, e.size, mini);
    }
    return this.chainBytes(e.start, this.fat, false, e.size);
  }

  private offsetOf(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  private mini(): Buffer {
    if (!this.miniStream) {
      const root = this.raw[0]!;
      this.miniStream =
        root.start <= MAXREGSECT ? this.chainBytes(root.start, this.fat, false, root.size) : Buffer.alloc(0);
    }
    return this.miniStream;
  }

  /** 사슬을 따라 바이트를 모은다. limit 바이트에서 멈춘다 */
  private chainBytes(start: number, table: Uint32Array, isMini: boolean, limit: number, source?: Buffer): Buffer {
    const unit = isMini ? 64 : this.sectorSize;
    const capacity = isMini ? Math.floor((source?.length ?? 0) / 64) : this.sectorCount;
    const parts: Buffer[] = [];
    let got = 0;
    let s = start;
    const seen = new Set<number>();
    while (s <= MAXREGSECT && got < limit) {
      if (seen.has(s) || s >= capacity) fail();
      seen.add(s);
      const off = isMini ? s * 64 : this.offsetOf(s);
      const src = isMini ? source! : this.buf;
      if (off + unit > src.length) {
        // 마지막 섹터가 파일 끝에서 잘린 경우: 있는 만큼만
        if (off >= src.length) fail();
        parts.push(src.subarray(off));
        got += src.length - off;
        break;
      }
      const take = Math.min(unit, limit - got);
      parts.push(src.subarray(off, off + take));
      got += take;
      if (s >= table.length) {
        if (got < limit && limit !== Infinity) fail();
        break;
      }
      s = table[s]!;
    }
    if (limit !== Infinity && got < limit) fail();
    return Buffer.concat(parts, got);
  }
}
