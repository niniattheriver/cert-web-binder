import { describe, expect, it } from 'vitest';
import { OfficeParseError } from '../errors.js';
import { Cfb, isCfb } from './cfb.js';
import { writeCfb } from './testkit.js';

describe('OLE 복합 문서 읽기', () => {
  it('작은 스트림(미니 스트림)과 큰 스트림, 저장소 안 스트림을 모두 읽는다', () => {
    const small = Buffer.from('가나다 작은 스트림', 'utf8');
    const big = Buffer.alloc(10_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const buf = writeCfb([
      { path: 'Small', data: small },
      { path: 'Big', data: big },
      { path: 'BodyText/Section0', data: Buffer.from('section zero') },
      { path: 'BodyText/Section1', data: Buffer.alloc(5000, 7) },
    ]);
    expect(isCfb(buf)).toBe(true);
    const cfb = Cfb.open(buf)!;
    expect(cfb.read('Small', 1e6)!.equals(small)).toBe(true);
    expect(cfb.read('Big', 1e6)!.equals(big)).toBe(true);
    expect(cfb.read('BodyText/Section0', 1e6)!.toString()).toBe('section zero');
    expect(cfb.read('BodyText/Section1', 1e6)!.length).toBe(5000);
    expect(cfb.children('BodyText').map((e) => e.name)).toEqual(['Section0', 'Section1']);
  });

  it('이름은 대소문자를 가리지 않고 찾는다, 없는 스트림과 저장소는 null', () => {
    const cfb = Cfb.open(writeCfb([{ path: 'WordDocument', data: Buffer.from('x') }, { path: 'S/A', data: Buffer.from('y') }]))!;
    expect(cfb.has('worddocument')).toBe(true);
    expect(cfb.read('WORDDOCUMENT', 10)!.toString()).toBe('x');
    expect(cfb.read('없음', 10)).toBeNull();
    expect(cfb.read('S', 10)).toBeNull();
  });

  it('상한보다 큰 스트림은 주어진 문구로 거부한다', () => {
    const cfb = Cfb.open(writeCfb([{ path: 'Big', data: Buffer.alloc(9000) }]))!;
    expect(() => cfb.read('Big', 1000, '너무 큼')).toThrow('너무 큼');
  });

  it('복합 문서가 아니면 null, 머리가 깨졌거나 사슬이 고리면 OfficeParseError', () => {
    expect(Cfb.open(Buffer.from('PK\u0003\u0004 not cfb'))).toBeNull();
    const buf = writeCfb([{ path: 'Big', data: Buffer.alloc(9000, 1) }]);
    const badOrder = Buffer.from(buf);
    badOrder.writeUInt16LE(0x1234, 0x1c);
    expect(() => Cfb.open(badOrder)).toThrow(OfficeParseError);
    // FAT 첫 칸(섹터 0, FAT 자신)을 고쳐 디렉터리 사슬이 자기 자신을 가리키게 한다
    const loop = Buffer.from(buf);
    const dirStart = loop.readUInt32LE(0x30);
    loop.writeUInt32LE(dirStart, 512 + dirStart * 4);
    expect(() => Cfb.open(loop)).toThrow(OfficeParseError);
  });
});
