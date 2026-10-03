# 启动 tars-pilot：开一个可见的终端窗口「tars-pilot」运行本地 HTTP 接口（:8765）。
#   - 窗口里就是 cmd.exe /k title tars-pilot && node server.mjs，输出直接显示在窗口里，可以在里面敲命令。
#   - 用 conhost.exe 托管成独立窗口（不进 Windows Terminal 的标签页），关它不会影响别的终端标签。
#   - 服务和窗口绑定：关掉这个窗口 = 接口停止 + WSL 里的模型（vLLM）一起停掉。
#   - 模型（:8000，约 13.6GB 显存）由接口按需管理：有任务时自动启动，空闲 20 分钟自动停止。
# 已经在跑（:8765 在监听）就直接返回，不重复开窗口。窗口外一键停止：stop-all.ps1。
# 用法: powershell -File start-all.ps1 [-Warm]      -Warm：顺便把模型也提前加载好
param([switch]$Warm)
$root = $PSScriptRoot

function Test-Url($url) {
  try { Invoke-RestMethod $url -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output "tars-pilot 已在运行 (:8765)，不重复开窗口"
} else {
  Start-Process -FilePath conhost.exe -WorkingDirectory $root -ArgumentList 'cmd.exe /k title tars-pilot && node server.mjs'
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Url "http://127.0.0.1:8765/health")) {
    if ((Get-Date) -gt $deadline) { Write-Output "接口服务 30 秒内没有就绪，看 tars-pilot 窗口里的报错"; exit 1 }
    Start-Sleep -Seconds 1
  }
  Write-Output "tars-pilot 已启动 (:8765)，窗口标题 tars-pilot（关掉窗口 = 停止全部服务）"
}

if ($Warm -and -not (Test-Url "http://127.0.0.1:8000/v1/models")) {
  # 让接口去拉模型（和任务触发的是同一套逻辑：已经在加载就不重复启动）
  Invoke-RestMethod -Method Post "http://127.0.0.1:8765/model/warm" -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Output "正在预加载模型（通常 1-2 分钟）..."
  $deadline = (Get-Date).AddMinutes(10)
  while (-not (Test-Url "http://127.0.0.1:8000/v1/models")) {
    if ((Get-Date) -gt $deadline) { Write-Output "模型 10 分钟内没有就绪，看 logs/model.log"; exit 1 }
    Start-Sleep -Seconds 3
  }
  Write-Output "模型就绪 (:8000)"
}
