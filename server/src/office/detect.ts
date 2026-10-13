/**
 * 검사실 자료 업로드 형식 판별: 확장자가 아니라 **내용(매직 바이트, ZIP 목차)** 으로 정한다
 *
 * - PDF: 앞 1024바이트 안에 '%PDF-' (pdf.js 가 허용하는 범위와 같다)
 * - ZIP: 목차로 docx(word/document.xml), xlsx(xl/workbook.xml), pptx(ppt/presentation.xml),
 *        hwpx(mimetype = application/hwp+zip 또는 Contents/content.hpf)
 * - OLE2(D0 CF 11 E0): 복합 문서 목록으로 구형 Word(WordDocument), Excel(Workbook), 한글(FileHeader + DocInfo)을
 *   가린다. 같은 계열의 새 형식(docx, xlsx, hwpx)으로 저장하고 legacy 에 구형 이름을 적는다.
 *   구형 ppt, Excel 95 이전(Book), **암호가 걸린 Office 파일**(EncryptedPackage)은 거부 + 안내.
 * - 한글 97 이전(hwp 3.x)은 복합 문서가 아니다: 머리 'HWP Document File' 로 알아보고 거부 + 안내
 * - 텍스트: txt/csv/tsv/md 확장자 + NUL 없음 + UTF-8/CP949 로 읽힘
 * 판별 실패는 전부 UnsupportedFormatError(사용자에게 그대로 보여줄 한국어 문구)로 던진다.
 */
import path from 'node:path';
import { readZipDirectory, readZipEntry, type ZipDirEntry } from '../files/unzip.js';
import { Cfb } from './legacy/cfb.js';
import { OfficeParseError } from './errors.js';
import type { FileKind } from './model.js';

/** 압축을 푼 전체 크기 상한: ZIP 폭탄 방어 */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 400 * 1024 * 1024;
/** ZIP 항목 수 상한 */
export const MAX_ZIP_ENTRIES = 20_000;

export const FILE_KIND_MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/hwp+zip',
  text: 'text/plain; charset=utf-8',
};

/** 화면/안내용 형식 이름 */
export const FILE_KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  hwpx: '한글',
  text: '텍스트',
};

/** 업로드 화면 accept 와 같은 목록: 확장자(점 없이) */
export const ACCEPTED_EXTENSIONS = [
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'hwpx',
  'hwp',
  'txt',
  'csv',
  'tsv',
  'md',
] as const;

const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md']);

/** 파일 이름에서 지원 확장자 하나를 뗀다(제목 만들기용). 다른 확장자는 그대로 둔다 */
export function stripDocExtension(name: string): string {
  return name.replace(new RegExp(`\\.(${ACCEPTED_EXTENSIONS.join('|')})$`, 'i'), '');
}

export const SUPPORTED_FORMATS_HINT =
  'PDF, Word (docx, doc), Excel (xlsx, xls), PowerPoint (pptx), 한글(hwpx, hwp), 텍스트(txt, csv, tsv, md) 파일을 올려 주세요.';

/**
 * 구형 형식의 추출기 라벨 → 내려받기 형식. 구형은 같은 계열 새 형식의 file_kind 로 저장하므로, 판본 파일을 내려줄
 * 때는 추출기 라벨(document_version.extractor)로 원래 형식을 알린다. 라벨은 legacy/doc.ts, xls.ts, hwp.ts 의 상수와
 * 같다(시험으로 확인).
 */
export const LEGACY_EXTRACTOR_MIME: Readonly<Record<string, string>> = {
  'doc-v1': 'application/msword',
  'xls-v1': 'application/vnd.ms-excel',
  'hwp-v1': 'application/x-hwp',
};

/** 판본 파일 내려받기 형식: 구형 추출기면 원래 형식, 아니면 file_kind 형식 */
export function downloadMime(kind: FileKind, extractor: string | null | undefined): string {
  return (extractor ? LEGACY_EXTRACTOR_MIME[extractor] : undefined) ?? FILE_KIND_MIME[kind];
}

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

export interface DetectedFile {
  kind: FileKind;
  /** 소문자 확장자(점 없음): 없으면 '' */
  ext: string;
  /** 텍스트일 때 세부 형식 */
  textFormat?: 'txt' | 'csv' | 'tsv' | 'md';
  /** ZIP 형식일 때 목차 (재사용용) */
  zipDir?: ZipDirEntry[];
  /** 구형 바이너리(복합 문서) 형식: kind 는 같은 계열의 새 형식이고 추출기만 다르다 */
  legacy?: 'doc' | 'xls' | 'hwp';
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buf[i] !== bytes[i]) return false;
  return true;
}

function hasPdfHeader(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.length, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

const MSG_ENCRYPTED_OFFICE = '암호(열람 제한)가 걸린 Office 파일입니다. 암호를 해제해 저장한 뒤 다시 올려 주세요.';
const MSG_PPT = '구형 PowerPoint (ppt) 파일은 올릴 수 없습니다. PowerPoint에서 pptx 또는 PDF로 저장해 올려 주세요.';
const MSG_EXCEL5 = 'Excel 95 이전 형식(xls)은 읽을 수 없습니다. Excel에서 xlsx로 저장해 올려 주세요.';
const MSG_HWP3 = '한글 97 이전 형식(hwp 3.0)은 읽을 수 없습니다. 한글에서 hwpx 또는 hwp로 다시 저장해 올려 주세요.';

/**
 * 복합 문서(OLE2) 안 스트림 이름으로 형식을 가린다. 스트림을 읽지는 않는다(목록만): 내용의 손상, 암호, 판은
 * 형식별 추출기가 따로 확인한다.
 */
function detectOle(buf: Uint8Array, ext: string): DetectedFile {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let cfb: Cfb | null;
  try {
    cfb = Cfb.open(b);
  } catch (e) {
    throw new UnsupportedFormatError(e instanceof OfficeParseError ? e.message : `복합 문서 구조를 읽지 못했습니다. ${SUPPORTED_FORMATS_HINT}`);
  }
  if (!cfb) throw new UnsupportedFormatError(`복합 문서 구조를 읽지 못했습니다(손상 가능성). ${SUPPORTED_FORMATS_HINT}`);
  if (cfb.has('EncryptionInfo') || cfb.has('EncryptedPackage')) throw new UnsupportedFormatError(MSG_ENCRYPTED_OFFICE);
  if (cfb.has('WordDocument')) return { kind: 'docx', ext, legacy: 'doc' };
  if (cfb.has('Workbook')) return { kind: 'xlsx', ext, legacy: 'xls' };
  if (cfb.has('Book')) throw new UnsupportedFormatError(MSG_EXCEL5);
  if (cfb.has('FileHeader') && cfb.has('DocInfo')) return { kind: 'hwpx', ext, legacy: 'hwp' };
  if (cfb.has('PowerPoint Document')) throw new UnsupportedFormatError(MSG_PPT);
  throw new UnsupportedFormatError(`Office/한글 문서가 아닌 복합 문서입니다. ${SUPPORTED_FORMATS_HINT}`);
}

/**
 * 앞 64KB 로 텍스트 파일인지 본다. BOM 있는 UTF-16(메모장 '유니코드', 엑셀 '유니코드 텍스트' 저장)은 ASCII 글자마다
 * 0 바이트가 있으므로 바이트가 아니라 해독한 글자로 판정한다(text.ts decodeTextBuffer 와 같은 BOM 규칙).
 * 해독한 글자에 NUL 이 있거나 짝 없는 대리 글자가 있으면 텍스트가 아니다. 그 밖의 인코딩은 NUL 바이트가 없어야 한다.
 */
function looksLikeText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 64 * 1024);
  const utf16 = buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le' : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : null;
  if (utf16) {
    try {
      // stream: 64KB 에서 잘린 마지막 글자(대리 쌍의 앞쪽)는 오류로 보지 않는다
      const head = new TextDecoder(utf16, { fatal: true }).decode(buf.subarray(2, n), { stream: true });
      return !head.includes('\u0000');
    } catch {
      return false;
    }
  }
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return false;
  return true;
}

/**
 * 파일 내용으로 형식을 정한다. 지원하지 않으면 UnsupportedFormatError.
 * (PDF 손상/암호 판정은 기존 extract.ts 가 맡는다: 여기서는 '%PDF-' 머리만 본다.)
 */
export function detectFileKind(buf: Uint8Array, fileName: string): DetectedFile {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (buf.length === 0) throw new UnsupportedFormatError('빈 파일입니다.');

  if (hasPdfHeader(buf)) return { kind: 'pdf', ext };
  // 확장자가 pdf 인데 머리가 없으면 기존 PDF 경로에 넘겨 '손상된 PDF' 로 안내되게 한다
  if (ext === 'pdf') return { kind: 'pdf', ext };

  if (startsWith(buf, OLE_MAGIC)) return detectOle(buf, ext);
  if (Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.length, 17)).toString('latin1') === 'HWP Document File') {
    throw new UnsupportedFormatError(MSG_HWP3);
  }

  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const dir = readZipDirectory(b);
    if (!dir || dir.length === 0) {
      throw new UnsupportedFormatError(`압축(ZIP) 구조를 읽지 못했습니다(손상 가능성). ${SUPPORTED_FORMATS_HINT}`);
    }
    if (dir.length > MAX_ZIP_ENTRIES) {
      throw new UnsupportedFormatError('파일 안의 항목이 너무 많습니다(압축 폭탄 의심). 원본을 확인해 주세요.');
    }
    const total = dir.reduce((s, e) => s + e.uncompressedSize, 0);
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new UnsupportedFormatError(
        `압축을 풀면 ${Math.round(total / 1024 / 1024)}MB가 넘는 파일입니다(상한 ${MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024}MB).`,
      );
    }
    const names = new Set(dir.map((e) => e.name));
    if (names.has('word/document.xml')) return { kind: 'docx', ext, zipDir: dir };
    if (names.has('xl/workbook.xml')) return { kind: 'xlsx', ext, zipDir: dir };
    if (names.has('ppt/presentation.xml')) return { kind: 'pptx', ext, zipDir: dir };
    const mimetype = dir.find((e) => e.name === 'mimetype');
    if (mimetype) {
      const body = readZipEntry(b, mimetype, 1024)?.toString('utf8').trim();
      if (body === 'application/hwp+zip' || body === 'application/haansofthwpx') {
        return { kind: 'hwpx', ext, zipDir: dir };
      }
    }
    if (names.has('Contents/content.hpf')) return { kind: 'hwpx', ext, zipDir: dir };
    throw new UnsupportedFormatError(`압축 파일이지만 Office/한글 문서가 아닙니다. ${SUPPORTED_FORMATS_HINT}`);
  }

  if (TEXT_EXT.has(ext)) {
    if (!looksLikeText(buf)) {
      throw new UnsupportedFormatError('텍스트 파일로 읽을 수 없습니다(이진 데이터가 섞여 있습니다).');
    }
    return { kind: 'text', ext, textFormat: ext as DetectedFile['textFormat'] };
  }

  throw new UnsupportedFormatError(`지원하지 않는 형식입니다. ${SUPPORTED_FORMATS_HINT}`);
}
