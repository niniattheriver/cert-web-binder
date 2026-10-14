/**
 * 구형 형식 시험 도구: 시험용 OLE 복합 문서(CFB v3)를 손으로 만든다.
 * 시험(*.test.ts)에서 쓴다. vitest 에 의존하지 않는다.
 *
 * 4096바이트보다 작은 스트림은 규칙대로 미니 스트림(64바이트 단위)에, 큰 스트림은 512바이트 섹터에 담는다.
 * 형제 나무는 오른쪽 형제로만 잇는다(적흑 균형은 지키지 않는다: 우리 읽기는 나무 검색을 하지 않는다).
 */
import zlib from 'node:zlib';

const SECTOR = 512;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const MINI_CUTOFF = 4096;

interface Node {
  name: string;
  type: 1 | 2 | 5;
  children: Node[];
  data?: Buffer;
  id: number;
  start: number;
  size: number;
}

function padTo(b: Buffer, n: number): Buffer {
  if (b.length === n) return b;
  const out = Buffer.alloc(n);
  b.copy(out);
  return out;
}

/** path = 'A/B/Stream' 형태. 중간 이름은 저장소가 된다 */
export function writeCfb(files: { path: string; data: Buffer }[]): Buffer {
  const root: Node = { name: 'Root Entry', type: 5, children: [], id: 0, start: ENDOFCHAIN, size: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let s = cur.children.find((c) => c.name === parts[i] && c.type === 1);
      if (!s) {
        s = { name: parts[i]!, type: 1, children: [], id: 0, start: 0, size: 0 };
        cur.children.push(s);
      }
      cur = s;
    }
    cur.children.push({ name: parts[parts.length - 1]!, type: 2, children: [], data: f.data, id: 0, start: ENDOFCHAIN, size: f.data.length });
  }
  const nodes: Node[] = [];
  const visit = (n: Node): void => {
    n.id = nodes.length;
    nodes.push(n);
    n.children.forEach(visit);
  };
  visit(root);

  // 미니 스트림
  const miniParts: Buffer[] = [];
  const miniFat: number[] = [];
  let miniCount = 0;
  for (const n of nodes) {
    if (n.type !== 2 || n.data!.length >= MINI_CUTOFF) continue;
    const count = Math.ceil(n.data!.length / 64);
    if (count === 0) continue;
    n.start = miniCount;
    for (let i = 0; i < count; i += 1) miniFat.push(i === count - 1 ? ENDOFCHAIN : miniCount + i + 1);
    miniParts.push(padTo(n.data!, count * 64));
    miniCount += count;
  }
  const miniStream = Buffer.concat(miniParts);
  const miniFatBytes = Buffer.alloc(Math.ceil((miniFat.length * 4) / SECTOR) * SECTOR, 0xff);
  miniFat.forEach((v, i) => miniFatBytes.writeUInt32LE(v, i * 4));

  // 섹터 수 계산
  const dirBytesLen = Math.ceil((nodes.length * 128) / SECTOR) * SECTOR;
  const nDir = dirBytesLen / SECTOR;
  const nMiniFat = miniFatBytes.length / SECTOR;
  const nMini = Math.ceil(miniStream.length / SECTOR);
  const big = nodes.filter((n) => n.type === 2 && n.data!.length >= MINI_CUTOFF);
  const nBig = big.reduce((s, n) => s + Math.ceil(n.data!.length / SECTOR), 0);
  let nFat = 1;
  for (;;) {
    const total = nFat + nDir + nMiniFat + nMini + nBig;
    const need = Math.ceil(total / (SECTOR / 4));
    if (need <= nFat) break;
    nFat = need;
  }
  if (nFat > 109) throw new Error('testkit: 너무 큰 시험 파일');
  const total = nFat + nDir + nMiniFat + nMini + nBig;
  const fat = new Array<number>(nFat * (SECTOR / 4)).fill(FREESECT);
  let next = 0;
  const alloc = (count: number): number => {
    if (count === 0) return ENDOFCHAIN;
    const first = next;
    for (let i = 0; i < count; i += 1) fat[first + i] = i === count - 1 ? ENDOFCHAIN : first + i + 1;
    next += count;
    return first;
  };
  for (let i = 0; i < nFat; i += 1) fat[i] = FATSECT;
  next = nFat;
  const dirStart = alloc(nDir);
  const miniFatStart = alloc(nMiniFat);
  const miniStart = alloc(nMini);
  root.start = nMini > 0 ? miniStart : ENDOFCHAIN;
  root.size = miniStream.length;
  for (const n of big) n.start = alloc(Math.ceil(n.data!.length / SECTOR));
  if (next !== total) throw new Error('testkit: 섹터 계산 오류');

  // 디렉터리
  const dir = Buffer.alloc(dirBytesLen);
  for (const n of nodes) {
    const o = n.id * 128;
    const name = Buffer.from(`${n.name}\u0000`, 'utf16le');
    name.copy(dir, o, 0, Math.min(64, name.length));
    dir.writeUInt16LE(Math.min(64, name.length), o + 0x40);
    dir[o + 0x42] = n.type;
    dir[o + 0x43] = 1;
    dir.writeUInt32LE(NOSTREAM, o + 0x44);
    dir.writeUInt32LE(NOSTREAM, o + 0x48);
    dir.writeUInt32LE(n.children.length > 0 ? n.children[0]!.id : NOSTREAM, o + 0x4c);
    dir.writeUInt32LE(n.type === 1 ? 0 : n.start, o + 0x74);
    dir.writeUInt32LE(n.type === 1 ? 0 : n.size, o + 0x78);
  }
  // 형제: 오른쪽으로 잇는다
  for (const n of nodes) {
    n.children.forEach((c, i) => {
      const sib = n.children[i + 1];
      dir.writeUInt32LE(sib ? sib.id : NOSTREAM, c.id * 128 + 0x48);
    });
  }
  // 빈 항목 칸은 이름 없음(종류 0)
  for (let i = nodes.length; i < dirBytesLen / 128; i += 1) {
    const o = i * 128;
    dir.writeUInt32LE(NOSTREAM, o + 0x44);
    dir.writeUInt32LE(NOSTREAM, o + 0x48);
    dir.writeUInt32LE(NOSTREAM, o + 0x4c);
  }

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(0, 0x28);
  header.writeUInt32LE(nFat, 0x2c);
  header.writeUInt32LE(dirStart, 0x30);
  header.writeUInt32LE(MINI_CUTOFF, 0x38);
  header.writeUInt32LE(nMiniFat > 0 ? miniFatStart : ENDOFCHAIN, 0x3c);
  header.writeUInt32LE(nMiniFat, 0x40);
  header.writeUInt32LE(ENDOFCHAIN, 0x44);
  header.writeUInt32LE(0, 0x48);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i < nFat ? i : FREESECT, 0x4c + i * 4);

  const fatBytes = Buffer.alloc(nFat * SECTOR);
  fat.forEach((v, i) => fatBytes.writeUInt32LE(v >>> 0, i * 4));
  const parts: Buffer[] = [header, fatBytes, dir, miniFatBytes, padTo(miniStream, nMini * SECTOR)];
  for (const n of big) parts.push(padTo(n.data!, Math.ceil(n.data!.length / SECTOR) * SECTOR));
  return Buffer.concat(parts);
}

// ─────────────────────────────── 한글(hwp 5.0) 레코드 ───────────────────────────────

/** 레코드 하나: 머리(태그 10비트, 수준 10비트, 크기 12비트, 0xFFF 면 다음 4바이트가 크기) + 본문 */
export function hwpRecord(tag: number, level: number, body: Buffer): Buffer {
  const big = body.length >= 0xfff;
  const head = Buffer.alloc(big ? 8 : 4);
  head.writeUInt32LE(((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((big ? 0xfff : body.length) << 20)) >>> 0, 0);
  if (big) head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

export function hwpCompress(b: Buffer): Buffer {
  return zlib.deflateRawSync(b);
}

/** FileHeader 스트림 (256바이트) */
export function hwpFileHeader(opts: { compressed?: boolean; encrypted?: boolean; distribution?: boolean; version?: number } = {}): Buffer {
  const b = Buffer.alloc(256);
  b.write('HWP Document File', 0, 'latin1');
  b.writeUInt32LE(opts.version ?? 0x05000300, 32);
  let attr = 0;
  if (opts.compressed ?? true) attr |= 1;
  if (opts.encrypted) attr |= 2;
  if (opts.distribution) attr |= 4;
  b.writeUInt32LE(attr, 36);
  return b;
}
