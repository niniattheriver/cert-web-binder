# 인증 근거자료 웹 바인더: 업그레이드 (Windows/WinSW, 설계서 §7)
# 배포 파일을 새 릴리스로 바꾼다: 실행 엔진(runtime\), server\ web\ node_modules\ packaging\ docs\ 와 루트의 package.json,
# config.example.json, 시작 스크립트, 설명서(README.md, 처음 읽어주세요.txt), 고지(NOTICE, LICENSE, THIRD_PARTY_LICENSES.txt).
# 실행 엔진도 함께 바꿔야 새 node_modules 의 네이티브 모듈(better-sqlite3)과 짝이 맞는다.
# config.json, data\, 서비스 파일(qaevidence-service.exe, qaevidence.xml, 로그)은 그대로 둔다.
#
# 안전장치
# - 서비스가 멈춘 것을 확인한 뒤에만 파일을 바꾼다.
# - 바꾸기 전의 파일과 DB(data\app.db)는 설치 루트의 _upgrade_backup_<시각>\ 에 남긴다.
# - 파일을 바꾸다 실패하면 이전 파일로 되돌리고 이전 버전으로 서비스를 다시 켠다.
# - 새 버전이 /api/health 에 응답하지 않으면 실패(종료 코드 1)로 끝내고 되돌리는 명령을 알려 준다.
#
# 사용법(관리자 PowerShell):
#   .\upgrade.ps1 -InstallRoot C:\qaevidence -ReleaseZip C:\temp\새릴리스.zip
# 되돌리기(업그레이드가 남긴 백업 폴더로):
#   .\upgrade.ps1 -InstallRoot C:\qaevidence -RollbackFrom C:\qaevidence\_upgrade_backup_20261014-093000
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$ReleaseZip,
  [string]$RollbackFrom,
  [string]$ServiceExe = "qaevidence-service.exe",
  # 새 버전이 응답할 때까지 기다리는 최대 초 (처음 켜는 PC 는 보안 검사로 1~3분 걸릴 수 있다)
  [int]$HealthTimeoutSec = 180
)
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrEmpty($ReleaseZip) -eq [string]::IsNullOrEmpty($RollbackFrom)) {
  throw "-ReleaseZip(업그레이드)과 -RollbackFrom(되돌리기) 가운데 하나만 지정하세요."
}
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$svc = Join-Path $InstallRoot $ServiceExe
if (-not (Test-Path -LiteralPath $svc)) { throw "서비스 실행 파일이 없습니다: $svc" }

# 새 릴리스로 바꾸는 항목 (release.mjs 가 zip 루트에 두는 것. 이 릴리스에 없는 항목은 건너뛴다)
$Items = @(
  "runtime", "server", "web", "node_modules", "packaging", "docs",
  "package.json", "config.example.json", "start-windows.bat", "start-linux.sh",
  "README.md", "처음 읽어주세요.txt", "NOTICE", "LICENSE", "THIRD_PARTY_LICENSES.txt"
)
# 백업 폴더에 남기는 목록 파일 (되돌릴 때 이 항목들을 지우고 백업에 있던 것을 되돌린다)
$ManifestName = "upgrade-items.txt"
$DbFiles = @("app.db", "app.db-wal", "app.db-shm")

function Get-ConfigValue([string]$Name) {
  $cfg = Join-Path $InstallRoot "config.json"
  if (-not (Test-Path -LiteralPath $cfg)) { return $null }
  try { return (Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).$Name } catch { return $null }
}

function Get-DataDir {
  $d = Get-ConfigValue "dataDir"
  if ([string]::IsNullOrWhiteSpace($d)) { $d = "./data" }
  if ([System.IO.Path]::IsPathRooted($d)) { return $d }
  return Join-Path $InstallRoot $d
}

# WinSW status 출력: 2.x 는 Started/Stopped/NonExistent, 3.x 는 Active (running)/Inactive (stopped)
function Get-ServiceState {
  # PowerShell 5.1 은 2>&1 로 받은 오류 줄을 Stop 설정에서 예외로 바꾼다: 이 함수 안에서만 계속 진행
  $ErrorActionPreference = "Continue"
  $out = (& $svc status 2>&1 | Out-String)
  if ($out -match "nonexistent") { return "nonexistent" }
  if ($out -match "stopped") { return "stopped" }
  if ($out -match "started|running") { return "running" }
  return $out.Trim()
}

function Wait-ServiceStopped([int]$Sec) {
  $deadline = (Get-Date).AddSeconds($Sec)
  while ((Get-Date) -lt $deadline) {
    $state = Get-ServiceState
    if ($state -eq "stopped") { return $true }
    if ($state -eq "nonexistent") { return $false }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-AppService {
  Write-Host "[업그레이드] 서비스 중지"
  & $svc stop
  if (-not (Wait-ServiceStopped 60)) {
    throw "서비스가 멈추지 않았습니다(상태: $(Get-ServiceState)). 파일은 바꾸지 않았습니다."
  }
}

# 서비스를 켜고 /api/health 가 200 을 돌려줄 때까지 기다린다 (포트는 config.json, 없으면 8080)
function Start-AppAndWait {
  & $svc start
  $port = Get-ConfigValue "port"
  if (-not $port) { $port = 8080 }
  $url = "http://127.0.0.1:$port/api/health"
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

if ($RollbackFrom) {
  # ── 되돌리기 ────────────────────────────────────────────────────────────────
  $backup = (Resolve-Path -LiteralPath $RollbackFrom).Path
  $manifest = Join-Path $backup $ManifestName
  if (-not (Test-Path -LiteralPath $manifest)) { throw "업그레이드 백업 폴더가 아닙니다($ManifestName 없음): $backup" }
  Stop-AppService
  Write-Host "[되돌리기] 배포 파일을 백업의 것으로 되돌립니다: $backup"
  foreach ($item in (Get-Content -LiteralPath $manifest -Encoding UTF8 | Where-Object { $_ -ne "" })) {
    $d = Join-Path $InstallRoot $item
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
    $b = Join-Path $backup $item
    if (Test-Path -LiteralPath $b) { Move-Item -LiteralPath $b -Destination $d }
  }
  # DB 는 업그레이드 직전 사본으로 (새 버전이 마이그레이션으로 바꿨을 수 있다). 지금의 WAL 이 옛 DB 에 섞이지 않게 먼저 지운다
  $dataDir = Get-DataDir
  $dbBackup = Join-Path $backup "data"
  if (Test-Path -LiteralPath (Join-Path $dbBackup "app.db")) {
    foreach ($f in $DbFiles) {
      $p = Join-Path $dataDir $f
      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    foreach ($f in $DbFiles) {
      $p = Join-Path $dbBackup $f
      if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination $dataDir }
    }
    Write-Host "[되돌리기] DB 를 업그레이드 직전 사본으로 되돌렸습니다"
  }
  Write-Host "[되돌리기] 서비스 시작"
  if (Start-AppAndWait) {
    Write-Host "[되돌리기] 완료. 이전 버전이 응답합니다."
    exit 0
  }
  Write-Host "[되돌리기] 이전 버전이 응답하지 않습니다. 설치 루트의 qaevidence-service.err.log 를 확인하세요."
  exit 1
}

# ── 업그레이드 ────────────────────────────────────────────────────────────────
# 1) 새 릴리스를 임시 폴더에 풀고 구성을 확인한다 (설치 폴더는 아직 건드리지 않는다)
$tmp = Join-Path $env:TEMP ("qae-" + [guid]::NewGuid().ToString("N"))
Write-Host "[업그레이드] 압축 해제: $ReleaseZip"
Expand-Archive -LiteralPath $ReleaseZip -DestinationPath $tmp -Force
$src = (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName
if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src "server")) -or -not (Test-Path -LiteralPath (Join-Path $src "runtime"))) {
  Remove-Item -LiteralPath $tmp -Recurse -Force
  throw "릴리스 zip 의 구성이 예상과 다릅니다(server, runtime 폴더가 없음): $ReleaseZip"
}

# 2) 서비스 중지 (실행 엔진이 파일을 잡고 있으면 바꿀 수 없다)
try { Stop-AppService } catch { Remove-Item -LiteralPath $tmp -Recurse -Force; throw }

# 3) 바꾸기 전의 DB 사본
$backup = Join-Path $InstallRoot ("_upgrade_backup_" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path (Join-Path $backup "data") | Out-Null
$dataDir = Get-DataDir
foreach ($f in $DbFiles) {
  $p = Join-Path $dataDir $f
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $backup "data") }
}

# 4) 배포 파일 바꾸기: 이전 것은 백업 폴더로 옮기고 새 것을 복사한다. 실패하면 되돌리고 이전 버전으로 다시 켠다
Write-Host "[업그레이드] 배포 파일 교체 (config.json, data\ 는 그대로)"
$moved = New-Object System.Collections.Generic.List[string]
$copied = New-Object System.Collections.Generic.List[string]
try {
  foreach ($item in $Items) {
    $s = Join-Path $src $item
    if (-not (Test-Path -LiteralPath $s)) { continue }
    $d = Join-Path $InstallRoot $item
    if (Test-Path -LiteralPath $d) {
      Move-Item -LiteralPath $d -Destination (Join-Path $backup $item)
      $moved.Add($item)
    }
    $copied.Add($item)
    Copy-Item -LiteralPath $s -Destination $d -Recurse -Force
  }
  Set-Content -LiteralPath (Join-Path $backup $ManifestName) -Value $copied -Encoding UTF8
} catch {
  $err = $_
  Write-Host "[업그레이드] 파일을 바꾸다 실패했습니다: $($err.Exception.Message)"
  Write-Host "[업그레이드] 이전 파일로 되돌리고 이전 버전으로 다시 켭니다"
  foreach ($item in $copied) {
    $d = Join-Path $InstallRoot $item
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
  }
  foreach ($item in $moved) { Move-Item -LiteralPath (Join-Path $backup $item) -Destination (Join-Path $InstallRoot $item) }
  Remove-Item -LiteralPath $tmp -Recurse -Force
  & $svc start
  throw $err
}
Remove-Item -LiteralPath $tmp -Recurse -Force

# 5) 새 버전 시작과 응답 확인 (기동 때 DB 마이그레이션이 자동으로 적용된다)
Write-Host "[업그레이드] 서비스 시작 (기동 시 DB 마이그레이션 자동 적용)"
if (Start-AppAndWait) {
  Write-Host "[업그레이드] 완료. 새 버전이 응답합니다. config.json 과 data\ 는 그대로입니다."
  Write-Host "  이전 파일과 업그레이드 직전 DB 사본: $backup (새 버전을 확인한 뒤 지워도 됩니다)"
  exit 0
}
Write-Host "[업그레이드] 새 버전이 $HealthTimeoutSec 초 안에 응답하지 않습니다. 설치 루트의 qaevidence-service.err.log 를 확인하세요."
Write-Host "  이전 버전으로 되돌리려면(관리자 PowerShell):"
Write-Host "  .\upgrade.ps1 -InstallRoot `"$InstallRoot`" -RollbackFrom `"$backup`""
exit 1
