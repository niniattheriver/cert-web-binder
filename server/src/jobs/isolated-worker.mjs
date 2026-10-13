/**
 * runIsolated(isolated.ts)의 작업 스레드 쪽: 작업({id, 모듈 주소, 함수 이름, 인자})을 하나씩 받아 그 함수를 부르고
 * 결과나 오류({이름, 메시지})를 같은 id 로 돌려준다. 모듈은 한 번 읽으면 스레드가 살아 있는 동안 다시 쓴다.
 * 모듈 주소와 함수 이름은 서버 코드가 정한 값만 온다(사용자 입력이 아니다).
 *
 * 이 입구는 일반 JavaScript 다: 작업 스레드는 주 프로세스의 tsx 로더(--import tsx)를 물려받지 않으므로,
 * 여기서 tsx 를 직접 등록한 뒤 TypeScript 모듈을 읽는다(서버 코드의 './x.js' import 를 x.ts 로 찾는 것도 tsx 몫이다).
 */
import { register } from 'tsx/esm/api';
import { parentPort } from 'node:worker_threads';

register();

parentPort.on('message', async ({ id, moduleUrl, exportName, args }) => {
  try {
    const mod = await import(moduleUrl);
    const fn = mod[exportName];
    if (typeof fn !== 'function') throw new Error(`작업 스레드에서 부를 함수가 없습니다: ${exportName}`);
    const result = await fn(...args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    parentPort.postMessage({ id, ok: false, error: { name: err.name, message: err.message } });
  }
});
