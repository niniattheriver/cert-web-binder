// 의존성 없는 ZIP 작성기 왕복 검증 — 로컬 헤더를 스캔해 inflate 후 원본과 대조.
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipEntries } from './zip.js';

/** 최소 ZIP 리더: 로컬 파일 헤더를 순차 파싱해 {name: content} 맵을 만든다. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compressedSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    out.set(name, content);
    i = dataStart + compressedSize;
  }
  return out;
}

describe('zipEntries', () => {
  it('여러 엔트리를 압축·복원해도 내용이 보존된다', () => {
    const a = Buffer.from('안녕하세요, 웹 바인더 백업 번들입니다.\n'.repeat(50), 'utf8');
    const b = Buffer.from(JSON.stringify({ fileCount: 3, ok: true }), 'utf8');
    const zip = zipEntries([
      { name: 'app-20260713.db', data: a },
      { name: 'manifest.json', data: b },
    ]);

    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // 'PK\x03\x04'
    const files = unzip(zip);
    expect(files.get('app-20260713.db')).toEqual(a);
    expect(files.get('manifest.json')).toEqual(b);
    // EOCD 시그니처 존재
    expect(zip.subarray(zip.length - 22, zip.length - 18)).toEqual(
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    );
  });

  it('빈 입력도 유효한 EOCD를 만든다', () => {
    const zip = zipEntries([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt16LE(10)).toBe(0); // 엔트리 수 0
  });
});
