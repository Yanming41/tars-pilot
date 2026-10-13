"""tars-pilot 本地接口的 Python 客户端（只用标准库，直接复制进你的项目即可）。

    from tars_pilot_client import TarsPilot

    tp = TarsPilot()                      # 默认 http://127.0.0.1:8765
    tp.health()                           # {'ok': True, 'grounder': True, 'busy': False, 'queued': 0}
    r = tp.run_recipe("xhs-search", {"keyword": "电动滑板车"})
    if r["status"] == "done": ...
    r = tp.run_task("打开小红书搜索 {{keyword}}", {"keyword": "电动滑板车"}, save="xhs-search")

run_* 默认阻塞直到执行完（回放一般几秒到十几秒，交给 GPT 兜底时可能一两分钟）。
返回的是任务对象：status 为 done / fail / cancelled / error，result 里有 answer、usedGPT、failedStep 等，log 是执行日志。

如果 tars-pilot 开了 Discord 播报：环境变量 TARS_DISCORD_CHANNEL(频道/帖子 ID)和 TARS_CALLER(调用方名字)
有值的话会自动带上，进度卡片就发到那个频道/帖子里；不设就发主频道。

批量调用(比如爬虫一轮几十上百次)：创建时给 batch_title，这个客户端发出的所有任务就归到同一个批次，
Discord 上只有一张汇总卡(当前操作 + 计数 + 「展开明细」按钮)，不再一个任务一张卡：

    tp = TarsPilot(caller="小红书爬虫", batch_title="小红书爬虫 · 搜索「沙发」")
    ...                                    # 程序退出时自动结束批次；也可以手动 tp.end_batch()
"""

import atexit
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class TarsPilotError(RuntimeError):
    pass


class TarsPilot:
    def __init__(self, base_url: str = "http://127.0.0.1:8765", token: str | None = None, timeout: float = 900,
                 *, caller: str | None = None, batch_title: str | None = None, batch_id: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.caller = caller
        self.batch = None
        if batch_title or batch_id:
            self.batch = {"id": batch_id or f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}", "title": batch_title}
            atexit.register(self.end_batch)

    def end_batch(self) -> None:
        """结束批次：汇总卡定格成「本轮结束」。重复调用没关系；连不上也不报错(tars 会在 15 分钟后自动结束)。"""
        if not self.batch or self.batch.get("ended"):
            return
        self.batch["ended"] = True
        try:
            self._request("POST", f"/batches/{urllib.parse.quote(self.batch['id'], safe='')}/end", {}, timeout=10)
        except TarsPilotError:
            pass

    def _request(self, method: str, path: str, body: dict | None = None, timeout: float | None = None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise TarsPilotError(f"{method} {path} -> HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise TarsPilotError(f"连不上 tars-pilot ({self.base_url})，先运行 node server.mjs: {e.reason}") from None

    def health(self) -> dict:
        return self._request("GET", "/health", timeout=10)

    def recipes(self) -> list[dict]:
        return self._request("GET", "/recipes", timeout=10)

    def _origin(self) -> dict:
        origin = {}
        if os.environ.get("TARS_DISCORD_CHANNEL"):
            origin["discord_channel_id"] = os.environ["TARS_DISCORD_CHANNEL"]
        if self.caller or os.environ.get("TARS_CALLER"):
            origin["caller"] = self.caller or os.environ["TARS_CALLER"]
        if self.batch:
            origin["batch"] = {"id": self.batch["id"], "title": self.batch["title"]}
        return origin

    def run_recipe(self, name: str, vars: dict | None = None, *, fallback: bool = True, heal: bool = False,
                   wait: bool = True) -> dict:
        """按模板回放；某步失败时（fallback=True）自动交给 GPT 从当前画面接着做。"""
        return self._request("POST", "/runs", {"recipe": name, "vars": vars or {}, "fallback": fallback,
                                               "heal": heal, "wait": wait, **self._origin()})

    def run_task(self, task: str, vars: dict | None = None, *, save: str | None = None,
                 max_steps: int | None = None, wait: bool = True) -> dict:
        """让 GPT 规划 + UI-TARS 定位完成任务；save 给了名字且成功时，存成模板。"""
        body = {"task": task, "vars": vars or {}, "wait": wait, **self._origin()}
        if save:
            body["save"] = save
        if max_steps:
            body["maxSteps"] = max_steps
        return self._request("POST", "/runs", body)

    def get_run(self, run_id: str) -> dict:
        return self._request("GET", f"/runs/{run_id}", timeout=10)

    def cancel(self, run_id: str) -> dict:
        return self._request("POST", f"/runs/{run_id}/cancel", {}, timeout=10)

    def wait_run(self, run_id: str, poll: float = 2.0) -> dict:
        """配合 wait=False 使用：轮询直到任务结束。"""
        while True:
            run = self.get_run(run_id)
            if run["status"] not in ("queued", "running"):
                return run
            time.sleep(poll)


if __name__ == "__main__":
    tp = TarsPilot()
    print(tp.health())
    for r in tp.recipes():
        print(f"{r['name']}  ({r['steps']} 步)  {r['task']}")
