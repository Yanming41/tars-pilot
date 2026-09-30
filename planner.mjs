// GPT 规划循环（通过 Codex SDK，走 ChatGPT 订阅），agent.mjs 和模板回放的自愈兜底都用它
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { cfg, here, capture, isChanged, runStep, focusWindow, sleep, osDriver } from './lib.mjs';
import { CdpDriver } from './cdp.mjs';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['observation', 'progress', 'status', 'action_type', 'target', 'text', 'submit', 'keys', 'direction', 'expect', 'answer'],
  properties: {
    observation: { type: 'string', description: '当前屏幕上与任务相关的状态；上一步是否达到预期（结合红圈位置和界面变化判断）' },
    progress: { type: 'string', description: '已完成哪些子目标、接下来还剩什么' },
    status: { type: 'string', enum: ['continue', 'done', 'fail'] },
    action_type: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'hotkey', 'scroll', 'navigate', 'wait', 'none'] },
    target: { type: 'string', description: 'click/double_click/right_click/scroll 的目标元素描述；其他动作填空字符串' },
    text: { type: 'string', description: 'type 时要输入的文字；navigate 时要打开的网址；其他动作填空字符串' },
    submit: { type: 'boolean', description: 'type 后是否按回车' },
    keys: { type: 'string', description: 'hotkey 的按键，小写空格分隔，如 "ctrl a"；其他动作填空字符串' },
    direction: { type: 'string', enum: ['up', 'down', 'none'] },
    expect: { type: 'string', description: '执行这个动作后屏幕上应该出现的变化，一句话、具体可见（以后回放时用来检查这一步是否成功）；没有动作时填空字符串' },
    answer: { type: 'string', description: 'status 为 done/fail 时给用户的结果或原因；否则空字符串' },
  },
};

const intro = (task, context, driverKind) => `你是一个电脑操作智能体的"规划器"。你看不到鼠标，也不能自己点击，只负责决策；不要执行任何命令、不要读写文件。
另一个"定位模型"会根据你写的 target 在高清截图上找到元素并点击，它只会看图找元素，不懂上下文。
${driverKind === 'cdp' ? '\n注意：截图只包含一个浏览器标签页的网页内容，看不到浏览器地址栏、标签栏和桌面；要打开网址用 navigate（text 填网址），不要用 ctrl l。\n' : ''}
用户任务：${task}
${context ? `\n补充情况：${context}\n` : ''}
规则：
1. 每轮我给你当前截图（已缩小）和上一步的执行结果。红圈标出的是上一步实际点击的位置。
2. 每轮只给一个原子动作。输入文字前，先用一步 click 点中输入框。
3. target 要能在截图上唯一定位：写元素上的可见文字、图标外观、所在区域（如"页面顶部搜索框右侧的放大镜图标"）。不要写坐标。
4. 上一步如果"界面无明显变化"或红圈位置不对，说明没生效：换一种目标描述或换一种方法，同一动作不要重复超过 2 次。
5. 能用快捷键更稳的就用 hotkey。
6. 遇到登录、验证码、支付，或需要用户确认的情况，返回 status=fail 并说明原因。
7. 不做付款、删除、发送消息、发布内容等不可逆操作，除非用户任务明确要求。
8. 任务完成后返回 status=done，answer 里写结果（如果任务要求读取信息，把信息写进 answer）。`;

/**
 * GPT 规划 + UI-TARS 定位。
 *   cdp：浏览器标签页的网址/标题关键字 → 用 CDP 驱动（不动真实鼠标）；不给就用系统驱动（整个屏幕 + 真实鼠标）
 *   browser：cdp 连哪个浏览器（chrome / edge / http://127.0.0.1:端口），默认 chrome
 *   focus：系统驱动下，开始前先把标题包含这段文字的窗口切到前台
 *   driver：直接传一个已经连好的驱动（模板回放兜底时复用），传了就不再按 cdp/focus 创建
 * 返回 { result: {status, answer}, steps: [已执行的动作（统一步骤格式，含 expect）], usage }
 */
export async function runAgent({ task, context = '', maxSteps = cfg.maxSteps ?? 25, signal, focus, cdp, browser, driver, workDir = join(here, '.planner-work') }) {
  const plannerCfg = { effort: 'low', screenshotWidth: 1280, ...cfg.planner };
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const ownDriver = !driver;
  if (!driver) driver = cdp ? await CdpDriver.connect(cdp, browser) : osDriver;
  try {
    if (driver.kind === 'os' && focus) {
      await focusWindow(focus);
      await sleep(500);
    }

    const codexConfig = { model_reasoning_effort: plannerCfg.effort };
    if (plannerCfg.model) codexConfig.model = plannerCfg.model;
    const thread = new Codex({ config: codexConfig }).startThread({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      webSearchEnabled: false,
      workingDirectory: workDir,
    });

    const t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    const steps = [];
    let usage = null; // Codex 返回的是整个会话的累计用量
    let lastClick = null;
    let feedback = '';
    let prevThumb = null;
    let stuck = 0;
    let result = null;

    for (let step = 1; step <= maxSteps && !signal?.aborted; step++) {
      const shot = await capture(driver, {
        plannerPath: join(workDir, `step-${String(step).padStart(2, '0')}.jpg`),
        plannerWidth: plannerCfg.screenshotWidth,
        lastClick,
      });
      if (prevThumb) {
        const changed = isChanged(prevThumb, shot.thumb);
        stuck = changed ? 0 : stuck + 1;
        feedback += changed ? '；界面有变化' : '；界面无明显变化';
        if (stuck >= (cfg.maxNoChange ?? 4)) {
          result = { status: 'fail', answer: `连续 ${stuck} 步界面无变化，已停止` };
          break;
        }
      }
      prevThumb = shot.thumb;

      const tp = Date.now();
      const text = step === 1 ? `${intro(task, context, driver.kind)}\n\n第 1 步，这是当前屏幕。` : `第 ${step} 步。上一步执行结果：${feedback}\n这是当前屏幕。`;
      const r = await thread.run([{ type: 'text', text }, { type: 'local_image', path: shot.plannerPath }], { outputSchema: schema, signal });
      if (r.usage) usage = r.usage;
      const d = JSON.parse(r.finalResponse);
      console.log(`\n[GPT step ${step}] (+${secs()}s, 规划 ${((Date.now() - tp) / 1000).toFixed(1)}s) ${d.observation}\n  进度: ${d.progress}`);
      if (d.status !== 'continue') {
        result = { status: d.status, answer: d.answer };
        break;
      }

      const st = { action: d.action_type };
      if (d.target) st.target = d.target;
      if (d.action_type === 'type' || d.action_type === 'navigate') st.text = d.text;
      if (d.action_type === 'type' && d.submit) st.submit = true;
      if (d.keys) st.keys = d.keys;
      if (d.action_type === 'scroll') st.direction = d.direction === 'up' ? 'up' : 'down';
      if (d.expect) st.expect = d.expect;

      lastClick = null;
      try {
        const out = await runStep(shot, st, driver);
        lastClick = out.click ?? null;
        feedback = out.desc;
        if (st.action !== 'none') steps.push(st);
      } catch (e) {
        console.error(`  执行出错: ${e.message}`);
        feedback = `执行出错：${e.message}`;
      }
    }

    if (!result) result = { status: 'fail', answer: signal?.aborted ? '用户中断' : `达到最大步数 ${maxSteps}` };
    if (usage) {
      console.log(`规划器用量(ChatGPT 订阅): 输入 ${usage.input_tokens} tokens（其中缓存 ${usage.cached_input_tokens}），输出 ${usage.output_tokens}`);
    }
    return { result, steps, usage };
  } finally {
    if (ownDriver) await driver.close();
  }
}
