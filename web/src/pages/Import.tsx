/**
 * 가져오기 — 문항 PDF (설계서 §4 #10, §6.2 Day 1 범위: 파서 + 드라이런 + 커밋)
 * 흐름: 연도 선택 + 다중 PDF 선택 → 미리보기 업로드 → 파일별 아코디언 미리보기 → 모드 선택
 *   → 가져오기 실행 → 결과 요약.
 * 연도별 관리: '가져올 연도'를 골라 그 해의 심사로 인입한다.
 *   새 연도를 처음 시작할 때는 지난 연도의 서술 답변·근거 연결을 물려받을 수 있다(예/아니오 선택·점수는 새로 시작).
 *   연도·이월 여부는 미리보기 업로드 시점에 확정된다.
 * viewer 역할은 접근 차단 안내.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  commitQuestionPdfImport,
  fetchBootstrap,
  importQuestionPdfsDryRun,
  type BootstrapResponse,
  type ImportCommitResponse,
  type ImportDryRunResponse,
  type ImportMode,
} from '../api';
import { useAuth } from '../auth';
import { errorMessage, fmtNum, truthy } from '../util';

const PREVIEW_ROWS = 10;
const YEAR_FROM = 2026;
const YEAR_TO = 2036;

export default function ImportPage() {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [search] = useSearchParams();

  // ?year= (연도 대시보드에서 진입) — 유효 범위 밖이면 무시
  const urlYearRaw = Number(search.get('year'));
  const urlYear =
    Number.isInteger(urlYearRaw) && urlYearRaw >= 2000 && urlYearRaw <= 2100 ? urlYearRaw : null;

  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [bootFailed, setBootFailed] = useState(false);
  /** 사용자가 고른 연도 — null 이면 기본값(URL → 현재 주기 연도 → 올해) 사용 */
  const [yearSel, setYearSel] = useState<number | null>(urlYear);
  const [carryChecked, setCarryChecked] = useState(true);

  const [files, setFiles] = useState<File[]>([]);
  const [dryRun, setDryRun] = useState<ImportDryRunResponse | null>(null);
  const [mode, setMode] = useState<ImportMode>('keep_existing');
  const [result, setResult] = useState<ImportCommitResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 연도 기본값·이월 판단용 주기 리스트 — 불러오기 전에는 미리보기를 시작하지 않는다
  // (연도 기본값·물려받기 판단이 항상 실제 연도 목록을 본 상태에서 확정되도록)
  const loadBoot = () => {
    setBootFailed(false);
    fetchBootstrap()
      .then(setBoot)
      .catch(() => setBootFailed(true));
  };
  useEffect(() => {
    loadBoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // viewer 접근 차단 (서버도 403으로 거부하지만 화면에서 먼저 안내)
  if (user?.role === 'viewer') {
    return (
      <div className="page page-narrow">
        <div className="card">
          <h1 className="card-title">가져오기</h1>
          <p>열람 전용 계정은 가져오기를 사용할 수 없습니다. 담당자(편집 권한)에게 요청하세요.</p>
          <Link to="/" className="btn">
            연도 목록으로
          </Link>
        </div>
      </div>
    );
  }

  const year = yearSel ?? urlYear ?? boot?.activeCycle?.year ?? new Date().getFullYear();
  const yearOptions: number[] = [];
  for (let y = YEAR_FROM; y <= YEAR_TO; y += 1) yearOptions.push(y);
  if (!yearOptions.includes(year)) {
    yearOptions.push(year);
    yearOptions.sort((a, b) => a - b);
  }

  const cycles = boot?.cycles ?? [];
  const hasOlderData = cycles.some(
    (c) => c.year != null && c.year < year && c.questionCount > 0,
  );
  // 물려받기 체크박스: 데이터가 있는 더 이전 연도가 있으면 항상 보여 준다.
  // (이미 시작한 연도에 다시 올릴 때도 새로 생기는 문항은 물려받을 수 있으므로 숨기지 않는다)
  // 물려받을 연도가 아예 없으면 숨기고 기본값(켬)으로 보낸다 — 서버가 알아서 건너뜀.
  const showCarry = hasOlderData;
  const carry = showCarry ? carryChecked : true;

  const onFilesChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFiles(Array.from(e.target.files ?? []));
    setError(null);
  };

  const reset = () => {
    setFiles([]);
    setDryRun(null);
    setResult(null);
    setError(null);
    setMode('keep_existing');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const runDryRun = async () => {
    if (files.length === 0) {
      setError('업로드할 문항 PDF를 선택하세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await importQuestionPdfsDryRun(files, { year, carry });
      setDryRun(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const runCommit = async () => {
    if (!dryRun) return;
    setBusy(true);
    setError(null);
    try {
      const r = await commitQuestionPdfImport(dryRun.batchId, mode);
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // ── 3단계: 완료 ──
  if (result) {
    const doneYear = dryRun?.targetYear ?? year;
    return (
      <div className="page page-narrow">
        <h1>가져오기 완료</h1>
        <div className="card">
          <div className="result-grid">
            <div className="result-cell">
              <div className="result-num">{result.created}</div>
              <div className="result-label">생성</div>
            </div>
            <div className="result-cell">
              <div className="result-num">{result.updated}</div>
              <div className="result-label">갱신</div>
            </div>
            <div className="result-cell">
              <div className="result-num">{result.unchanged}</div>
              <div className="result-label">변동 없음</div>
            </div>
            <div className="result-cell">
              <div className="result-num">{result.categoriesCreated}</div>
              <div className="result-label">분야 생성</div>
            </div>
          </div>
          {(result.carriedQuestions ?? 0) > 0 && (
            <p className="dim">
              물려받음: 답변 {result.carriedAnswers ?? 0}건 · 근거 연결{' '}
              {result.carriedEvidence ?? 0}건
            </p>
          )}
          {result.protectedDiffs?.length > 0 && (
            <div className="warn-list">
              보호 필드 차이 {result.protectedDiffs.length}건 — 덮어쓰지 않고 '재확인'으로
              표시했습니다 ('확인 필요' 메뉴에서 확인).
            </div>
          )}
          {(result.criteriaApplied > 0 ||
            result.criteriaManual?.length > 0 ||
            result.criteriaViolations?.length > 0) && (
            <p className="dim">
              세부항목표: 자동 등록 {result.criteriaApplied ?? 0}건 · 직접 전환 필요{' '}
              {result.criteriaManual?.length ?? 0}건 · 계약 위반{' '}
              {result.criteriaViolations?.length ?? 0}건 (재확인 표시됨)
            </p>
          )}
          {result.autoCandidates?.length > 0 && (
            <p className="dim">
              자동배점 임계표 후보 {result.autoCandidates.length}건 — 문항 채점 카드에서 지표
              바인딩 후 활성화하세요.
            </p>
          )}
          <div className="btn-row">
            <Link to={`/y/${doneYear}`} className="btn btn-primary">
              {doneYear}년 심사로 이동
            </Link>
            <button type="button" className="btn" onClick={reset}>
              추가로 가져오기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 2단계: 미리보기(드라이런 결과) ──
  if (dryRun) {
    const totalQuestions = dryRun.files.reduce((s, f) => s + f.questionCount, 0);
    const totalWarnings = dryRun.files.reduce((s, f) => s + f.warnings.length, 0);
    const showCarryCard =
      dryRun.carry === true &&
      dryRun.carrySourceCycleId != null &&
      typeof dryRun.carryMatched === 'number';
    return (
      <div className="page page-narrow">
        <h1>가져오기 — 미리보기</h1>
        <p className="dim">
          {dryRun.targetYear != null ? `${dryRun.targetYear}년 심사 · ` : ''}파일{' '}
          {dryRun.files.length}개 · 문항 {totalQuestions}개
          {totalWarnings > 0 ? ` · 경고 ${totalWarnings}건` : ''} — 아직 DB에는 반영되지
          않았습니다. 내용을 확인한 뒤 [가져오기 실행]을 누르세요.
        </p>

        {showCarryCard && (
          <div className="card">
            <h2 className="card-title">지난 연도에서 물려받기</h2>
            <p>
              지난 연도와 같은 문항 {dryRun.carryMatched ?? 0}건을 찾았습니다. 이 중 답변이 있는
              문항 {dryRun.carryWithAnswer ?? 0}건, 근거 연결이 있는 문항{' '}
              {dryRun.carryWithEvidence ?? 0}건의 내용이 새 연도로 복사됩니다. 점수·검토 표시는
              모두 새로 시작합니다.
            </p>
          </div>
        )}

        {dryRun.files.map((f, idx) => (
          <details key={`${f.fileName}-${idx}`} className="card import-file" open={idx === 0}>
            <summary className="import-summary">
              <strong>{f.fileName}</strong>
              <span className="import-summary-meta">
                분야 {f.categoryCode} {f.categoryName} · 문항 {f.questionCount}개 · 개정표{' '}
                {f.revisionRows}행
                {f.warnings.length > 0 && (
                  <span className="warn-count"> · 경고 {f.warnings.length}건</span>
                )}
              </span>
            </summary>
            {f.warnings.length > 0 && (
              <ul className="warn-list">
                {f.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
            {f.diff && (
              <div className="import-diff">
                <strong>DB 대조:</strong> 신규 {f.diff.create} · 갱신 {f.diff.update} · 변동 없음{' '}
                {f.diff.unchanged}
                {Object.keys(f.diff.fieldChanges).length > 0 && (
                  <>
                    {' '}
                    <span className="dim">
                      (필드별:{' '}
                      {Object.entries(f.diff.fieldChanges)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')}
                      )
                    </span>
                  </>
                )}
                {f.diff.missingInPdf.length > 0 && (
                  <div className="dim">
                    PDF에 없는 기존 문항 {f.diff.missingInPdf.length}건 (삭제하지 않음):{' '}
                    {f.diff.missingInPdf.slice(0, 8).join(', ')}
                    {f.diff.missingInPdf.length > 8 && ' …'}
                  </div>
                )}
                {f.diff.protectedDiffs.length > 0 && (
                  <div className="warn-list">
                    배점·유형이 저장된 값과 다른 문항 {f.diff.protectedDiffs.length}건 — '문항
                    내용만 새로 반영'에서는 덮어쓰지 않고 '재확인'으로 표시:{' '}
                    {f.diff.protectedDiffs
                      .slice(0, 6)
                      .map((p) => `${p.questionNo}(${p.field}: ${String(p.current)}→${String(p.parsed)})`)
                      .join(', ')}
                    {f.diff.protectedDiffs.length > 6 && ' …'}
                  </div>
                )}
                {(f.diff.criteriaEligible > 0 ||
                  f.diff.criteriaManual.length > 0 ||
                  f.diff.criteriaViolations.length > 0) && (
                  <div className="dim">
                    세부항목표: 자동 등록 예정 {f.diff.criteriaEligible} · 직접 전환 필요{' '}
                    {f.diff.criteriaManual.length} · 배점 합계 불일치 {f.diff.criteriaViolations.length}
                  </div>
                )}
                {f.diff.autoCandidates.length > 0 && (
                  <div className="dim">
                    자동배점 후보 {f.diff.autoCandidates.length}건 (활성화는 문항에서 수동):{' '}
                    {f.diff.autoCandidates.slice(0, 8).join(', ')}
                    {f.diff.autoCandidates.length > 8 && ' …'}
                  </div>
                )}
                {f.diff.chapterMissing > 0 && (
                  <div className="warn-list">
                    목차 제목을 찾지 못한 문항 {f.diff.chapterMissing}건 — 목록에서는 문항번호
                    그룹으로 대신 표시됩니다
                  </div>
                )}
              </div>
            )}
            <div className="mini-table-wrap">
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>번호</th>
                    <th>문항</th>
                    <th className="col-right">배점</th>
                    <th className="col-center">해당없음</th>
                  </tr>
                </thead>
                <tbody>
                  {f.questions.slice(0, PREVIEW_ROWS).map((qq) => (
                    <tr key={qq.questionNo}>
                      <td className="q-no">{qq.questionNo}</td>
                      <td className="cell-ellipsis" title={qq.body}>
                        {qq.body}
                      </td>
                      <td className="col-right">{fmtNum(qq.maxScore)}</td>
                      <td className="col-center">{truthy(qq.allowNa) ? '가능' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {f.questions.length > PREVIEW_ROWS && (
              <p className="dim">… 외 {f.questions.length - PREVIEW_ROWS}문항</p>
            )}
          </details>
        ))}

        <div className="card">
          <h2 className="card-title">기존 문항과 겹칠 때 — 어떻게 합칠까요?</h2>
          <p className="page-desc">
            올린 파일 속 문항번호가 이미 등록된 문항과 같을 때, 그 문항을 어떻게 처리할지
            고르는 옵션입니다. 어떤 방식을 골라도 <strong>이미 입력한 채점·답변·근거 연결은
            지워지지 않습니다.</strong>
          </p>
          <label className="radio-row">
            <input
              type="radio"
              name="mode"
              checked={mode === 'keep_existing'}
              onChange={() => setMode('keep_existing')}
            />
            <span>
              지금 그대로 두기{' '}
              <span className="dim">
                — 이미 등록된 문항은 아무것도 바꾸지 않습니다. 파일에만 있는 새 문항만
                추가됩니다. (실수로 같은 파일을 또 올려도 안전)
              </span>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="mode"
              checked={mode === 'overwrite'}
              onChange={() => setMode('overwrite')}
            />
            <span>
              파일 내용으로 전부 바꾸기{' '}
              <span className="dim">
                — 문항 설명과 배점·유형까지 모두 파일에 적힌 값으로 바꿉니다. 배점이 바뀌면
                이전에 매긴 점수와 어긋날 수 있어, 아직 채점을 시작하기 전(처음 정리 단계)에만
                권합니다.
              </span>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="mode"
              checked={mode === 'reingest'}
              onChange={() => setMode('reingest')}
            />
            <span>
              문항 설명만 새로 반영 (해마다 개정판 반영 시 권장){' '}
              <span className="dim">
                — 문항의 설명·목차만 파일 내용으로 바꿉니다. 배점·유형이 파일과 다르면 함부로
                바꾸지 않고 '재확인' 표시를 붙여 알려만 줍니다. 작년에 해 둔 채점·답변·근거는
                그대로 두고 올해 개정 내용만 받아들이는 방식입니다.
              </span>
            </span>
          </label>
          <p className="dim">처음 등록(겹치는 문항 없음)할 때는 세 방식의 결과가 같습니다.</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={runCommit} disabled={busy}>
              {busy ? '가져오는 중…' : '가져오기 실행'}
            </button>
            <button type="button" className="btn" onClick={reset} disabled={busy}>
              처음부터 다시
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 1단계: 연도·파일 선택 ──
  return (
    <div className="page page-narrow">
      <h1>가져오기 — 문항 PDF</h1>
      <div className="card">
        <p>
          인증기관에서 내려받은 분야별 문항 PDF를 선택하세요. 업로드하면 먼저{' '}
          <strong>미리보기</strong>가 먼저 표시되며, [가져오기 실행] 전에는 DB가 변경되지
          않습니다.
        </p>
        <label className="import-year-row">
          <span className="import-year-label">가져올 연도</span>
          <select
            value={year}
            onChange={(e) => setYearSel(Number(e.target.value))}
            disabled={busy}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        </label>
        <p className="dim">
          분야별 한 파일씩 올려도 되고, 여러 분야 PDF를 한 번에 올려도 됩니다. 담당자가 자기
          분야만 따로 올려도 같은 연도로 합쳐집니다.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="application/pdf,.pdf"
          onChange={onFilesChange}
          hidden
        />
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            PDF 파일 선택
          </button>
          {files.length === 0 && <span className="dim">선택한 파일 없음</span>}
        </div>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="dim">({Math.round(f.size / 1024)} KB)</span>
              </li>
            ))}
          </ul>
        )}
        {showCarry && (
          <label className="radio-row">
            <input
              type="checkbox"
              checked={carryChecked}
              onChange={(e) => setCarryChecked(e.target.checked)}
            />
            <span>지난 연도의 서술 답변·근거 연결 물려받기 — 예/아니오 선택과 점수는 새로 시작합니다.</span>
          </label>
        )}
        {bootFailed && (
          <div className="form-error" role="alert">
            연도 정보를 불러오지 못해 미리보기를 시작할 수 없습니다.{' '}
            <button type="button" className="btn btn-sm" onClick={loadBoot}>
              다시 시도
            </button>
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={runDryRun}
            disabled={busy || files.length === 0 || boot == null}
          >
            {busy
              ? '업로드 중…'
              : boot == null && !bootFailed
                ? '연도 정보 불러오는 중…'
                : '업로드 (미리보기)'}
          </button>
        </div>
      </div>
    </div>
  );
}
