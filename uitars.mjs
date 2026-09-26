#!/usr/bin/env node
// UI-TARS-1.5 单模型模式：截图 → 本地 vLLM 上的 UI-TARS-1.5-7B（自己想、自己定位）→ 鼠标/键盘操作整个桌面。
// 官方 @ui-tars/cli 没传 uiTarsVersion，会按 1.0 解析坐标导致点偏，所以这里直接调 SDK。
// 多步任务更推荐 agent.mjs（GPT 规划 + UI-TARS 定位）。
//
// 用法: node uitars.mjs "打开记事本，输入 hello"
//       node uitars.mjs --max-steps 30 "..."
import { GUIAgent, UITarsModelVersion } from '@ui-tars/sdk';
import { cfg, SYSTEM_PROMPT_V1_5, HiResNutJSOperator, localFetch } from './lib.mjs';

const args = process.argv.slice(2);
let maxLoopCount = cfg.maxSteps ?? 25;
const i = args.indexOf('--max-steps');
if (i >= 0) {
  maxLoopCount = Number(args[i + 1]);
  args.splice(i, 2);
}
const instruction = args.join(' ').trim();
if (!instruction) {
  console.error('用法: node uitars.mjs [--max-steps N] "你的指令"');
  process.exit(1);
}

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

let printed = 0;
const t0 = Date.now();
const agent = new GUIAgent({
  model: {
    baseURL: cfg.baseURL ?? 'http://127.0.0.1:8000/v1',
    apiKey: cfg.apiKey ?? 'local',
    model: cfg.model ?? 'ui-tars',
    max_tokens: cfg.maxTokens ?? 1024,
    fetch: localFetch,
  },
  uiTarsVersion: UITarsModelVersion.V1_5,
  systemPrompt: SYSTEM_PROMPT_V1_5,
  operator: new HiResNutJSOperator(),
  maxLoopCount,
  retry: { screenshot: { maxRetries: 2 } },
  signal: abort.signal,
  logger: { ...console, info: () => {} },
  onData: ({ data }) => {
    for (const c of data.conversations ?? []) {
      if (c.from === 'gpt' && c.value) console.log(`\n[step ${++printed}] (+${((Date.now() - t0) / 1000).toFixed(1)}s) ${c.value.trim()}`);
    }
    if (data.status && data.status !== 'running') console.log(`[status] ${data.status}`);
  },
  onError: ({ error }) => console.error('[error]', error?.message ?? error),
});

await agent.run(instruction);
