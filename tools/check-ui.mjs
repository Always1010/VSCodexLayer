import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.scratch', 'ui');
await fs.mkdir(output, { recursive: true });
const executable = [
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
].find((file) => { try { return !!process.getBuiltinModule('node:fs').statSync(file); } catch { return false; } });
if (!executable) throw new Error('没有找到现有 Chrome 或 Edge；本脚本不会安装浏览器。');

const threads = Array.from({ length: 63 }, (_, index) => ({
  id: `thread-${index}`, title: index === 0 ? '设计项目聊天导航' : index === 1 ? '<img src=x onerror=alert(1)>'
    : index === 2 ? '检查当前项目筛选' : index < 8 ? `VSCodexLayer 聊天 ${index + 1}` : `其他项目聊天 ${index - 7}`,
  cwd: index < 8 ? 'D:/WRK/VSCodexLayer' : index < 38 ? 'D:/WRK/Project' : 'D:/Other/Project',
  updatedAt: 1000 - index, status: index === 0 ? 'active' : 'notLoaded',
}));
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="initial-route" content="/local/thread-0">
<style>
:root{--vscode-font-family:"Segoe UI","Microsoft YaHei",sans-serif;--vscode-font-size:13px;--vscode-sideBar-background:#f7f7f7;--vscode-sideBar-foreground:#242424;--vscode-input-background:#fff;--vscode-panel-border:#e4e4e4;--vscode-descriptionForeground:#7d7d7d;--vscode-focusBorder:#007acc}
:root[data-theme=dark]{--vscode-sideBar-background:#202020;--vscode-sideBar-foreground:#eee;--vscode-input-background:#2b2b2b;--vscode-input-foreground:#eee;--vscode-panel-border:#393939;--vscode-descriptionForeground:#aaa;--vscode-list-hoverBackground:#303030;--vscode-list-inactiveSelectionBackground:#383838}
*{box-sizing:border-box}html,body,#root{margin:0;height:100%;width:100%}body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#fff;color:#282828}#root{display:flex;flex-direction:column;padding:24px;background:inherit}header{font-size:14px}article{flex:1;padding:40px 5%;line-height:1.8}article h1{font-size:22px}article p{max-width:600px;color:#777}textarea{width:100%;height:100px;padding:18px;border:1px solid #ddd;border-radius:20px;font:inherit;resize:none;background:inherit;color:inherit}.note{font-size:11px;color:#888;margin-top:8px}
</style>
<script>
window.mockThreads=${JSON.stringify(threads)};window.mockState={mode:'all',width:250,groups:[],collapsed:null,disabled:false};window.mockRequests=[];let acquired=false;
window.acquireVsCodeApi=()=>{if(acquired)throw Error('API acquired twice');acquired=true;let state={draft:'未发送的草稿'};return{getState:()=>state,setState:value=>(state=value),postMessage(message){
if(message.type!=='vscodex-layer/request')return;mockRequests.push(message);let result;
if(message.method==='init')result={supported:true,folders:[{name:'VSCodexLayer',path:'D:/WRK/VSCodexLayer'}],state:mockState,version:'mock'};
else if(message.method==='list'){const first=message.params.cursor==null;result={data:mockThreads.slice(first?0:50,first?50:63),nextCursor:first?'page-2':null}}
else if(message.method==='save-state'){mockState=structuredClone(message.params.state);result={saved:true}}
else if(message.method==='navigate'){__vscodexLayerBridge.observeRoute('/local/'+message.params.threadId);document.querySelector('#native-title').textContent=mockThreads.find(t=>t.id===message.params.threadId).title;result={threadId:message.params.threadId}}
setTimeout(()=>window.postMessage({type:'vscodex-layer/response',id:message.id,result},location.origin),0)
}}};
</script>
<link rel="stylesheet" href="/webview/layer.css"><script src="/webview/bootstrap.js"></script>
<script type="module" src="/webview/layer.mjs"></script>
</head><body><main id="root"><header id="native-title">设计项目聊天导航</header><article><h1>右侧保留官方聊天界面</h1><p>这里使用模拟聊天区域检查导航布局。实际增强复用官方消息、输入框、模型选择、工具执行和审批。</p><p>选择左侧聊天，在同一个页面切换。项目可以折叠，支持全部项目和当前项目筛选。</p></article><textarea id="native-composer" aria-label="聊天输入框">未发送的草稿</textarea><div class="note">界面验证示意 · 模拟数据</div></main>
<script type="module">window.nativeRoot=document.getElementById('root');window.nativeApi=acquireVsCodeApi();nativeApi.postMessage({type:'ready'});</script>
</body></html>`;
const allowed = new Set(['bootstrap.js', 'client.mjs', 'core.mjs', 'layer.mjs', 'layer.css']);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); return; }
  const name = url.pathname.replace('/webview/', '');
  if (!url.pathname.startsWith('/webview/') || !allowed.has(name)) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : 'text/javascript' });
    response.end(await fs.readFile(path.join(root, 'webview', name)));
  } catch { response.writeHead(500); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/`;
const tempParent = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(tempParent, 'vscodex-layer-browser-'));
if (!profile.startsWith(`${tempParent}${path.sep}vscodex-layer-browser-`)) throw new Error('临时浏览器目录异常。');
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let sequence = 0;
const pending = new Map();
let closed = false;
browser.once('exit', () => { closed = true; });
async function send(method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
try {
  let portInfo;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { portInfo = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; }
    catch { if (closed) throw new Error('无头浏览器启动失败。'); await pause(100); }
  }
  if (!portInfo) throw new Error('无头浏览器未提供调试端口。');
  socket = new WebSocket(`ws://127.0.0.1:${portInfo[0]}${portInfo[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); const request = pending.get(message.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = (condition) => evaluate(`new Promise((resolve,reject)=>{let tries=0;const check=()=>{if(${condition})return resolve(true);if(++tries>150)return reject(Error('界面等待超时: '+${JSON.stringify(condition)}));setTimeout(check,30)};check()})`);
  const assertBrowser = async (condition, label) => {
    if (!await evaluate(`Boolean(${condition})`)) throw new Error(label);
  };
  const screenshot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(path.join(output, name), Buffer.from(data, 'base64'));
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: address }, sessionId);
  await waitFor(`document.querySelector('.vcl-count')?.textContent.includes('63 个聊天')`);
  await assertBrowser(`mockRequests.filter(r=>r.method==='list').length===2`, '没有读取完整分页');
  await assertBrowser(`document.querySelectorAll('.vcl-project-heading').length===3`, '同名项目被错误合并');
  await assertBrowser(`document.querySelectorAll('#vcl-navigation img').length===0`, '聊天标题被当成 HTML 执行');
  await assertBrowser(`document.getElementById('root')===nativeRoot && document.getElementById('native-composer').value==='未发送的草稿' && nativeApi.getState().draft==='未发送的草稿'`, '官方根节点或草稿被改写');
  await screenshot('navigation-light.png');
  await evaluate(`document.querySelector('[data-vcl-key="thread:thread-8"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-8"]')?.getAttribute('aria-current')==='page'`);
  await evaluate(`const select=document.getElementById('vcl-mode');select.value='current';select.dispatchEvent(new Event('change'))`);
  await assertBrowser(`document.querySelectorAll('.vcl-project-heading').length===1 && document.querySelectorAll('.vcl-thread').length===8`, '当前项目筛选错误');
  await evaluate(`const input=document.querySelector('.vcl-input');input.value='检查';input.dispatchEvent(new Event('input'))`);
  await assertBrowser(`document.querySelectorAll('.vcl-thread').length===1`, '聊天搜索错误');
  await evaluate(`document.querySelector('.vcl-input').value='';document.querySelector('.vcl-input').dispatchEvent(new Event('input'));document.querySelector('[data-vcl-key="thread:thread-0"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-0"]')?.getAttribute('aria-current')==='page'`);
  await evaluate(`document.querySelector('.vcl-project-heading').click();document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`!document.querySelector('[aria-label="刷新聊天列表"]').disabled`);
  await assertBrowser(`document.querySelectorAll('.vcl-thread').length===0`, '项目折叠失败');
  await evaluate(`document.querySelector('.vcl-project-heading').click();document.querySelector('[role=separator]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  await waitFor(`mockState.width===260 && mockState.mode==='current'`);
  await screenshot('navigation-current.png');
  await evaluate(`document.documentElement.dataset.theme='dark';document.body.style.background='#181818';document.body.style.color='#eee'`);
  await screenshot('navigation-dark.png');
  await evaluate(`document.querySelector('[aria-label="返回原版界面"]').click()`);
  await waitFor(`!document.body.classList.contains('vcl-enabled') && document.getElementById('vcl-launcher')`);
  await assertBrowser(`mockState.disabled && document.getElementById('root')===nativeRoot && document.getElementById('native-composer').value==='未发送的草稿'`, '返回原版时草稿或状态错误');
  await evaluate(`document.getElementById('vcl-launcher').click()`);
  await waitFor(`document.body.classList.contains('vcl-enabled') && document.querySelector('.vcl-count')?.textContent.includes('8 个聊天')`);
  await assertBrowser(`!mockState.disabled`, '重新启用失败');
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await waitFor(`document.getElementById('vcl-navigation')?.classList.contains('vcl-collapsed')`);
  await screenshot('navigation-narrow.png');
  console.log('无头界面检查通过：63 条分页、同名项目、筛选、搜索、折叠、路由高亮、宽度保存、草稿保留、返回原版、重新启用和窄窗口。');
  console.log(`模拟界面截图：${output}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close'); } catch { /* Browser may close before acknowledging. */ }
    socket.close();
  }
  for (let attempt = 0; !closed && attempt < 50; attempt += 1) await pause(100);
  if (!closed) browser.kill();
  for (const request of pending.values()) clearTimeout(request.timer);
  server.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
