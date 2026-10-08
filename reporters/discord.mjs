// 把 tars-pilot 的每个任务播报到 Discord：一张卡片，执行中原地刷新(第几步、当前进度、最近动作)，结束时变成结果；
// 需要用户马上处理的通知([通知] 开头的日志行，比如 Duo 匹配码)和任务结束时，各发一条 @ 用户。
//
// 发到哪：请求里的 discord_channel_id(主频道，或者论坛里某个帖子的 ID)；没给就发主频道。
// 调用方通常不用手填：Python 客户端会自动读环境变量 TARS_DISCORD_CHANNEL 带上。
//
// 配置放在仓库外(webhook 地址相当于发言密码)，默认 ~/.discord_dm/tars_discord.json：
//   { "mainChannelId": "...", "forumChannelId": "...", "ownerId": "...",
//     "webhooks": { "<主频道ID>": "https://discord.com/api/webhooks/...", "<论坛频道ID>": "..." } }
// 文件不存在就不播报，tars-pilot 其他功能不受影响。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EDIT_MS = 5000;
const DEFAULT_MAX_STEPS = 25;
const NO_MENTIONS = { parse: [] };

function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
const plain = (t) => String(t ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim();

export function parseLog(log) {
  const info = { step: 0, totalSteps: null, progress: null, actions: [], notices: [], modelStarting: false };
  for (const raw of log ?? []) {
    for (const line of String(raw).split('\n')) {
      const t = line.trim();
      let m;
      if ((m = t.match(/^\[step (\d+)\/(\d+)\]/))) {
        info.step = Number(m[1]);
        info.totalSteps = Number(m[2]);
        info.actions.push(t.replace(/^\[step \d+\/\d+\]\s*\(\+[\d.]+s\)\s*/, ''));
      } else if ((m = t.match(/^\[GPT step (\d+)\]/))) {
        info.step = Number(m[1]);
        info.totalSteps = null; // 模板回放失败后交给 GPT 兜底，总步数不再确定
      } else if ((m = t.match(/^进度[:：]\s*(.+)/))) {
        info.progress = m[1];
      } else if ((m = t.match(/^动作[:：]\s*(.+)/))) {
        info.actions.push(m[1].replace(/\s*→\s*定位.*$/, ''));
      } else if ((m = t.match(/^\[通知\]\s*(.+)/))) {
        info.notices.push(m[1]);
      } else if (t.startsWith('[model] 启动')) {
        info.modelStarting = true;
      } else if (t.startsWith('[model] 模型就绪')) {
        info.modelStarting = false;
      }
    }
  }
  return info;
}

function describeTask(req) {
  if (req.recipe) {
    const vars = req.vars && Object.keys(req.vars).length ? ` ${JSON.stringify(req.vars)}` : '';
    return `模板 \`${req.recipe}\`${vars}`;
  }
  return clip(plain(req.task || '(没有描述)'), 300);
}

export function renderCard(run) {
  const req = run.request ?? {};
  const info = parseLog(run.log);
  const head = [
    `🖱️ **网页任务** · \`${String(run.id).slice(0, 8)}\`${req.caller ? ` · 来自 ${req.caller}` : ''}`,
    `**任务**：${describeTask(req)}`,
    `**网站**：${req.browser || 'chrome'} · ${req.cdp || '当前标签页'}`,
  ];
  const startedAt = Date.parse(run.startedAt || run.createdAt || '') || Date.now();

  if (run.status === 'queued') return [...head, '🕒 排队中：前面还有任务(鼠标键盘只有一套，只能一个个来)'].join('\n');
  if (run.status === 'running') {
    const max = info.totalSteps ?? req.maxSteps ?? DEFAULT_MAX_STEPS;
    const stepText = info.step ? (info.totalSteps ? `第 ${info.step}/${max} 步` : `第 ${info.step} 步(最多 ${max} 步)`) : '准备中';
    const lines = [...head, `⏳ 进行中 · ${stepText} · 已用 ${formatElapsed(Date.now() - startedAt)}`];
    if (info.modelStarting && !info.step) lines.push('正在启动本地视觉模型，第一次要 1-2 分钟…');
    if (info.progress) lines.push(`**进度**：${clip(plain(info.progress), 200)}`);
    lines.push(...info.actions.slice(-3).map((a) => `• \`${clip(plain(a), 90)}\``));
    return lines.join('\n');
  }

  const result = run.result ?? {};
  const took = formatElapsed(result.durationMs ?? Date.now() - startedAt);
  const steps = result.steps ?? info.step;
  const answer = clip(plain(result.answer || result.reason || ''), 600);
  if (run.status === 'done') return [...head, `✅ 完成 · 用时 ${took} · 共 ${steps} 步`, answer && `**结果**：${answer}`].filter(Boolean).join('\n');
  if (run.status === 'cancelled') return [...head, `⏹ 已取消 · 用时 ${took}`, answer && `**说明**：${answer}`].filter(Boolean).join('\n');
  return [...head, `❌ 没完成 · 用时 ${took}${steps ? ` · 停在第 ${steps} 步` : ''}`, answer && `**原因**：${answer}`].filter(Boolean).join('\n');
}

/** 返回 { onCreated, onLog, onFinished }；没有配置文件时返回 null(不播报)。三个回调都不会抛错。 */
export function createDiscordReporter(configPath = join(homedir(), '.discord_dm', 'tars_discord.json')) {
  if (!existsSync(configPath)) return null;
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const { mainChannelId, forumChannelId, ownerId, webhooks = {} } = cfg;
  if (!mainChannelId || !webhooks[mainChannelId]) return null;

  // 主频道直接发；其他频道 ID 当作论坛里的帖子，用论坛的 webhook 加 thread_id
  const target = (channelId) =>
    channelId === mainChannelId || !webhooks[forumChannelId]
      ? { url: webhooks[mainChannelId], query: '' }
      : { url: webhooks[forumChannelId], query: `thread_id=${channelId}` };

  const post = async (channelId, content, mention = false) => {
    const t = target(channelId);
    const res = await fetch(`${t.url}?${['wait=true', t.query].filter(Boolean).join('&')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: mention && ownerId ? { users: [ownerId] } : NO_MENTIONS }),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
    return res.json();
  };
  const edit = async (channelId, messageId, content) => {
    const t = target(channelId);
    const res = await fetch(`${t.url}/messages/${messageId}${t.query ? `?${t.query}` : ''}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: NO_MENTIONS }),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  };

  // 每个任务一份播报状态；同一个任务的 Discord 操作串行执行，保证先发卡片再改卡片
  const states = new Map();
  const stateOf = (run) => {
    if (!states.has(run.id)) {
      states.set(run.id, { channelId: run.request?.discord_channel_id || mainChannelId, messageId: null, lastCard: '', lastEdit: 0, timer: null, chain: Promise.resolve() });
    }
    return states.get(run.id);
  };
  const enqueue = (st, job) => {
    st.chain = st.chain.then(job).catch((e) => process.stdout.write(`[discord] 播报失败: ${e.message}\n`));
    return st.chain;
  };

  const refresh = (run, st) =>
    enqueue(st, async () => {
      const card = renderCard(run);
      if (!st.messageId) {
        st.messageId = (await post(st.channelId, card)).id;
      } else if (card !== st.lastCard) {
        await edit(st.channelId, st.messageId, card);
      }
      st.lastCard = card;
      st.lastEdit = Date.now();
    });

  // 执行中日志刷得很快，卡片最多每 EDIT_MS 改一次
  const scheduleRefresh = (run, st) => {
    if (st.timer) return;
    const wait = Math.max(0, EDIT_MS - (Date.now() - st.lastEdit));
    st.timer = setTimeout(() => {
      st.timer = null;
      refresh(run, st);
    }, wait);
    st.timer.unref?.();
  };

  return {
    onCreated(run) {
      refresh(run, stateOf(run));
    },
    onLog(run, line) {
      const st = stateOf(run);
      const notice = String(line).match(/\[通知\]\s*(.+)/);
      if (notice && ownerId) {
        enqueue(st, () => post(st.channelId, `🔔 <@${ownerId}> 网页任务 \`${String(run.id).slice(0, 8)}\` 需要你：${notice[1]}`, true));
      }
      scheduleRefresh(run, st);
    },
    onFinished(run) {
      const st = stateOf(run);
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      refresh(run, st);
      const verdict = run.status === 'done' ? '✅ 完成了' : run.status === 'cancelled' ? '⏹ 已取消' : '❌ 没完成';
      const mention = ownerId ? `<@${ownerId}> ` : '';
      enqueue(st, () => post(st.channelId, `${mention}网页任务 \`${String(run.id).slice(0, 8)}\` ${verdict}，详情见上面的卡片。`, true)).then(() => states.delete(run.id));
    },
  };
}
