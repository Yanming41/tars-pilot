// uitars.mjs / agent.mjs / replay.mjs 共用的部分：配置、截图、UI-TARS 定位、动作执行、模板变量
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { actionParser } from '@ui-tars/action-parser';
import { UITarsModelVersion } from '@ui-tars/sdk';
import { NutJSOperator } from '@ui-tars/operator-nut-js';
import { screen, sleep } from '@computer-use/nut-js';
import { Jimp } from 'jimp';

export { sleep };
export const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = [join(here, 'config.json'), join(homedir(), '.ui-tars-cli.json')].find(existsSync);
export const cfg = cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf-8')) : {};

// NutJS 操控器在 GUIAgent 之外默认用 console.info 打调试信息，刷屏
if (!cfg.debug) console.info = () => {};

// UI-TARS-1.5 官方 COMPUTER_USE 提示词（点坐标格式）；SDK 默认的是 1.0 的框坐标格式
export const SYSTEM_PROMPT_V1_5 = `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Format
\`\`\`
Thought: ...
Action: ...
\`\`\`

## Action Space

click(start_box='<|box_start|>(x1,y1)<|box_end|>')
left_double(start_box='<|box_start|>(x1,y1)<|box_end|>')
right_single(start_box='<|box_start|>(x1,y1)<|box_end|>')
drag(start_box='<|box_start|>(x1,y1)<|box_end|>', end_box='<|box_start|>(x3,y3)<|box_end|>')
hotkey(key='ctrl c') # Split keys with a space and use lowercase. Also, do not use more than 3 keys in one hotkey action.
type(content='xxx') # Use escape characters \\', \\", and \\n in content part to ensure we can parse the content in normal python string format. If you want to submit your input, use \\n at the end of content.
scroll(start_box='<|box_start|>(x1,y1)<|box_end|>', direction='down or up or right or left') # Show more information on the \`direction\` side.
wait() #Sleep for 5s and take a screenshot to check for any changes.
finished(content='xxx') # Use escape characters \\', \\", and \\n in content part to ensure we can parse the content in normal python string format.

## Note
- Use ${cfg.language ?? 'Chinese'} in \`Thought\` part.
- Write a small plan and finally summarize your next action (with its target element) in one sentence in \`Thought\` part.

## User Instruction
`;

// 官方 NutJSOperator 会把截图缩到逻辑分辨率（175% 缩放下 2560x1440 -> 1463x823），
// 模型看到的图太糊、点不准。这里改为发原始物理分辨率截图，执行时再换算回逻辑坐标给鼠标用；
// 并且每步动作后等一会儿，避免下一张截图还没反映出界面变化。
export class HiResNutJSOperator extends NutJSOperator {
  async screenshot() {
    const img = await (await screen.grab()).toRGB();
    // JPEG 比 PNG 小约 3 倍；SDK 固定标成 image/png，但 vLLM 按内容解码，不受影响
    const buf = await Jimp.fromBitmap({ width: img.width, height: img.height, data: Buffer.from(img.data) }).getBuffer('image/jpeg', { quality: 85 });
    return { base64: buf.toString('base64'), scaleFactor: img.pixelDensity.scaleX };
  }
  async execute(params) {
    const s = params.scaleFactor || 1;
    const out = await super.execute({ ...params, screenWidth: params.screenWidth / s, screenHeight: params.screenHeight / s });
    await sleep(cfg.settleMs ?? 1000);
    return out;
  }
}

// 访问本地 vLLM 用的 fetch：
// SDK 把每次请求超时写死为 30s，本地带多张高清截图时可能超过；去掉它的 signal，改用自己的超时。
// 另外 SDK 模型重试有 bug（失败一次就把状态标成 ERROR，重试成功后循环照样退出），
// 所以连接被重置这类网络错误在这里直接重试，不让 SDK 看到。
export async function localFetch(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const start = Date.now();
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout((cfg.requestTimeoutSec ?? 180) * 1000) });
    } catch (e) {
      const reason = `${e.message} | ${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`;
      if (e.name === 'TimeoutError' || attempt >= 4) {
        console.error(`[fetch] failed after ${((Date.now() - start) / 1000).toFixed(1)}s: ${reason}`);
        throw e;
      }
      if (cfg.debug) console.error(`[fetch] retry ${attempt}: ${reason}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// Qwen2.5-VL / UI-TARS-1.5 的图片缩放规则，模型输出的坐标就在这个缩放后的像素空间里
export function smartResize(height, width, factor = 28, minPixels = 78400, maxPixels = 12845056) {
  let h = Math.max(factor, Math.round(height / factor) * factor);
  let w = Math.max(factor, Math.round(width / factor) * factor);
  if (h * w > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    h = Math.floor(height / beta / factor) * factor;
    w = Math.floor(width / beta / factor) * factor;
  } else if (h * w < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    h = Math.ceil((height * beta) / factor) * factor;
    w = Math.ceil((width * beta) / factor) * factor;
  }
  return { height: h, width: w };
}

// ---------- 截图 ----------
// plannerPath 给了才会额外存一张缩小图（给 GPT 看），并用红圈标出 lastClick（物理像素坐标）
export async function capture({ plannerPath, plannerWidth = 1280, lastClick } = {}) {
  const raw = await (await screen.grab()).toRGB();
  const full = Jimp.fromBitmap({ width: raw.width, height: raw.height, data: Buffer.from(raw.data) });
  const hiB64 = (await full.getBuffer('image/jpeg', { quality: 85 })).toString('base64');

  if (plannerPath) {
    const w = plannerWidth;
    const small = full.clone().resize({ w, h: Math.round((raw.height * w) / raw.width) });
    if (lastClick) {
      const k = w / raw.width;
      const cx = lastClick.px * k;
      const cy = lastClick.py * k;
      for (let r = 14; r <= 17; r++) {
        for (let a = 0; a < 360; a++) {
          const x = Math.round(cx + r * Math.cos((a * Math.PI) / 180));
          const y = Math.round(cy + r * Math.sin((a * Math.PI) / 180));
          if (x >= 0 && y >= 0 && x < small.width && y < small.height) small.setPixelColor(0xff0000ff, x, y);
        }
      }
    }
    await small.write(plannerPath, { quality: 80 });
  }

  // 用于判断"界面有没有变化"的小灰度图
  const thumb = full.clone().resize({ w: 320, h: 180 }).greyscale().bitmap.data;
  return { hiB64, width: raw.width, height: raw.height, scaleFactor: raw.pixelDensity.scaleX, plannerPath, thumb };
}

// 变化的像素个数（320x180 灰度图上）。计算器数字从 0 变 1 这种小变化也只有十几个像素，所以按个数不按比例
export function changedPixels(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 20) diff++;
  return diff;
}
export const isChanged = (a, b) => changedPixels(a, b) >= (cfg.minChangedPixels ?? 6);

// ---------- UI-TARS：定位 / 判断 ----------
const grounder = new OpenAI({
  baseURL: cfg.baseURL ?? 'http://127.0.0.1:8000/v1',
  apiKey: cfg.apiKey ?? 'local',
  fetch: localFetch,
  maxRetries: 0,
});

export async function askGrounder(shot, text, maxTokens = 300) {
  const r = await grounder.chat.completions.create({
    model: cfg.model ?? 'ui-tars',
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.hiB64}` } },
      ],
    }],
  });
  return r.choices[0].message.content ?? '';
}

// short：UI-TARS 评测定位时用的"只输出坐标"提示词，比完整 Thought+Action 快约 1 秒；
// full：完整电脑操作提示词（先写 Thought 再给坐标）。short 解析不到坐标时自动退回 full。
const GROUND_SHORT = (t) => `Output only the coordinate of one point in your response. What element matches the following task: ${t}`;

export async function ground(shot, target) {
  const coord = /\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)/;
  let out = '';
  let m = null;
  if ((cfg.grounderPrompt ?? 'short') === 'short') {
    out = await askGrounder(shot, GROUND_SHORT(target));
    m = out.match(coord);
  }
  if (!m) {
    out = await askGrounder(shot, `${SYSTEM_PROMPT_V1_5}点击${target}`);
    m = out.match(/Action:[\s\S]*?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)/);
  }
  if (!m) throw new Error(`UI-TARS 没给出坐标: ${out.slice(0, 200)}`);
  const { width: rw, height: rh } = smartResize(shot.height, shot.width);
  const mx = Number(m[1]);
  const my = Number(m[2]);
  // mx/my：模型坐标（缩放后空间，交给解析器）；px/py：物理像素位置（画红圈、打日志）
  return { mx, my, px: Math.round((mx / rw) * shot.width), py: Math.round((my / rh) * shot.height) };
}

// ---------- 执行：拼成 UI-TARS 动作字符串，复用官方解析器 + 高清版 NutJS 操控器 ----------
const operator = new HiResNutJSOperator();
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

async function execute(shot, actionStr) {
  const { parsed } = actionParser({
    prediction: `Thought: -\nAction: ${actionStr}`,
    factor: [1000, 1000],
    screenContext: { width: shot.width, height: shot.height },
    scaleFactor: shot.scaleFactor,
    modelVer: UITarsModelVersion.V1_5,
  });
  if (!parsed?.length) throw new Error(`动作解析失败: ${actionStr}`);
  await operator.execute({
    prediction: actionStr,
    parsedPrediction: parsed[0],
    factors: [1000, 1000],
    screenWidth: shot.width,
    screenHeight: shot.height,
    scaleFactor: shot.scaleFactor,
  });
}

// 一步动作的统一格式（规划器输出和模板共用）：
//   { action: click|double_click|right_click|type|hotkey|scroll|wait, target?, text?, submit?, keys?, direction?, seconds?, expect? }
export function describeStep(st) {
  switch (st.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${st.action}「${st.target}」`;
    case 'type':
      return `输入 "${st.text}"${st.submit ? ' 并回车' : ''}`;
    case 'hotkey':
      return `按快捷键 ${st.keys}`;
    case 'scroll':
      return `在${st.target || '屏幕中央'}向${st.direction === 'up' ? '上' : '下'}滚动`;
    case 'wait':
      return `等待 ${st.seconds ?? 3} 秒`;
    default:
      return '没有动作';
  }
}

// 执行一步，返回 { desc, click }；click 是实际点击位置（物理像素），用于给规划器画红圈
export async function runStep(shot, st) {
  switch (st.action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const tg = Date.now();
      const g = await ground(shot, st.target);
      const fn = { click: 'click', double_click: 'left_double', right_click: 'right_single' }[st.action];
      console.log(`  动作: ${describeStep(st)} → 定位 (${g.px},${g.py})，${((Date.now() - tg) / 1000).toFixed(1)}s`);
      await execute(shot, `${fn}(start_box='(${g.mx},${g.my})')`);
      return { desc: `${describeStep(st)}，点在屏幕 (${g.px},${g.py})（截图上的红圈）`, click: g };
    }
    case 'type':
      console.log(`  动作: ${describeStep(st)}`);
      await execute(shot, `type(content='${esc(st.text + (st.submit ? '\n' : ''))}')`);
      return { desc: describeStep(st) };
    case 'hotkey':
      console.log(`  动作: ${describeStep(st)}`);
      await execute(shot, `hotkey(key='${esc(st.keys)}')`);
      return { desc: describeStep(st) };
    case 'scroll': {
      const dir = st.direction === 'up' ? 'up' : 'down';
      let mx;
      let my;
      if (st.target) {
        ({ mx, my } = await ground(shot, st.target));
      } else {
        const rs = smartResize(shot.height, shot.width);
        mx = Math.round(rs.width / 2);
        my = Math.round(rs.height / 2);
      }
      console.log(`  动作: ${describeStep(st)}`);
      await execute(shot, `scroll(start_box='(${mx},${my})', direction='${dir}')`);
      return { desc: describeStep(st) };
    }
    case 'wait':
      console.log(`  动作: ${describeStep(st)}`);
      await sleep((st.seconds ?? 3) * 1000);
      return { desc: describeStep(st) };
    default:
      return { desc: '没有执行动作' };
  }
}

// ---------- 命令行参数 / 模板变量 ----------
// 解析 --max-steps N、--save NAME、--var k=v（可多次）、--flag 这类参数，剩下的拼成任务文本
export function parseArgs(argv, flags = []) {
  const opts = { vars: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--var') {
      const [k, ...v] = argv[++i].split('=');
      opts.vars[k] = v.join('=');
    } else if (flags.includes(a)) {
      opts[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      opts[a.slice(2)] = argv[++i];
    } else {
      rest.push(a);
    }
  }
  opts.text = rest.join(' ').trim();
  return opts;
}

export const fillVars = (s, vars) => (s ?? '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

// 把步骤里出现的变量值换回 {{变量名}}，长的值先换
export function templatize(st, vars) {
  const entries = Object.entries(vars).filter(([, v]) => v).sort((a, b) => b[1].length - a[1].length);
  const out = { ...st };
  for (const f of ['target', 'text', 'expect']) {
    if (!out[f]) continue;
    for (const [k, v] of entries) out[f] = out[f].split(v).join(`{{${k}}}`);
  }
  return out;
}
