#!/usr/bin/env node
// 按模板回放：每一步由模板决定做什么，UI-TARS 只负责把元素描述变成坐标，不用 GPT。
// 每步执行后检查界面有没有变化（可选再让 UI-TARS 判断 expect 是否成立）；
// 检查失败时交给 GPT 规划器从当前画面接着做（--no-fallback 关闭），--heal 会用成功的新路径更新模板。
//
// 用法: node replay.mjs bing-search
//       node replay.mjs bing-search --var keyword=电动滑板车
//       node replay.mjs bing-search --heal
//       node replay.mjs --list
import { parseArgs } from './lib.mjs';
import { listRecipes, runRecipe } from './recipes.mjs';

const opts = parseArgs(process.argv.slice(2), ['--heal', '--no-fallback', '--list', '--check-expect']);

if (opts.list) {
  for (const r of listRecipes()) console.log(`${r.name}  (${r.steps} 步)  ${r.task}  变量: ${JSON.stringify(r.vars)}`);
  process.exit(0);
}
if (!opts.text) {
  console.error('用法: node replay.mjs NAME [--var k=v ...] [--cdp 标签页网址关键字 [--browser edge] | --focus 窗口标题] [--heal] [--no-fallback] [--check-expect]  |  node replay.mjs --list');
  process.exit(1);
}

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

const r = await runRecipe({
  name: opts.text,
  vars: opts.vars,
  fallback: !opts['no-fallback'],
  heal: !!opts.heal,
  checkExpect: opts['check-expect'] ? true : undefined,
  maxSteps: opts['max-steps'] ? Number(opts['max-steps']) : undefined,
  signal: abort.signal,
  focus: opts.focus,
  cdp: opts.cdp,
  browser: opts.browser,
});
if (r.usedGPT) console.log(`\n[${r.status}] ${r.answer}`);
process.exit(r.status === 'done' ? 0 : 1);
