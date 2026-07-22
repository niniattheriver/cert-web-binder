/**
 * 운영 점검 (admin 전용) — 설계서 §7
 * 비개발자 담당자가 백업·무결성·저장 공간을 버튼 클릭만으로 다루는 화면.
 * 인증심사(실사) 전날 체크리스트를 화면 안에서 순서대로 안내한다(체크 상태는 이 PC에 저장).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchAdminStatus,
  fetchIntegrity,
  runAdminBackup,
  runIntegrity,
  type AdminStatus,
  type BackupBundleResult,
  type IntegrityResult,
} from '../api';
import { useAuth } from '../auth';
import { errorMessage } from '../util';

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
  { key: 'backup', label: '위의 [지금 백업] 버튼을 눌러 백업 파일을 만든다.' },
  { key: 'copy', label: '설치 폴더 안의 data 폴더를 통째로 복사해 USB 등 다른 장치에 보관한다. (탐색기에서 복사 → 붙여넣기)' },
  { key: 'integrity', label: '위의 [지금 점검 실행]을 눌러 모든 항목이 "통과"인지 확인한다.' },
  { key: 'viewer', label: '심사위원용 열람 계정을 만들고 만료일을 설정한다. (사용자 계정 관리에서)' },
  { key: 'lookup', label: '위쪽 검색창에 문항번호를 입력해 3초 안에 해당 문항이 열리는지 연습한다.' },
  { key: 'export', label: '분야 화면에서 [엑셀 내보내기]와 인쇄가 되는지 확인한다.' },
  { key: 'restart', label: '서버 PC를 재부팅한 뒤에도 접속되는지 확인한다. (상시 운영 설정을 한 경우)' },
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
  const [busy, setBusy] = useState<'backup' | 'integrity' | null>(null);
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
    try {
      const r = await runAdminBackup();
      setBackupResult(r);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
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
      setError(errorMessage(err));
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
        백업·점검을 버튼 한 번으로 실행합니다. 인증심사(실사) 전날에는 아래 체크리스트를 위에서부터
        순서대로 따라가면 준비가 끝납니다.
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <h2 className="card-title">백업</h2>
        <p className="dim">
          문항·답변·채점·근거 연결이 담긴 <b>데이터베이스의 사본(ZIP)</b>을 즉시 만들어 서버의
          백업 폴더(<code>data</code> 폴더 안 <code>backups</code>)에 저장합니다. 매일 새벽 3시의
          자동 백업(데이터베이스 스냅샷)과는 별개이며, 이 ZIP은 자동으로 지워지지 않으므로 오래된
          것은 가끔 직접 삭제해 주세요. <b>업로드한 PDF 원본 파일은 ZIP에 들어가지 않습니다</b> —
          완전한 보관은 <code>data</code> 폴더 전체 복사로 하세요(아래 체크리스트 2번).
        </p>
        <p>
          최근 백업:{' '}
          {backupStale ? (
            <strong className="adminops-fail">
              {status?.backups.latest
                ? `오래됨 — ${status.backups.latest} (${fmtWhen(status.backups.latestAt)})`
                : '아직 없음'}
            </strong>
          ) : (
            <strong>{status?.backups.latest ?? '확인 중…'}</strong>
          )}
          {!backupStale && status?.backups.latestBytes != null && ` (${fmtBytes(status.backups.latestBytes)})`}
          {status != null && ` · 보관 중 ${status.backups.count}개`}
        </p>
        {backupStale && (
          <p className="dim">
            서비스가 새벽 3시에 꺼져 있지 않았는지 확인하고, 아래 [지금 백업]으로 즉시 하나 만들어
            두세요.
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => void onBackup()} disabled={busy !== null}>
            {busy === 'backup' ? '백업 만드는 중…' : '지금 백업'}
          </button>
        </div>
        {backupResult && (
          <p className="adminops-ok" role="status">
            ✓ 백업 완료 — <strong>{backupResult.zipFile}</strong> ({fmtBytes(backupResult.zipBytes)}
            )이 서버 PC의 <code>{backupResult.zipPath}</code> 에 저장됐습니다. 더 안전하게 하려면{' '}
            <code>data</code> 폴더 전체를 USB 등 다른 장치에 복사해 두세요(PDF 원본 포함 보관).
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">자료 이상 여부 점검 (무결성)</h2>
        <p className="dim">
          저장된 자료에 깨지거나 어긋난 곳이 없는지 자동으로 검사합니다. 기동 시와 매주 자동
          실행되며, 심사 전날에는 한 번 직접 실행해 전 항목 통과를 확인하세요.
        </p>
        <p>
          마지막 점검:{' '}
          {integrity ? (
            <>
              <strong className={integrity.ok ? 'adminops-pass' : 'adminops-fail'}>
                {integrity.ok ? '전 항목 통과' : '위반 있음'}
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
                      <span className="adminops-fail">위반 {c.offenderCount}건</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {integrity && !integrity.ok && (
          <p className="dim">
            위반이 있으면 자동으로 고치지 않습니다 — 화면을 캡처해 시스템 담당자(또는 설치를 도운
            분)에게 전달하세요.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">저장 공간</h2>
        {status?.disk ? (
          <p>
            디스크 사용 {status.disk.usedPct}% · 남은 공간 <strong>{fmtBytes(status.disk.freeBytes)}</strong>
            {status.disk.usedPct >= 90 && (
              <span className="adminops-fail"> — 공간이 부족합니다. 오래된 백업 파일 정리를 검토하세요.</span>
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
          체크 표시는 이 PC 브라우저에 저장됩니다. 위에서부터 순서대로 진행하세요.
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
