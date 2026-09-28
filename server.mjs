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
//        两种任务都可以加 "cdp": "xiaohongshu.com"：用 CDP 驱动只操作那个 Chrome 标签页，不动真实鼠标（推荐）
//        或 "focus": "小红书"：用系统驱动，开始前把标题包含这段文字的窗口切到前台（模板里存了的话默认用模板的）
//        GPT 任务: { "task": "打开...搜索 {{keyword}}", "vars": {...}, "save": "模板名(可选)", "maxSteps": 25 }
//   GET  /runs  /runs/:id          任务状态/结果/日志
//   POST /runs/:id/cancel          取消（排队中的直接移除，执行中的会在当前步骤后停下）
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { cfg, fillVars } from './lib.mjs';
import { runAgent } from './planner.mjs';
import { listRecipes, loadRecipe, runRecipe, saveRecipe } from './recipes.mjs';

const serverCfg = { host: '127.0.0.1', port: 8765, token: '', ...cfg.server };
const runs = new Map();
const queue = [];
let current = null;

// 执行中的任务的输出同时记到它自己的日志里，接口可以取回
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    if (current) {
      current.log.push(args.map(String).join(' ').trim());
      if (current.log.length > 500) current.log.shift();
    }
  };
}

const view = ({ abort, waiters, ...r }) => r;

function finish(run, status, result) {
  run.status = status;
  run.result = result;
  run.finishedAt = new Date().toISOString();
  for (const w of run.waiters) w();
  run.waiters = [];
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
    });
  }
  const t0 = Date.now();
  const { result, steps, usage } = await runAgent({
    task: fillVars(req.task, req.vars ?? {}),
    maxSteps: req.maxSteps ?? cfg.maxSteps ?? 25,
    signal,
    focus: req.focus,
    cdp: req.cdp,
  });
  let saved = null;
  if (req.save && result.status === 'done') saved = saveRecipe(req.save, req.task, req.vars ?? {}, steps, { focus: req.focus, cdp: req.cdp });
  return { ...result, usedGPT: true, steps: steps.length, saved, usage, durationMs: Date.now() - t0 };
}

async function pump() {
  if (current || !queue.length) return;
  current = queue.shift();
  current.status = 'running';
  current.startedAt = new Date().toISOString();
  const run = current;
  try {
    const result = await execute(run);
    finish(run, run.abort.signal.aborted ? 'cancelled' : result.status, result);
  } catch (e) {
    console.error(`[run ${run.id}] 出错: ${e.stack ?? e.message}`);
    finish(run, run.abort.signal.aborted ? 'cancelled' : 'error', { status: 'error', answer: e.message });
  } finally {
    current = null;
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
  pump();
  return run;
}

async function grounderOnline() {
  try {
    const r = await fetch(`${cfg.baseURL ?? 'http://127.0.0.1:8000/v1'}/models`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
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
    if (req.headers.origin) return send(res, 403, { error: '不接受浏览器跨站请求' });
    if (serverCfg.token && req.headers.authorization !== `Bearer ${serverCfg.token}`) return send(res, 401, { error: '缺少或错误的 token' });
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) {
      return send(res, 415, { error: 'Content-Type 必须是 application/json' });
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, grounder: await grounderOnline(), busy: !!current, queued: queue.length });
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

process.on('SIGINT', () => {
  current?.abort.abort();
  server.close();
  process.exit(0);
});
