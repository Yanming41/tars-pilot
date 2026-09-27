#!/usr/bin/env node
// 规划器 + 定位器模式：
//   GPT（通过 Codex SDK，走 ChatGPT 订阅）看缩小截图，决定下一步做什么、点"哪个元素"（自然语言）；
//   本地 UI-TARS-1.5-7B 看原图，把元素描述变成坐标；nut-js 执行。
//
// 用法: node agent.mjs "打开Chrome，访问 bing.com，搜索 UI-TARS"
//       node agent.mjs --max-steps 30 "..."
//       录制成模板（成功后保存到 recipes/NAME.json，任务里的 {{变量}} 会保留在模板里）：
//       node agent.mjs --save bing-search --var keyword=UI-TARS "打开Chrome，访问 bing.com，搜索 {{keyword}}"
//       --focus 小红书：开始前先把标题包含「小红书」的窗口切到前台（存模板时一起记下，回放会自动切）
import { cfg, parseArgs, fillVars } from './lib.mjs';
import { runAgent } from './planner.mjs';
import { saveRecipe } from './recipes.mjs';

const opts = parseArgs(process.argv.slice(2));
if (!opts.text) {
  console.error('用法: node agent.mjs [--max-steps N] [--focus 窗口标题] [--save NAME] [--var k=v ...] "你的任务"');
  process.exit(1);
}
const task = fillVars(opts.text, opts.vars);

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

const t0 = Date.now();
const { result, steps } = await runAgent({
  task,
  maxSteps: Number(opts['max-steps'] ?? cfg.maxSteps ?? 25),
  signal: abort.signal,
  focus: opts.focus,
});
console.log(`\n[${result.status}] (+${((Date.now() - t0) / 1000).toFixed(1)}s) ${result.answer}`);

if (opts.save) {
  if (result.status !== 'done') {
    console.log('任务没有成功完成，不保存模板');
  } else {
    const file = saveRecipe(opts.save, opts.text, opts.vars, steps, opts.focus);
    console.log(file ? `模板已保存: ${file}（${steps.length} 步）` : '没有执行任何动作（屏幕一开始就满足任务），不保存模板；换个起始状态或变量值再录');
  }
}
process.exit(result.status === 'done' ? 0 : 1);
