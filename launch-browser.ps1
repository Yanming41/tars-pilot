# 启动一个"自动化专用"的浏览器实例：单独的资料目录 + 固定 CDP 调试端口 + 防遮挡参数；端口上已经有浏览器在跑就直接复用。
# 为什么要单独的资料目录：Chrome/Edge 136+ 不允许对默认资料开 --remote-debugging-port（防窃取资料的恶意软件），
# 所以自动化用的浏览器和你日常用的浏览器分开：在这个实例里登录一次账号（Edge 可以登录微软账号同步密码/地址/收藏夹），之后一直复用。
# 注意：调试端口不需要任何确认，本机任何程序都能控制这个浏览器——只在自己信任的电脑上用。
#
# 用法: powershell -File launch-browser.ps1                         # Edge，端口 9223，资料在 %USERPROFILE%\automation-browser\edge
#       powershell -File launch-browser.ps1 -Browser chrome -Port 9224 -Url https://example.com
param(
  [ValidateSet('edge', 'chrome')][string]$Browser = 'edge',
  [int]$Port = 0,
  [string]$ProfileDir = '',
  [string]$Url = 'about:blank'
)
if (-not $Port) { $Port = if ($Browser -eq 'edge') { 9223 } else { 9222 } }
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:USERPROFILE "automation-browser\$Browser" }

$candidates = if ($Browser -eq 'edge') {
  @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
} else {
  @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
}
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { Write-Output "找不到 $Browser 可执行文件"; exit 1 }

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Output "端口 $Port 上已经有浏览器在跑，直接复用"
  exit 0
}

New-Item -ItemType Directory -Force $ProfileDir | Out-Null
$argList = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$ProfileDir`"",
  '--no-first-run',
  '--no-default-browser-check',
  # Windows 上窗口被挡住/最小化时浏览器会停止出新画面，CDP 截图会超时；这几个开关让它在后台照常渲染
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  $Url
)
Start-Process -FilePath $exe -ArgumentList $argList | Out-Null

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try {
    $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    Write-Output "已启动 $($v.Browser)，调试端口 $Port，资料目录 $ProfileDir"
    exit 0
  } catch { Start-Sleep -Milliseconds 500 }
}
Write-Output "浏览器 20 秒内没在端口 $Port 上就绪"
exit 1
