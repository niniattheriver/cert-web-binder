/**
 * 첨부파일 미리보기 payload 생성: 첨부를 누르면 바로 내려받지 않고 메일 첨부처럼 미리보기 창이 뜨며,
 * 내려받기는 옆의 별도 버튼으로 한다.
 *
 * 고충실도 미리보기
 * - 내용이 docx, xlsx, pptx, hwpx, 텍스트(txt, md, csv, tsv)로 판별되면(office/detect.ts) 지침서
 *   라이브러리와 같은 추출기(office/index.ts extractOffice)가 만든 렌더 모델을 준다. 화면은 지침서
 *   뷰어와 같은 렌더러(FlowView, SheetView, SlidesView, PlainView)로 그린다.
 * - 판별이나 추출에 실패하면 아래의 예전 방식(글자, 표, 문단만 뽑기)으로 돌아가고, 그것도 안 되면
 *   kind:'none' 으로 이유를 알린다. 구형 hwp, doc, xls 도 내용으로 판별해 같은 렌더 모델로 보여 준다.
 *   구형 ppt 는 안내만 준다.
 * - 같은 첨부를 거듭 열어도 다시 해석하지 않도록 렌더 모델을 작은 LRU 캐시(8개)에 둔다.
 *
 * 원칙
 * - **새 의존성 없음.** xlsx 는 이미 있는 ExcelJS(MIT), docx·pptx·hwpx 는 내장 zlib 기반
 *   `unzip.ts` 로 읽는다(설계서 §1: 의존성은 MIT/Apache 만, 런타임 외부 요청 금지).
 * - **원본 파일을 브라우저에 그대로 넘기지 않는다.** 렌더 모델 JSON 이나 뽑은 글자만 준다.
 *   HTML/스크립트가 섞여 들어올 여지를 없애기 위함(저장형 XSS 차단 — 설계서 §7 A-7 과 같은 취지).
 *   pdf·이미지만은 예외로 파일 URL 을 그대로 쓴다(inline 화이트리스트에 있는 형식).
 *   모델 안의 그림은 그림 라우트가 모델의 media 목록 색인으로만 찾는다(요청에서 경로를 받지 않는다).
 * - **상한을 둔다.** 미리보기가 수백 MB 파일로 서버 메모리를 먹으면 안 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { detectFileKind, type DetectedFile } from '../office/detect.js';
import { sniffImage } from '../office/image-sniff.js';
import { runIsolated } from '../jobs/isolated.js';
import { OfficeLimitError } from '../office/errors.js';
import { extractOfficeIsolated, OFFICE_PARSE_MAX_HEAP_MB, OFFICE_PARSE_TIMEOUT_MS, toOfficeLimit } from '../office/index.js';
import { readModelMedia } from '../office/media.js';
import type { FileKind, MediaRef } from '../office/model.js';
import { readZipDirectory, readZipEntry, readZipFile } from './unzip.js';

/** 미리보기로 읽어들일 원본 최대 크기 — 넘으면 kind:'none' */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_SHEETS = 10;
const MAX_ROWS = 300;
const MAX_COLS = 40;
const MAX_PARAGRAPHS = 3_000;
const MAX_SLIDES = 120;

/** 렌더 모델 캐시 상한: 항목 수, 모델 JSON 바이트 합 */
const MODEL_CACHE_MAX_ENTRIES = 8;
const MODEL_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 원본 바이트를 잠깐 들고 있는 시간: 미리보기 직후 그림 요청이 몰려도 파일을 한 번만 읽는다 */
const RECENT_SOURCE_TTL_MS = 30_000;
/** 모델 그림 한 장의 상한과 허용 형식 (지침서 그림 라우트와 같다. svg 는 스크립트를 품을 수 있어 뺀다) */
const MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const MEDIA_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp',
]);

export type PreviewPayload =
  /** 브라우저가 파일 URL 을 그대로 렌더한다(inline 화이트리스트) */
  | { kind: 'pdf' }
  | { kind: 'image' }
  | { kind: 'text'; text: string; truncated: boolean }
  | {
      kind: 'sheet';
      sheets: { name: string; rows: string[][]; truncated: boolean }[];
      truncated: boolean;
    }
  | { kind: 'doc'; paragraphs: string[]; truncated: boolean }
  | { kind: 'slides'; slides: { no: number; lines: string[] }[]; truncated: boolean }
  /** 미리보기를 만들 수 없음 — 화면은 내려받기 안내만 보여준다 */
  | { kind: 'none'; reason: string };

/** 렌더 모델이 있는 형식 (PDF 는 브라우저가 파일을 직접 그린다) */
export type ModelFileKind = Exclude<FileKind, 'pdf'>;

/**
 * 고충실도 미리보기 (서버 안 표현). 응답의 preview 는 { kind: 'model', fileKind, model } 이고,
 * model 자리에는 render 바이트를 다시 해석하지 않고 그대로 싣는다(modelPreviewBody).
 */
export interface ModelPreview {
  kind: 'model';
  fileKind: ModelFileKind;
  /** 만든 추출기 라벨 (document_version.extractor 와 같은 값) */
  extractor: string;
  /** RenderModel JSON (UTF-8) */
  render: Buffer;
  /** 모델의 media 목록. 그림을 처음 요청할 때 render 에서 꺼내 채운다(modelMedia) */
  media?: (MediaRef | null)[];
}

export type PreviewResult = PreviewPayload | ModelPreview;

export interface PreviewOptions {
  /** 첨부 내용 sha256. 주면 렌더 모델을 캐시하고 원본 바이트를 잠깐 다시 쓴다 */
  sha256?: string;
}

const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md', 'json', 'log', 'xml', 'yaml', 'yml']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function previewExt(origName: string): string {
  return path.extname(origName).slice(1).toLowerCase();
}

// ─────────────────────────────── 원본 읽기 ───────────────────────────────

/** 저장 파일이 없거나 상한보다 크면 그 안내(kind:'none'), 읽어도 되면 null */
function sourceProblem(filePath: string): PreviewPayload | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { kind: 'none', reason: '저장 파일을 찾지 못했습니다.' };
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    return {
      kind: 'none',
      reason: `미리보기 상한(${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)}MB)보다 큰 파일입니다. 내려받아 확인하세요.`,
    };
  }
  return null;
}

let recentSource: { sha256: string; buf: Buffer; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * 원본 바이트. sha256 을 주면 마지막으로 읽은 원본 하나를 잠깐 들고 있다가 다시 쓴다
 * (그림이 30장인 문서를 열어도 파일을 30번 읽지 않게. 내용주소 저장이라 같은 sha256 은 같은 바이트다).
 */
async function readSource(filePath: string, sha256: string | undefined): Promise<Buffer> {
  if (sha256 && recentSource?.sha256 === sha256) {
    recentSource.timer.refresh();
    return recentSource.buf;
  }
  const buf = await fs.promises.readFile(filePath);
  if (sha256) {
    if (recentSource) clearTimeout(recentSource.timer);
    const timer = setTimeout(() => {
      recentSource = null;
    }, RECENT_SOURCE_TTL_MS);
    timer.unref();
    recentSource = { sha256, buf, timer };
  }
  return buf;
}

// ─────────────────────────────── 렌더 모델 (고충실도) ───────────────────────────────

/** 키 → 렌더 모델. Map 의 순서가 최근 사용 순서다(오래된 것이 앞) */
const modelCache = new Map<string, ModelPreview>();
let modelCacheBytes = 0;
/**
 * 형식별 추출기 라벨 ('xlsx' → 'xlsx-v1'). 라벨은 형식 모듈 안의 상수이고 그 모듈은 처음 쓸 때 불러오므로
 * (office/index.ts) 그 형식을 처음 추출할 때 알게 된다. 그 전에는 그 형식으로 만든 캐시 항목도 없다.
 */
const extractorLabels = new Map<string, string>();
/** 진행 중인 추출: 같은 첨부를 동시에 열어도(미리보기와 그림 요청) 한 번만 해석한다 */
const inflight = new Map<string, Promise<ModelPreview | null>>();

/** 판별 형식 → 캐시 키의 형식 칸. 텍스트는 세부 형식마다 모델이 다르다(csv 는 시트, txt 는 글) */
function variantOf(d: DetectedFile): string {
  return d.kind === 'text' ? `text/${d.textFormat ?? 'txt'}` : d.kind;
}

/**
 * 캐시 키: 첨부 sha256 + 추출기 라벨 + 형식 + 파일 이름.
 * 파일 이름도 넣는 까닭: 같은 바이트라도 이름(확장자)에 따라 세부 형식이 달라지고(csv, txt),
 * csv 는 파일 이름이 시트 이름이 된다.
 */
function modelCacheKey(sha256: string, extractor: string, variant: string, origName: string): string {
  return [sha256, extractor, variant, origName].join('\u0000');
}

function cacheGet(key: string): ModelPreview | undefined {
  const hit = modelCache.get(key);
  if (hit) {
    modelCache.delete(key); // 최근 사용으로 옮긴다
    modelCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, entry: ModelPreview): void {
  const size = entry.render.byteLength;
  if (size > MODEL_CACHE_MAX_BYTES / 2) return; // 아주 큰 모델은 담지 않는다(다른 항목을 모두 밀어내지 않게)
  const old = modelCache.get(key);
  if (old) {
    modelCache.delete(key);
    modelCacheBytes -= old.render.byteLength;
  }
  modelCache.set(key, entry);
  modelCacheBytes += size;
  for (const [k, v] of modelCache) {
    if (modelCache.size <= MODEL_CACHE_MAX_ENTRIES && modelCacheBytes <= MODEL_CACHE_MAX_BYTES) break;
    modelCache.delete(k);
    modelCacheBytes -= v.render.byteLength;
  }
}

async function extractModel(
  detected: DetectedFile,
  buf: Buffer,
  origName: string,
  variant: string,
): Promise<ModelPreview | null> {
  try {
    const r = await extractOfficeIsolated(detected, buf, origName); // 작업 스레드에서 (jobs/isolated.ts)
    extractorLabels.set(variant, r.extractor);
    return { kind: 'model', fileKind: r.fileKind, extractor: r.extractor, render: r.render };
  } catch (err) {
    // 시간, 메모리 상한에 걸린 파일은 예전 방식으로 다시 해석하지 않는다(buildPreview 가 안내로 끝낸다)
    if (err instanceof OfficeLimitError) throw err;
    // 손상 파일, 암호 등: 예전 방식이 할 수 있는 만큼 보여 준다
    console.warn(
      `[첨부] 렌더 모델을 만들지 못해 예전 미리보기로 보여줍니다(${variant}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** 내용으로 판별해 렌더 모델을 만든다(캐시 우선). 렌더 모델 형식이 아니거나 추출에 실패하면 null */
async function modelPreview(
  buf: Buffer,
  origName: string,
  sha256: string | undefined,
): Promise<ModelPreview | null> {
  let detected: DetectedFile;
  try {
    detected = detectFileKind(buf, origName);
  } catch {
    return null; // 내용으로 형식을 정하지 못했다(구형 형식, 지원 밖 확장자): 예전 방식이 확장자로 본다
  }
  if (detected.kind === 'pdf') return null;
  const variant = variantOf(detected);
  if (!sha256) return extractModel(detected, buf, origName, variant);

  const label = extractorLabels.get(variant);
  if (label) {
    const hit = cacheGet(modelCacheKey(sha256, label, variant, origName));
    if (hit) return hit;
  }
  const flightKey = [sha256, variant, origName].join('\u0000');
  let pending = inflight.get(flightKey);
  if (!pending) {
    pending = extractModel(detected, buf, origName, variant)
      .then((m) => {
        if (m) cachePut(modelCacheKey(sha256, m.extractor, variant, origName), m);
        return m;
      })
      .finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, pending);
  }
  return pending;
}

function isMediaRef(v: unknown): v is MediaRef {
  if (!v || typeof v !== 'object') return false;
  const o = v as { path?: unknown; mime?: unknown };
  return typeof o.path === 'string' && typeof o.mime === 'string';
}

/** 모델의 media 목록 (색인이 모델과 같아야 하므로 걸러 내지 않고 모양이 틀린 칸만 null) */
function modelMedia(m: ModelPreview): (MediaRef | null)[] {
  if (!m.media) {
    let list: unknown;
    try {
      list = (JSON.parse(m.render.toString('utf8')) as { media?: unknown }).media;
    } catch {
      list = [];
    }
    m.media = Array.isArray(list) ? list.map((v) => (isMediaRef(v) ? v : null)) : [];
  }
  return m.media;
}

/**
 * 미리보기 응답 본문(JSON 바이트): { ...meta, preview: { kind: 'model', fileKind, model } }.
 * 모델은 render 바이트를 그대로 이어 붙인다(수 MB 모델을 다시 해석하고 직렬화하지 않기 위함).
 */
export function modelPreviewBody(meta: Record<string, unknown>, p: ModelPreview): Buffer {
  const metaJson = JSON.stringify(meta);
  const head =
    `${metaJson.slice(0, -1)}${metaJson.length > 2 ? ',' : ''}` +
    `"preview":{"kind":"model","fileKind":${JSON.stringify(p.fileKind)},"model":`;
  return Buffer.concat([Buffer.from(head, 'utf8'), p.render, Buffer.from('}}', 'utf8')]);
}

/**
 * 렌더 모델이 가리키는 그림 한 장 (GET /api/questions/attachments/:aid/media/:n).
 * 모델의 media[index].path 를 첨부(ZIP 항목, hwp 는 복합 문서 스트림) 안에서 찾는다. 경로를 요청에서 받지 않으므로
 * 다른 항목에 닿지 않는다.
 * 모델이 없거나(형식 밖, 추출 실패) 그 색인이 없거나 허용 형식이 아니면 null.
 */
export async function attachmentMedia(
  filePath: string,
  origName: string,
  sha256: string,
  index: number,
): Promise<{ mime: string; bytes: Buffer } | null> {
  const ext = previewExt(origName);
  if (ext === 'pdf' || IMAGE_EXT.has(ext)) return null;
  if (!Number.isInteger(index) || index < 0) return null;
  if (sourceProblem(filePath)) return null;
  const buf = await readSource(filePath, sha256);
  let model: ModelPreview | null;
  try {
    model = await modelPreview(buf, origName, sha256);
  } catch (e) {
    if (e instanceof OfficeLimitError) return null;
    throw e;
  }
  if (!model) return null;
  const ref = modelMedia(model)[index];
  if (!ref || !MEDIA_MIME.has(ref.mime)) return null;
  const bytes = readModelMedia(buf, ref.path, MEDIA_MAX_BYTES);
  // 실제 바이트가 래스터 그림일 때만, 판정한 형식으로 (판본 그림 경로와 같은 규칙, office/image-sniff.ts)
  const sniffed = bytes ? sniffImage(bytes.subarray(0, 32)) : null;
  return bytes && sniffed ? { mime: sniffed, bytes } : null;
}

// ─────────────────────────────── 예전 방식 (글자, 표, 문단만) ───────────────────────────────

/** XML 엔티티 되돌리기 (문서 본문 추출용 — 수치 참조 포함) */
function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `<tag ...>글자</tag>` 안의 글자를 선형 시간으로 모은다 (indexOf 만 쓰므로 O(n)).
 * 예전에는 `<tag[^>]*>([\s\S]*?)</tag>` 를 matchAll 로 돌렸는데, 닫는 태그가 없는 조각(손상 문서,
 * 악성 업로드)에서 여는 태그마다 끝까지 되훑어 시간이 제곱으로 늘었다(256KB document.xml 에 닫히지 않은
 * <w:t> 수천 개 → 3초, 8MB 까지 허용되므로 수 분. 이벤트 루프 전체가 그동안 멈춘다). 여닫이 글자 추출은
 * 중첩되지 않으므로 선형 스캔이면 충분하고 정상 문서의 결과는 그대로다.
 */
function collectTagText(src: string, tag: string): string[] {
  const out: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  for (;;) {
    const a = src.indexOf(open, i);
    if (a < 0) break;
    // 태그 경계: open 다음 글자는 '>' '/' 또는 공백이어야 한다(<w:tab>, <a:tab> 등 오매치 방지)
    const after = src.charCodeAt(a + open.length);
    const boundary =
      Number.isNaN(after) ||
      after === 0x3e /* > */ ||
      after === 0x2f /* / */ ||
      after === 0x20 ||
      after === 0x09 ||
      after === 0x0a ||
      after === 0x0d;
    if (!boundary) {
      i = a + open.length;
      continue;
    }
    const gt = src.indexOf('>', a + open.length);
    if (gt < 0) break;
    if (src.charCodeAt(gt - 1) === 0x2f /* 자기닫힘 <tag/> */) {
      i = gt + 1;
      continue;
    }
    const b = src.indexOf(close, gt + 1);
    if (b < 0) break;
    out.push(src.slice(gt + 1, b));
    i = b + close.length;
  }
  return out;
}

/** 예전 방식 ZIP 미리보기(ExcelJS 등 경계 없는 도구)에 넘기기 전 압축 해제 분량을 검사하는 상한 */
const LEGACY_ZIP_MAX_ENTRIES = 20_000;
const LEGACY_ZIP_MAX_INFLATED = 100 * 1024 * 1024;

/**
 * ExcelJS 처럼 ZIP 전체를 경계 없이 푸는 도구에 넘기기 전, 경계 있는 리더로 실제 압축 해제량을 재
 * 상한 안이면 true. 항목이 너무 많거나(압축 폭탄), 실제로 풀면 상한을 넘거나(ZIP 폭탄 — 목차에 적힌
 * 크기를 거짓으로 작게 적은 경우 포함), ZIP 이 아니면 false. 형식 판별(detect)이 거부한 파일도
 * 예전 방식은 확장자만 보고 들어오므로, 여기서 다시 막는다.
 */
function zipInflationWithinBudget(buf: Buffer): boolean {
  const dir = readZipDirectory(buf);
  if (!dir || dir.length === 0 || dir.length > LEGACY_ZIP_MAX_ENTRIES) return false;
  let used = 0;
  for (const e of dir) {
    if (e.name.endsWith('/')) continue; // 디렉토리 항목
    const remaining = LEGACY_ZIP_MAX_INFLATED - used;
    if (remaining <= 0) return false;
    const data = readZipEntry(buf, e, remaining);
    // null = 남은 예산을 넘겨 풀리거나(ZIP 폭탄, 거짓 크기) 항목이 깨진 경우 → 거부. 빈 항목은 빈 Buffer 라 null 이 아니다
    if (!data) return false;
    used += data.length;
  }
  return true;
}

/**
 * 한글 텍스트 파일은 UTF-8 과 CP949(EUC-KR) 가 섞여 들어온다.
 * UTF-8 로 엄격 디코드해 보고 실패하면 euc-kr 로 돌린다(Node 20+ full-icu 전제).
 */
function decodeText(buf: Buffer): string {
  let body = buf;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3); // UTF-8 BOM
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(body);
    } catch {
      return body.toString('utf8'); // 최후 폴백 — 깨진 글자는 U+FFFD 로 남는다
    }
  }
}

function clampText(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_TEXT_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/** docx — word/document.xml 의 <w:p> 를 문단으로, <w:t> 를 글자로 */
function previewDocx(buf: Buffer): PreviewPayload {
  const xml = readZipFile(buf, 'word/document.xml');
  if (!xml) return { kind: 'none', reason: 'docx 본문(word/document.xml)을 읽지 못했습니다.' };
  const src = xml.toString('utf8');
  const paras: string[] = [];
  let truncated = false;
  for (const chunk of src.split(/<\/w:p>/)) {
    if (paras.length >= MAX_PARAGRAPHS) {
      truncated = true;
      break;
    }
    const withBreaks = chunk.replace(/<w:(?:br|cr)\b[^<>]*\/?>/g, '\n').replace(/<w:tab\b[^<>]*\/?>/g, '\t');
    const runs = collectTagText(withBreaks, 'w:t');
    const text = unescapeXml(runs.join('')).replace(/[ \t]+$/g, '');
    if (text.trim() !== '') paras.push(text);
  }
  if (paras.length === 0) {
    return { kind: 'none', reason: '문서에서 추출할 텍스트가 없습니다(이미지 위주 문서일 수 있습니다).' };
  }
  return { kind: 'doc', paragraphs: paras, truncated };
}

/** pptx — ppt/slides/slideN.xml 을 슬라이드 번호 순으로, <a:t> 를 줄로 */
function previewPptx(buf: Buffer): PreviewPayload {
  const dir = readZipDirectory(buf);
  if (!dir) return { kind: 'none', reason: 'pptx를 열지 못했습니다.' };
  const slideEntries = dir
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .map((e) => ({ e, no: Number(e.name.match(/slide(\d+)\.xml$/)?.[1] ?? 0) }))
    .sort((a, b) => a.no - b.no);
  if (slideEntries.length === 0) return { kind: 'none', reason: '슬라이드를 찾지 못했습니다.' };

  const slides: { no: number; lines: string[] }[] = [];
  let truncated = slideEntries.length > MAX_SLIDES;
  for (const { e, no } of slideEntries.slice(0, MAX_SLIDES)) {
    const xml = readZipEntry(buf, e);
    if (!xml) continue;
    const src = xml.toString('utf8');
    const lines: string[] = [];
    for (const para of src.split(/<\/a:p>/)) {
      const runs = collectTagText(para, 'a:t');
      const text = unescapeXml(runs.join('')).trim();
      if (text !== '') lines.push(text);
    }
    slides.push({ no, lines });
  }
  if (slides.length === 0) truncated = false;
  return { kind: 'slides', slides, truncated };
}

/** hwpx — Contents/sectionN.xml 의 <hp:t> (최선노력. hwp 바이너리는 지원하지 않는다) */
function previewHwpx(buf: Buffer): PreviewPayload {
  const dir = readZipDirectory(buf);
  if (!dir) return { kind: 'none', reason: 'hwpx를 열지 못했습니다.' };
  const sections = dir
    .filter((e) => /^Contents\/section\d+\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (sections.length === 0) return { kind: 'none', reason: '본문(Contents/section*.xml)이 없습니다.' };

  const paras: string[] = [];
  let truncated = false;
  for (const e of sections) {
    const xml = readZipEntry(buf, e);
    if (!xml) continue;
    const src = xml.toString('utf8');
    for (const para of src.split(/<\/hp:p>/)) {
      if (paras.length >= MAX_PARAGRAPHS) {
        truncated = true;
        break;
      }
      const runs = collectTagText(para, 'hp:t');
      const text = unescapeXml(runs.join('')).trim();
      if (text !== '') paras.push(text);
    }
  }
  if (paras.length === 0) return { kind: 'none', reason: '문서에서 추출할 텍스트가 없습니다.' };
  return { kind: 'doc', paragraphs: paras, truncated };
}

/** 엑셀 셀 값을 표시용 문자열로 (수식은 계산 결과를, 없으면 빈 칸) */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text; // 하이퍼링크·리치텍스트
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('result' in v) return cellText(v.result); // 수식
    if ('error' in v) return String(v.error);
    return '';
  }
  return String(value);
}

async function previewXlsx(buf: Buffer): Promise<PreviewPayload> {
  // ExcelJS(JSZip)는 ZIP 전체를 경계 없이 메모리에 푼다. 이 예전 방식은 모델 추출(office/xlsx.ts)이
  // 실패했을 때, 그리고 형식 판별(detect)이 거부한 파일에도 확장자만 보고 들어오므로, ExcelJS 에 넘기기
  // 전에 경계 있는 리더로 실제 압축 해제량을 재 ZIP 폭탄을 막는다(안 그러면 작은 xlsx 가 수 GB 로 풀려 서버
  // 메모리를 소진한다 — detect 의 상한을 우회하는 경로다).
  if (!zipInflationWithinBudget(buf)) {
    return { kind: 'none', reason: '엑셀 파일이 너무 크거나 구조가 올바르지 않아 미리보기를 만들지 못했습니다. 내려받아 확인하세요.' };
  }
  const wb = new ExcelJS.Workbook();
  // ExcelJS 는 Buffer 를 그대로 받는다. 타입 선언만 옛 Buffer 꼴이라 office/xlsx.ts 와 같이 넘긴다
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: { name: string; rows: string[][]; truncated: boolean }[] = [];
  let truncated = wb.worksheets.length > MAX_SHEETS;
  for (const ws of wb.worksheets.slice(0, MAX_SHEETS)) {
    const rows: string[][] = [];
    let sheetTruncated = false;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rows.length >= MAX_ROWS) {
        sheetTruncated = true;
        return;
      }
      if (rowNumber > MAX_ROWS * 4) return; // 아주 먼 곳의 흩어진 행은 건너뛴다
      const cells: string[] = [];
      const limit = Math.min(ws.columnCount || 0, MAX_COLS);
      for (let c = 1; c <= limit; c += 1) cells.push(cellText(row.getCell(c).value));
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells);
    });
    if ((ws.columnCount || 0) > MAX_COLS) sheetTruncated = true;
    sheets.push({ name: ws.name, rows, truncated: sheetTruncated });
  }
  if (sheets.length === 0) return { kind: 'none', reason: '시트가 없습니다.' };
  return { kind: 'sheet', sheets, truncated };
}

/** 렌더 모델을 만들지 못한 구형 파일의 안내 (손상, 암호, 배포용 문서 등) */
const LEGACY_REASON: Record<string, string> = {
  hwp: '이 hwp 파일을 읽지 못했습니다(손상, 암호, 배포용 문서일 수 있습니다). 내려받아 확인하세요.',
  doc: '이 doc 파일을 읽지 못했습니다(손상되었거나 암호가 걸렸을 수 있습니다). 내려받아 확인하세요.',
  xls: '이 xls 파일을 읽지 못했습니다(손상되었거나 암호가 걸렸을 수 있습니다). 내려받아 확인하세요.',
  ppt: '구형 ppt는 미리보기를 지원하지 않습니다(pptx로 저장하면 볼 수 있습니다).',
};

/**
 * 예전 방식 미리보기: 확장자로 형식을 보고 글자, 표, 문단만 뽑는다.
 * 렌더 모델을 만들지 못한 파일(추출 실패, json 같은 지원 밖 텍스트)의 대안이다.
 */
export async function buildLegacyPreview(buf: Buffer, origName: string): Promise<PreviewPayload> {
  const ext = previewExt(origName);
  try {
    if (TEXT_EXT.has(ext)) {
      const { text, truncated } = clampText(decodeText(buf));
      return { kind: 'text', text, truncated };
    }
    if (ext === 'xlsx') return await previewXlsx(buf);
    if (ext === 'docx') return previewDocx(buf);
    if (ext === 'pptx') return previewPptx(buf);
    if (ext === 'hwpx') return previewHwpx(buf);
  } catch (err) {
    return {
      kind: 'none',
      reason: `미리보기를 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { kind: 'none', reason: LEGACY_REASON[ext] ?? '이 형식은 미리보기를 지원하지 않습니다.' };
}

/**
 * 파일 하나의 미리보기. 렌더 모델 → 예전 방식 → kind:'none' 순서로 시도한다.
 * 형식을 알아보지 못하면 kind:'none' 을 돌려주고 화면은 내려받기만 안내한다: 실패가 조용히 빈 화면이 되지 않게.
 */
export async function buildPreview(
  filePath: string,
  origName: string,
  opts: PreviewOptions = {},
): Promise<PreviewResult> {
  const ext = previewExt(origName);
  if (ext === 'pdf') return { kind: 'pdf' };
  if (IMAGE_EXT.has(ext)) return { kind: 'image' };

  const problem = sourceProblem(filePath);
  if (problem) return problem;
  let buf: Buffer;
  try {
    buf = await readSource(filePath, opts.sha256);
  } catch {
    return { kind: 'none', reason: '저장 파일을 찾지 못했습니다.' };
  }
  let model: ModelPreview | null;
  try {
    model = await modelPreview(buf, origName, opts.sha256);
  } catch (e) {
    if (e instanceof OfficeLimitError) return { kind: 'none', reason: limitReason(e) };
    throw e;
  }
  if (model) return model;
  // 예전 방식도 같은 해석기(ExcelJS 등)를 쓰므로 작업 스레드에서 같은 상한으로 돌린다
  try {
    return await runIsolated<PreviewPayload>(new URL(import.meta.url), 'legacyPreviewFromBytes', [buf, origName], {
      timeoutMs: OFFICE_PARSE_TIMEOUT_MS,
      maxOldGenerationSizeMb: OFFICE_PARSE_MAX_HEAP_MB,
    });
  } catch (e) {
    const limit = toOfficeLimit(e);
    return {
      kind: 'none',
      reason: limit ? limitReason(limit) : `미리보기를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 해석 상한에 걸린 미리보기 안내 (업로드 안내의 '다시 올려 주세요' 대신 미리보기에 맞는 말로) */
function limitReason(e: OfficeLimitError): string {
  if (e.limit === 'busy') return '지금 다른 파일을 여럿 읽고 있어 미리보기를 만들지 못했습니다. 잠시 뒤 다시 열어 주세요.';
  if (e.limit === 'timeout') {
    return `파일을 읽는 데 ${Math.round(OFFICE_PARSE_TIMEOUT_MS / 60_000)}분이 넘게 걸려 미리보기를 멈췄습니다. 내려받아 확인하세요.`;
  }
  return '파일이 너무 커서 미리보기를 만들지 못했습니다. 내려받아 확인하세요.';
}

/** 작업 스레드 쪽 입구: 스레드로 건너오면 Buffer 가 Uint8Array 가 되므로 되돌려 예전 방식 미리보기를 만든다 */
export async function legacyPreviewFromBytes(bytes: Uint8Array, origName: string): Promise<PreviewPayload> {
  return buildLegacyPreview(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), origName);
}
