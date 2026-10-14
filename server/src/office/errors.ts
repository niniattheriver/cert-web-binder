/**
 * Office 해석 오류
 *
 * 형식은 맞는데(판별 통과) 내용을 읽지 못한 경우. 라우트가 400 'invalid_office' 로 바꿔
 * message 를 그대로 사용자에게 보여준다. 그래서 message 는 사용자용 한국어 문장으로 쓴다.
 */
export class OfficeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeParseError';
  }
}

/**
 * 해석 상한 초과(시간, 메모리, 작업 스레드 대기 줄). 라우트에는 OfficeParseError 와 같이 400 으로 보인다.
 * 첨부 미리보기는 이 오류면 예전 방식으로 다시 해석하지 않는다(같은 파일을 주 스레드에서 다시 읽지 않게).
 */
export class OfficeLimitError extends OfficeParseError {
  constructor(
    message: string,
    /** 어느 상한인가: 시간, 메모리, 작업 스레드 대기 줄 (미리보기는 종류별로 안내를 따로 쓴다) */
    readonly limit: 'timeout' | 'memory' | 'busy',
  ) {
    super(message);
    this.name = 'OfficeLimitError';
  }
}
