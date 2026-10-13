/**
 * docx 패키지(OPC) 읽기: ZIP 항목, 부분(part) XML, 관계(rels) 해석
 *
 * - 부분별 압축 해제 상한: document.xml 64MB, 나머지 16MB. 상한을 넘거나 깨진 선택 부분은 없는 것으로 본다.
 * - 관계 대상은 원본 부분의 폴더 기준 상대 경로다('../media/a.png' 같은 상위 경로 포함).
 *   '/word/media/a.png' 같은 절대 경로도 받는다. 외부 대상(TargetMode="External")은 버린다.
 */
import { readZipDirectory, readZipEntry, type ZipDirEntry } from '../../files/unzip.js';
import { attr, parseXml, type XElement } from '../xml.js';
import { decodeXmlBytes } from './units.js';

export const MAIN_PART = 'word/document.xml';
export const MAX_MAIN_BYTES = 64 * 1024 * 1024;
export const MAX_PART_BYTES = 16 * 1024 * 1024;

export interface Rel {
  type: string;
  /** ZIP 안 경로 (외부 대상은 담지 않는다) */
  target: string;
}

/** 부분의 관계 파일 경로: word/header1.xml → word/_rels/header1.xml.rels */
function relsPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash >= 0 ? partPath.slice(0, slash + 1) : '';
  return `${dir}_rels/${partPath.slice(slash + 1)}.rels`;
}

export class DocxPackage {
  private readonly entries = new Map<string, ZipDirEntry>();
  private readonly relsCache = new Map<string, Map<string, Rel>>();

  constructor(private readonly buf: Buffer, dir: ZipDirEntry[]) {
    for (const e of dir) if (!this.entries.has(e.name)) this.entries.set(e.name, e);
  }

  static open(buf: Buffer): DocxPackage | null {
    const dir = readZipDirectory(buf);
    if (!dir || dir.length === 0) return null;
    return new DocxPackage(buf, dir);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** 부분 바이트 (없거나 상한 초과, 손상이면 null) */
  bytes(path: string, max = MAX_PART_BYTES): Buffer | null {
    const e = this.entries.get(path);
    return e ? readZipEntry(this.buf, e, max) : null;
  }

  /** 부분 XML 루트 (없거나 읽지 못하면 null) */
  xml(path: string | undefined, max = MAX_PART_BYTES): XElement | null {
    if (!path) return null;
    const b = this.bytes(path, max);
    if (!b) return null;
    try {
      return parseXml(decodeXmlBytes(b)).root;
    } catch {
      return null;
    }
  }

  /** 부분과 그 관계 파일의 풀린 크기 합 (중앙 디렉토리 값, 없는 부분은 0) */
  sizeWithRels(partPath: string): number {
    const size = (p: string): number => this.entries.get(p)?.uncompressedSize ?? 0;
    return size(partPath) + size(relsPathOf(partPath));
  }

  /** 부분의 관계 목록: rId → 대상 */
  rels(partPath: string): Map<string, Rel> {
    const cached = this.relsCache.get(partPath);
    if (cached) return cached;
    const map = new Map<string, Rel>();
    const slash = partPath.lastIndexOf('/');
    const dir = slash >= 0 ? partPath.slice(0, slash + 1) : '';
    const root = this.xml(relsPathOf(partPath));
    if (root) {
      for (const c of root.children) {
        if (c.type !== 'el' || !/(^|:)Relationship$/.test(c.name)) continue;
        const id = attr(c, 'Id');
        const target = attr(c, 'Target');
        if (!id || !target || attr(c, 'TargetMode') === 'External') continue;
        const resolved = this.resolve(dir, target);
        if (resolved) map.set(id, { type: attr(c, 'Type') ?? '', target: resolved });
      }
    }
    this.relsCache.set(partPath, map);
    return map;
  }

  /** 관계 종류(끝 이름, 예: 'styles')로 첫 대상 찾기 */
  relByType(partPath: string, typeSuffix: string): string | undefined {
    for (const r of this.rels(partPath).values()) {
      if (r.type.endsWith(`/${typeSuffix}`)) return r.target;
    }
    return undefined;
  }

  /** 상대/절대 대상 → ZIP 안 경로. 없으면 undefined */
  private resolve(baseDir: string, target: string): string | undefined {
    const raw = target.replace(/\\/g, '/');
    const cands: string[] = [];
    const join = (t: string): string => {
      const parts = (t.startsWith('/') ? t.slice(1) : baseDir + t).split('/');
      const out: string[] = [];
      for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') out.pop();
        else out.push(p);
      }
      return out.join('/');
    };
    cands.push(join(raw));
    try {
      const dec = decodeURIComponent(raw);
      if (dec !== raw) cands.push(join(dec));
    } catch {
      // 잘못된 % 인코딩: 원문 그대로만 본다
    }
    for (const c of cands) if (this.entries.has(c)) return c;
    // 대상이 ZIP 에 없어도 경로는 돌려준다(그림 등은 쓰기 전에 has() 로 다시 확인한다)
    return cands[0];
  }
}
