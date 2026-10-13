/**
 * 무거운 해석을 작업 스레드(worker_threads)에서 돌린다 — 업로드한 Office, 텍스트 파일 해석과 첨부 미리보기
 * (office/index.ts, files/preview.ts)
 *
 * - 해석이 오래 걸리거나 메모리를 많이 써도 서버의 다른 요청(화면, 검색, 저장)은 멈추지 않는다.
 * - 시간 상한(timeoutMs)을 넘기면 그 스레드를 끝내고 IsolatedTimeoutError, 메모리 상한을 넘기면 IsolatedMemoryError.
 *   해석기 안의 예상 못 한 반복(손상 파일, 꾸민 파일)이나 메모리 폭증도 서버 전체를 멈추거나 죽이지 못한다.
 * - 스레드는 띄워 둔 채 다시 쓴다(해석 모듈을 매번 새로 읽으면 작은 xlsx 도 1초씩 걸린다). 동시에 도는 스레드는
 *   LIMITS.maxWorkers 개. 한동안(IDLE_MS) 쓰지 않거나 MAX_TASKS_PER_WORKER 건을 맡은 스레드는 닫아 메모리를 돌려준다.
 * - 스레드가 모두 바쁘면 기다리는 줄에 선다. 줄에는 개수(LIMITS.maxWaiting)와 기다리는 파일 크기 합(LIMITS.maxWaitingBytes)
 *   상한이 있고, LIMITS.queueWaitMs 안에 자리가 나지 않으면 IsolatedBusyError 로 끝난다(기다리는 동안 업로드 원본을
 *   주 프로세스 메모리에 끝없이 쌓아 두지 않게). 시간 상한은 자리를 얻은 뒤부터 잰다.
 * - 스레드 입구(isolated-worker.mjs)가 TypeScript 로더(tsx)를 직접 등록하고 모듈을 읽는다. 부를 모듈과 함수는 서버 코드가 정한다.
 * - 인자와 결과는 구조화 복제로 건너간다: Buffer 는 Uint8Array 로 도착하므로 받는 쪽이 되돌린다.
 */
import { Worker } from 'node:worker_threads';

export class IsolatedTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`작업 스레드가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`);
    this.name = 'IsolatedTimeoutError';
  }
}

export class IsolatedMemoryError extends Error {
  constructor() {
    super('작업 스레드가 메모리 상한을 넘어 멈췄습니다.');
    this.name = 'IsolatedMemoryError';
  }
}

export class IsolatedBusyError extends Error {
  constructor() {
    super('작업 스레드가 모두 바쁘고 기다리는 줄도 가득 찼습니다.');
    this.name = 'IsolatedBusyError';
  }
}

export interface IsolatedOptions {
  /** 자리를 얻은 뒤 이 시간이 지나면 그 스레드를 끝낸다 */
  timeoutMs: number;
  /** 작업 스레드 V8 힙(old space) 상한, MB. 없으면 Node 기본값. 상한마다 따로 스레드를 띄운다 */
  maxOldGenerationSizeMb?: number;
}

/** 작업 스레드가 돌려준 오류({이름, 메시지})를 같은 종류의 오류로 되살린다. 모르는 이름이면 undefined */
export type ErrorReviver = (e: { name: string; message: string }) => Error | undefined;

/** 스케줄러 상한 (시험이 잠깐 바꿔 볼 수 있게 객체로 둔다) */
export const LIMITS = {
  /** 동시에 도는 작업 스레드 수 (스레드마다 메모리 상한까지 쓸 수 있어 적게 둔다) */
  maxWorkers: 2,
  /** 기다리는 작업 수 */
  maxWaiting: 16,
  /** 기다리는 작업들이 들고 있는 바이트(인자의 Buffer, Uint8Array) 합 */
  maxWaitingBytes: 512 * 1024 * 1024,
  /** 자리를 기다리는 시간 */
  queueWaitMs: 120_000,
};
/** 쓰지 않는 스레드를 닫기까지 */
const IDLE_MS = 60_000;
/** 스레드 하나가 맡을 작업 수 (해석기에 메모리가 조금씩 남더라도 쌓이지 않게) */
const MAX_TASKS_PER_WORKER = 200;

const WORKER_URL = new URL('./isolated-worker.mjs', import.meta.url);

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { name: string; message: string } };

interface Slot {
  worker: Worker;
  heapMb: number | undefined;
  busy: boolean;
  tasks: number;
  idleTimer: NodeJS.Timeout | null;
  /** 지금 맡은 작업이 끝날 때 부르는 함수 (메시지, 오류, 종료 가운데 먼저 온 것) */
  settle: ((r: { reply?: Reply; error?: Error }) => void) | null;
}

interface Waiter {
  wake: () => void;
  bytes: number;
}

const slots: Slot[] = [];
const waiting: Waiter[] = [];
let waitingBytes = 0;
let nextId = 1;

/**
 * 작업 스레드에 물려줄 실행 옵션: 로더(--import, --require, --loader)와 디버거 옵션은 뺀다.
 * TypeScript 로더는 스레드 입구가 직접 등록한다(물려받아 두 번 등록되지 않게).
 */
function workerExecArgv(): string[] {
  const out: string[] = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (/^--(import|require|loader|experimental-loader)$/.test(a) || a === '-r') {
      i += 1; // 다음 값까지 뺀다
      continue;
    }
    if (/^--(import|require|loader|experimental-loader)=/.test(a) || a.startsWith('--inspect')) continue;
    out.push(a);
  }
  return out;
}

/** 기다리는 작업 하나를 깨운다(깨어난 작업이 자리를 다시 찾는다) */
function wakeOne(): void {
  waiting[0]?.wake();
}

function removeWaiter(w: Waiter): void {
  const i = waiting.indexOf(w);
  if (i >= 0) {
    waiting.splice(i, 1);
    waitingBytes -= w.bytes;
  }
}

function removeSlot(slot: Slot): void {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = null;
  void slot.worker.terminate();
  wakeOne(); // 자리가 났다
}

function spawnSlot(heapMb: number | undefined): Slot {
  const worker = new Worker(WORKER_URL, {
    execArgv: workerExecArgv(),
    ...(heapMb ? { resourceLimits: { maxOldGenerationSizeMb: heapMb } } : {}),
  });
  worker.unref(); // 쉬는 스레드 때문에 프로세스(명령행 도구, 시험)가 끝나지 못하는 일이 없게
  const slot: Slot = { worker, heapMb, busy: false, tasks: 0, idleTimer: null, settle: null };
  worker.on('message', (reply: Reply) => slot.settle?.({ reply }));
  worker.on('error', (err: Error & { code?: string }) => {
    const e = err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new IsolatedMemoryError() : err;
    if (slot.settle) slot.settle({ error: e });
    else removeSlot(slot);
  });
  worker.on('exit', (code) => {
    if (slot.settle) slot.settle({ error: new Error(`작업 스레드가 결과 없이 끝났습니다(종료 코드 ${code}).`) });
    else if (slots.includes(slot)) removeSlot(slot);
  });
  slots.push(slot);
  return slot;
}

/** 이 메모리 상한의 쉬는 스레드를 고르거나 자리가 있으면 새로 띄운다. 자리가 없으면 null */
function tryTake(heapMb: number | undefined): Slot | null {
  const idle = slots.find((s) => !s.busy && s.heapMb === heapMb);
  if (idle) {
    if (idle.idleTimer) clearTimeout(idle.idleTimer);
    idle.idleTimer = null;
    idle.busy = true;
    return idle;
  }
  if (slots.length >= LIMITS.maxWorkers) {
    // 다른 상한의 쉬는 스레드가 자리를 차지하고 있으면 닫고 그 자리에 띄운다
    const other = slots.find((s) => !s.busy);
    if (!other) return null;
    const i = slots.indexOf(other);
    if (i >= 0) slots.splice(i, 1);
    if (other.idleTimer) clearTimeout(other.idleTimer);
    void other.worker.terminate();
  }
  const s = spawnSlot(heapMb);
  s.busy = true;
  return s;
}

/** 자리를 얻는다. 모두 바쁘면 기다리는 줄에 서고, 줄이 가득 찼거나 너무 오래 기다리면 IsolatedBusyError */
async function acquire(heapMb: number | undefined, bytes: number): Promise<Slot> {
  for (;;) {
    const slot = tryTake(heapMb);
    if (slot) return slot;
    if (waiting.length >= LIMITS.maxWaiting || waitingBytes + bytes > LIMITS.maxWaitingBytes) throw new IsolatedBusyError();
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        bytes,
        wake: () => {
          clearTimeout(timer);
          removeWaiter(w);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        removeWaiter(w);
        reject(new IsolatedBusyError());
      }, LIMITS.queueWaitMs);
      waiting.push(w);
      waitingBytes += bytes;
    });
  }
}

/** 쉬는 스레드를 모두 닫는다 (시험이 깨끗한 상태에서 시작하게. 일하는 스레드는 그대로 둔다) */
export function closeIdleWorkers(): void {
  for (const s of slots.filter((x) => !x.busy)) removeSlot(s);
}

function releaseIdle(slot: Slot): void {
  slot.busy = false;
  slot.settle = null;
  if (slot.tasks >= MAX_TASKS_PER_WORKER) {
    removeSlot(slot);
    return;
  }
  slot.idleTimer = setTimeout(() => removeSlot(slot), IDLE_MS);
  slot.idleTimer.unref();
  wakeOne();
}

/** 인자 가운데 바이트 배열(Buffer, Uint8Array 등)의 크기 합 */
function argBytes(args: unknown[]): number {
  let n = 0;
  for (const a of args) if (ArrayBuffer.isView(a)) n += a.byteLength;
  return n;
}

/** moduleUrl 모듈의 exportName 함수를 작업 스레드에서 args 로 불러 결과를 돌려준다 */
export async function runIsolated<T>(
  moduleUrl: URL,
  exportName: string,
  args: unknown[],
  opts: IsolatedOptions,
  revive?: ErrorReviver,
): Promise<T> {
  const slot = await acquire(opts.maxOldGenerationSizeMb, argBytes(args));
  const id = nextId++;
  slot.tasks += 1;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // 끝나지 않는 해석: 그 스레드를 끝낸다(다음 작업은 새 스레드에서)
      slot.settle = null;
      removeSlot(slot);
      reject(new IsolatedTimeoutError(opts.timeoutMs));
    }, opts.timeoutMs);
    slot.settle = ({ reply, error }) => {
      if (reply && reply.id !== id) return; // 앞 작업의 늦은 답 (끝낸 스레드라면 오지 않는다)
      clearTimeout(timer);
      if (error) {
        slot.settle = null;
        removeSlot(slot);
        reject(error);
        return;
      }
      releaseIdle(slot);
      if (reply!.ok) resolve(reply!.result as T);
      else reject(revive?.(reply!.error) ?? Object.assign(new Error(reply!.error.message), { name: reply!.error.name }));
    };
    slot.worker.postMessage({ id, moduleUrl: moduleUrl.href, exportName, args });
  });
}
