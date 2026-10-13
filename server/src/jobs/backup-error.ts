/**
 * 백업을 만들지 못한 이유 가운데 관리자가 알아야 하는 것(ZIP 형식 한계, 저장 공간 부족 등).
 * 메시지는 그대로 화면에 보이므로 사용자용 한국어 문장으로 쓴다(routes/admin.ts 가 500 과 함께 details 로 보낸다).
 */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}
