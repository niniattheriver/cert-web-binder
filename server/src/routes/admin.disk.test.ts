// 디스크 게이지 가드 — Docker bind mount 등이 반환하는 비상식 statfs 값은 null(화면 "확인 불가").
import { describe, expect, it } from 'vitest';
import { computeDiskUsage } from './admin.js';

const GiB = 1024 * 1024 * 1024;

describe('computeDiskUsage', () => {
  it('정상 값은 총량·여유·사용률을 계산한다', () => {
    // 500GB 중 200GB 여유 (bsize 4096)
    const r = computeDiskUsage({ blocks: (500 * GiB) / 4096, bsize: 4096, bavail: (200 * GiB) / 4096 });
    expect(r).not.toBeNull();
    expect(r!.totalBytes).toBe(500 * GiB);
    expect(r!.freeBytes).toBe(200 * GiB);
    expect(r!.usedPct).toBe(60);
  });

  it('총량이 0 이하이면 null', () => {
    expect(computeDiskUsage({ blocks: 0, bsize: 4096, bavail: 0 })).toBeNull();
    expect(computeDiskUsage({ blocks: -1, bsize: 4096, bavail: 0 })).toBeNull();
  });

  it('여유가 음수이거나 총량보다 크면 null', () => {
    expect(computeDiskUsage({ blocks: 100, bsize: 4096, bavail: -5 })).toBeNull();
    expect(computeDiskUsage({ blocks: 100, bsize: 4096, bavail: 200 })).toBeNull();
  });

  it('총량이 64TiB를 넘는 허위값(Docker bind mount 실측 ~70TB)은 null', () => {
    const fakeTotal = 70 * 1024 * GiB; // 70TiB
    expect(
      computeDiskUsage({ blocks: fakeTotal / 4096, bsize: 4096, bavail: (fakeTotal / 4096) * 0.9 }),
    ).toBeNull();
  });
});
