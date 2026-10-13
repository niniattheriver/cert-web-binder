/**
 * 판본 렌더 모델 캐시: GET /api/docs/versions/:vid/render 를 판본당 한 번만 받는다
 *
 * - 모듈 수준 Promise 캐시라 뷰어가 다시 붙어도(문항 상세의 근거 교체, 판본 전환 후 복귀) 다시 받지 않는다.
 *   렌더 모델은 판본에 묶여 불변이므로(model.ts 머리말) 무효화가 필요 없다.
 * - 최근에 쓴 순서로 6개까지 둔다(LRU). 실패한 Promise 는 지워 다음 호출이 다시 시도한다.
 * - 응답 모양을 가볍게 확인해 RenderModel 로 좁힌다(kind, pages). 모르는 kind 는 오류로 돌려준다.
 */
import { fetchVersionRender } from '../api';
import type { RenderModel } from './model';

const CACHE_MAX = 6;
const cache = new Map<number, Promise<RenderModel>>();

const KINDS = new Set<RenderModel['kind']>(['flow', 'sheet', 'slides', 'plain']);

/** 서버 응답 → RenderModel (모양이 다르면 오류) */
export function asRenderModel(raw: unknown): RenderModel {
  if (!raw || typeof raw !== 'object') throw new Error('화면용 데이터가 비어 있습니다.');
  const obj = raw as { kind?: unknown; pages?: unknown; media?: unknown };
  if (typeof obj.kind !== 'string' || !KINDS.has(obj.kind as RenderModel['kind'])) {
    throw new Error(`알 수 없는 화면용 데이터 형식입니다(${String(obj.kind)}).`);
  }
  if (!Array.isArray(obj.pages)) throw new Error('화면용 데이터에 쪽 목록이 없습니다.');
  if (obj.media !== undefined && !Array.isArray(obj.media)) {
    throw new Error('화면용 데이터의 그림 목록이 올바르지 않습니다.');
  }
  return raw as RenderModel;
}

/** 판본 렌더 모델 (캐시) */
export function loadRenderModel(versionId: number): Promise<RenderModel> {
  const hit = cache.get(versionId);
  if (hit) {
    // 최근 사용으로 옮긴다
    cache.delete(versionId);
    cache.set(versionId, hit);
    return hit;
  }
  const p = fetchVersionRender(versionId).then(asRenderModel);
  cache.set(versionId, p);
  p.catch(() => {
    if (cache.get(versionId) === p) cache.delete(versionId);
  });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return p;
}

/** 캐시 비우기 (시험용) */
export function clearRenderCache(): void {
  cache.clear();
}
