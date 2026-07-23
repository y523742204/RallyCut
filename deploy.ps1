# RallyCut 一键部署: 构建 -> 同步产物 -> 推送 gh-pages
# 用法: 在项目根目录的 PowerShell 里执行  .\deploy.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '== 1/3 构建静态产物 ==' -ForegroundColor Cyan
pnpm run build
if ($LASTEXITCODE -ne 0) { throw 'build 失败，已中止' }

Write-Host '== 2/3 同步产物到 gh-pages-deploy ==' -ForegroundColor Cyan
$deploy = Join-Path $PSScriptRoot 'gh-pages-deploy'
if (-not (Test-Path (Join-Path $deploy '.git'))) { throw "未找到发布仓库: $deploy" }
Get-ChildItem $deploy -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot 'out\*') $deploy -Recurse -Force
New-Item -ItemType File -Path (Join-Path $deploy '.nojekyll') -Force | Out-Null

Write-Host '== 3/3 提交并推送 gh-pages ==' -ForegroundColor Cyan
Push-Location $deploy
try {
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host '产物无变化，无需发布' -ForegroundColor Yellow
  } else {
    git commit -m ('deploy: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')) | Out-Null
    git push origin gh-pages
    if ($LASTEXITCODE -ne 0) { throw 'push 失败' }
    Write-Host '已发布，约 1 分钟后生效: https://y523742204.github.io/RallyCut/' -ForegroundColor Green
  }
} finally {
  Pop-Location
}
