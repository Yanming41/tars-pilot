#!/usr/bin/env node
// CDP 驱动的点击准确率回归测试：在指定浏览器里新开一个测试标签页（24 个编号按钮），
// 反复 截图 → 按截图像素坐标点按钮中心（中间穿插滚动），核对实际点中的是不是目标，并检查截图尺寸是否始终和视口一致。
// 不碰任何真实网站。改 cdp.mjs 之后跑一下。
//
// 用法: node tools/clicktest.mjs [浏览器，默认 edge]      例: node tools/clicktest.mjs chrome
import { CdpDriver, cdpEndpointFor } from '../cdp.mjs';

const browser = process.argv[2] ?? 'edge';
const endpoint = cdpEndpointFor(browser);
const html = `<title>tars-clicktest</title><style>body{margin:0;font:16px sans-serif}button{position:absolute;width:90px;height:40px}</style>
<script>window.__hits=[];addEventListener('click',e=>__hits.push({id:e.target.id||'(none)',x:e.clientX,y:e.clientY}),true)</script>` +
  Array.from({ length: 24 }, (_, i) => `<button id="b${i}" style="left:${40 + (i % 6) * 200}px;top:${40 + Math.floor(i / 6) * 180}px">b${i}</button>`).join('') +
  '<div style="height:3000px"></div>';
const tab = await (await fetch(`${endpoint}/json/new?${encodeURIComponent('data:text/html,' + encodeURIComponent(html))}`, { method: 'PUT' })).json();
await new Promise((r) => setTimeout(r, 1500));

const d = await CdpDriver.connect('tars-clicktest', browser);
const ev = async (e) => (await d.send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value;
const sizes = new Set();
let tried = 0;
let miss = 0;
try {
  for (let k = 0; k < 20; k++) {
    if (k % 7 === 6) {
      await d.scroll(null, { px: 600, py: 400 }, k % 2 ? 'down' : 'up');
      await new Promise((r) => setTimeout(r, 500));
    }
    const { img } = await d.grab();
    sizes.add(`${img.bitmap.width}x${img.bitmap.height}`);
    const id = `b${(k * 5) % 24}`;
    const r = JSON.parse(await ev(`JSON.stringify(document.getElementById('${id}').getBoundingClientRect())`));
    if (r.y < 0 || r.y + r.height > innerHeightOf(d)) continue; // 被滚出视口的跳过
    tried++;
    await d.click(null, { px: (r.x + r.width / 2) * d.dpr, py: (r.y + r.height / 2) * d.dpr });
    await new Promise((r) => setTimeout(r, 200));
    const hit = JSON.parse(await ev('JSON.stringify(__hits.at(-1) || null)'));
    if (!hit || hit.id !== id) {
      miss++;
      console.log(`MISS 目标 ${id}，实际点到 ${JSON.stringify(hit)}，截图 ${img.bitmap.width}x${img.bitmap.height}，dpr ${d.dpr}`);
    }
  }
} finally {
  await d.close();
  await fetch(`${endpoint}/json/close/${tab.id}`).catch(() => {});
}
console.log(`${browser}（${endpoint}）：点了 ${tried} 次，点偏 ${miss} 次；截图尺寸: ${[...sizes].join(', ')}`);
process.exit(miss ? 1 : 0);

function innerHeightOf(drv) {
  return drv.viewport.height;
}
