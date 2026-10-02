# 一键启动 tars-pilot：本地 UI-TARS 模型服务（WSL + vLLM，:8000）和本地 HTTP 接口（:8765）。
# 各开在一个独立的最小化窗口里（关掉那个窗口就停止对应服务）；已经在跑的直接跳过。
# 用 Start-Process 拉起，进程不挂在调用者（终端 / Claude 会话的后台任务）下面，调用者退出了服务照样在跑。
# 用法: powershell -File start-all.ps1 [-Distro Ubuntu]
param([string]$Distro = "Ubuntu")
$root = $PSScriptRoot

function Test-Url($url) {
  try { Invoke-RestMethod $url -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Test-Url "http://127.0.0.1:8000/v1/models") {
  Write-Output "模型服务已在运行 (:8000)"
} else {
  Start-Process powershell -WindowStyle Minimized -ArgumentList @('-NoProfile', '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='tars-pilot model (vLLM :8000)'; wsl -d $Distro --cd '$root' -- bash ./serve.sh")
  Write-Output "已启动模型服务窗口，等待就绪（首次加载约 1-2 分钟）..."
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-Url "http://127.0.0.1:8000/v1/models")) {
    if ((Get-Date) -gt $deadline) { Write-Output "模型服务 5 分钟内没有就绪，去它的窗口看报错"; exit 1 }
    Start-Sleep -Seconds 3
  }
  Write-Output "模型服务就绪 (:8000)"
}

if (Test-Url "http://127.0.0.1:8765/health") {
  Write-Output "接口服务已在运行 (:8765)"
} else {
  Start-Process powershell -WindowStyle Minimized -ArgumentList @('-NoProfile', '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='tars-pilot API (:8765)'; Set-Location '$root'; node server.mjs")
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Url "http://127.0.0.1:8765/health")) {
    if ((Get-Date) -gt $deadline) { Write-Output "接口服务 30 秒内没有就绪，去它的窗口看报错"; exit 1 }
    Start-Sleep -Seconds 1
  }
  Write-Output "接口服务就绪 (:8765)"
}
Invoke-RestMethod "http://127.0.0.1:8765/health" | ConvertTo-Json -Compress
