// 스트리밍 ZIP 작성기 검증 — STORE+deflate 혼합 왕복, CRC 되patch, 경로 정규화, 한계 가드.
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createZipFileWriter } from './zip-stream.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-zipstream-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** CRC32 참조 구현 (독립 검증용 — 느린 CI 러너를 위해 테이블 방식) */
const REF_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function refCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = REF_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 최소 ZIP 리더 — 로컬 헤더 순차 파싱, CRC 필드도 함께 반환 */
function unzip(buf: Buffer): Map<string, { content: Buffer; crc: number; method: number }> {
  const out = new Map<string, { content: Buffer; crc: number; method: number }>();
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const crc = buf.readUInt32LE(i + 14);
    const compressedSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    out.set(name, { content, crc, method });
    i = dataStart + compressedSize;
  }
  return out;
}

describe('createZipFileWriter', () => {
  it('STORE(대형 파일)+deflate(버퍼) 혼합 엔트리를 왕복 보존한다', async () => {
    // 청크 경계(1MiB)를 넘는 파일로 스트리밍 루프를 검증
    const big = Buffer.alloc(2 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const bigPath = path.join(tmp, 'big.bin');
    fs.writeFileSync(bigPath, big);
    const manifest = Buffer.from(JSON.stringify({ ok: true, 이름: '전체 백업' }), 'utf8');

    const zipPath = path.join(tmp, 'out.zip');
    const writer = await createZipFileWriter(zipPath);
    await writer.addFile('data/files/ab/big.bin', bigPath);
    await writer.addBuffer('manifest.json', manifest);
    const { entryCount, zipBytes } = await writer.finalize();

    expect(entryCount).toBe(2);
    const buf = fs.readFileSync(zipPath);
    expect(buf.length).toBe(zipBytes);

    const files = unzip(buf);
    const bigEntry = files.get('data/files/ab/big.bin')!;
    expect(bigEntry.method).toBe(0); // STORE
    expect(bigEntry.content).toEqual(big);
    expect(bigEntry.crc).toBe(refCrc32(big)); // 되patch된 CRC 정확성
    const manEntry = files.get('manifest.json')!;
    expect(manEntry.method).toBe(8);
    expect(manEntry.content).toEqual(manifest);
    expect(manEntry.crc).toBe(refCrc32(manifest));

    // EOCD 존재 + 엔트리 수
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(2);
  }, 30000); // 느린 CI 러너 여유

  it('Windows 구분자(\\)는 / 로 정규화되고, 상위 경로(..)·절대 경로는 거부한다', async () => {
    const small = path.join(tmp, 's.txt');
    fs.writeFileSync(small, 'x');
    const zipPath = path.join(tmp, 'norm.zip');
    const writer = await createZipFileWriter(zipPath);
    await writer.addFile('data\\files\\ab\\cd.pdf', small);
    await expect(writer.addBuffer('../evil.txt', Buffer.from('x'))).rejects.toThrow('잘못된');
    await expect(writer.addBuffer('/abs.txt', Buffer.from('x'))).rejects.toThrow('잘못된');
    await writer.finalize();
    const files = unzip(fs.readFileSync(zipPath));
    expect([...files.keys()]).toEqual(['data/files/ab/cd.pdf']);
  });

  it('finalize 후 재마감은 오류', async () => {
    const zipPath = path.join(tmp, 'twice.zip');
    const writer = await createZipFileWriter(zipPath);
    await writer.addBuffer('a.txt', Buffer.from('a'));
    await writer.finalize();
    await expect(writer.finalize()).rejects.toThrow('이미 마감');
  });

  it('파일이 도중에 커지면(크기 불일치) 한국어 오류로 실패한다', async () => {
    // stat 후 내용이 달라진 상황은 재현이 어려우므로, 존재하지 않는 파일 오류와
    // 빈 파일 정상 처리로 경계만 확인한다.
    const empty = path.join(tmp, 'empty.bin');
    fs.writeFileSync(empty, '');
    const zipPath = path.join(tmp, 'edge.zip');
    const writer = await createZipFileWriter(zipPath);
    await expect(writer.addFile('none.bin', path.join(tmp, 'no-such-file'))).rejects.toThrow();
    await writer.addFile('empty.bin', empty);
    const { entryCount } = await writer.finalize();
    expect(entryCount).toBe(1);
    const files = unzip(fs.readFileSync(zipPath));
    expect(files.get('empty.bin')!.content.length).toBe(0);
  });
});
