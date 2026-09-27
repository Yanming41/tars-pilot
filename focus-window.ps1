# 把标题包含指定文字的顶层窗口切到前台（最小化的会先还原）。
# 用法: pwsh -NoProfile -File focus-window.ps1 -Title "小红书" [-List]
# Windows 默认不允许后台程序抢焦点，这里先模拟一下 Alt 键再 SetForegroundWindow（常见绕法）。
param([string]$Title = "", [switch]$List)
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
$hit = $wins | Where-Object { $_.Value -like "*$Title*" } | Select-Object -First 1
if (-not $hit) { Write-Output "NOT_FOUND"; exit 2 }
if ([TpWin]::Focus($hit.Key)) { Write-Output "OK $($hit.Value)"; exit 0 }
Write-Output "FAILED $($hit.Value)"; exit 1
