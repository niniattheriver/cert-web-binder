/**
 * 데모와 시험용 그림 파일 생성기 (설계서 §3.6 그림 근거자료)
 *
 * 저장소에 바이너리를 두지 않고 시드, 시험 때 만든다(seed/office-fixtures.ts 와 같은 방식). 그림 안에 글자는 없다:
 * 그림 파일은 글자를 읽지 않으므로 글꼴 없이 도형만 그린다. 의존성은 node:zlib 하나다(PNG 의 IDAT 압축).
 *
 * buildDemoPng(): 가상기관 망 분리 구성도. 왼쪽 업무망(파랑 영역, PC 3대, 서버), 가운데 방화벽(벽돌), 오른쪽 인터넷망
 *   (노랑 영역, 구름, PC 2대). revised 는 개정판(방화벽 아래 DMZ 영역을 더한 다른 그림)이다.
 */
import zlib from 'node:zlib';

type Rgb = readonly [number, number, number];

class Canvas {
  readonly px: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    bg: Rgb,
  ) {
    this.px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }

  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }

  /** 채운 사각형 [x, x+w) × [y, y+h) */
  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx += 1) this.set(xx, yy, c);
    }
  }

  /** 테두리만 (굵기 t) */
  frame(x: number, y: number, w: number, h: number, t: number, c: Rgb): void {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }

  /** 채운 원 */
  circle(cx: number, cy: number, r: number, c: Rgb): void {
    for (let y = cy - r; y <= cy + r; y += 1) {
      for (let x = cx - r; x <= cx + r; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c);
    }
  }

  /** 굵기 t 의 선분 */
  line(x0: number, y0: number, x1: number, y1: number, t: number, c: Rgb): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const r = Math.floor(t / 2);
    for (let i = 0; i <= steps; i += 1) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      this.rect(x - r, y - r, t, t, c);
    }
  }
}

const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [17, 17, 17];
const GRAY: Rgb = [120, 120, 120];
const BLUE: Rgb = [29, 78, 216];
const BLUE_BG: Rgb = [232, 240, 251];
const AMBER: Rgb = [180, 83, 9];
const YELLOW_BG: Rgb = [255, 248, 220];
const GREEN: Rgb = [21, 128, 61];
const GREEN_BG: Rgb = [229, 245, 234];
const BRICK: Rgb = [174, 21, 44];
const CLOUD: Rgb = [214, 214, 214];
const SCREEN: Rgb = [200, 220, 245];

/** 모니터와 받침 모양의 PC */
function pc(cv: Canvas, x: number, y: number): void {
  cv.rect(x, y, 84, 58, INK);
  cv.rect(x + 5, y + 5, 74, 48, SCREEN);
  cv.rect(x + 36, y + 58, 12, 12, INK);
  cv.rect(x + 22, y + 70, 40, 6, INK);
}

/** 선반 줄이 있는 서버 */
function server(cv: Canvas, x: number, y: number): void {
  cv.rect(x, y, 70, 130, INK);
  for (let i = 0; i < 4; i += 1) {
    cv.rect(x + 6, y + 8 + i * 30, 58, 22, [70, 70, 70]);
    cv.circle(x + 54, y + 19 + i * 30, 3, [74, 222, 128]);
  }
}

/** 벽돌 무늬 방화벽 */
function firewall(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, BRICK);
  for (let row = 0, yy = y; yy < y + h; row += 1, yy += 20) {
    cv.rect(x, yy, w, 3, WHITE);
    const off = row % 2 === 0 ? 0 : 15;
    for (let xx = x + off; xx < x + w; xx += 30) cv.rect(xx, yy, 3, 20, WHITE);
  }
  cv.frame(x, y, w, h, 3, INK);
}

function cloud(cv: Canvas, cx: number, cy: number): void {
  for (const [dx, dy, r] of [
    [-50, 10, 38],
    [0, -12, 50],
    [52, 8, 40],
    [-10, 26, 36],
    [30, 28, 34],
  ] as const) {
    cv.circle(cx + dx, cy + dy, r, CLOUD);
  }
}

/** 그림 → PNG 바이트 (RGB 8비트, 필터 없음) */
function encodePng(cv: Canvas): Buffer {
  const raw = Buffer.alloc((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y += 1) {
    raw[y * (cv.w * 3 + 1)] = 0;
    Buffer.from(cv.px.buffer, y * cv.w * 3, cv.w * 3).copy(raw, y * (cv.w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** 가상기관 망 분리 구성도 (글자 없는 그림). revised 는 DMZ 를 더한 개정판 */
export function buildDemoPng(opts: { revised?: boolean } = {}): Buffer {
  const cv = new Canvas(960, 600, WHITE);
  // 업무망
  cv.rect(40, 70, 380, 480, BLUE_BG);
  cv.frame(40, 70, 380, 480, 4, BLUE);
  cv.rect(40, 70, 380, 36, BLUE);
  pc(cv, 80, 160);
  pc(cv, 80, 300);
  pc(cv, 80, 440);
  server(cv, 300, 250);
  for (const y of [190, 330, 470]) cv.line(164, y, 300, 315, 3, GRAY);
  // 인터넷망
  cv.rect(540, 70, 380, 480, YELLOW_BG);
  cv.frame(540, 70, 380, 480, 4, AMBER);
  cv.rect(540, 70, 380, 36, AMBER);
  cloud(cv, 730, 220);
  pc(cv, 600, 400);
  pc(cv, 760, 400);
  cv.line(642, 400, 710, 270, 3, GRAY);
  cv.line(802, 400, 750, 270, 3, GRAY);
  // 방화벽과 연결선
  cv.line(370, 315, 450, 315, 4, INK);
  cv.line(510, 315, 680, 240, 4, INK);
  firewall(cv, 450, 220, 60, 190);
  if (opts.revised) {
    // 개정판: 방화벽 아래 DMZ(초록 영역과 작은 서버)를 더한다
    cv.line(480, 410, 480, 450, 4, INK);
    cv.rect(430, 450, 100, 90, GREEN_BG);
    cv.frame(430, 450, 100, 90, 3, GREEN);
    cv.rect(455, 462, 50, 66, INK);
    for (let i = 0; i < 2; i += 1) {
      cv.rect(460, 470 + i * 28, 40, 20, [70, 70, 70]);
      cv.circle(492, 480 + i * 28, 3, [74, 222, 128]);
    }
  }
  return encodePng(cv);
}
