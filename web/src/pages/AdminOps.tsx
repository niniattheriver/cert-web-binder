/**
 * 운영 점검 (admin 전용) — 설계서 §7
 * 비개발자 담당자가 백업·무결성·저장 공간을 버튼 클릭만으로 다루는 화면.
 * 인증심사(실사) 전날 체크리스트를 화면 안에서 순서대로 안내한다(체크 상태는 이 PC에 저장).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  fetchAdminStatus,
  fetchIntegrity,
  runAdminBackup,
  runAdminFullBackup,
  runIntegrity,
  type AdminStatus,
  type BackupBundleResult,
  type FullBackupResult,
  type IntegrityResult,
} from '../api';
import { useAuth } from '../auth';
import { errorMessage } from '../util';

/** 서버 자작 안내(details — 예: '이미 전체 백업이 진행 중입니다')를 일반 409 문구보다 우선 노출 */
function apiMessage(e: unknown): string {
  if (e instanceof ApiError && typeof e.body?.details === 'string') return e.body.details;
  return errorMessage(e);
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n === 0) return '0';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

/** 백업이 없거나 이 시간(ms)보다 오래되면 경고 */
const BACKUP_STALE_MS = 48 * 60 * 60 * 1000;

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { hour12: false });
}

const CHECKLIST_KEY = 'd1-checklist-v1';

const CHECKLIST: { key: string; label: string }[] = [
  { key: 'backup', label: '위의 [전체 백업(원본 파일 포함)]을 눌러 백업 파일을 만듭니다.' },
  { key: 'copy', label: '만들어진 전체 백업 ZIP (또는 data 폴더 전체)을 USB 같은 다른 장치에 복사해 둡니다.' },
  { key: 'integrity', label: '위의 [지금 점검 실행]을 눌러 모든 항목이 "통과"인지 확인합니다.' },
  { key: 'viewer', label: '사용자 계정 관리에서 심사위원용 열람 계정을 만들고 만료일을 정합니다.' },
  { key: 'lookup', label: '위쪽 검색창에 문항 번호를 넣고 3초 안에 그 문항을 여는 연습을 합니다.' },
  { key: 'export', label: '분야 화면에서 [엑셀 내보내기]와 인쇄가 되는지 확인합니다.' },
  { key: 'restart', label: '상시 운영 설정을 했다면, 서버 PC를 다시 켠 뒤에도 접속되는지 확인합니다.' },
];

function loadChecklist(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CHECKLIST_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export default function AdminOps() {
  const { user } = useAuth();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [backupResult, setBackupResult] = useState<BackupBundleResult | null>(null);
  const [fullResult, setFullResult] = useState<FullBackupResult | null>(null);
  const [busy, setBusy] = useState<'backup' | 'fullBackup' | 'integrity' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>(loadChecklist);

  const reload = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([fetchAdminStatus(), fetchIntegrity()]);
      setStatus(s);
      setIntegrity(i);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleCheck = (key: string) => {
    const next = { ...checked, [key]: !checked[key] };
    setChecked(next);
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
  };

  const onBackup = async () => {
    setBusy('backup');
    setError(null);
    setBackupResult(null); // 이전 성공 메시지가 새 실행 결과처럼 남지 않게
    setFullResult(null);
    try {
      const r = await runAdminBackup();
      setBackupResult(r);
      await reload();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onFullBackup = async () => {
    setBusy('fullBackup');
    setError(null);
    setBackupResult(null);
    setFullResult(null);
    try {
      const r = await runAdminFullBackup();
      setFullResult(r);
      await reload();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onIntegrity = async () => {
    setBusy('integrity');
    setError(null);
    try {
      setIntegrity(await runIntegrity());
      await reload();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (user && user.role !== 'admin') {
    return (
      <div className="page-narrow">
        <h1>운영 점검</h1>
        <p className="dim">관리자 전용 화면입니다.</p>
      </div>
    );
  }

  const doneCount = CHECKLIST.filter((c) => checked[c.key]).length;
  const backupStale =
    status != null &&
    (status.backups.latestAt == null ||
      Date.now() - new Date(status.backups.latestAt).getTime() > BACKUP_STALE_MS);

  return (
    <div className="page-narrow adminops-page">
      <h1>운영 점검</h1>
      <p className="dim">
        백업과 자료 점검을 버튼 한 번으로 실행합니다. 인증심사(실사) 전날에는 아래 체크리스트를
        위에서부터 차례로 따라 하면 됩니다.
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <h2 className="card-title">백업</h2>
        <p className="dim">
          두 가지 백업을 만들 수 있습니다. <b>빠른 백업</b>은 문항, 답변, 채점, 근거 연결이 담긴{' '}
          <b>데이터베이스의 사본만</b> ZIP으로 만듭니다. 업로드한 원본 파일(근거자료, 첨부)은 들어가지
          않고 몇 초면 끝납니다. <b>전체 백업</b>은 데이터베이스와{' '}
          <b>업로드한 원본 파일(근거자료, 첨부)까지 전부</b> 한 ZIP에 담습니다(파일이 많으면 몇 분). 둘 다 서버의 백업 폴더(<code>data</code> 폴더 안{' '}
          <code>backups</code>)에 저장되며, 매일 새벽 3시의 자동 백업과는 따로 만들어집니다. 이 ZIP은
          자동으로 지워지지 않으니 오래된 것은 가끔 직접 지워 주세요.
        </p>
        <p>
          최근 백업:{' '}
          {backupStale ? (
            <strong className="adminops-fail">
              {status?.backups.latest
                ? `오래됨: ${status.backups.latest} (${fmtWhen(status.backups.latestAt)})`
                : '아직 없음'}
            </strong>
          ) : (
            <strong>{status?.backups.latest ?? '확인 중…'}</strong>
          )}
          {!backupStale && status?.backups.latestBytes != null && ` (${fmtBytes(status.backups.latestBytes)})`}
          {status != null && `, 보관 중 ${status.backups.count}개`}
        </p>
        {backupStale && (
          <p className="dim">
            새벽 3시에 서버가 꺼져 있었는지 확인하고 아래 버튼으로 지금 하나 만들어 두세요.
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => void onBackup()} disabled={busy !== null}>
            {busy === 'backup' ? '백업 만드는 중…' : '빠른 백업(DB만)'}
          </button>
          <button type="button" className="btn" onClick={() => void onFullBackup()} disabled={busy !== null}>
            {busy === 'fullBackup' ? '전체 백업 만드는 중…(파일이 많으면 몇 분 걸립니다)' : '전체 백업(원본 파일 포함)'}
          </button>
        </div>
        {backupResult && (
          <p className="adminops-ok" role="status">
            ✓ 빠른 백업 완료: <strong>{backupResult.zipFile}</strong> (
            {fmtBytes(backupResult.zipBytes)})이 서버 PC의 <code>{backupResult.zipPath}</code>에
            저장됐습니다. 업로드한 원본 파일(근거자료, 첨부)까지 보관하려면 [전체 백업(원본 파일 포함)]을
            쓰세요.
          </p>
        )}
        {fullResult && (
          <p className="adminops-ok" role="status">
            ✓ 전체 백업 완료: <strong>{fullResult.zipFile}</strong> ({fmtBytes(fullResult.zipBytes)}
            , 담긴 파일 {fullResult.fileCount}개)이 서버 PC의 <code>{fullResult.zipPath}</code>에
            저장됐습니다. 이 ZIP을 USB 같은 다른 장치에 복사해 두면 안전하게 보관할 수 있습니다.
            {fullResult.missingCount > 0 && (
              <strong className="adminops-fail">
                {' '}
                원본이 없는 파일 {fullResult.missingCount}개는 담지 못했습니다. 아래 [지금 점검
                실행]으로 자료에 이상이 없는지 확인하세요.
              </strong>
            )}
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">자료 점검</h2>
        <p className="dim">
          저장된 자료에 깨지거나 어긋난 곳이 없는지 검사합니다. 서버를 켤 때와 매주 한 번 자동으로
          실행되고, 심사 전날에는 직접 한 번 실행해 모든 항목이 통과하는지 확인하세요.
        </p>
        <p>
          마지막 점검:{' '}
          {integrity ? (
            <>
              <strong className={integrity.ok ? 'adminops-pass' : 'adminops-fail'}>
                {integrity.ok ? '전 항목 통과' : '이상 있음'}
              </strong>{' '}
              <span className="dim">({fmtWhen(integrity.checkedAt)})</span>
            </>
          ) : (
            '불러오는 중…'
          )}
        </p>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => void onIntegrity()} disabled={busy !== null}>
            {busy === 'integrity' ? '점검 중…' : '지금 점검 실행'}
          </button>
        </div>
        {integrity && (
          <table className="simple-table adminops-table">
            <thead>
              <tr>
                <th>점검 항목</th>
                <th className="col-center">결과</th>
              </tr>
            </thead>
            <tbody>
              {integrity.checks.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="col-center">
                    {c.ok ? (
                      <span className="adminops-pass">통과</span>
                    ) : (
                      <span className="adminops-fail">이상 {c.offenderCount}건</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {integrity && !integrity.ok && (
          <p className="dim">
            이상 항목은 자동으로 고쳐지지 않습니다. 화면을 캡처해 시스템 담당자(또는 설치를 도운
            분)에게 보내 주세요.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">저장 공간</h2>
        {status?.disk ? (
          <p>
            디스크 사용 {status.disk.usedPct}%, 남은 공간 <strong>{fmtBytes(status.disk.freeBytes)}</strong>
            {status.disk.usedPct >= 90 && (
              <span className="adminops-fail"> 공간이 부족합니다. 오래된 백업 파일을 정리해 주세요.</span>
            )}
          </p>
        ) : (
          <p className="dim">디스크 정보를 가져올 수 없는 환경입니다.</p>
        )}
        <p className="dim">
          자료 위치: <code>{status?.config.dataDir ?? '…'}</code>
        </p>
      </div>

      <div className="card">
        <h2 className="card-title">
          인증심사(실사) 전날 체크리스트{' '}
          <span className="dim">
            {doneCount}/{CHECKLIST.length}
          </span>
        </h2>
        <p className="dim">
          체크 표시는 이 PC의 브라우저에만 저장됩니다. 위에서부터 차례로 진행하세요.
        </p>
        <ul className="adminops-checklist">
          {CHECKLIST.map((c) => (
            <li key={c.key}>
              <label>
                <input type="checkbox" checked={!!checked[c.key]} onChange={() => toggleCheck(c.key)} />
                <span className={checked[c.key] ? 'is-done' : ''}>{c.label}</span>
              </label>
              {c.key === 'viewer' && (
                <Link className="adminops-link" to="/users">
                  사용자 계정 관리 열기 →
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
