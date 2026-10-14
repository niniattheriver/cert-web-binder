// 작업 스레드 실행기: 결과, 오류 되살리기, 시간 상한, 메모리 상한, 그동안 주 스레드가 멈추지 않는지
import { describe, expect, it } from 'vitest';
import {
  closeIdleWorkers,
  IsolatedBusyError,
  IsolatedMemoryError,
  IsolatedTimeoutError,
  LIMITS,
  runIsolated,
} from './isolated.js';

const FIXTURE = new URL(import.meta.url.replace(/isolated\.test\.(ts|js)$/, 'isolated.fixture.$1'));

describe('runIsolated', () => {
  it('작업 스레드에서 함수를 불러 결과를 돌려준다', async () => {
    await expect(runIsolated<number>(FIXTURE, 'add', [2, 3], { timeoutMs: 20_000 })).resolves.toBe(5);
  }, 30_000);

  it('Buffer 인자는 Uint8Array 로 건너간다(받는 쪽이 되돌린다)', async () => {
    const info = await runIsolated<{ isBuffer: boolean; length: number; first: number }>(
      FIXTURE,
      'bytesInfo',
      [Buffer.from([7, 8, 9])],
      { timeoutMs: 20_000 },
    );
    expect(info).toEqual({ isBuffer: false, length: 3, first: 7 });
  }, 30_000);

  it('작업 스레드의 오류는 이름과 메시지가 그대로 오고, 되살리는 함수가 있으면 그 종류로 바뀐다', async () => {
    await expect(runIsolated(FIXTURE, 'fail', ['손상 파일'], { timeoutMs: 20_000 })).rejects.toMatchObject({
      name: 'FixtureError',
      message: '손상 파일',
    });
    class Revived extends Error {}
    await expect(
      runIsolated(FIXTURE, 'fail', ['손상 파일'], { timeoutMs: 20_000 }, (e) =>
        e.name === 'FixtureError' ? new Revived(e.message) : undefined,
      ),
    ).rejects.toBeInstanceOf(Revived);
  }, 30_000);

  it('시간 상한을 넘기면 스레드를 끝내고, 그동안 주 스레드는 멈추지 않는다', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    const started = performance.now();
    try {
      await expect(runIsolated(FIXTURE, 'spin', [60_000], { timeoutMs: 1_500 })).rejects.toBeInstanceOf(IsolatedTimeoutError);
    } finally {
      clearInterval(timer);
    }
    // 상한(1.5초) 근처에서 끝난다: 60초를 다 돌지 않는다. 스레드를 띄우는 시간까지 넉넉히 본다
    expect(performance.now() - started).toBeLessThan(15_000);
    // 작업 스레드가 CPU 를 붙잡는 동안에도 주 스레드의 20ms 타이머가 여러 번 돌았다
    expect(ticks).toBeGreaterThan(20);
  }, 30_000);

  it('메모리 상한을 넘기면 스레드만 끝나고 IsolatedMemoryError', async () => {
    await expect(
      runIsolated(FIXTURE, 'hog', [], { timeoutMs: 60_000, maxOldGenerationSizeMb: 64 }),
    ).rejects.toBeInstanceOf(IsolatedMemoryError);
  }, 90_000);

  it('스레드는 다시 쓰고, 시간 상한에 걸린 스레드는 버리고 새로 띄운다', async () => {
    const opts = { timeoutMs: 20_000 };
    const a = await runIsolated<number>(FIXTURE, 'threadNo', [], opts);
    const b = await runIsolated<number>(FIXTURE, 'threadNo', [], opts);
    expect(b).toBe(a); // 해석 모듈을 다시 읽지 않도록 같은 스레드에서
    await expect(runIsolated(FIXTURE, 'spin', [60_000], { timeoutMs: 500 })).rejects.toBeInstanceOf(IsolatedTimeoutError);
    // 오류로 끝난 작업 뒤에도 쓸 수 있다
    await expect(runIsolated(FIXTURE, 'fail', ['x'], opts)).rejects.toMatchObject({ name: 'FixtureError' });
    await expect(runIsolated<number>(FIXTURE, 'add', [1, 1], opts)).resolves.toBe(2);
  }, 60_000);

  it('동시에 여러 작업을 맡겨도 모두 끝난다(스레드는 2개까지, 나머지는 기다린다)', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => runIsolated<number>(FIXTURE, 'add', [i, 10], { timeoutMs: 20_000 })),
    );
    expect(results).toEqual([10, 11, 12, 13, 14]);
  }, 60_000);
});

describe('기다리는 줄 상한', () => {
  /** 쉬는 스레드를 닫고 상한을 잠깐 바꿔 fn 을 돌린 뒤 되돌린다 */
  async function withLimits(over: Partial<typeof LIMITS>, fn: () => Promise<void>): Promise<void> {
    const saved = { ...LIMITS };
    closeIdleWorkers();
    Object.assign(LIMITS, over);
    try {
      await fn();
    } finally {
      Object.assign(LIMITS, saved);
    }
  }

  it('스레드가 모두 바쁘고 줄(개수)이 가득 차면 바로 IsolatedBusyError, 줄에 선 작업은 자리가 나면 끝난다', async () => {
    await withLimits({ maxWorkers: 1, maxWaiting: 1 }, async () => {
      const busy = runIsolated<number>(FIXTURE, 'spin', [1_500], { timeoutMs: 20_000 });
      const queued = runIsolated<number>(FIXTURE, 'add', [1, 2], { timeoutMs: 20_000 });
      await expect(runIsolated(FIXTURE, 'add', [3, 4], { timeoutMs: 20_000 })).rejects.toBeInstanceOf(IsolatedBusyError);
      await expect(queued).resolves.toBe(3);
      await busy;
    });
  }, 60_000);

  it('기다리는 작업들의 바이트 합이 상한을 넘으면 IsolatedBusyError, 상한 안이면 줄에 선다', async () => {
    await withLimits({ maxWorkers: 1, maxWaitingBytes: 10 }, async () => {
      const busy = runIsolated<number>(FIXTURE, 'spin', [1_000], { timeoutMs: 20_000 });
      await expect(runIsolated(FIXTURE, 'bytesInfo', [Buffer.alloc(11)], { timeoutMs: 20_000 })).rejects.toBeInstanceOf(
        IsolatedBusyError,
      );
      await expect(runIsolated(FIXTURE, 'bytesInfo', [Buffer.alloc(10, 1)], { timeoutMs: 20_000 })).resolves.toMatchObject({
        length: 10,
        first: 1,
      });
      await busy;
    });
  }, 60_000);

  it('줄에서 queueWaitMs 안에 자리가 나지 않으면 IsolatedBusyError (시간 상한은 자리를 얻은 뒤부터 잰다)', async () => {
    await withLimits({ maxWorkers: 1, queueWaitMs: 300 }, async () => {
      const busy = runIsolated<number>(FIXTURE, 'spin', [3_000], { timeoutMs: 20_000 });
      const started = performance.now();
      await expect(runIsolated(FIXTURE, 'add', [1, 1], { timeoutMs: 20_000 })).rejects.toBeInstanceOf(IsolatedBusyError);
      expect(performance.now() - started).toBeLessThan(2_500);
      await busy;
    });
  }, 60_000);
});
