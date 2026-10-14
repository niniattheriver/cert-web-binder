// 작업 스레드 상한 오류 → 사용자용 OfficeLimitError (라우트에서 400, 첨부 미리보기는 예전 방식으로 다시 읽지 않음)
import { describe, expect, it } from 'vitest';
import { IsolatedBusyError, IsolatedMemoryError, IsolatedTimeoutError } from '../jobs/isolated.js';
import { OfficeLimitError, OfficeParseError } from './errors.js';
import { toOfficeLimit } from './index.js';

describe('toOfficeLimit', () => {
  it('시간, 메모리, 대기 줄 오류는 종류를 단 OfficeLimitError(OfficeParseError 의 한 종류)로 바꾼다', () => {
    const cases = [
      [new IsolatedTimeoutError(120_000), 'timeout'],
      [new IsolatedMemoryError(), 'memory'],
      [new IsolatedBusyError(), 'busy'],
    ] as const;
    for (const [e, limit] of cases) {
      const r = toOfficeLimit(e);
      expect(r).toBeInstanceOf(OfficeLimitError);
      expect(r).toBeInstanceOf(OfficeParseError);
      expect(r?.limit).toBe(limit);
    }
    expect(toOfficeLimit(new IsolatedBusyError())?.message).toContain('잠시 뒤 다시 올려 주세요');
  });

  it('다른 오류(손상 파일 등)는 null: 미리보기가 예전 방식으로 넘어갈 수 있게', () => {
    expect(toOfficeLimit(new Error('x'))).toBeNull();
    expect(toOfficeLimit(new OfficeParseError('손상'))).toBeNull();
  });
});
