# 窗口外一键停止 tars-pilot：结束 tars-pilot 窗口（连同里面的 node 接口），并清理 WSL 里的模型进程（vLLM），释放显存。
# 只按进程链找窗口（监听 :8765 的 node → 它的父进程 cmd → 托管它的 conhost），不按窗口标题匹配，不会碰别的窗口。
# 不会碰自动化浏览器（Chrome :9222 / Edge :9223）。
# 用法: powershell -File stop-all.ps1
$c = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $node = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  $top = $node
  $cmd = Get-CimInstance Win32_Process -Filter "ProcessId=$($node.ParentProcessId)" -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Name -eq 'cmd.exe' -and $cmd.CommandLine -like '*title tars-pilot*') {
    $top = $cmd
    $host_ = Get-CimInstance Win32_Process -Filter "ProcessId=$($cmd.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($host_ -and $host_.Name -eq 'conhost.exe') { $top = $host_ }
  }
  # 从最上层结束整棵进程树：conhost（窗口）→ cmd → node
  & taskkill.exe /PID $top.ProcessId /T /F | Out-Null
  Write-Output "已结束 tars-pilot（$($top.Name) PID $($top.ProcessId) 及其子进程）"
} else {
  Write-Output "tars-pilot 接口没在运行"
}

# node 是被直接结束的，来不及自己清模型，这里补上
$r = wsl -d Ubuntu -- bash -c "if pgrep -f '[v]llm serve|[V]LLM::EngineCore' >/dev/null; then pkill -KILL -f '[v]llm serve'; pkill -KILL -f '[V]LLM::EngineCore'; echo KILLED; else echo NONE; fi" 2>$null
if ($r -match 'KILLED') { Write-Output "已停止模型服务（vLLM），显存已释放" } else { Write-Output "模型服务没在运行" }

# 兼容旧版 start-all 留下的最小化 PowerShell 窗口
Get-Process powershell, pwsh -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'tars-pilot*' } | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  Write-Output "已关闭旧窗口: $($_.MainWindowTitle)"
}
