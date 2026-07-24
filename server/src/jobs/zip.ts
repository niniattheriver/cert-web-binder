/**
 * 의존성 없는 최소 ZIP 작성기 (설계서 §7 — [지금 백업] = DB 스냅샷 + 파일 매니페스트 ZIP)
 * - Node 내장 zlib(deflate, 방식 8)만 사용 — 새 의존성 추가 없음(설계서 §1 의존성 정책).
 * - 저장/압축된 엔트리로 표준 ZIP(로컬 헤더 + 중앙 디렉토리 + EOCD)을 만든다. ZIP64 미지원(4GB 미만 전제).
 * - 내부망 오프라인 백업 번들 용도 — 외부 라이브러리·CDN 불필요(가드레일 3).
 */
import zlib from 'node:zlib';

export interface ZipEntry {
  /** ZIP 내부 경로(예: 'app.db', 'manifest.json') */
  name: string;
  data: Buffer;
  /** 엔트리 타임스탬프(기본 현재 시각) */
  date?: Date;
}

// CRC32 (IEEE 802.3) 룩업 테이블 — 모듈 로드 시 1회 생성.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 증분 계산 — 초기 상태 0xffffffff로 시작해 청크마다 진행시키고,
 * 마지막에 (state ^ 0xffffffff) >>> 0 으로 최종화한다(스트리밍 ZIP 작성기 공용).
 */
export function crc32Update(state: number, buf: Buffer): number {
  let crc = state;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function crc32(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

/** MS-DOS 시각/날짜(2초 단위) 인코딩 */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/** 엔트리 목록으로 ZIP 바이트를 만든다(deflate 압축, 표준 호환). */
export function zipEntries(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;
    const compressed = zlib.deflateRawSync(entry.data);
    const compressedSize = compressed.length;
    const { time, date } = dosDateTime(entry.date ?? new Date());

    // 로컬 파일 헤더
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 파일명
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, compressed);

    // 중앙 디렉토리 헤더
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralSize = centralDir.length;
  const centralOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}
