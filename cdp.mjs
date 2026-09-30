// CDP 驱动：截图、点击、输入都直接对 Chrome 里的某个标签页做（Chrome DevTools Protocol），
// 不动系统的真实鼠标键盘——跑的时候你可以照常用电脑。Chrome 窗口被别的窗口挡住也能截图、点击。
// 需要 Chrome 以 --remote-debugging-port 启动（默认连 http://127.0.0.1:9222）。
// Windows 上 Chrome 窗口被挡住/最小化时会停止出新画面，截图会卡住：建议 Chrome 启动时加
//   --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
// 这里再加两层保险：固定视口（强制重新出帧，布局也不随窗口大小变）；截图超时就重试，窗口被最小化了就还原到最底层。
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { cfg, sleep, here } from './lib.mjs';

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
// 带 ctrl 的编辑快捷键要附带 commands，Chrome 才会真的执行（光发按键事件不会全选/粘贴）
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

function keyDef(k) {
  if (KEYS[k]) return KEYS[k];
  if (/^[a-z]$/.test(k)) return { key: k, code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0), text: k };
  if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}`, keyCode: k.charCodeAt(0), text: k };
  if (/^f([1-9]|1[0-2])$/.test(k)) return { key: k.toUpperCase(), code: k.toUpperCase(), keyCode: 111 + Number(k.slice(1)) };
  throw new Error(`CDP 模式不支持的按键: ${k}`);
}

// browser：浏览器名（config.json 的 browsers 里配，默认 chrome=9222、edge=9223）或直接给 http://host:port
export function cdpEndpointFor(browser) {
  if (!browser) return cfg.cdpEndpoint ?? 'http://127.0.0.1:9222';
  if (/^https?:\/\//.test(browser)) return browser.replace(/\/$/, '');
  const known = { chrome: 'http://127.0.0.1:9222', edge: 'http://127.0.0.1:9223', ...cfg.browsers };
  if (!known[browser]) throw new Error(`不认识的浏览器「${browser}」，可用: ${Object.keys(known).join(', ')}，或直接给 http://127.0.0.1:端口`);
  return known[browser];
}

export class CdpDriver {
  kind = 'cdp';

  static async connect(match, browser) {
    const endpoint = cdpEndpointFor(browser);
    let list;
    try {
      list = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    } catch (e) {
      throw new Error(`连不上 Chrome 调试端口 ${endpoint}（Chrome 要以 --remote-debugging-port 启动）: ${e.message}`);
    }
    const pages = list.filter((t) => t.type === 'page');
    const page = pages.find((t) => t.url.includes(match)) ?? pages.find((t) => t.title.includes(match));
    if (!page) throw new Error(`${endpoint} 的浏览器里没有网址或标题包含「${match}」的标签页`);
    const d = new CdpDriver();
    await d.#open(page.webSocketDebuggerUrl);
    d.target = { title: page.title, url: page.url };
    // 让页面始终以为自己有焦点、处于活跃状态，窗口被挡住也照常渲染和响应输入
    await d.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    d.viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...cfg.cdpViewport };
    await d.setViewport();
    await d.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    console.log(`  CDP 接管标签页: ${page.title}（${endpoint}）`);
    return d;
  }

  #ws;
  #id = 0;
  #pending = new Map();

  async #open(url) {
    this.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.#ws.onopen = resolve;
      this.#ws.onerror = (e) => reject(new Error(`CDP WebSocket 连接失败: ${e.message ?? e.type}`));
    });
    this.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    };
    this.#ws.onclose = () => {
      for (const p of this.#pending.values()) p.reject(new Error('CDP 连接已断开'));
      this.#pending.clear();
    };
  }

  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 固定视口（jiggle=true 时高度差 1px，用来强制 Chrome 重新布局、出一帧新画面）
  async setViewport(jiggle = false) {
    const v = this.viewport;
    await this.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height + (jiggle ? 1 : 0), deviceScaleFactor: v.deviceScaleFactor, mobile: false });
  }

  async close() {
    try {
      await this.send('Emulation.clearDeviceMetricsOverride', {}, 3000);
    } catch {}
    try {
      this.#ws?.close();
    } catch {}
  }

  // 窗口被最小化时还原它，但压到所有窗口最底层（不抢焦点、不挡你正在用的窗口）
  async #unminimize() {
    let title = '';
    try {
      title = (await this.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 3000)).result.value;
    } catch {}
    if (!title) return;
    await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'focus-window.ps1'), '-Title', title, '-Background'],
      { windowsHide: true, timeout: 15000 }, () => resolve()));
  }

  // 截当前视口（只有网页内容，没有浏览器地址栏/标签栏）。坐标单位：截图像素；dpr = 截图像素 / CSS 像素
  async grab() {
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        ({ data } = await this.send('Page.captureScreenshot', { format: 'png' }, 8000));
        break;
      } catch (e) {
        if (!/超时/.test(e.message) || attempt >= 4) throw new Error(`${e.message}（Chrome 窗口是不是被最小化了？放在其他窗口后面即可，别最小化）`);
        if (attempt === 2) await this.#unminimize();
        await this.setViewport(attempt % 2 === 1);
      }
    }
    if (this.viewport) await this.setViewport(false);
    const img = await Jimp.read(Buffer.from(data, 'base64'));
    const { cssVisualViewport: vp } = await this.send('Page.getLayoutMetrics');
    this.dpr = img.bitmap.width / vp.clientWidth;
    return { img, scaleFactor: this.dpr };
  }

  #css(px, py) {
    return { x: px / (this.dpr || 1), y: py / (this.dpr || 1) };
  }

  async #mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  // 下面这些和 lib.mjs 的 osDriver 同一套签名：g 是 ground() 的结果，用其中的截图像素坐标 px/py
  async click(shot, g, { button = 'left', count = 1 } = {}) {
    const { x, y } = this.#css(g.px, g.py);
    await this.#mouse('mouseMoved', x, y);
    for (let c = 1; c <= count; c++) {
      await this.#mouse('mousePressed', x, y, { button, buttons: button === 'right' ? 2 : 1, clickCount: c });
      await this.#mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: c });
    }
  }

  async scroll(shot, g, direction) {
    const { x, y } = this.#css(g.px, g.py);
    await this.#mouse('mouseMoved', x, y);
    await this.#mouse('mouseWheel', x, y, { deltaX: 0, deltaY: direction === 'up' ? -600 : 600 });
  }

  async type(shot, text, submit) {
    if (text) await this.send('Input.insertText', { text });
    if (submit) await this.press(KEYS.enter);
  }

  async press(def, modifiers = 0, commands) {
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: def.text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(def.text && !modifiers ? { text: def.text } : {}), ...(commands ? { commands } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // keys: "ctrl a" / "enter" / "shift tab" 这种小写空格分隔的写法
  async hotkey(shot, keys) {
    const parts = keys.toLowerCase().split(/[\s+]+/).filter(Boolean);
    let modifiers = 0;
    const main = [];
    for (const k of parts) (k in MODS ? (modifiers |= MODS[k]) : main.push(k));
    if (!main.length) throw new Error(`快捷键里没有主键: ${keys}`);
    for (const k of main) {
      const cmd = modifiers === 2 ? EDIT_COMMANDS[k] : undefined;
      await this.press(keyDef(k), modifiers, cmd ? [cmd] : undefined);
    }
  }

  async navigate(shot, url) {
    await this.send('Page.navigate', { url: /^https?:\/\//.test(url) ? url : `https://${url}` });
    // 等页面加载（最多 15 秒）
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const r = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 5000);
        if (r.result?.value === 'complete') break;
      } catch {}
    }
  }
}
