# 把标题包含指定文字的顶层窗口切到前台（最小化的会先还原）。
# 用法: powershell -NoProfile -File focus-window.ps1 -Title "小红书" [-List] [-Background]
#   -Background：不切到前台；如果窗口被最小化了，还原它但压到所有窗口最底层（不抢焦点、不挡你的窗口）。
#                给 CDP 驱动用：Chrome 最小化时不渲染，截图会超时
#   -Port 9223：只匹配启动参数里带 --remote-debugging-port=9223 的浏览器进程的窗口。
#                自动化浏览器登录了同一个微软账号后窗口标题和日常浏览器一样（"... - 个人 - Microsoft Edge"），
#                只按标题匹配会误操作到日常浏览器——CDP 驱动一律带 -Port。
# Windows 默认不允许后台程序抢焦点，这里先模拟一下 Alt 键再 SetForegroundWindow（常见绕法）。
param([string]$Title = "", [switch]$List, [switch]$Background, [int]$Port = 0)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TpWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static List<KeyValuePair<IntPtr, string>> List() {
    var r = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.Length > 0) r.Add(new KeyValuePair<IntPtr, string>(h, sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);            // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);         // Alt down
    keybd_event(0x12, 0, 2, UIntPtr.Zero);         // Alt up
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(300);
    return GetForegroundWindow() == h;
  }
}
"@
$wins = [TpWin]::List()
if ($List) { $wins | ForEach-Object { $_.Value }; exit 0 }
$cands = $wins | Where-Object { $_.Value -like "*$Title*" }
if ($Port) {
  # 浏览器的窗口属于主进程（不带 --type=）；只留命令行里有这个调试端口的
  $okPids = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match "--remote-debugging-port=$Port(\s|$|`")" } | ForEach-Object { [uint32]$_.ProcessId }
  $cands = $cands | Where-Object { $p = [uint32]0; [void][TpWin]::GetWindowThreadProcessId($_.Key, [ref]$p); $okPids -contains $p }
}
$hit = $cands | Select-Object -First 1
if (-not $hit) { Write-Output "NOT_FOUND"; exit 2 }
if ($Background) {
  if ([TpWin]::IsIconic($hit.Key)) { [void][TpWin]::ShowWindow($hit.Key, 4) }   # SW_SHOWNOACTIVATE
  [void][TpWin]::SetWindowPos($hit.Key, [IntPtr]1, 0, 0, 0, 0, 0x0013)        # HWND_BOTTOM | NOSIZE | NOMOVE | NOACTIVATE
  Write-Output "OK $($hit.Value)"; exit 0
}
if ([TpWin]::Focus($hit.Key)) { Write-Output "OK $($hit.Value)"; exit 0 }
Write-Output "FAILED $($hit.Value)"; exit 1
