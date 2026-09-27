// 模板的保存 / 列出 / 回放（replay.mjs 命令行和 server.mjs 接口共用）
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, here, fillVars, templatize, capture, isChanged, runStep, askGrounder, describeStep, sleep, focusWindow } from './lib.mjs';
import { runAgent } from './planner.mjs';

export const recipesDir = join(here, 'recipes');
const recipeFile = (name) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`模板名只能包含字母、数字、_ . -：${name}`);
  return join(recipesDir, `${name}.json`);
};

export function listRecipes() {
  if (!existsSync(recipesDir)) return [];
  return readdirSync(recipesDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.bak.json'))
    .map((f) => {
      const r = JSON.parse(readFileSync(join(recipesDir, f), 'utf-8'));
      return { name: r.name, task: r.task, vars: r.vars, focus: r.focus, steps: r.steps.length, createdAt: r.createdAt, updatedAt: r.updatedAt };
    });
}

export function loadRecipe(name) {
  return JSON.parse(readFileSync(recipeFile(name), 'utf-8'));
}

// 把 runAgent 实际执行的步骤存成模板；0 步不存。返回保存路径或 null
// focus：回放前要切到前台的窗口标题关键字（录制时用了 --focus 就一起存下来）
export function saveRecipe(name, taskTemplate, vars, steps, focus) {
  if (!steps.length) return null;
  mkdirSync(recipesDir, { recursive: true });
  const file = recipeFile(name);
  const recipe = {
    name,
    task: taskTemplate, // 保留 {{变量}}
    vars, // 录制时用的值，回放时不传就用这些
    ...(focus ? { focus } : {}),
    createdAt: new Date().toISOString(),
    steps: steps.map((st) => templatize(st, vars)),
  };
  writeFileSync(file, JSON.stringify(recipe, null, 2));
  return file;
}

// 让 UI-TARS 判断截图是否符合描述（只回答 是/否）。实测偏向答"是"，默认不用
async function expectHolds(shot, expect) {
  const out = await askGrounder(shot, `请仔细看截图，判断下面这句话描述的情况是否已经出现在屏幕上：\n「${expect}」\n只回答一个字：是 或 否。`, 10);
  return !out.includes('否');
}

/**
 * 按模板回放。每一步由模板决定做什么，UI-TARS 只负责把元素描述变成坐标，不用 GPT；
 * 某步执行后界面没变化（或 expect 检查不通过）就交给 GPT 从当前画面接着做。
 * 返回 { status: 'done'|'fail'|'cancelled', answer, usedGPT, failedStep, reason, durationMs, healed }
 */
export async function runRecipe({ name, vars = {}, fallback = true, heal = false, checkExpect, maxSteps, signal, focus }) {
  const recipe = loadRecipe(name);
  const allVars = { ...recipe.vars, ...vars };
  const task = fillVars(recipe.task, allVars);
  const steps = recipe.steps.map((st) => ({ ...st, target: fillVars(st.target, allVars), text: fillVars(st.text, allVars), expect: fillVars(st.expect, allVars) }));
  const replayCfg = { verifyTimeoutMs: 6000, checkExpect: false, ...cfg.replay };
  const doCheckExpect = checkExpect ?? replayCfg.checkExpect;

  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  const finish = (r) => ({ usedGPT: false, failedStep: null, reason: '', healed: false, ...r, durationMs: Date.now() - t0 });
  console.log(`回放模板 ${recipe.name}：${task}（${steps.length} 步）`);

  // 等待界面变化（页面加载可能要一会儿），最多 verifyTimeoutMs
  async function waitForChange(before) {
    const deadline = Date.now() + replayCfg.verifyTimeoutMs;
    for (;;) {
      const after = await capture();
      if (isChanged(before.thumb, after.thumb)) return after;
      if (Date.now() > deadline || signal?.aborted) return null;
      await sleep(1000);
    }
  }

  const focusTitle = focus ?? recipe.focus;
  if (focusTitle) {
    try {
      await focusWindow(focusTitle);
      await sleep(500);
    } catch (e) {
      return finish({ status: 'fail', answer: e.message, reason: e.message });
    }
  }

  let shot = await capture();
  let failedAt = -1;
  let reason = '';
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) return finish({ status: 'cancelled', answer: '已取消' });
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
    if (doCheckExpect && st.expect) {
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

  if (signal?.aborted) return finish({ status: 'cancelled', answer: '已取消' });
  if (failedAt < 0) {
    console.log(`\n[done] (+${secs()}s) 模板 ${steps.length} 步全部执行完成，没有调用 GPT`);
    return finish({ status: 'done', answer: `模板 ${steps.length} 步全部执行完成` });
  }

  console.log(`\n[step ${failedAt + 1} 失败] ${reason}`);
  if (!fallback) return finish({ status: 'fail', answer: `第 ${failedAt + 1} 步失败：${reason}`, failedStep: failedAt + 1, reason });

  // ---------- 自愈：交给 GPT 从当前画面接着做 ----------
  const done = steps.slice(0, failedAt).map((st, k) => `${k + 1}. ${describeStep(st)}`).join('\n');
  const context = `这个任务之前一直按固定步骤自动执行。已经完成的步骤：\n${done || '（无）'}\n第 ${failedAt + 1} 步「${describeStep(steps[failedAt])}」出了问题：${reason}。\n请根据当前屏幕状态判断实际进展，从这里继续把任务完成（之前的步骤不用重做，除非屏幕显示它们没有生效）。`;
  console.log('交给 GPT 规划器继续...');
  const { result, steps: gptSteps } = await runAgent({ task, context, maxSteps: maxSteps ?? cfg.maxSteps ?? 25, signal });
  console.log(`\n[${result.status}] (+${secs()}s) ${result.answer}`);

  let healed = false;
  if (heal && result.status === 'done') {
    const file = recipeFile(name);
    copyFileSync(file, file.replace(/\.json$/, '.bak.json'));
    const updated = {
      ...recipe,
      updatedAt: new Date().toISOString(),
      steps: [...recipe.steps.slice(0, failedAt), ...gptSteps.map((st) => templatize(st, allVars))],
    };
    writeFileSync(file, JSON.stringify(updated, null, 2));
    healed = true;
    console.log(`模板已更新（旧版备份为 ${recipe.name}.bak.json）：${updated.steps.length} 步`);
  }
  return finish({ status: result.status, answer: result.answer, usedGPT: true, failedStep: failedAt + 1, reason, healed });
}
