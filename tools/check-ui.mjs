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
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="initial-route" content="/">
<style>
:root{--vscode-font-family:"Segoe UI","Microsoft YaHei",sans-serif;--vscode-font-size:13px;--vscode-sideBar-background:#f7f7f7;--vscode-sideBar-foreground:#242424;--vscode-input-background:#fff;--vscode-panel-border:#e4e4e4;--vscode-descriptionForeground:#7d7d7d;--vscode-focusBorder:#007acc}
:root[data-theme=dark]{--vscode-sideBar-background:#202020;--vscode-sideBar-foreground:#eee;--vscode-input-background:#2b2b2b;--vscode-input-foreground:#eee;--vscode-panel-border:#393939;--vscode-descriptionForeground:#aaa;--vscode-list-hoverBackground:#303030;--vscode-list-inactiveSelectionBackground:#383838}
*{box-sizing:border-box}html,body,#root{margin:0;height:100%;width:100%}body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#fff;color:#282828}#root{display:flex;flex-direction:column;padding:24px;background:inherit}header{font-size:14px}article{flex:1;padding:40px 5%;line-height:1.8}article h1{font-size:22px}article p{max-width:600px;color:#777}textarea{width:100%;height:100px;padding:18px;border:1px solid #ddd;border-radius:20px;font:inherit;resize:none;background:inherit;color:inherit}.note{font-size:11px;color:#888;margin-top:8px}
</style>
<script>
window.mockThreads=${JSON.stringify(threads)};window.mockState={mode:'all',width:250,groups:[],collapsed:null,disabled:false};window.mockRequests=[];window.mockRoute='/';window.mockDrafts={'/':'未发送的草稿','/local/thread-8':'历史聊天自己的草稿'};window.mockSubmissions=0;window.mockUnavailable=new Set();let acquired=false;
window.mockDraftKey=path=>{const url=new URL(path,location.origin);return __vscodexLayerBridge.projectRoute(url.pathname,url.pathname,url.search)?.vclDraftKey??path};
window.mockNavigate=path=>{mockRoute=path;__vscodexLayerBridge.observeRoute(path);document.querySelector('#native-title').textContent=path==='/'?'':mockThreads.find(t=>'/local/'+t.id===path)?.title??'新聊天';const previous=document.querySelector('#native-composer');const next=previous.cloneNode();next.value=mockDrafts[mockDraftKey(path)]??'';next.oninput=()=>{mockDrafts[mockDraftKey(mockRoute)]=next.value};previous.replaceWith(next);document.querySelector('[data-vcl-home-history]').hidden=path!=='/'};
window.mockNewChat=()=>{if(!__vscodexLayerBridge.resumeDraft({selectChat:true}))mockNavigate('/')};
window.mockSubmit=async success=>{if(!success)return;const url=new URL(mockRoute,location.origin);const project=__vscodexLayerBridge.projectRoute(url.pathname,url.pathname,url.search);if(project)await __vscodexLayerBridge.validateProject(project.vclProjectCwd);mockSubmissions++;mockDrafts[mockDraftKey(mockRoute)]='';const thread={id:mockSubmissions===1?'sent-thread':'sent-thread-'+mockSubmissions,title:'新发送的聊天',cwd:project?.vclProjectCwd??'D:/WRK/VSCodexLayer',updatedAt:2000};mockThreads.unshift(thread);mockNavigate('/local/'+thread.id);window.postMessage({type:'vscodex-layer/event',event:'threads-changed'},location.origin)};
window.acquireVsCodeApi=()=>{if(acquired)throw Error('API acquired twice');acquired=true;let state={draft:'未发送的草稿'};return{getState:()=>state,setState:value=>(state=value),postMessage(message){
if(message.type!=='vscodex-layer/request')return;mockRequests.push(message);let result,error;
if(message.method==='init')result={supported:true,folders:[{name:'VSCodexLayer',path:'D:/WRK/VSCodexLayer'}],state:mockState,version:'mock'};
else if(message.method==='list'){const first=message.params.cursor==null;result={data:mockThreads.slice(first?0:50,first?50:undefined),nextCursor:first?'page-2':null}}
else if(message.method==='save-state'){mockState=structuredClone(message.params.state);result={saved:true}}
else if(message.method==='navigate'){mockNavigate('/local/'+message.params.threadId);result={threadId:message.params.threadId}}
else if(message.method==='validate-project'){if(mockUnavailable.has(message.params.cwd))error='项目目录不存在或无法访问';else result={cwd:message.params.cwd}}
else if(message.method==='new-project-chat'){if(mockUnavailable.has(message.params.cwd))error='项目目录不存在或无法访问';else{const path=message.params.path+'?vclProjectCwd='+encodeURIComponent(message.params.cwd);mockNavigate(path);result={path,cwd:message.params.cwd}}}
else if(message.method==='new-chat'){mockNavigate(message.params.path);result={path:message.params.path}}
setTimeout(()=>window.postMessage({type:'vscodex-layer/response',id:message.id,result,error},location.origin),0)
}}};
</script>
<link rel="stylesheet" href="/webview/layer.css"><script src="/webview/bootstrap.js"></script>
<script type="module" src="/webview/layer.mjs"></script>
</head><body><main id="root"><header><button data-vcl-chat-back aria-label="返回">←</button><span id="native-title"></span></header><div data-vcl-home-history>聊天 · 最近聊天 · 查看全部</div><article><h1>右侧保留官方聊天界面</h1><p>这里使用模拟聊天区域检查导航布局。实际增强复用官方消息、输入框、模型选择、工具执行和审批。</p><p>选择左侧聊天，在同一个页面切换。项目可以折叠，支持全部项目和当前项目筛选。</p></article><textarea id="native-composer" aria-label="聊天输入框">未发送的草稿</textarea><div class="note">界面验证示意 · 模拟数据</div></main>
<script type="module">window.nativeRoot=document.getElementById('root');window.nativeApi=acquireVsCodeApi();mockNavigate('/');nativeApi.postMessage({type:'ready'});</script>
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
  const toggleShortcut = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', modifiers: 1 }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 1 }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', modifiers: 1 }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft' }, sessionId);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: address }, sessionId);
  await waitFor(`document.querySelector('.vcl-count')?.textContent.includes('63 个聊天')`);
  await assertBrowser(`mockRequests.filter(r=>r.method==='list').length===2`, '没有读取完整分页');
  await assertBrowser(`document.querySelectorAll('.vcl-project-heading').length===3`, '同名项目被错误合并');
  await assertBrowser(`document.querySelectorAll('#vcl-navigation img').length===0`, '聊天标题被当成 HTML 执行');
  await assertBrowser(`document.getElementById('root')===nativeRoot && document.getElementById('native-composer').value==='未发送的草稿' && nativeApi.getState().draft==='未发送的草稿'`, '官方根节点或草稿被改写');
  await assertBrowser(`!document.querySelector('[aria-current="page"]') && getComputedStyle(document.querySelector('[data-vcl-home-history]')).display==='none'`, '空白页仍显示重复历史列表或选中聊天');
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await waitFor(`document.getElementById('vcl-navigation').classList.contains('vcl-collapsed')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await waitFor(`!document.getElementById('vcl-navigation').classList.contains('vcl-collapsed')`);
  await evaluate(`document.getElementById('native-composer').value='中文草稿\\n第二行 @文件 /命令';document.getElementById('native-composer').dispatchEvent(new Event('input'));document.querySelector('[data-vcl-key="thread:thread-8"]').click()`);
  await waitFor(`mockRoute==='/local/thread-8'`);
  await assertBrowser(`getComputedStyle(document.querySelector('[data-vcl-chat-back]')).display==='none'`, '聊天顶部返回键仍显示');
  await assertBrowser(`document.getElementById('native-composer').value==='历史聊天自己的草稿'`, '新聊天草稿串入历史聊天');
  await evaluate(`mockNewChat()`);
  await waitFor(`mockRoute==='/'`);
  await assertBrowser(`document.getElementById('native-composer').value==='中文草稿\\n第二行 @文件 /命令' && mockSubmissions===0 && mockThreads.length===63`, '切回空白页草稿丢失或提前创建了聊天');
  await evaluate(`mockSubmit(false);document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`!document.querySelector('[aria-label="刷新聊天列表"]').disabled`);
  await assertBrowser(`document.getElementById('native-composer').value==='中文草稿\\n第二行 @文件 /命令'`, '失败或刷新丢失草稿');
  await evaluate(`document.getElementById('native-composer').value='未发送的草稿';document.getElementById('native-composer').dispatchEvent(new Event('input'))`);
  await evaluate(`document.getElementById('native-composer').focus()`);
  await toggleShortcut();
  await waitFor(`mockState.collapsed===true`);
  await assertBrowser(`document.getElementById('vcl-navigation').classList.contains('vcl-collapsed') && document.activeElement.id==='native-composer' && document.getElementById('native-composer').value==='未发送的草稿'`, '快捷键没有折叠导航或改变输入框草稿／焦点');
  await assertBrowser(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',code:'Slash',altKey:true,repeat:true,cancelable:true}))===false && document.getElementById('vcl-navigation').classList.contains('vcl-collapsed')`, '长按快捷键反复切换');
  await toggleShortcut();
  await waitFor(`mockState.collapsed===false`);
  await assertBrowser(`!document.getElementById('vcl-navigation').classList.contains('vcl-collapsed') && document.getElementById('native-composer').value==='未发送的草稿'`, '快捷键没有展开导航或写入斜杠');
  await assertBrowser(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',code:'Slash',altKey:true,ctrlKey:true,cancelable:true})) && window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',code:'Slash',altKey:true,isComposing:true,cancelable:true})) && !document.getElementById('vcl-navigation').classList.contains('vcl-collapsed')`, '快捷键拦截其他组合键或中文输入法');
  await evaluate(`document.querySelector('.vcl-input').focus()`);
  await toggleShortcut();
  await assertBrowser(`document.activeElement.id==='vcl-toggle'`, '折叠后焦点留在隐藏的导航控件');
  await toggleShortcut();
  await screenshot('navigation-light.png');
  await evaluate(`document.querySelector('[data-vcl-key="thread:thread-8"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-8"]')?.getAttribute('aria-current')==='page'`);
  await evaluate(`const select=document.getElementById('vcl-mode');select.value='current';select.dispatchEvent(new Event('change'))`);
  await assertBrowser(`document.querySelectorAll('.vcl-project-heading').length===1 && document.querySelectorAll('.vcl-thread').length===8`, '当前项目筛选错误');
  await evaluate(`const input=document.querySelector('.vcl-input');input.value='检查';input.dispatchEvent(new Event('input'))`);
  await assertBrowser(`document.querySelectorAll('.vcl-thread').length===1`, '聊天搜索错误');
  await evaluate(`document.querySelector('.vcl-input').value='';document.querySelector('.vcl-input').dispatchEvent(new Event('input'));document.querySelector('[data-vcl-key="thread:thread-0"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-0"]')?.getAttribute('aria-current')==='page'`);
  await evaluate(`window.postMessage({type:'vscodex-layer/event',event:{type:'thread-activity',threadId:'thread-0',phase:'completed',status:'idle',activeFlags:[]}},location.origin)`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`);
  await assertBrowser(`document.querySelector('[data-vcl-key="thread:thread-0"]').getAttribute('aria-label').includes('本轮已结束') && getComputedStyle(document.querySelector('.vcl-attention')).backgroundColor==='rgb(55, 148, 255)'`, '当前聊天结束没有蓝点或状态说明');
  await evaluate(`document.querySelector('.vcl-project-heading').click();document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`!document.querySelector('[aria-label="刷新聊天列表"]').disabled`);
  await assertBrowser(`document.querySelectorAll('.vcl-thread').length===0`, '项目折叠失败');
  await assertBrowser(`document.querySelector('.vcl-project-heading .vcl-attention')`, '折叠项目丢失提醒');
  await evaluate(`document.querySelector('.vcl-project-heading').click();document.querySelector('[role=separator]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  await waitFor(`mockState.width===260 && mockState.mode==='current'`);
  await assertBrowser(`mockState.unread.includes('thread-0') && document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`, '刷新丢失结束提示或未保存未读状态');
  await evaluate(`document.querySelector('[data-vcl-key="thread:thread-0"]').click()`);
  await assertBrowser(`!document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`, '点击当前聊天没有清除结束提示');
  await evaluate(`window.postMessage({type:'vscodex-layer/event',event:{type:'thread-activity',threadId:'thread-0',phase:'status',status:'active',activeFlags:['waitingOnApproval']}},location.origin)`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`);
  await evaluate(`document.querySelector('[data-vcl-key="thread:thread-0"]').click()`);
  await assertBrowser(`document.querySelector('[data-vcl-key="thread:thread-0"]').getAttribute('aria-label').includes('等待审批') && document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`, '查看误清除尚未处理的审批提醒');
  await evaluate(`window.postMessage({type:'vscodex-layer/event',event:{type:'thread-activity',threadId:'thread-0',phase:'started',status:'active',activeFlags:[]}},location.origin)`);
  await waitFor(`!document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`);
  await screenshot('navigation-current.png');
  await evaluate(`document.documentElement.dataset.theme='dark';document.body.style.background='#181818';document.body.style.color='#eee'`);
  await screenshot('navigation-dark.png');
  await evaluate(`document.querySelector('[aria-label="返回原版界面"]').click()`);
  await waitFor(`!document.body.classList.contains('vcl-enabled') && document.getElementById('vcl-launcher')`);
  await assertBrowser(`mockState.disabled && document.getElementById('root')===nativeRoot && getComputedStyle(document.querySelector('[data-vcl-chat-back]')).display!=='none'`, '返回原版时状态或返回键错误');
  await evaluate(`mockNewChat()`);
  await assertBrowser(`document.getElementById('native-composer').value==='未发送的草稿' && getComputedStyle(document.querySelector('[data-vcl-home-history]')).display!=='none'`, '返回原版未恢复首页列表或草稿');
  await evaluate(`window.mockKeyEvents=0;window.addEventListener('keydown',()=>{mockKeyEvents++})`);
  await toggleShortcut();
  await assertBrowser(`mockKeyEvents===2 && !document.body.classList.contains('vcl-enabled')`, '导航关闭后仍拦截快捷键');
  await evaluate(`document.getElementById('vcl-launcher').click()`);
  await waitFor(`document.body.classList.contains('vcl-enabled') && document.querySelector('.vcl-count')?.textContent.includes('8 个聊天')`);
  await assertBrowser(`!mockState.disabled`, '重新启用失败');
  await evaluate(`mockSubmit(true)`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:sent-thread"]')?.getAttribute('aria-current')==='page'`);
  await evaluate(`mockNewChat()`);
  await waitFor(`mockRoute==='/'`);
  await assertBrowser(`document.getElementById('native-composer').value==='' && mockSubmissions===1 && mockThreads.length===64`, '发送后草稿复活或聊天重复创建');
  await evaluate(`document.getElementById('vcl-mode').value='all';document.getElementById('vcl-mode').dispatchEvent(new Event('change'))`);
  await assertBrowser(`document.querySelectorAll('.vcl-new-chat').length===3 && document.querySelectorAll('.vcl-project-heading .vcl-new-chat').length===0`, '项目新建按钮缺失或嵌入折叠按钮');
  await evaluate(`document.querySelector('[data-vcl-key="project:d:/other/project"]').click();document.querySelector('[data-vcl-key="new:d:/other/project"]').click()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Other/Project' && !document.querySelector('.vcl-new-chat').disabled`);
  await assertBrowser(`getComputedStyle(document.querySelector('[data-vcl-chat-back]')).display==='none'`, '项目新聊天页顶部返回键仍显示');
  await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/other/project"]').getAttribute('aria-expanded')==='false' && document.querySelector('.vcl-project-context').title==='D:/Other/Project' && mockThreads.length===64 && mockSubmissions===1`, '新建操作折叠项目、绑定错误目录或提前创建聊天');
  await evaluate(`document.getElementById('native-composer').value='其他项目的草稿';document.getElementById('native-composer').dispatchEvent(new Event('input'));document.querySelector('[data-vcl-key="new:d:/wrk/vscodexlayer"]').click()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/WRK/VSCodexLayer'`);
  await assertBrowser(`document.getElementById('native-composer').value===''`, '其他项目草稿串入当前项目');
  await evaluate(`document.getElementById('native-composer').value='当前项目的草稿';document.getElementById('native-composer').dispatchEvent(new Event('input'));document.querySelector('[data-vcl-key="new:d:/other/project"]').click()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Other/Project'`);
  await assertBrowser(`document.getElementById('native-composer').value==='其他项目的草稿'`, '跨项目切回后草稿丢失');
  await evaluate(`document.querySelector('[data-vcl-key="thread:thread-8"]').click()`);
  await waitFor(`mockRoute==='/local/thread-8'`);
  await evaluate(`mockNewChat()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Other/Project'`);
  await assertBrowser(`document.getElementById('native-composer').value==='其他项目的草稿'`, '普通新聊天没有返回上次的项目草稿');
  await evaluate(`mockUnavailable.add('D:/WRK/Project');document.querySelector('[data-vcl-key="new:d:/wrk/project"]').click()`);
  await waitFor(`document.querySelector('.vcl-status').classList.contains('vcl-error') && !document.querySelector('.vcl-new-chat').disabled`);
  await assertBrowser(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Other/Project' && document.getElementById('native-composer').value==='其他项目的草稿'`, '失效项目新建后回退或覆盖草稿');
  await evaluate(`mockUnavailable.add('D:/Other/Project')`);
  await assertBrowser(`(async()=>{try{await mockSubmit(true);return false}catch(error){return mockSubmissions===1&&mockThreads.length===64&&document.getElementById('native-composer').value==='其他项目的草稿'}})()`, '首次发送未拒绝失效目录或丢失草稿');
  await evaluate(`mockUnavailable.clear();mockSubmit(true)`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:sent-thread-2"]')?.getAttribute('aria-current')==='page'`);
  await assertBrowser(`mockThreads[0].cwd==='D:/Other/Project' && document.querySelector('[data-vcl-key="thread:sent-thread-2"]').closest('.vcl-project').querySelector('[data-vcl-key="project:d:/other/project"]')`, '新聊天创建到了当前窗口目录或错误项目分组');
  await evaluate(`mockNewChat()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Other/Project'`);
  await assertBrowser(`document.getElementById('native-composer').value===''`, '发送后项目草稿没有清理');
  await evaluate(`document.querySelector('[data-vcl-key="new:d:/wrk/vscodexlayer"]').click()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/WRK/VSCodexLayer'`);
  await assertBrowser(`document.getElementById('native-composer').value==='当前项目的草稿'`, '发送其他项目后当前项目草稿被清理');
  await evaluate(`mockThreads.push({id:'unclassified',title:'未分类聊天',cwd:null});document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="new:"]')?.disabled`);
  await screenshot('navigation-project-new-chat.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await waitFor(`!document.getElementById('vcl-navigation').classList.contains('vcl-collapsed')`);
  await toggleShortcut();
  await waitFor(`document.getElementById('vcl-navigation')?.classList.contains('vcl-collapsed')`);
  await screenshot('navigation-narrow.png');
  console.log('无头界面检查通过：提醒与结束蓝点、折叠项目汇总、未读保存与查看清除，以及项目新建、草稿隔离、搜索筛选和导航布局。');
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
