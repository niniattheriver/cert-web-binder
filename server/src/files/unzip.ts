/**
 * 의존성 없는 최소 ZIP 리더 (첨부파일 미리보기용 — docx·pptx·hwpx 는 내부가 ZIP 이다).
 *
 * 짝이 되는 작성기는 `jobs/zip.ts` 다. 같은 정책을 따른다 — Node 내장 zlib 만 쓰고
 * 새 의존성을 만들지 않는다(설계서 §1 의존성 정책).
 *
 * 지원 범위: 저장(0)·deflate(8) 엔트리, 4GB 미만, ZIP64 아님. Office 문서에는 충분하다.
 * 크기는 **중앙 디렉토리 값**을 신뢰한다 — 로컬 헤더는 data descriptor 사용 시 0 이 들어간다.
 */
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** EOCD 는 파일 끝에서 최대 22 + 65535(주석) 바이트 안에 있다 */
const EOCD_SEARCH_MAX = 22 + 0xffff;

export interface ZipDirEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** 중앙 디렉토리를 읽어 엔트리 목록을 만든다. ZIP 이 아니면 null. */
export function readZipDirectory(buf: Buffer): ZipDirEntry[] | null {
  const from = Math.max(0, buf.length - EOCD_SEARCH_MAX);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (dirOffset >= buf.length) return null;

  const entries: ZipDirEntry[] = [];
  let p = dirOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 엔트리 하나를 풀어 Buffer 로 돌려준다. 풀린 크기가 `maxBytes` 를 넘으면 null
 * (미리보기가 거대한 파일로 서버 메모리를 먹지 않게 하는 상한).
 *
 * 압축 해제는 **목차에 적힌 풀린 크기(uncompressedSize)까지만** 한다. 목차에는 작게 적고 실제로는
 * 거대하게 부풀리는 ZIP 폭탄(거짓 크기)은 적힌 크기 지점에서 압축 해제가 예외로 멈춰 거부된다. 정상
 * 파일은 적힌 크기 == 실제 크기라 그대로 풀린다. (예전에는 maxBytes 까지 풀어, 적힌 크기를 거짓으로
 * 작게 적은 파일이 부분 크기 상한·압축 폭탄 집계·머리말 예산 같은 '적힌 크기' 기반 방어를 우회했다.)
 */
export function readZipEntry(
  buf: Buffer,
  entry: ZipDirEntry,
  maxBytes = 8 * 1024 * 1024,
): Buffer | null {
  if (entry.uncompressedSize > maxBytes) return null;
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) return null;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) return null;
  const raw = buf.subarray(start, end);
  if (entry.method === 0) {
    // 저장(미압축): 실제 바이트 길이는 compressedSize. 목차의 풀린 크기와 다르면 거짓 크기다
    return raw.length === entry.uncompressedSize ? Buffer.from(raw) : null;
  }
  if (entry.method !== 8) return null;
  if (entry.uncompressedSize === 0) return Buffer.alloc(0); // maxOutputLength:0 은 예외라 따로 처리
  try {
    const out = zlib.inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize });
    // 적힌 크기보다 적게 풀렸으면(잘린 스트림·거짓 크기) 거부 — 정상 파일은 정확히 일치한다
    return out.length === entry.uncompressedSize ? out : null;
  } catch {
    return null;
  }
}

/** 이름으로 엔트리 하나를 찾아 푼다 (대소문자 구분). 없으면 null. */
export function readZipFile(buf: Buffer, name: string, maxBytes?: number): Buffer | null {
  const dir = readZipDirectory(buf);
  if (!dir) return null;
  const entry = dir.find((e) => e.name === name);
  return entry ? readZipEntry(buf, entry, maxBytes) : null;
}
