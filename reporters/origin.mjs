// 请求里没写 discord_channel_id 时，猜一下是谁发来的，好把卡片发回对的地方。
//
// Claude Code 不一定用 Python 客户端(它会自动带上 TARS_DISCORD_CHANNEL)，经常直接 curl。请求都来自本机：
// 用这条连接的端口找到发请求的进程(curl / python / node)，沿父进程往上找，找到 discord_bridge 启动的
// `claude --session-id <id>` / `--resume <id>`，再到桥接的状态文件里查这个会话对应哪个论坛帖子。
// 找不到(不是桥接开的会话、非 Windows 等)就返回 null，照旧发主频道。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BRIDGE_STATE = path.join(os.homedir(), '.discord_dm', 'bridge_state.json');
// --resume 后面可能是会话 ID，也可能是 .jsonl 的完整路径
const CLAUDE_SESSION = /claude(?:\.exe)?"?\s.*--(?:session-id|resume)\s+"?[^\s"]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });

// 端口 → 进程(netstat，几十毫秒) → 往上最多 12 层的命令行(一次取全部进程，约 1.5 秒)
async function processChain(clientPort, serverPort) {
  const netstat = await run('netstat.exe', ['-ano', '-p', 'TCP']);
  const row = netstat.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .find((c) => c[1]?.endsWith(`:${clientPort}`) && c[2]?.endsWith(`:${serverPort}`));
  let pid = Number(row?.[4]);
  if (!pid) return [];
  const json = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress']);
  let procs;
  try {
    procs = new Map(JSON.parse(json).map((p) => [p.ProcessId, p]));
  } catch {
    return [];
  }
  const chain = [];
  for (let i = 0; i < 12 && procs.has(pid); i++) {
    const p = procs.get(pid);
    if (p.CommandLine) chain.push(p.CommandLine);
    pid = p.ParentProcessId;
  }
  return chain;
}

export async function guessOrigin(socket) {
  if (process.platform !== 'win32' || !socket?.remotePort) return null;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)) return null;
  const chain = await processChain(socket.remotePort, socket.localPort);
  const sessionId = chain.map((cmd) => CLAUDE_SESSION.exec(cmd)?.[1]).find(Boolean);
  if (!sessionId) return null;
  try {
    const state = JSON.parse(await readFile(BRIDGE_STATE, 'utf8'));
    const threadId = Object.entries(state.sessions ?? {}).find(([, s]) => s.claudeSessionId === sessionId)?.[0];
    return threadId ? { discord_channel_id: threadId, caller: 'Claude Code' } : null;
  } catch {
    return null;
  }
}
