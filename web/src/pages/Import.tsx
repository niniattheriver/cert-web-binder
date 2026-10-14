/**
 * 가져오기 — 문항 PDF (설계서 §4 #10, §6.2 Day 1 범위: 파서 + 드라이런 + 커밋)
 * 흐름: 연도 선택 + 다중 PDF 선택 → 미리보기 업로드 → 파일별 아코디언 미리보기 → 모드 선택
 *   → 가져오기 실행 → 결과 요약.
 * 연도별 관리: '가져올 연도'를 골라 그 해의 심사로 인입한다.
 *   새 연도를 처음 시작할 때는 지난 연도의 서술 답변·근거 연결을 물려받을 수 있다(예/아니오 선택·점수는 새로 시작).
 *   연도·이월 여부는 미리보기 업로드 시점에 확정된다.
 * viewer 역할은 접근 차단 안내.
 * 파일 고르기: 점선 칸에 끌어다 놓거나 [PDF 파일 선택]. 고를 때마다 목록에 더하고(같은 이름이면 새 파일로),
 *   줄마다 [빼기]. 파일 선택 창에서 하나씩 골라도 된다.
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from 'react';
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
import Icon from '../components/Icon';

const PREVIEW_ROWS = 10;
const YEAR_FROM = 2026;
const YEAR_TO = 2036;

/** 저장된 문항과 비교한 결과의 항목 이름 (서버의 필드 이름 → 화면 이름) */
const FIELD_LABEL: Record<string, string> = {
  body: '문항 설명',
  topic: '질문 문장',
  chapterMajor: '대목차',
  chapterMinor: '소목차',
  sortKey: '순서',
  autoCandidate: '자동배점 후보',
  maxScore: '배점',
  allowNa: '해당없음 허용',
  questionType: '유형',
  gradeSymbol: '유형 기호',
};
const TYPE_LABEL: Record<string, string> = { core: '핵심', required: '필요', basic: '기본' };

/** 배점, 유형 차이의 값 표시: 해당없음 허용은 가능/불가, 유형은 우리말, 빈 값은 '없음' */
function diffValue(field: string, v: unknown): string {
  if (v == null || v === '') return '없음';
  if (field === 'allowNa') return v === true || v === 1 ? '가능' : '불가';
  if (field === 'questionType') return TYPE_LABEL[String(v)] ?? String(v);
  return String(v);
}

/** 끌어다 놓는 것이 파일인가 (글자, 링크를 끌 때는 반응하지 않는다) */
function dragHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** 문항 PDF 로 받을 파일인가 (이름 끝이 .pdf 이거나 형식이 PDF) */
function isPdfFile(f: File): boolean {
  return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
}

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
  /** PDF 가 아니라 목록에 넣지 않은 파일 이름(마지막으로 고르거나 놓은 묶음) */
  const [skipped, setSkipped] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

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

  // 끌어다 놓기: 칸 밖에 떨어뜨린 파일을 브라우저가 열어 이 화면을 떠나지 않게 기본 동작을 막는다
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (dragHasFiles(e)) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
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

  /** 고르거나 끌어다 놓은 파일을 목록에 더한다. PDF 만 받고, 같은 이름이면 새로 고른 파일로 바꾼다 */
  const addFiles = (list: ArrayLike<File>) => {
    const incoming = Array.from(list);
    const pdfs = incoming.filter(isPdfFile);
    setSkipped(incoming.filter((f) => !isPdfFile(f)).map((f) => f.name));
    if (pdfs.length > 0) {
      setFiles((prev) => [...prev.filter((p) => !pdfs.some((n) => n.name === p.name)), ...pdfs]);
    }
    setError(null);
  };

  const onFilesChange = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files ?? []);
    e.target.value = ''; // 같은 파일을 다시 골라도 바뀜이 알려지게
  };

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  };

  const onDropEnter = (e: ReactDragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDropOver = (e: ReactDragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  };
  const onDropLeave = (e: ReactDragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDropFiles = (e: ReactDragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (busy) return;
    addFiles(e.dataTransfer.files);
  };

  const reset = () => {
    setFiles([]);
    setSkipped([]);
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
              물려받음: 답변 {result.carriedAnswers ?? 0}건, 근거 연결{' '}
              {result.carriedEvidence ?? 0}건
            </p>
          )}
          {result.protectedDiffs?.length > 0 && (
            <div className="warn-list">
              배점이나 유형이 저장된 값과 다른 문항 {result.protectedDiffs.length}건은 덮어쓰지 않고
              '재확인' 표시를 붙였습니다. '확인 필요' 메뉴에서 확인하세요.
            </div>
          )}
          {(result.criteriaApplied > 0 ||
            result.criteriaManual?.length > 0 ||
            result.criteriaViolations?.length > 0) && (
            <p className="dim">
              세부항목표: 자동 등록 {result.criteriaApplied ?? 0}건, 직접 전환 필요{' '}
              {result.criteriaManual?.length ?? 0}건, 배점 합계 불일치{' '}
              {result.criteriaViolations?.length ?? 0}건(재확인 표시)
            </p>
          )}
          {result.autoCandidates?.length > 0 && (
            <p className="dim">
              자동배점 구간표 후보 {result.autoCandidates.length}건: 문항의 채점 카드에서 기관 지표를
              연결하면 쓸 수 있습니다.
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
        <h1>가져오기 미리보기</h1>
        <p className="dim">
          {dryRun.targetYear != null ? `${dryRun.targetYear}년 심사, ` : ''}파일{' '}
          {dryRun.files.length}개, 문항 {totalQuestions}개
          {totalWarnings > 0 ? `, 경고 ${totalWarnings}건` : ''}. 아직 저장하지 않았습니다. 내용을
          확인한 뒤 [가져오기 실행]을 누르세요.
        </p>

        {showCarryCard && (
          <div className="card">
            <h2 className="card-title">지난 연도에서 물려받기</h2>
            <p>
              지난 연도와 같은 문항 {dryRun.carryMatched ?? 0}건을 찾았습니다. 이 중 답변이 있는
              문항 {dryRun.carryWithAnswer ?? 0}건, 근거 연결이 있는 문항{' '}
              {dryRun.carryWithEvidence ?? 0}건의 내용이 새 연도로 복사됩니다. 점수와 검토 표시는
              새로 시작합니다.
            </p>
          </div>
        )}

        {dryRun.files.map((f, idx) => (
          <details key={`${f.fileName}-${idx}`} className="card import-file" open={idx === 0}>
            <summary className="import-summary">
              <strong>{f.fileName}</strong>
              <span className="import-summary-meta">
                분야 {f.categoryCode} {f.categoryName}, 문항 {f.questionCount}개, 개정표{' '}
                {f.revisionRows}행
                {f.warnings.length > 0 && (
                  <span className="warn-count">, 경고 {f.warnings.length}건</span>
                )}
              </span>
            </summary>
            {f.warnings.length > 0 && (
              <ul className="warn-list">
                {f.warnings.map((w, i) => (
                  <li key={i}>
                    <Icon name="warn" size={14} /> {w}
                  </li>
                ))}
              </ul>
            )}
            {f.diff && (
              <div className="import-diff">
                <strong>저장된 문항과 비교:</strong> 신규 {f.diff.create}, 갱신 {f.diff.update}, 변동 없음{' '}
                {f.diff.unchanged}
                {Object.keys(f.diff.fieldChanges).length > 0 && (
                  <>
                    {' '}
                    <span className="dim">
                      (바뀐 항목:{' '}
                      {Object.entries(f.diff.fieldChanges)
                        .map(([k, v]) => `${FIELD_LABEL[k] ?? k} ${v}건`)
                        .join(', ')}
                      )
                    </span>
                  </>
                )}
                {f.diff.missingInPdf.length > 0 && (
                  <div className="dim">
                    PDF에 없는 기존 문항 {f.diff.missingInPdf.length}건(지우지 않음):{' '}
                    {f.diff.missingInPdf.slice(0, 8).join(', ')}
                    {f.diff.missingInPdf.length > 8 && ' …'}
                  </div>
                )}
                {f.diff.protectedDiffs.length > 0 && (
                  <div className="warn-list">
                    배점이나 유형이 저장된 값과 다른 문항 {f.diff.protectedDiffs.length}건: '문항
                    설명만 새로 반영'에서는 덮어쓰지 않고 '재확인' 표시를 붙입니다.{' '}
                    {f.diff.protectedDiffs
                      .slice(0, 6)
                      .map(
                        (p) =>
                          `${p.questionNo}(${FIELD_LABEL[p.field] ?? p.field}: ${diffValue(p.field, p.current)}→${diffValue(p.field, p.parsed)})`,
                      )
                      .join(', ')}
                    {f.diff.protectedDiffs.length > 6 && ' …'}
                  </div>
                )}
                {(f.diff.criteriaEligible > 0 ||
                  f.diff.criteriaManual.length > 0 ||
                  f.diff.criteriaViolations.length > 0) && (
                  <div className="dim">
                    세부항목표: 자동 등록 예정 {f.diff.criteriaEligible}, 직접 전환 필요{' '}
                    {f.diff.criteriaManual.length}, 배점 합계 불일치 {f.diff.criteriaViolations.length}
                  </div>
                )}
                {f.diff.autoCandidates.length > 0 && (
                  <div className="dim">
                    자동배점 후보 {f.diff.autoCandidates.length}건(각 문항에서 직접 켭니다):{' '}
                    {f.diff.autoCandidates.slice(0, 8).join(', ')}
                    {f.diff.autoCandidates.length > 8 && ' …'}
                  </div>
                )}
                {f.diff.chapterMissing > 0 && (
                  <div className="warn-list">
                    목차 제목을 찾지 못한 문항 {f.diff.chapterMissing}건: 목록에서는 문항 번호
                    묶음으로 대신 보여 줍니다.
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
                      <td className="col-center">{truthy(qq.allowNa) ? '가능' : '불가'}</td>
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
          <h2 className="card-title">이미 등록된 문항과 번호가 같으면</h2>
          <p className="page-desc">
            올린 파일의 문항 번호가 이미 등록된 문항과 같을 때 어떻게 할지 고릅니다. 어느 방식을
            골라도 <strong>이미 입력한 채점, 답변, 근거 연결은 지워지지 않습니다.</strong>
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
                이미 등록된 문항은 그대로 두고 파일에만 있는 새 문항만 추가합니다. 같은 파일을
                실수로 다시 올려도 안전합니다.
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
                문항 설명, 배점, 유형을 모두 파일에 적힌 값으로 바꿉니다. 배점이 바뀌면 이미 매긴
                점수와 어긋날 수 있으니 채점을 시작하기 전에만 쓰세요.
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
              문항 설명만 새로 반영(같은 연도에 고친 PDF를 다시 올릴 때 권장){' '}
              <span className="dim">
                문항 설명과 목차만 파일 내용으로 바꿉니다. 배점이나 유형이 파일과 다르면 바꾸지 않고
                '재확인' 표시만 붙입니다. 이미 해 둔 채점, 답변, 근거는 그대로 둡니다.
              </span>
            </span>
          </label>
          <p className="dim">겹치는 문항이 없는 첫 등록에서는 세 방식의 결과가 같습니다.</p>
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
      <h1>문항 PDF 가져오기</h1>
      <div className="card">
        <p>
          인증기관에서 받은 분야별 문항 PDF를 고르세요. 올리면 먼저 <strong>미리보기</strong>를
          보여 주고, [가져오기 실행]을 누르기 전에는 아무것도 바뀌지 않습니다.
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
          분야별 한 파일씩 올려도 되고 여러 분야 PDF를 한 번에 올려도 됩니다. 담당자가 자기
          분야만 따로 올려도 같은 연도로 합쳐집니다.
        </p>
        {/* 끌어다 놓기 칸: 탐색기에서 PDF 를 놓거나 [PDF 파일 선택]으로 고른다. 둘 다 아래 목록에 더한다 */}
        <div
          className={'import-drop' + (dragOver ? ' is-over' : '') + (busy ? ' is-busy' : '')}
          onDragEnter={onDropEnter}
          onDragOver={onDropOver}
          onDragLeave={onDropLeave}
          onDrop={onDropFiles}
          role="region"
          aria-label="문항 PDF 끌어다 놓기"
        >
          <p className="import-drop-title">
            {dragOver ? '놓으면 아래 목록에 더해집니다' : '문항 PDF를 여기에 끌어다 놓으세요'}
          </p>
          <p className="import-drop-sub">
            여러 파일을 한 번에 놓을 수 있습니다. [PDF 파일 선택]으로 하나씩 골라도 목록에 더해집니다.
          </p>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            PDF 파일 선택
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            onChange={onFilesChange}
            hidden
          />
        </div>
        {skipped.length > 0 && (
          <p className="dim import-skipped">
            PDF가 아니라 목록에 넣지 않은 파일: {skipped.map((n) => `'${n}'`).join(', ')}
          </p>
        )}
        {files.length === 0 ? (
          <p className="dim">선택한 파일 없음</p>
        ) : (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="dim">({Math.round(f.size / 1024)} KB)</span>{' '}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => removeFile(f.name)}
                  aria-label={`${f.name} 목록에서 빼기`}
                >
                  빼기
                </button>
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
            <span>지난 연도의 서술 답변과 근거 연결 물려받기(예/아니오 선택과 점수는 새로 시작)</span>
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
                : '업로드하고 미리보기'}
          </button>
        </div>
      </div>
    </div>
  );
}
