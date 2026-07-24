/**
 * 파일 대상 스트리밍 ZIP 작성기 (설계서 §7 — [전체 백업(PDF 포함)])
 * - zip.ts(메모리 방식)와 달리 큰 파일을 1MiB 청크로 읽어 디스크에 바로 쓴다 — 수백 MB PDF도 메모리 평탄.
 * - async: 청크 단위로 이벤트 루프에 양보 — 전체 백업이 몇 분 걸려도 서버가 다른 요청을 계속 받는다.
 * - PDF는 이미 압축돼 있으므로 STORE(방식 0)로 담는다. 크기는 stat으로 선기록하고,
 *   CRC 4바이트만 스트리밍 후 로컬 헤더에 되patch(출력이 파일이라 가능 — 데이터 디스크립터 불요,
 *   Windows 탐색기 포함 모든 해제 도구 호환).
 * - manifest.json 같은 소형 텍스트는 addBuffer(deflate)로 담는다.
 * - ZIP64 미지원(zip.ts와 동일 전제): 4GB·엔트리 65,535 초과 시 한국어 오류로 실패한다.
 * - 의존성 무추가(node:fs/zlib만 — 가드레일 2·3).
 */
import type { FileHandle } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { crc32Update, dosDateTime } from './zip.js';

const CHUNK_SIZE = 1024 * 1024; // 1MiB
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const LIMIT_MESSAGE =
  '전체 백업이 ZIP 형식 한계(4GB)를 넘어 만들 수 없습니다. data 폴더 복사 방식을 사용하세요.';

interface EntryRecord {
  nameBuf: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  time: number;
  date: number;
  localHeaderOffset: number;
}

/** ZIP 내부 경로 정규화 — Windows 구분자를 /로, 선행 /·상위 경로 세그먼트는 거부 */
function normalizeEntryName(name: string): string {
  const normalized = name.split('\\').join('/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`잘못된 ZIP 내부 경로입니다: ${name}`);
  }
  return normalized;
}

function localHeader(e: EntryRecord): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 파일명
  local.writeUInt16LE(e.method, 8);
  local.writeUInt16LE(e.time, 10);
  local.writeUInt16LE(e.date, 12);
  local.writeUInt32LE(e.crc, 14);
  local.writeUInt32LE(e.compressedSize, 18);
  local.writeUInt32LE(e.uncompressedSize, 22);
  local.writeUInt16LE(e.nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length
  return local;
}

export interface ZipFileWriter {
  /** 소형 엔트리(deflate) — manifest.json 등 */
  addBuffer(name: string, data: Buffer, date?: Date): Promise<void>;
  /** 대형 파일(STORE) — 1MiB 청크 스트리밍, CRC 되patch */
  addFile(name: string, absPath: string, date?: Date): Promise<void>;
  /** 중앙 디렉토리 + EOCD 기록 후 닫기 */
  finalize(): Promise<{ entryCount: number; zipBytes: number }>;
  /** 실패 시 정리용 — 파일 핸들만 닫는다(임시 파일 삭제는 호출자 몫) */
  abort(): Promise<void>;
}

export async function createZipFileWriter(targetPath: string): Promise<ZipFileWriter> {
  const fd: FileHandle = await fsp.open(targetPath, 'w');
  const entries: EntryRecord[] = [];
  let offset = 0;
  let finished = false;

  // 위치 지정 쓰기 — 부분 쓰기(bytesWritten < length)는 이어서 완성하고, 진전이 없으면
  // 오류로 실패시킨다(부분 기록된 채 성공으로 보고되는 조용한 백업 손상 방지).
  const writeAt = async (buf: Buffer, at: number) => {
    let pos = 0;
    while (pos < buf.length) {
      const { bytesWritten } = await fd.write(buf, pos, buf.length - pos, at + pos);
      if (bytesWritten <= 0) {
        throw new Error('백업 ZIP 쓰기가 중단되었습니다. 저장 공간을 확인해 주세요.');
      }
      pos += bytesWritten;
    }
  };

  const write = async (buf: Buffer) => {
    await writeAt(buf, offset);
    offset += buf.length;
  };

  const guardEntry = (addedBytes: number) => {
    if (entries.length >= MAX_ENTRIES) throw new Error(LIMIT_MESSAGE);
    if (offset + addedBytes >= MAX_UINT32) throw new Error(LIMIT_MESSAGE);
  };

  return {
    async addBuffer(name, data, date = new Date()) {
      const nameBuf = Buffer.from(normalizeEntryName(name), 'utf8');
      const compressed = zlib.deflateRawSync(data);
      guardEntry(30 + nameBuf.length + compressed.length);
      const { time, date: dosDate } = dosDateTime(date);
      const e: EntryRecord = {
        nameBuf,
        crc: (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0,
        compressedSize: compressed.length,
        uncompressedSize: data.length,
        method: 8,
        time,
        date: dosDate,
        localHeaderOffset: offset,
      };
      await write(localHeader(e));
      await write(nameBuf);
      await write(compressed);
      entries.push(e);
    },

    async addFile(name, absPath, date = new Date()) {
      const nameBuf = Buffer.from(normalizeEntryName(name), 'utf8');
      const size = (await fsp.stat(absPath)).size;
      if (size >= MAX_UINT32) throw new Error(LIMIT_MESSAGE);
      guardEntry(30 + nameBuf.length + size);
      const { time, date: dosDate } = dosDateTime(date);
      const e: EntryRecord = {
        nameBuf,
        crc: 0, // 스트리밍 후 되patch
        compressedSize: size, // STORE: 압축 크기 = 원본 크기 — 선기록 가능
        uncompressedSize: size,
        method: 0,
        time,
        date: dosDate,
        localHeaderOffset: offset,
      };
      await write(localHeader(e));
      await write(nameBuf);

      const src = await fsp.open(absPath, 'r');
      let crcState = 0xffffffff;
      let readTotal = 0;
      try {
        const chunk = Buffer.alloc(CHUNK_SIZE);
        for (;;) {
          const { bytesRead } = await src.read(chunk, 0, CHUNK_SIZE, null);
          if (bytesRead <= 0) break;
          const view = bytesRead === CHUNK_SIZE ? chunk : chunk.subarray(0, bytesRead);
          crcState = crc32Update(crcState, view);
          await write(view);
          readTotal += bytesRead;
        }
      } finally {
        await src.close();
      }
      if (readTotal !== size) {
        throw new Error(`파일 크기가 도중에 달라졌습니다: ${name} (${size} → ${readTotal})`);
      }
      e.crc = (crcState ^ 0xffffffff) >>> 0;
      // 로컬 헤더의 CRC 필드(+14)만 되patch
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(e.crc, 0);
      await writeAt(crcBuf, e.localHeaderOffset + 14);
      entries.push(e);
    },

    async finalize() {
      if (finished) throw new Error('이미 마감된 ZIP입니다.');
      finished = true;
      // 쓰기 도중 실패(ENOSPC 등)해도 핸들은 반드시 닫는다 — Windows에서 열린 핸들은
      // 임시 ZIP 삭제(EPERM)를 막아 원인 오류를 은폐하고 파일을 잔존시킨다.
      try {
      const centralOffset = offset;
      for (const e of entries) {
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8); // flags
        central.writeUInt16LE(e.method, 10);
        central.writeUInt16LE(e.time, 12);
        central.writeUInt16LE(e.date, 14);
        central.writeUInt32LE(e.crc, 16);
        central.writeUInt32LE(e.compressedSize, 20);
        central.writeUInt32LE(e.uncompressedSize, 24);
        central.writeUInt16LE(e.nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // extra length
        central.writeUInt16LE(0, 32); // comment length
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(e.localHeaderOffset, 42);
        await write(central);
        await write(e.nameBuf);
      }
      const centralSize = offset - centralOffset;
      if (offset + 22 >= MAX_UINT32) throw new Error(LIMIT_MESSAGE);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4); // this disk
      eocd.writeUInt16LE(0, 6); // start disk
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(centralSize, 12);
      eocd.writeUInt32LE(centralOffset, 16);
      eocd.writeUInt16LE(0, 20); // comment length
      await write(eocd);
      return { entryCount: entries.length, zipBytes: offset };
      } finally {
        await fd.close();
      }
    },

    async abort() {
      // finished 여부와 무관하게 닫는다(중복 close 는 무시) — finalize 실패 후에도 안전
      finished = true;
      await fd.close().catch(() => undefined);
    },
  };
}
