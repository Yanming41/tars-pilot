// 把 tars-pilot 的每个任务播报到 Discord：一张卡片，执行中原地刷新(第几步、当前进度、最近动作)，结束时变成结果；
// 需要用户马上处理的通知([通知] 开头的日志行，比如 Duo 匹配码)和任务结束时，各发一条 @ 用户。
// 带批次号的任务(见 batches.mjs)不各发各的：整个批次一张汇总卡原地刷新，结束时不 @，
// 只有 [通知] 照样单独 @；卡片上的「📂 展开明细」按钮由 discord_bridge 处理(读 GET /batches/:key)。
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
import { counts, getBatch, shortDesc } from '../batches.mjs';

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

const COLORS = { queued: 0x95a5a6, running: 0x3498db, done: 0x2ecc71, cancelled: 0xf1c40f, failed: 0xe74c3c };

function progressBar(step, max) {
  const filled = Math.max(0, Math.min(10, Math.round((step / Math.max(1, max)) * 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/** 一个任务当前状态对应的 Discord 卡片(embed) */
export function renderCard(run) {
  const req = run.request ?? {};
  const info = parseLog(run.log);
  const startedAt = Date.parse(run.startedAt || run.createdAt || '') || Date.now();
  const result = run.result ?? {};
  const fields = [
    { name: '网站', value: `${req.browser || 'chrome'} · ${req.cdp || '当前标签页'}`, inline: true },
    { name: '来自', value: req.caller || '未注明', inline: true },
  ];
  let state;
  let title;

  if (run.status === 'queued') {
    state = 'queued';
    title = '🕒 排队中';
    fields.push({ name: '说明', value: '前面还有任务(鼠标键盘只有一套，只能一个个来)', inline: false });
  } else if (run.status === 'running') {
    state = 'running';
    title = '⏳ 进行中';
    const max = info.totalSteps ?? req.maxSteps ?? DEFAULT_MAX_STEPS;
    const stepText = !info.step ? '准备中' : info.totalSteps ? `第 ${info.step}/${max} 步` : `第 ${info.step} 步(最多 ${max})`;
    fields.push({ name: '进度', value: `${progressBar(info.step, max)} ${stepText}`, inline: true });
    fields.push({ name: '已用', value: formatElapsed(Date.now() - startedAt), inline: true });
    if (info.modelStarting && !info.step) fields.push({ name: '当前', value: '正在启动本地视觉模型，第一次要 1-2 分钟…', inline: false });
    if (info.progress) fields.push({ name: '当前', value: clip(plain(info.progress), 300), inline: false });
    const recent = info.actions.slice(-3).map((a) => `• \`${clip(plain(a), 90)}\``);
    if (recent.length) fields.push({ name: '最近动作', value: recent.join('\n'), inline: false });
  } else {
    const took = formatElapsed(result.durationMs ?? Date.now() - startedAt);
    const steps = result.steps ?? info.step;
    const answer = clip(plain(result.answer || result.reason || ''), 1000);
    if (run.status === 'done') {
      state = 'done';
      title = '✅ 完成';
    } else if (run.status === 'cancelled') {
      state = 'cancelled';
      title = '⏹ 已取消';
    } else {
      state = 'failed';
      title = '❌ 没完成';
    }
    fields.push({ name: '用时', value: took, inline: true });
    if (steps) fields.push({ name: '步数', value: state === 'failed' ? `停在第 ${steps} 步` : `共 ${steps} 步`, inline: true });
    if (answer) fields.push({ name: state === 'done' ? '结果' : state === 'cancelled' ? '说明' : '原因', value: answer, inline: false });
  }

  return {
    title: `🖱️ 网页任务 · ${title}`,
    description: describeTask(req),
    color: COLORS[state],
    fields,
    footer: { text: `tars-pilot · ${String(run.id).slice(0, 8)}` },
    timestamp: new Date(startedAt).toISOString(),
  };
}

const ENTRY_ICONS = { done: '✅', cancelled: '⏹', queued: '🕒', running: '⏳' };
export const entryIcon = (status) => ENTRY_ICONS[status] ?? '❌';

/** 批次汇总卡：最上面是当前在做的事，下面是计数和最近几条；明细点按钮看 */
export function renderBatchCard(batch, currentRun) {
  const c = counts(batch);
  const ended = Boolean(batch.endedAt);
  const lastAt = ended ? batch.endedAt : Date.now();
  let head;
  let color;
  if (!ended) {
    head = '🔄 进行中';
    color = COLORS.running;
  } else if (batch.endReason === 'idle') {
    head = '⚠️ 已停止（15 分钟没有新任务）';
    color = COLORS.cancelled;
  } else {
    head = c.failed ? '✅ 本轮结束（有失败）' : '✅ 本轮结束';
    color = c.failed ? COLORS.cancelled : COLORS.done;
  }

  let description;
  if (!ended && currentRun?.status === 'running') {
    const info = parseLog(currentRun.log);
    const step = !info.step ? '准备中' : info.totalSteps ? `第 ${info.step}/${info.totalSteps} 步` : `第 ${info.step} 步`;
    description = `**▶ 当前：** ${clip(plain(shortDesc(currentRun.request)), 150)}（${step}）`;
    if (info.modelStarting && !info.step) description += '\n正在启动本地视觉模型，第一次要 1-2 分钟…';
    else if (info.progress) description += `\n${clip(plain(info.progress), 200)}`;
  } else if (!ended) {
    description = c.pending ? `**▶ 当前：** 排队中（${c.pending} 个）` : '**▶ 当前：** 等下一个任务…';
  } else {
    description = `共执行 ${c.total} 次，用时 ${formatElapsed(lastAt - batch.createdAt)}`;
  }

  const tally = [`✅ ${c.done}`, `❌ ${c.failed}`, c.cancelled ? `⏹ ${c.cancelled}` : null].filter(Boolean).join('　');
  const fields = [
    { name: '已执行', value: `${c.total} 次　${tally}`, inline: true },
    { name: '已用', value: formatElapsed(lastAt - batch.createdAt), inline: true },
    { name: '来自', value: batch.caller || '未注明', inline: true },
  ];
  const recent = batch.entries
    .filter((e) => e.finishedAt)
    .slice(-3)
    .reverse()
    .map((e) => `${entryIcon(e.status)} ${clip(plain(e.desc), 60)}${e.status !== 'done' && e.answer ? ` — ${clip(e.answer, 60)}` : ''}`);
  if (recent.length) fields.push({ name: '最近', value: recent.join('\n'), inline: false });

  return {
    embed: {
      title: `🗂️ ${batch.title || '批量网页任务'} · ${head}`,
      description,
      color,
      fields,
      footer: { text: `tars-pilot · 批次 ${batch.id}` },
      timestamp: new Date(batch.createdAt).toISOString(),
    },
    components: [
      { type: 1, components: [{ type: 2, style: 2, label: '展开明细', emoji: { name: '📂' }, custom_id: `tb:${batch.key}:0` }] },
    ],
  };
}

/** 返回 { onCreated, onLog, onFinished, onBatchEnded }；没有配置文件时返回 null(不播报)。回调都不会抛错。 */
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

  // payload：文字消息传字符串；卡片传 { embeds: [...] }
  const toBody = (payload, mention) => ({
    ...(typeof payload === 'string' ? { content: payload } : payload),
    allowed_mentions: mention && ownerId ? { users: [ownerId] } : NO_MENTIONS,
  });
  // 带按钮的消息要加 with_components=true，webhook 才会收下 components
  const withComponents = (payload) => (payload?.components ? 'with_components=true' : '');
  const post = async (channelId, payload, mention = false) => {
    const t = target(channelId);
    const res = await fetch(`${t.url}?${['wait=true', t.query, withComponents(payload)].filter(Boolean).join('&')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toBody(payload, mention)),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  const edit = async (channelId, messageId, payload) => {
    const t = target(channelId);
    const query = [t.query, withComponents(payload)].filter(Boolean).join('&');
    const res = await fetch(`${t.url}/messages/${messageId}${query ? `?${query}` : ''}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toBody(payload, false)),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
      const embed = renderCard(run);
      const card = JSON.stringify({ ...embed, timestamp: undefined }); // 只用来判断内容有没有变
      if (!st.messageId) {
        st.messageId = (await post(st.channelId, { embeds: [embed] })).id;
      } else if (card !== st.lastCard) {
        await edit(st.channelId, st.messageId, { embeds: [embed] });
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

  // 批次：每个批次一份播报状态，一张卡片
  const batchStates = new Map();
  const batchStateOf = (batch) => {
    if (!batchStates.has(batch.key)) {
      batchStates.set(batch.key, { channelId: batch.channelId || mainChannelId, messageId: null, lastCard: '', lastEdit: 0, timer: null, current: null, chain: Promise.resolve() });
    }
    return batchStates.get(batch.key);
  };
  const refreshBatch = (batch, bst) =>
    enqueue(bst, async () => {
      const { embed, components } = renderBatchCard(batch, bst.current);
      const card = JSON.stringify({ ...embed, timestamp: undefined });
      if (!bst.messageId) {
        bst.messageId = (await post(bst.channelId, { embeds: [embed], components })).id;
      } else if (card !== bst.lastCard) {
        await edit(bst.channelId, bst.messageId, { embeds: [embed], components });
      }
      bst.lastCard = card;
      bst.lastEdit = Date.now();
    });
  const scheduleBatch = (batch, bst) => {
    if (bst.timer) return;
    const wait = Math.max(0, EDIT_MS - (Date.now() - bst.lastEdit));
    bst.timer = setTimeout(() => {
      bst.timer = null;
      refreshBatch(batch, bst);
    }, wait);
    bst.timer.unref?.();
  };
  const batchOf = (run) => (run.batchKey ? getBatch(run.batchKey) : null);
  const notify = (st, run, line) => {
    const notice = String(line).match(/\[通知\]\s*(.+)/);
    if (notice && ownerId) {
      enqueue(st, () => post(st.channelId, `🔔 <@${ownerId}> 网页任务 \`${String(run.id).slice(0, 8)}\` 需要你：${notice[1]}`, true));
    }
  };

  return {
    onCreated(run) {
      const batch = batchOf(run);
      if (batch) {
        const bst = batchStateOf(batch);
        if (run.status === 'running') bst.current = run;
        // 第一张卡马上发，之后的更新节流
        if (!bst.messageId && !bst.lastEdit) refreshBatch(batch, bst);
        else scheduleBatch(batch, bst);
        return;
      }
      refresh(run, stateOf(run));
    },
    onLog(run, line) {
      const batch = batchOf(run);
      if (batch) {
        const bst = batchStateOf(batch);
        bst.current = run;
        notify(bst, run, line);
        scheduleBatch(batch, bst);
        return;
      }
      const st = stateOf(run);
      notify(st, run, line);
      scheduleRefresh(run, st);
    },
    onBatchEnded(batch) {
      const bst = batchStateOf(batch);
      if (bst.timer) clearTimeout(bst.timer);
      bst.timer = null;
      bst.current = null;
      refreshBatch(batch, bst);
    },
    onFinished(run) {
      const batch = batchOf(run);
      if (batch) {
        const bst = batchStateOf(batch);
        if (bst.current === run) bst.current = null;
        scheduleBatch(batch, bst);
        return;
      }
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
