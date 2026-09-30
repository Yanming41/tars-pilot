# tars-pilot

**Pure-vision desktop & web automation on a single consumer GPU.**
GPT (through the official Codex SDK, billed to your ChatGPT subscription — no API key) decides *what* to do from screenshots;
a local **UI-TARS-1.5-7B** turns "the magnifier icon next to the search box" into pixel coordinates;
real OS-level mouse/keyboard input does the rest. Successful runs can be saved as templates and replayed without GPT, falling back to GPT only when a step fails.

纯视觉的桌面/网页自动化：GPT 看截图做决策，本地 UI-TARS 把"点哪个元素"变成坐标，系统级鼠标键盘执行；跑通的流程可以存成模板，之后免 GPT 回放，失败时自动交回 GPT。

---

## 入口

| 入口 | 结构 | 适合 |
|---|---|---|
| `agent.mjs`（推荐） | **GPT 规划** + **本地 UI-TARS 定位** | 多步任务、第一次做的流程；`--save` 录成模板 |
| `replay.mjs` | 按模板回放，UI-TARS 只负责定位，**不调用 GPT**；某步失败自动交给 GPT | 固定流程，快且不耗订阅额度 |
| `uitars.mjs` | UI-TARS 单模型（自己想、自己定位），完全本地 | 很短的任务 |
| `server.mjs` | 本地 HTTP 接口，把上面的能力开放给别的程序 | 爬虫等自动化流程接入 |

## 前提

- Windows 10/11 + WSL2 (Ubuntu)，NVIDIA 显卡约 16GB 显存（UI-TARS GPTQ 4bit + 32k 上下文约占 13.6GB）
- Node.js ≥ 22
- `agent.mjs` 和回放兜底需要 [Codex CLI](https://github.com/openai/codex) 已用 ChatGPT 账号登录（`codex login status` 显示 *Logged in using ChatGPT*）
- 在 175% 缩放、2560×1440 屏幕上开发和测试；其他分辨率/缩放按原理可用，但没测过

## 安装

```powershell
git clone https://github.com/Yanming41/tars-pilot.git
cd tars-pilot
npm install
# WSL 里装 uv / Python / vLLM 并下载模型（约 6.5GB）
wsl -d Ubuntu --cd . -- bash ./setup-wsl.sh
```

## 使用

```powershell
# 终端 1：启动本地定位模型（首次加载约 1-2 分钟，窗口别关）
powershell -File start-server.ps1
# 检查：curl http://127.0.0.1:8000/v1/models

# 终端 2：下任务（执行期间会接管鼠标键盘，Ctrl+C 停止）
node agent.mjs "打开Chrome，访问 bing.com，搜索 UI-TARS，告诉我第一条结果的标题"

# 录制成模板 → 换变量回放
node agent.mjs --save bing-search --var keyword=Qwen3-VL "在Google Chrome浏览器里打开 bing.com，搜索 {{keyword}}，搜索结果页出现后就算完成"
node replay.mjs bing-search --var keyword=电动滑板车
node replay.mjs --list
```

每次 `agent.mjs` 运行的缩小截图（带红圈）和 `trace.json` 在 `.planner-work/`（已 gitignore，里面是你的桌面截图）。

## 两种驱动：CDP（不占鼠标）vs 系统（真实鼠标）

| 驱动 | 怎么选 | 眼睛 / 手 | 适合 |
|---|---|---|---|
| **CDP**（推荐用于网页） | `--cdp xiaohongshu.com` / 请求里 `"cdp": "..."` / 模板里存了 `cdp` | 只截那个 Chrome 标签页；点击/输入通过 CDP 注入页面 | 网页自动化，**不动你的真实鼠标键盘，跑的时候你可以照常用电脑** |
| 系统 | 默认；`--focus 窗口标题` 先切到前台 | 截整个屏幕；nut-js 真实鼠标键盘 | 桌面软件、非 Chrome 程序 |

CDP 驱动要点：
- **自动化专用浏览器**：`powershell -File launch-browser.ps1`（默认 Edge、端口 9223、资料在 `%USERPROFILE%\automation-browser\edge`；`-Browser chrome -Port 9224` 也行）。Chrome/Edge 136+ 不允许对日常默认资料开调试端口，所以自动化用一个单独资料：在里面登录一次（Edge 可登录微软账号同步密码/地址/收藏夹），之后所有网站都在这一个实例里操作。
- 选浏览器：`--browser edge` / 请求里 `"browser": "edge"`（`chrome`=9222 默认、`edge`=9223，`config.json` 的 `browsers` 可加别名，或直接写 `http://127.0.0.1:端口`）；模板会记住。
- Chrome 要以 `--remote-debugging-port=9222` 启动，并**建议加** `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`（否则窗口被挡住/最小化时 Chrome 不出新画面，截图会超时）。
- 驱动连接时固定视口为 1280×800（`config.json` 的 `cdpViewport` 可改），布局不随窗口大小变化；退出时还原。
- Chrome 窗口放在其他窗口后面即可，**别最小化**：最小化时截图偶尔超时，驱动会重试，并把窗口还原（不抢焦点）。
- 截图里没有地址栏，打开网址用 `navigate` 动作（规划器会自动用）。
- `ctrl a/c/v/x/z` 这类编辑快捷键会带上 Chrome 的编辑命令，真的全选/复制/粘贴。

## agent.mjs 每一步

```
截全屏 2560x1440
  ├─ 缩到 1280 宽 + 红圈标出上一步点击位置 ──▶ GPT 规划器（同一个 Codex 会话，记得前面所有步骤）
  │     JSON：observation / progress / status / action_type / target(自然语言) / text / keys / direction / expect / answer
  └─ 原图 ──▶ UI-TARS："点哪个元素" → 坐标（只输出坐标的提示词，约 3.7s）
nut-js 执行（Windows SendInput）→ 对比前后截图判断界面有没有变化 → 结果回给规划器
```

- 规划器跑在 Codex 只读沙箱里、不审批、不能执行命令；提示词规定不做付款/删除/发消息/发布等不可逆操作（除非任务明确要求），遇到登录/验证码就停。
- 连续 `maxNoChange`（默认 4）步界面无变化就强制停止。

## 模板（recipes/*.json）与回放

- `agent.mjs --save NAME --var k=v` 成功后把实际执行的动作存成 `recipes/NAME.json`；文字/目标描述里出现的变量值会换回 `{{k}}`。0 步不保存。
- 模板是普通 JSON，可手改：每步 `{ action: click|double_click|right_click|type|hotkey|scroll|wait, target, text, submit, keys, direction, seconds, expect, noChangeOk }`。
- 回放每步执行后等界面变化（最多 `replay.verifyTimeoutMs`，默认 6s），不变判失败；某步确实不会改变界面时加 `"noChangeOk": true`。
- 失败后自动交给 GPT 从当前画面继续（`--no-fallback` 关闭）。`--heal`：GPT 成功后用"失败前的模板步骤 + GPT 新步骤"更新模板（旧版存为 `NAME.bak.json`）。如果失败原因是起始状态特殊（比如窗口都最小化了），别用 heal。
- `--check-expect`：让 UI-TARS 判断每步 `expect` 是否成立。**实测不可靠**（对不成立的描述也常答"是"），默认关闭。

## 本地 HTTP 接口（给爬虫等程序调用）

```powershell
node server.mjs      # 默认 http://127.0.0.1:8765；需要 start-server.ps1 的模型服务也在跑
```

| 接口 | 说明 |
|---|---|
| `GET /health` | `{ ok, grounder: 本地 UI-TARS 是否在线, busy, queued }` |
| `GET /recipes`、`GET /recipes/:name` | 模板列表 / 内容 |
| `POST /runs` | 提交任务，默认等执行完再返回；加 `"wait": false` 立刻返回任务 id |
| `GET /runs`、`GET /runs/:id` | 任务状态、结果（`result.answer / usedGPT / failedStep`）、执行日志（`log`） |
| `POST /runs/:id/cancel` | 取消：排队中的直接移除，执行中的在当前步骤后停 |

```jsonc
// 模板回放（失败时默认交给 GPT 兜底）
{ "recipe": "xhs-search", "vars": { "keyword": "电动滑板车" }, "fallback": true, "heal": false }
// GPT 任务（可顺便存成模板）
{ "task": "在小红书搜索 {{keyword}}", "vars": { "keyword": "电动滑板车" }, "save": "xhs-search", "maxSteps": 25 }
```

- 鼠标键盘只有一套，所有任务**排队串行**执行。
- 安全：只监听 127.0.0.1；拒绝带 `Origin` 头的请求、POST 只收 `application/json`（防止你浏览器里打开的网页偷偷调用）；可在 `config.json` 里设 `server.token`，之后请求要带 `Authorization: Bearer <token>`。
- Python 客户端（纯标准库，复制即用）：[`clients/python/tars_pilot_client.py`](clients/python/tars_pilot_client.py)

```python
from tars_pilot_client import TarsPilot
tp = TarsPilot()
r = tp.run_recipe("xhs-search", {"keyword": "电动滑板车"})
if r["status"] == "done":
    ...  # 接着用你自己的 CDP / Playwright 抓结果
```

- Node：直接 `fetch('http://127.0.0.1:8765/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({...}) })`（Node 的 fetch 不带 Origin 头）。
- 注意：操作的是**当前前台窗口**。请求里加 `"focus": "窗口标题关键字"`（或命令行 `--focus`），会先把那个窗口切到系统前台（`focus-window.ps1`：Win32 API + 模拟 Alt 键绕过 Windows 防抢焦点；CDP 的 `Page.bringToFront` 只切标签页、提不起系统窗口）。录制时带了 `--focus` 的模板会记住它，回放自动先切。如果你的程序用 CDP 改过页面尺寸（`Emulation.setDeviceMetricsOverride`），视觉操作前要先 `Emulation.clearDeviceMetricsOverride`，否则页面布局和录模板时不一样。

## config.json

- `baseURL` / `model`：本地 vLLM
- `planner.effort`：GPT 推理强度 `none` / `low`（默认）/ `medium` / `high`；`planner.model` 指定模型（默认用 `~/.codex/config.toml` 里的）；`planner.screenshotWidth`（默认 1280）
- `grounderPrompt`：`short`（默认，只输出坐标，快约 1s）/ `full`（先 Thought 再坐标）
- `maxSteps`、`maxNoChange`、`minChangedPixels`、`settleMs`（每步动作后等待）、`debug`
- `replay.verifyTimeoutMs`、`replay.checkExpect`
- `server.host`（默认 127.0.0.1）、`server.port`（默认 8765）、`server.token`（默认空，不校验）

## 实测（RTX 3080 Laptop 16GB，Windows 11，175% 缩放）

| 任务 | UI-TARS 单模型 | GPT 规划 + UI-TARS 定位 | 模板回放 |
|---|---|---|---|
| 计算器清零后算 12+34 | 15 步原地打转，失败 | 8 步 120s 成功 | — |
| Chrome → bing.com 搜索并读出第一条标题 | — | 9 步 131s 成功 | — |
| Chrome → bing 搜索（换关键词） | — | 3 步 34s（录制） | 2 步 ~6-13s，不调用 GPT |
| 回放第一步故意失败 | — | — | 自动交给 GPT，6 步 93s 完成 |

- 定位：合成网页 5/5（含无文字的放大镜图标），真实计算器按钮全部落在按钮中心。
- 速度：`agent.mjs` 约 15s/步（GPT 规划 8-10s + UI-TARS 定位 ~3.7s + 执行/截图 ~2s）。
- 订阅用量：第一步约 1.9 万输入 token（大部分是 Codex 自带系统提示词），同一会话后续步骤大部分命中缓存；每次结束会打印累计用量。

## 相对官方 `@ui-tars/cli` / SDK 的修正（见 `lib.mjs`）

- 官方 CLI 不传 `uiTarsVersion`，按 1.0 解析坐标 → 1.5 模型点偏。这里固定 V1_5 + 官方 1.5 电脑操作提示词。
- 官方 NutJS 截图会缩到逻辑分辨率（175% 缩放下 1463×823），太糊；改发原始物理分辨率 JPEG，执行时换算回逻辑坐标。
- SDK 请求超时写死 30s；SDK 模型重试有 bug（失败一次状态就变 ERROR，重试成功后循环仍退出）。改在自定义 fetch 里处理超时和 ECONNRESET 重试。
- `@ui-tars/sdk` 依赖 `uuid` 却没声明，所以 `package.json` 里显式加上了。

## 已知坑

- WSL 系统 Python 缺头文件、无 sudo → venv 用 `uv venv --managed-python`（`setup-wsl.sh` 已处理）。
- WSL 无 nvcc → `VLLM_USE_FLASHINFER_SAMPLER=0`（`serve.sh` 已处理）。
- 请求常先 ECONNRESET 一次再重试成功（Node 复用了被 uvicorn 关掉的空闲连接），无害；`debug: true` 时会打印。
- 社区反馈 GGUF / ollama 版 UI-TARS 坐标不可靠，所以用 vLLM + GPTQ。
- 每次 `agent.mjs` 运行会在 `~/.codex/sessions` 留一条 Codex 会话记录。

## 免责声明

本项目通过系统级输入操作你的真实桌面和浏览器。很多网站的服务条款禁止自动化操作，风控系统可以从操作频率、节奏等行为特征识别出自动化，可能导致限流或封号。请只在你有权自动化的场景下使用，并保持低频。作者不对使用后果负责。

## 致谢

- [UI-TARS](https://github.com/bytedance/UI-TARS) / [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop)（Apache-2.0）：模型、SDK、动作解析器与 NutJS 操控器；`lib.mjs` 中的 UI-TARS-1.5 提示词来自官方仓库
- [yujiepan/ui-tars-1.5-7B-GPTQ-W4A16g128](https://huggingface.co/yujiepan/ui-tars-1.5-7B-GPTQ-W4A16g128)：4bit 量化权重
- [vLLM](https://github.com/vllm-project/vllm)、[OpenAI Codex SDK](https://github.com/openai/codex)（Apache-2.0）、[nut.js](https://github.com/nut-tree/nut.js)（Apache-2.0）、[Jimp](https://github.com/jimp-dev/jimp)（MIT）
- 思路参考：[Agent S](https://github.com/simular-ai/agent-s)（规划器 + 定位器）、[GTA1](https://github.com/Yan98/GTA1)、[LocalLSTC](https://arxiv.org/abs/2608.25777)

## License

MIT
