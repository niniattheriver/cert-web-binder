// isolated.test.ts 가 작업 스레드에서 부르는 함수들 (시험 전용)

export function add(a: number, b: number): number {
  return a + b;
}

/** ms 동안 CPU 를 붙잡는다(작업 스레드가 바쁜 동안 주 스레드가 멈추지 않는지 보려고) */
export function spin(ms: number): number {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) n += 1;
  return n;
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

export function fail(message: string): never {
  throw new FixtureError(message);
}

/** 메모리를 끝없이 잡는다(메모리 상한 시험) */
export function hog(): number {
  const keep: number[][] = [];
  for (;;) keep.push(new Array<number>(1_000_000).fill(keep.length));
}

/** Buffer 를 받아 길이와 첫 바이트를 돌려준다(Uint8Array 로 도착함을 확인) */
export function bytesInfo(b: Uint8Array): { isBuffer: boolean; length: number; first: number } {
  return { isBuffer: Buffer.isBuffer(b), length: b.length, first: b[0] ?? -1 };
}

/** 이 작업을 맡은 스레드 번호(스레드를 다시 쓰는지 보려고) */
export async function threadNo(): Promise<number> {
  const { threadId } = await import('node:worker_threads');
  return threadId;
}
