"""tars-pilot 本地接口的 Python 客户端（只用标准库，直接复制进你的项目即可）。

    from tars_pilot_client import TarsPilot

    tp = TarsPilot()                      # 默认 http://127.0.0.1:8765
    tp.health()                           # {'ok': True, 'grounder': True, 'busy': False, 'queued': 0}
    r = tp.run_recipe("xhs-search", {"keyword": "电动滑板车"})
    if r["status"] == "done": ...
    r = tp.run_task("打开小红书搜索 {{keyword}}", {"keyword": "电动滑板车"}, save="xhs-search")

run_* 默认阻塞直到执行完（回放一般几秒到十几秒，交给 GPT 兜底时可能一两分钟）。
返回的是任务对象：status 为 done / fail / cancelled / error，result 里有 answer、usedGPT、failedStep 等，log 是执行日志。
"""

import json
import time
import urllib.error
import urllib.request


class TarsPilotError(RuntimeError):
    pass


class TarsPilot:
    def __init__(self, base_url: str = "http://127.0.0.1:8765", token: str | None = None, timeout: float = 900):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

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

    def run_recipe(self, name: str, vars: dict | None = None, *, fallback: bool = True, heal: bool = False,
                   wait: bool = True) -> dict:
        """按模板回放；某步失败时（fallback=True）自动交给 GPT 从当前画面接着做。"""
        return self._request("POST", "/runs", {"recipe": name, "vars": vars or {}, "fallback": fallback,
                                               "heal": heal, "wait": wait})

    def run_task(self, task: str, vars: dict | None = None, *, save: str | None = None,
                 max_steps: int | None = None, wait: bool = True) -> dict:
        """让 GPT 规划 + UI-TARS 定位完成任务；save 给了名字且成功时，存成模板。"""
        body = {"task": task, "vars": vars or {}, "wait": wait}
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
