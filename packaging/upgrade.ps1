# 인증 근거자료 웹 바인더 — 업그레이드 (Windows/WinSW, 설계서 §7)
# app 파일(server\ web\ node_modules\ package.json)만 교체하고 config.json·data\ 는 보존한다.
#
# 사용법(관리자 PowerShell):
#   .\upgrade.ps1 -InstallRoot C:\qaevidence -ReleaseZip C:\temp\새릴리스.zip
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ReleaseZip,
  [string]$ServiceExe = "qaevidence-service.exe"
)
$ErrorActionPreference = "Stop"

$svc = Join-Path $InstallRoot $ServiceExe
Write-Host "[업그레이드] 서비스 중지"
& $svc stop

$tmp = Join-Path $env:TEMP ("qae-" + [guid]::NewGuid().ToString("N"))
Write-Host "[업그레이드] 압축 해제: $ReleaseZip"
Expand-Archive -Path $ReleaseZip -DestinationPath $tmp -Force
$src = (Get-ChildItem -Path $tmp -Directory | Select-Object -First 1).FullName

Write-Host "[업그레이드] app 파일 교체 (config.json·data\ 보존)"
foreach ($item in @("server", "web", "node_modules", "package.json", "config.example.json", "packaging", "docs")) {
  $s = Join-Path $src $item
  $d = Join-Path $InstallRoot $item
  if (Test-Path $s) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    Copy-Item -Recurse -Force $s $d
  }
}
Remove-Item -Recurse -Force $tmp

Write-Host "[업그레이드] 서비스 시작 (기동 시 DB 마이그레이션 자동 적용)"
& $svc start
Start-Sleep -Seconds 2
& $svc status
Write-Host "[업그레이드] 완료. config.json 과 data\ 는 그대로 유지되었습니다."
