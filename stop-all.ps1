# 停止 tars-pilot 的全部服务：本地接口（:8765）、模型服务（WSL 里的 vLLM，释放显存），并关掉残留的 tars-pilot 窗口。
# 不会碰自动化浏览器（Chrome :9222 / Edge :9223）。
# 用法: powershell -File stop-all.ps1
$c = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output "已停止接口服务 (:8765, PID $($c.OwningProcess))" } else { Write-Output "接口服务没在运行" }

wsl -d Ubuntu -- pkill -f "vllm serve" 2>$null
if ($LASTEXITCODE -eq 0) { Write-Output "已停止模型服务（vLLM），显存已释放" } else { Write-Output "模型服务没在运行" }

$wins = Get-Process powershell, pwsh -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'tars-pilot*' }
foreach ($w in $wins) { Stop-Process -Id $w.Id -Force -ErrorAction SilentlyContinue; Write-Output "已关闭窗口: $($w.MainWindowTitle)" }
