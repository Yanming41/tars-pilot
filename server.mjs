#!/usr/bin/env node
// 本地 HTTP 接口：让别的程序（爬虫等）调用模板回放 / GPT 任务。
// 鼠标键盘只有一套，所有任务排队串行执行。
//
// 用法: node server.mjs            （默认 http://127.0.0.1:8765，可在 config.json 的 server 里改 host/port/token）
//
// 接口：
//   GET  /health                   服务状态 + 本地 UI-TARS 是否在线
//   GET  /recipes                  模板列表          GET /recipes/:name  模板内容
//   POST /runs                     提交任务（默认等执行完再返回；"wait": false 则立刻返回 id）
//        模板回放: { "recipe": "xhs-search", "vars": {"keyword": "电动滑板车"}, "fallback": true, "heal": false }
//        两种任务都可以加 "cdp": "xiaohongshu.com"：用 CDP 驱动只操作那个标签页，不动真实鼠标（推荐）；
//          "browser": "edge" 选浏览器（chrome=9222 默认 / edge=9223 / http://127.0.0.1:端口）
//        或 "focus": "小红书"：用系统驱动，开始前把标题包含这段文字的窗口切到前台（模板里存了的话默认用模板的）
//        GPT 任务: { "task": "打开...搜索 {{keyword}}", "vars": {...}, "save": "模板名(可选)", "maxSteps": 25 }
//   GET  /runs  /runs/:id          任务状态/结果/日志
//   POST /runs/:id/cancel          取消（排队中的直接移除，执行中的会在当前步骤后停下）
//
// 任务进度播报到 Discord(可选)：有 ~/.discord_dm/tars_discord.json 就开启，见 reporters/discord.mjs；
//   请求里加 "discord_channel_id" 指定发到哪个频道/帖子，不加就发主频道；"caller" 会显示在卡片上。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, fillVars, here } from './lib.mjs';
import { runAgent } from './planner.mjs';
import { createDiscordReporter } from './reporters/discord.mjs';
import { listRecipes, loadRecipe, runRecipe, saveRecipe } from './recipes.mjs';

const serverCfg = { host: '127.0.0.1', port: 8765, token: '', ...cfg.server };
const runs = new Map();
const queue = [];
let current = null;
let shuttingDown = false;
const reporter = createDiscordReporter(cfg.discordReporterConfig);

// 执行中的任务的输出同时记到它自己的日志里，接口可以取回
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    if (current) {
      const line = args.map(String).join(' ').trim();
      current.log.push(line);
      if (current.log.length > 500) current.log.shift();
      reporter?.onLog(current, line);
    }
  };
}

// ---------- 模型服务（WSL 里的 vLLM）生命周期：按需启动、空闲自动停止、接口退出时一起停 ----------
// 模型常驻会一直占着 ~13.6GB 显存；所以有任务时才拉起来（首次加载 1-2 分钟），空闲 modelIdleMinutes 分钟后停掉。
// 关闭本接口的窗口（Windows 会给 node 发 SIGHUP）、Ctrl+C、stop-all.ps1 都会顺带停掉 vLLM。
const modelCfg = { wslDistro: 'Ubuntu', modelIdleMinutes: 20, ...cfg.server };
const modelUrl = `${cfg.baseURL ?? 'http://127.0.0.1:8000/v1'}/models`;
const logsDir = join(here, 'logs');
let modelStarting = null;
let lastActivity = Date.now();

async function grounderOnline() {
  try {
    const r = await fetch(modelUrl, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

// WSL 里有没有 vLLM 进程（正在加载的也算）
function vllmRunning() {
  try {
    execFileSync('wsl', ['-d', modelCfg.wslDistro, '--', 'bash', '-c', "pgrep -f '[v]llm serve|[V]LLM::EngineCore' >/dev/null"], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// 2026-10-02 修：以前超时只有 5 分钟、超时后不清理，下一个任务又拉起一个新的 vLLM，
// 两个实例抢显存/内存，越来越慢、谁都起不来。现在：已经有 vLLM 在加载就等它，绝不重复启动；
// 超时（默认 10 分钟）或进程中途退出就把它停干净再报错。
function ensureModel() {
  if (modelStarting) return modelStarting;
  modelStarting = (async () => {
    if (await grounderOnline()) return;
    mkdirSync(logsDir, { recursive: true });
    if (vllmRunning()) {
      console.log('[model] 已有模型服务在加载，等它就绪（日志: logs/model.log）');
    } else {
      const log = openSync(join(logsDir, 'model.log'), 'a');
      console.log(`[model] 启动本地 UI-TARS 模型（WSL ${modelCfg.wslDistro} + vLLM），通常 1-2 分钟，日志: logs/model.log`);
      spawn('wsl', ['-d', modelCfg.wslDistro, '--cd', here, '--', 'bash', './serve.sh'], { stdio: ['ignore', log, log], windowsHide: true }).unref();
      await new Promise((r) => setTimeout(r, 5000));
    }
    const timeoutMin = modelCfg.modelStartTimeoutMinutes ?? 10;
    const deadline = Date.now() + timeoutMin * 60_000;
    let checks = 0;
    while (!(await grounderOnline())) {
      // 每 30 秒确认一次进程还活着（pgrep 走 wsl 有点慢，不每轮都查）
      if (++checks % 10 === 0 && !vllmRunning()) throw new Error('模型服务启动中途退出了，看 logs/model.log');
      if (Date.now() > deadline) {
        stopModelSync(`${timeoutMin} 分钟内没有就绪`);
        throw new Error(`模型服务 ${timeoutMin} 分钟内没有就绪，已停止，看 logs/model.log`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log('[model] 模型就绪');
  })().finally(() => {
    modelStarting = null;
  });
  return modelStarting;
}

// 同步版本：进程退出时也能用（SIGHUP 处理里不能 await）。
// 直接 SIGKILL 主进程（vllm serve）和真正占显存的子进程（VLLM::EngineCore），进程立刻消失、显存立刻释放。
// 模式写成 '[v]llm serve'：bash -c 自己的命令行里也有这串字，不加方括号 pkill 会先把自己的父进程 bash 杀掉，后面的命令就不执行了；
// 4 秒超时：关窗口时 Windows 只给约 5 秒清理时间，超时宁可放弃也不能让整个退出流程被拖住。
function stopModelSync(reason) {
  try {
    execFileSync('wsl', ['-d', modelCfg.wslDistro, '--', 'bash', '-c', "pkill -KILL -f '[v]llm serve'; pkill -KILL -f '[V]LLM::EngineCore'; true"],
      { stdio: 'ignore', windowsHide: true, timeout: 4000 });
    console.log(`[model] 已停止模型服务（${reason}），显存已释放`);
  } catch (e) {
    console.error(`[model] 停止模型服务时出错（${reason}）: ${e.message}`);
  }
}

setInterval(async () => {
  const idleMin = (Date.now() - lastActivity) / 60_000;
  if (!current && !queue.length && !modelStarting && modelCfg.modelIdleMinutes > 0 && idleMin >= modelCfg.modelIdleMinutes && (await grounderOnline())) {
    stopModelSync(`空闲 ${Math.round(idleMin)} 分钟`);
  }
}, 60_000).unref();

const view = ({ abort, waiters, ...r }) => r;

function finish(run, status, result) {
  run.status = status;
  run.result = result;
  run.finishedAt = new Date().toISOString();
  for (const w of run.waiters) w();
  run.waiters = [];
  reporter?.onFinished(run);
}

async function execute(run) {
  const req = run.request;
  const signal = run.abort.signal;
  if (run.kind === 'recipe') {
    return runRecipe({
      name: req.recipe,
      vars: req.vars ?? {},
      fallback: req.fallback ?? true,
      heal: req.heal ?? false,
      checkExpect: req.checkExpect,
      maxSteps: req.maxSteps,
      signal,
      focus: req.focus,
      cdp: req.cdp,
      browser: req.browser,
    });
  }
  const t0 = Date.now();
  const { result, steps, usage } = await runAgent({
    task: fillVars(req.task, req.vars ?? {}),
    maxSteps: req.maxSteps ?? cfg.maxSteps ?? 25,
    signal,
    focus: req.focus,
    cdp: req.cdp,
    browser: req.browser,
  });
  let saved = null;
  if (req.save && result.status === 'done') saved = saveRecipe(req.save, req.task, req.vars ?? {}, steps, { focus: req.focus, cdp: req.cdp, browser: req.browser });
  return { ...result, usedGPT: true, steps: steps.length, saved, usage, durationMs: Date.now() - t0 };
}

async function pump() {
  if (current || !queue.length) return;
  current = queue.shift();
  current.status = 'running';
  current.startedAt = new Date().toISOString();
  const run = current;
  lastActivity = Date.now();
  try {
    await ensureModel();
    const result = await execute(run);
    finish(run, run.abort.signal.aborted ? 'cancelled' : result.status, result);
  } catch (e) {
    console.error(`[run ${run.id}] 出错: ${e.stack ?? e.message}`);
    finish(run, run.abort.signal.aborted ? 'cancelled' : 'error', { status: 'error', answer: e.message });
  } finally {
    current = null;
    lastActivity = Date.now();
    // 只保留最近 100 个任务
    for (const id of [...runs.keys()].slice(0, Math.max(0, runs.size - 100))) if (runs.get(id).finishedAt) runs.delete(id);
    pump();
  }
}

function submit(body) {
  let kind;
  if (body.recipe) {
    try {
      loadRecipe(body.recipe);
    } catch (e) {
      throw Object.assign(new Error(e.code === 'ENOENT' ? `没有模板 ${body.recipe}` : e.message), { status: 404 });
    }
    kind = 'recipe';
  } else if (body.task) {
    kind = 'agent';
  } else {
    throw Object.assign(new Error('需要 recipe 或 task 字段'), { status: 400 });
  }
  const { wait, ...request } = body;
  const run = {
    id: randomUUID(),
    kind,
    request,
    status: 'queued',
    result: null,
    log: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    abort: new AbortController(),
    waiters: [],
  };
  runs.set(run.id, run);
  queue.push(run);
  pump(); // 没有排队的话这里已经同步变成 running，卡片就不会先显示"排队中"
  reporter?.onCreated(run);
  return run;
}


function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1 << 20) throw Object.assign(new Error('请求体太大'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    // 这个接口能操控真实鼠标键盘：拒绝浏览器发来的请求（网页里的脚本都会带 Origin），
    // POST 只收 application/json（浏览器跨站发这种请求必须先预检，而我们不回 CORS 头）
    if (shuttingDown) return send(res, 503, { error: '服务正在关闭' });
    if (req.headers.origin) return send(res, 403, { error: '不接受浏览器跨站请求' });
    if (serverCfg.token && req.headers.authorization !== `Bearer ${serverCfg.token}`) return send(res, 401, { error: '缺少或错误的 token' });
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) {
      return send(res, 415, { error: 'Content-Type 必须是 application/json' });
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.method === 'GET' && url.pathname === '/health') {
      const up = await grounderOnline();
      return send(res, 200, { ok: true, grounder: up, model: up ? 'running' : modelStarting ? 'starting' : `stopped（有任务时自动启动，空闲 ${modelCfg.modelIdleMinutes} 分钟自动停止）`, busy: !!current, queued: queue.length });
    }
    if (req.method === 'POST' && url.pathname === '/model/warm') {
      lastActivity = Date.now();
      ensureModel().catch((e) => console.error(`[model] ${e.message}`));
      return send(res, 202, { ok: true, model: (await grounderOnline()) ? 'running' : 'starting' });
    }
    if (req.method === 'POST' && url.pathname === '/model/stop') {
      if (current || modelStarting) return send(res, 409, { error: '有任务在跑或模型正在启动，稍后再停' });
      stopModelSync('手动停止');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && parts[0] === 'recipes') {
      if (parts.length === 1) return send(res, 200, listRecipes());
      try {
        return send(res, 200, loadRecipe(parts[1]));
      } catch {
        return send(res, 404, { error: `没有模板 ${parts[1]}` });
      }
    }
    if (parts[0] === 'runs') {
      if (req.method === 'GET' && parts.length === 1) {
        return send(res, 200, [...runs.values()].reverse().map(({ log, ...r }) => view(r)));
      }
      const run = parts[1] && runs.get(parts[1]);
      if (parts.length >= 2 && !run) return send(res, 404, { error: '没有这个任务' });
      if (req.method === 'GET' && parts.length === 2) return send(res, 200, view(run));
      if (req.method === 'POST' && parts[2] === 'cancel') {
        const qi = queue.indexOf(run);
        if (qi >= 0) {
          queue.splice(qi, 1);
          finish(run, 'cancelled', { status: 'cancelled', answer: '排队中被取消' });
        } else {
          run.abort.abort();
        }
        return send(res, 200, view(run));
      }
      if (req.method === 'POST' && parts.length === 1) {
        const body = await readJson(req);
        let run2;
        try {
          run2 = submit(body);
        } catch (e) {
          return send(res, e.status ?? 404, { error: e.message });
        }
        if (body.wait === false) return send(res, 202, view(run2));
        if (!run2.finishedAt) await new Promise((r) => run2.waiters.push(r));
        return send(res, 200, view(run2));
      }
    }
    return send(res, 404, { error: '没有这个接口' });
  } catch (e) {
    return send(res, e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: e.message });
  }
});

// 等待中的长请求不要被 Node 默认的超时掐断
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(serverCfg.port, serverCfg.host, () => {
  console.log(`tars-pilot API: http://${serverCfg.host}:${serverCfg.port}  （模板 ${listRecipes().length} 个，token ${serverCfg.token ? '已启用' : '未启用'}）`);
});

// 服务和窗口绑定：关掉 tars-pilot 窗口时 Windows 给 node 发 SIGHUP，约 5 秒后强制结束进程。
// 收到后：先停止接收新请求 → 取消正在跑和排队中的任务 → 停掉 WSL 里的 vLLM（≤4 秒）→ 退出。
// Ctrl+C（SIGINT）、SIGTERM、Ctrl+Break（SIGBREAK）走同一套流程。stop-all.ps1 是直接结束进程，它自己会清 vLLM。
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] 收到 ${sig}：停止接收新请求，停掉模型服务后退出`);
  server.close();
  current?.abort.abort();
  for (const r of queue.splice(0)) finish(r, 'cancelled', { status: 'cancelled', answer: '服务关闭' });
  stopModelSync(`接口退出（${sig}）`);
  process.exit(0);
}
for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
