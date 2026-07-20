/**
 * 채점 위젯 (설계서 §4 채점 위젯, R3 — 임무 D 소유)
 * - 라디오 예/아니오/해당없음(allow_na=1 문항만 노출), "배점: N" 상시 표시.
 * - 예 → 0.5 스텝 점수 스테퍼(0~배점 클램프). 아니오 → 0 자동·입력 비활성.
 *   해당없음 → 점수 없음(집계 분모 제외).
 * - 예 최초 선택 시 배점 만점 자동 채움 + 미확정 표시(흐림+'자동' 배지) — 사용자가 점수를
 *   만지거나 배지를 클릭하면 확정 (v1.5 Phase 2 A-7. 임포트 경로에선 발동하지 않음 — UI 전용).
 * - 표시는 프리젠테이션 전용 — 자동 저장(디바운스 600ms)·409/400 처리는 부모(QuestionDetail)가 담당.
 */
import type { AnswerChoice } from '../api';
import { fmtNum } from '../util';

export interface ScoreWidgetProps {
  maxScore: number | null;
  allowNa: boolean;
  choice: AnswerChoice | null;
  score: number | null;
  /** 예→만점 자동 채움 후 미확인 상태 */
  autofilled?: boolean;
  disabled?: boolean;
  /** 부모의 저장 상태 표시줄 ("저장 중…", "저장됨 10:32" 등) */
  statusText?: string | null;
  /** 서버 400 검증 메시지 등 오류 표시 */
  errorText?: string | null;
  onChange: (choice: AnswerChoice | null, score: number | null, autofilled: boolean) => void;
}

function clampStep(v: number, max: number): number {
  const stepped = Math.round(v * 2) / 2; // 0.5 간격
  return Math.min(max, Math.max(0, stepped));
}

const CHOICES: { value: AnswerChoice; label: string }[] = [
  { value: 'yes', label: '예' },
  { value: 'no', label: '아니오' },
  { value: 'na', label: '해당없음' },
];

export default function ScoreWidget({
  maxScore,
  allowNa,
  choice,
  score,
  autofilled,
  disabled,
  statusText,
  errorText,
  onChange,
}: ScoreWidgetProps) {
  const max = maxScore ?? 0;
  const choices = allowNa ? CHOICES : CHOICES.filter((c) => c.value !== 'na');

  const setChoice = (next: AnswerChoice) => {
    if (disabled) return;
    if (next === choice) return;
    if (next === 'no') onChange('no', 0, false);
    else if (next === 'na') onChange('na', null, false);
    else {
      // '아니오'의 0점은 서버 강제값이지 사용자가 매긴 점수가 아님 — 승계하지 않는다 (검토 반영)
      const prior = choice === 'no' ? null : score;
      if (prior != null) onChange('yes', clampStep(prior, max), false);
      else if (maxScore != null)
        onChange('yes', max, true); // 예 최초 선택 → 배점 만점 자동 채움(미확정)
      else onChange('yes', null, false);
    }
  };

  const stepperEnabled = !disabled && choice === 'yes' && maxScore != null;

  const bump = (delta: number) => {
    if (!stepperEnabled) return;
    onChange('yes', clampStep((score ?? 0) + delta, max), false); // 만지면 확정
  };

  const onDirectInput = (raw: string) => {
    if (!stepperEnabled) return;
    if (raw.trim() === '') {
      onChange('yes', null, false); // 미채점으로 되돌림
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange('yes', clampStep(n, max), false); // 만지면 확정
  };

  const showAutofill = choice === 'yes' && autofilled === true;

  const scoreShown = choice === 'no' ? 0 : score;

  return (
    <div className="score-widget">
      <div className="score-row">
        <div className="score-radios" role="radiogroup" aria-label="채점 선택">
          {choices.map((c) => (
            <label
              key={c.value}
              className={
                'score-radio' +
                (choice === c.value ? ' is-on' : '') +
                (disabled ? ' is-disabled' : '')
              }
            >
              <input
                type="radio"
                name="score-choice"
                value={c.value}
                checked={choice === c.value}
                disabled={disabled}
                onChange={() => setChoice(c.value)}
              />
              {c.label}
            </label>
          ))}
        </div>

        <div className="score-stepper">
          <button
            type="button"
            className="btn score-step-btn"
            disabled={!stepperEnabled || (scoreShown ?? 0) <= 0}
            onClick={() => bump(-0.5)}
            aria-label="0.5점 내리기"
          >
            −0.5
          </button>
          <input
            className={'score-input' + (showAutofill ? ' is-autofilled' : '')}
            type="number"
            inputMode="decimal"
            step={0.5}
            min={0}
            max={max}
            value={scoreShown ?? ''}
            placeholder={choice === 'yes' ? '미채점' : '—'}
            disabled={!stepperEnabled}
            onChange={(e) => onDirectInput(e.target.value)}
            aria-label="점수"
          />
          <button
            type="button"
            className="btn score-step-btn"
            disabled={!stepperEnabled || (scoreShown ?? 0) >= max}
            onClick={() => bump(0.5)}
            aria-label="0.5점 올리기"
          >
            +0.5
          </button>
          <span className="score-max">배점: {maxScore != null ? fmtNum(maxScore) : '—'}</span>
          {showAutofill && !disabled && (
            <button
              type="button"
              className="score-autofill-badge"
              onClick={() => onChange('yes', score, false)}
              title="예 선택 시 만점이 자동 입력됐습니다. 클릭하면 이 점수로 확정합니다."
            >
              자동 · 클릭해 확정
            </button>
          )}
          {choice === 'na' && <span className="dim score-na-note">집계 분모에서 제외됩니다</span>}
        </div>
      </div>

      {(statusText || errorText) && (
        <div className="score-status-row">
          {errorText ? (
            <span className="save-status is-error">{errorText}</span>
          ) : (
            <span className="save-status">{statusText}</span>
          )}
        </div>
      )}
    </div>
  );
}
