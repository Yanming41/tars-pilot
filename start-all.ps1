# 启动 tars-pilot：只开一个窗口（本地 HTTP 接口 :8765）。模型服务（WSL + vLLM，:8000，约 13.6GB 显存）由接口按需管理：
#   有任务时自动启动（首次加载 1-2 分钟），空闲 20 分钟自动停止（config.json 的 server.modelIdleMinutes），关窗口时一起停。
# 窗口标题：「tars-pilot — 关闭此窗口 = 停止全部服务」，在任务栏里找它；或者运行 stop-all.ps1。
# 用 Start-Process 拉起，不挂在调用者（终端 / Claude 会话的后台任务）下面。已经在跑就跳过。
# 用法: powershell -File start-all.ps1 [-Warm]      -Warm：顺便把模型也提前加载好
param([switch]$Warm)
$root = $PSScriptRoot
$title = 'tars-pilot — 关闭此窗口 = 停止全部服务'

function Test-Url($url) {
  try { Invoke-RestMethod $url -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Test-Url "http://127.0.0.1:8765/health") {
  Write-Output "接口服务已在运行 (:8765)"
} else {
  Start-Process powershell -WindowStyle Minimized -ArgumentList @('-NoProfile', '-Command', "`$host.UI.RawUI.WindowTitle='$title'; Set-Location '$root'; node server.mjs")
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Url "http://127.0.0.1:8765/health")) {
    if ((Get-Date) -gt $deadline) { Write-Output "接口服务 30 秒内没有就绪"; exit 1 }
    Start-Sleep -Seconds 1
  }
  Write-Output "接口服务就绪 (:8765)，窗口：$title"
}

if ($Warm -and -not (Test-Url "http://127.0.0.1:8000/v1/models")) {
  # 提交一个不存在的模板不会触发加载，所以直接让接口跑 wsl：和接口内部用同一个启动方式
  Start-Process wsl -WindowStyle Hidden -ArgumentList @('-d', 'Ubuntu', '--cd', $root, '--', 'bash', '-c', './serve.sh >> logs/model.log 2>&1')
  Write-Output "正在预加载模型（1-2 分钟）..."
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-Url "http://127.0.0.1:8000/v1/models")) {
    if ((Get-Date) -gt $deadline) { Write-Output "模型 5 分钟内没有就绪，看 logs/model.log"; exit 1 }
    Start-Sleep -Seconds 3
  }
  Write-Output "模型就绪 (:8000)"
}
Invoke-RestMethod "http://127.0.0.1:8765/health" | ConvertTo-Json -Compress
