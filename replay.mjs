#!/usr/bin/env node
// 按模板回放：每一步由模板决定做什么，UI-TARS 只负责把元素描述变成坐标，不用 GPT。
// 每步执行后检查界面有没有变化（可选再让 UI-TARS 判断 expect 是否成立）；
// 检查失败时交给 GPT 规划器从当前画面接着做（--no-fallback 关闭），--heal 会用成功的新路径更新模板。
//
// 用法: node replay.mjs bing-search
//       node replay.mjs bing-search --var keyword=电动滑板车
//       node replay.mjs bing-search --heal
//       node replay.mjs --list
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, here, parseArgs, fillVars, templatize, capture, isChanged, runStep, askGrounder, describeStep, sleep } from './lib.mjs';
import { runAgent } from './planner.mjs';

const opts = parseArgs(process.argv.slice(2), ['--heal', '--no-fallback', '--list', '--check-expect']);
const recipesDir = join(here, 'recipes');

if (opts.list) {
  for (const f of existsSync(recipesDir) ? readdirSync(recipesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.bak.json')) : []) {
    const r = JSON.parse(readFileSync(join(recipesDir, f), 'utf-8'));
    console.log(`${r.name}  (${r.steps.length} 步)  ${r.task}  变量: ${JSON.stringify(r.vars)}`);
  }
  process.exit(0);
}
if (!opts.text) {
  console.error('用法: node replay.mjs NAME [--var k=v ...] [--heal] [--no-fallback] [--check-expect]  |  node replay.mjs --list');
  process.exit(1);
}

const file = join(recipesDir, `${opts.text}.json`);
const recipe = JSON.parse(readFileSync(file, 'utf-8'));
const vars = { ...recipe.vars, ...opts.vars };
const task = fillVars(recipe.task, vars);
const steps = recipe.steps.map((st) => ({ ...st, target: fillVars(st.target, vars), text: fillVars(st.text, vars), expect: fillVars(st.expect, vars) }));
const replayCfg = { verifyTimeoutMs: 6000, checkExpect: false, ...cfg.replay };
const checkExpect = opts['check-expect'] || replayCfg.checkExpect;

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
console.log(`回放模板 ${recipe.name}：${task}（${steps.length} 步）`);

// 让 UI-TARS 判断截图是否符合描述（只回答 是/否）
async function expectHolds(shot, expect) {
  const out = await askGrounder(shot, `请仔细看截图，判断下面这句话描述的情况是否已经出现在屏幕上：\n「${expect}」\n只回答一个字：是 或 否。`, 10);
  return !out.includes('否');
}

// 等待界面变化（页面加载可能要一会儿），最多 verifyTimeoutMs
async function waitForChange(before) {
  const deadline = Date.now() + replayCfg.verifyTimeoutMs;
  for (;;) {
    const after = await capture();
    if (isChanged(before.thumb, after.thumb)) return after;
    if (Date.now() > deadline) return null;
    await sleep(1000);
  }
}

let shot = await capture();
let failedAt = -1;
let reason = '';
for (let i = 0; i < steps.length && !abort.signal.aborted; i++) {
  const st = steps[i];
  console.log(`\n[step ${i + 1}/${steps.length}] (+${secs()}s) ${describeStep(st)}`);
  try {
    await runStep(shot, st);
  } catch (e) {
    failedAt = i;
    reason = `执行出错：${e.message}`;
    break;
  }
  let after;
  if (st.action === 'wait' || st.noChangeOk) {
    after = await capture();
  } else {
    after = await waitForChange(shot);
    if (!after) {
      failedAt = i;
      reason = `执行后 ${replayCfg.verifyTimeoutMs / 1000} 秒内界面没有变化`;
      break;
    }
  }
  if (checkExpect && st.expect) {
    const ok = await expectHolds(after, st.expect);
    console.log(`  检查「${st.expect}」: ${ok ? '是' : '否'}`);
    if (!ok) {
      failedAt = i;
      reason = `执行后没有出现预期状态「${st.expect}」`;
      break;
    }
  }
  shot = after;
}

if (abort.signal.aborted) {
  console.log('\n[fail] 用户中断');
  process.exit(1);
}
if (failedAt < 0) {
  console.log(`\n[done] (+${secs()}s) 模板 ${steps.length} 步全部执行完成，没有调用 GPT`);
  process.exit(0);
}

console.log(`\n[step ${failedAt + 1} 失败] ${reason}`);
if (opts['no-fallback']) {
  console.log('[fail] 已关闭 GPT 兜底');
  process.exit(1);
}

// ---------- 自愈：交给 GPT 从当前画面接着做 ----------
const done = steps.slice(0, failedAt).map((st, k) => `${k + 1}. ${describeStep(st)}`).join('\n');
const context = `这个任务之前一直按固定步骤自动执行。已经完成的步骤：\n${done || '（无）'}\n第 ${failedAt + 1} 步「${describeStep(steps[failedAt])}」出了问题：${reason}。\n请根据当前屏幕状态判断实际进展，从这里继续把任务完成（之前的步骤不用重做，除非屏幕显示它们没有生效）。`;
console.log('交给 GPT 规划器继续...');
const { result, steps: gptSteps } = await runAgent({ task, context, maxSteps: Number(opts['max-steps'] ?? cfg.maxSteps ?? 25), signal: abort.signal });
console.log(`\n[${result.status}] (+${secs()}s) ${result.answer}`);

if (opts.heal && result.status === 'done') {
  copyFileSync(file, file.replace(/\.json$/, '.bak.json'));
  const healed = {
    ...recipe,
    updatedAt: new Date().toISOString(),
    steps: [...recipe.steps.slice(0, failedAt), ...gptSteps.map((st) => templatize(st, vars))],
  };
  writeFileSync(file, JSON.stringify(healed, null, 2));
  console.log(`模板已更新（旧版备份为 ${recipe.name}.bak.json）：${healed.steps.length} 步`);
}
process.exit(result.status === 'done' ? 0 : 1);
