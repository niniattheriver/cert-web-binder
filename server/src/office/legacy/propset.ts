/**
 * OLE 속성 집합(\u0005SummaryInformation 등)에서 쪽 수를 읽는다
 *
 * Word 는 저장할 때 센 쪽 수를 요약 정보의 PIDSI_PAGECOUNT(14)에 적는다. docx 의 docProps/app.xml <Pages> 와 같은
 * 쓰임으로, 쪽 나눔 어림의 목표로 쓴다. 구조(MS-OLEPS): 머리 28바이트 + (FMTID 16바이트, 위치 4바이트) 목록 →
 * 속성 집합(크기, 개수, (번호, 위치) 목록) → 값(종류 2바이트 + 채움 2바이트 + 값).
 * 읽지 못하면 undefined (쪽 수는 보조 정보라 문서 해석을 실패시키지 않는다).
 */
const PIDSI_PAGECOUNT = 14;
const VT_I2 = 0x0002;
const VT_I4 = 0x0003;

export function readPageCount(b: Buffer | null): number | undefined {
  if (!b || b.length < 48) return undefined;
  try {
    if (b.readUInt16LE(0) !== 0xfffe) return undefined;
    const sets = b.readUInt32LE(24);
    if (sets < 1) return undefined;
    const setOff = b.readUInt32LE(28 + 16);
    if (setOff + 8 > b.length) return undefined;
    const n = b.readUInt32LE(setOff + 4);
    for (let i = 0; i < n && i < 1000; i += 1) {
      const e = setOff + 8 + i * 8;
      if (e + 8 > b.length) return undefined;
      const id = b.readUInt32LE(e);
      if (id !== PIDSI_PAGECOUNT) continue;
      const v = setOff + b.readUInt32LE(e + 4);
      if (v + 8 > b.length) return undefined;
      const type = b.readUInt16LE(v);
      const count = type === VT_I4 ? b.readInt32LE(v + 4) : type === VT_I2 ? b.readInt16LE(v + 4) : NaN;
      return Number.isFinite(count) && count > 0 && count < 100_000 ? count : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
