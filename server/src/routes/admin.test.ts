// 백업 실패 이유: 알려진 원인(ZIP 형식 한계, 저장 공간, 쓰기 권한)은 관리자에게 그대로, 그 밖은 공통 오류 처리로
import { describe, expect, it } from 'vitest';
import { BackupError } from '../jobs/backup-error.js';
import { backupFailureMessage } from './admin.js';

describe('backupFailureMessage', () => {
  it('BackupError 는 메시지를 그대로 보인다', () => {
    const msg = '전체 백업이 ZIP 형식 한계(4GB)를 넘어 만들 수 없습니다. data 폴더 복사 방식을 사용하세요.';
    expect(backupFailureMessage(new BackupError(msg))).toBe(msg);
  });

  it('저장 공간 부족(ENOSPC, SQLITE_FULL)과 쓰기 권한(EACCES, EPERM)은 이유를 알린다', () => {
    for (const code of ['ENOSPC', 'SQLITE_FULL']) {
      expect(backupFailureMessage(Object.assign(new Error('x'), { code }))).toContain('저장 공간이 부족해');
    }
    for (const code of ['EACCES', 'EPERM']) {
      expect(backupFailureMessage(Object.assign(new Error('x'), { code }))).toContain('쓸 권한이 없어');
    }
  });

  it('모르는 오류는 null: 공통 오류 처리가 서버 창에 원문을 남기고 일반 문구로 답한다', () => {
    expect(backupFailureMessage(new Error('예상 못 한 오류'))).toBeNull();
    expect(backupFailureMessage(null)).toBeNull();
  });
});
