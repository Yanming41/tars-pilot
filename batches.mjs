// 批次：调用方给一串相关任务打上同一个批次号(请求里的 "batch": {"id": "...", "title": "..."}，或直接给字符串)，
// Discord 上就合并成一张汇总卡(见 reporters/discord.mjs)。批次结束：调用方 POST /batches/:id/end，
// 或者 IDLE_END_MS 内没有新任务时由 server 自动结束。
//
// 每个任务在批次里记一条摘要(不依赖 runs 列表，那里只留最近 100 个)，"展开明细"按钮就是读这些摘要。
import { randomBytes } from 'node:crypto';

export const IDLE_END_MS = 15 * 60 * 1000;
const MAX_BATCHES = 30;
const MAX_ENTRIES = 1000;

const batches = new Map(); // key(短 ID，放进按钮的 custom_id) -> batch
const keyById = new Map(); // 调用方给的 id -> 当前这个 id 对应的 key

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
const plain = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** 任务的一句话描述：模板名 + 变量值，或任务开头 */
export function shortDesc(req = {}) {
  if (req.recipe) {
    const vals = Object.values(req.vars ?? {}).map((v) => clip(plain(v), 40)).filter(Boolean);
    return `${req.recipe}${vals.length ? `「${vals.join('」「')}」` : ''}`;
  }
  return clip(plain(req.task || '(没有描述)'), 80);
}

function normalize(b) {
  if (!b) return null;
  if (typeof b === 'string') b = { id: b };
  if (!b.id) return null;
  return { id: clip(String(b.id), 100), title: b.title ? clip(plain(b.title), 200) : null };
}

/** 新任务进来：挂到它的批次上(没有就新建；同一个 id 的批次已结束则另开一个) */
export function attachRun(run) {
  const nb = normalize(run.request?.batch);
  if (!nb) return null;
  run.request.batch = nb;
  let batch = batches.get(keyById.get(nb.id));
  if (!batch || batch.endedAt) {
    const key = randomBytes(4).toString('hex');
    batch = {
      key,
      id: nb.id,
      title: nb.title,
      caller: run.request.caller ?? null,
      channelId: run.request.discord_channel_id ?? null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      endedAt: null,
      endReason: null,
      entries: [],
    };
    batches.set(key, batch);
    keyById.set(nb.id, key);
    for (const k of [...batches.keys()].slice(0, Math.max(0, batches.size - MAX_BATCHES))) batches.delete(k);
  }
  if (nb.title) batch.title = nb.title;
  batch.entries.push({ runId: run.id, desc: shortDesc(run.request), status: run.status, createdAt: run.createdAt, finishedAt: null, durationMs: null, steps: null, answer: null });
  if (batch.entries.length > MAX_ENTRIES) batch.entries.splice(0, batch.entries.length - MAX_ENTRIES);
  batch.lastActivity = Date.now();
  run.batchKey = batch.key;
  return batch;
}

/** 任务状态变了(开始执行 / 结束)：同步到批次摘要 */
export function updateRun(run) {
  const batch = batches.get(run.batchKey);
  const e = batch?.entries.find((x) => x.runId === run.id);
  if (!e) return null;
  e.status = run.status;
  if (run.finishedAt) {
    e.finishedAt = run.finishedAt;
    e.durationMs = run.result?.durationMs ?? Date.parse(run.finishedAt) - Date.parse(run.startedAt || run.createdAt);
    e.steps = run.result?.steps ?? null;
    e.answer = run.result?.answer ? clip(plain(run.result.answer), 300) : null;
  }
  batch.lastActivity = Date.now();
  return batch;
}

export const getBatch = (keyOrId) => batches.get(keyOrId) ?? batches.get(keyById.get(keyOrId)) ?? null;

export function endBatch(keyOrId, reason = 'ended') {
  const batch = getBatch(keyOrId);
  if (!batch || batch.endedAt) return batch;
  batch.endedAt = Date.now();
  batch.endReason = reason;
  return batch;
}

/** 超过 IDLE_END_MS 没有新动静、也没有排队/执行中的任务的批次，返回给 server 去结束 */
export function idleBatches(now = Date.now()) {
  return [...batches.values()].filter(
    (b) => !b.endedAt && now - b.lastActivity > IDLE_END_MS && !b.entries.some((e) => e.status === 'queued' || e.status === 'running')
  );
}

export function counts(batch) {
  const c = { total: batch.entries.length, done: 0, failed: 0, cancelled: 0, pending: 0 };
  for (const e of batch.entries) {
    if (e.status === 'done') c.done++;
    else if (e.status === 'cancelled') c.cancelled++;
    else if (e.status === 'queued' || e.status === 'running') c.pending++;
    else c.failed++;
  }
  return c;
}

/** GET /batches/:id 的返回：摘要 + 明细(新的在前) */
export function viewBatch(batch) {
  const { entries, ...rest } = batch;
  return { ...rest, counts: counts(batch), entries: [...entries].reverse() };
}
