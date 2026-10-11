import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readingOnly = process.argv.length === 3 && process.argv[2] === '--reading';
const reasoningOnly = process.argv.length === 3 && process.argv[2] === '--reasoning';
const archiveOnly = process.argv.length === 3 && process.argv[2] === '--archive';
if (process.argv.length > 2 && !readingOnly && !reasoningOnly && !archiveOnly) throw new Error('用法：node tools/check-ui.mjs [--reading|--reasoning|--archive]');
const output = path.join(root, '.scratch', 'ui');
await fs.mkdir(output, { recursive: true });
const executable = [
  '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
].find((file) => { try { return !!process.getBuiltinModule('node:fs').statSync(file); } catch { return false; } });
if (!executable) throw new Error('没有找到现有 Chrome 或 Edge；本脚本不会安装浏览器。');

const threads = Array.from({ length: 63 }, (_, index) => ({
  id: `thread-${index}`, title: index === 0 ? '设计项目聊天导航' : index === 1 ? '<img src=x onerror=alert(1)>'
    : index === 2 ? '检查当前项目筛选' : index < 8 ? `VSCodexLayer 聊天 ${index + 1}` : `其他项目聊天 ${index - 7}`,
  cwd: index < 8 ? 'D:/WRK/VSCodexLayer' : index < 38 ? 'D:/WRK/Project' : 'D:/Other/Project',
  createdAt: 1000 + index, updatedAt: 1000 - index, status: index === 0 ? 'active' : 'notLoaded',
}));
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="initial-route" content="/">
<style>
:root{--vscode-font-family:"Segoe UI","Microsoft YaHei",sans-serif;--vscode-font-size:13px;--vscode-sideBar-background:#f7f7f7;--vscode-sideBar-foreground:#242424;--vscode-input-background:#fff;--vscode-panel-border:#e4e4e4;--vscode-descriptionForeground:#7d7d7d;--vscode-focusBorder:#007acc}
:root[data-theme=dark]{--vscode-sideBar-background:#202020;--vscode-sideBar-foreground:#eee;--vscode-input-background:#2b2b2b;--vscode-input-foreground:#eee;--vscode-panel-border:#393939;--vscode-descriptionForeground:#aaa;--vscode-list-hoverBackground:#303030;--vscode-list-inactiveSelectionBackground:#383838}
*{box-sizing:border-box}html,body,#root{margin:0;height:100%;width:100%}body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#fff;color:#282828}#root{display:flex;flex-direction:column;padding:24px;background:inherit}header{font-size:14px}article{flex:1;padding:40px 5%;line-height:1.8}article h1{font-size:22px}article p{max-width:600px;color:#777}textarea{width:100%;height:100px;padding:18px;border:1px solid #ddd;border-radius:20px;font:inherit;resize:none;background:inherit;color:inherit}.note{font-size:11px;color:#888;margin-top:8px}
</style>
<script>
window.mockThreads=${JSON.stringify(threads)};window.mockState={revision:0,mode:'all',width:250,groups:[],collapsed:null,disabled:false,pinnedProjects:[],unread:[],unreadTurns:{}};window.mockRegistry={revision:0,projects:[]};window.mockPickedFolder=null;window.mockCannotOpen=false;window.mockSaveFailure=false;window.mockCopiedPath=null;window.mockRequests=[];window.mockRoute='/';window.mockDrafts={'/':'未发送的草稿','/local/thread-8':'历史聊天自己的草稿'};window.mockSubmissions=0;window.mockUnavailable=new Set();let acquired=false;
window.mockDraftKey=path=>{const url=new URL(path,location.origin);return __vscodexLayerBridge.projectRoute(url.pathname,url.pathname,url.search)?.vclDraftKey??path};
window.mockNavigate=path=>{mockRoute=path;__vscodexLayerBridge.observeRoute(path);document.querySelector('#native-title').textContent=path==='/'?'':mockThreads.find(t=>'/local/'+t.id===path)?.title??'新聊天';const previous=document.querySelector('#native-composer');const next=previous.cloneNode();next.value=mockDrafts[mockDraftKey(path)]??'';next.oninput=()=>{mockDrafts[mockDraftKey(mockRoute)]=next.value};previous.replaceWith(next);document.querySelector('[data-vcl-home-history]').hidden=path!=='/'};
window.mockNewChat=()=>{if(!__vscodexLayerBridge.resumeDraft({selectChat:true}))mockNavigate('/')};
window.mockSubmit=async success=>{if(!success)return;const url=new URL(mockRoute,location.origin);const project=__vscodexLayerBridge.projectRoute(url.pathname,url.pathname,url.search);if(project)await __vscodexLayerBridge.validateProject(project.vclProjectCwd);mockSubmissions++;mockDrafts[mockDraftKey(mockRoute)]='';const thread={id:mockSubmissions===1?'sent-thread':'sent-thread-'+mockSubmissions,title:'新发送的聊天',cwd:project?.vclProjectCwd??'D:/WRK/VSCodexLayer',createdAt:2000+mockSubmissions,updatedAt:2000};mockThreads.unshift(thread);mockNavigate('/local/'+thread.id);window.postMessage({type:'vscodex-layer/event',event:'threads-changed'},location.origin)};
window.acquireVsCodeApi=()=>{if(acquired)throw Error('API acquired twice');acquired=true;let state={draft:'未发送的草稿'};return{getState:()=>state,setState:value=>(state=value),postMessage(message){
if(message.type!=='vscodex-layer/request')return;mockRequests.push(message);let result,error;
if(message.method==='init')result={supported:true,mode:'local',registry:structuredClone(mockRegistry),folders:[{name:'VSCodexLayer',path:'D:/WRK/VSCodexLayer'}],state:mockState,version:'mock'};
else if(message.method==='list'){const first=message.params.cursor==null;const list=message.params.archived?mockArchivedThreads:mockThreads;result={data:structuredClone(list.slice(first?0:50,first?50:undefined)),nextCursor:first&&list.length>50?'page-2':null};if(message.params.archived&&mockArchiveListFailure)error='归档列表读取失败'}
else if(message.method==='save-state'){mockState=mockApplyOperations(mockState,message.params.operations);mockState.revision++;result={saved:true,state:structuredClone(mockState)};window.postMessage({type:'vscodex-layer/event',event:{type:'navigation-state-changed',state:structuredClone(mockState)}},location.origin)}
else if(message.method==='navigate'){mockNavigate('/local/'+message.params.threadId);result={threadId:message.params.threadId}}
else if(message.method==='validate-project'){if(mockUnavailable.has(message.params.cwd))error='项目目录不存在或无法访问';else result={cwd:message.params.cwd}}
else if(message.method==='new-project-chat'){if(mockCannotOpen||mockUnavailable.has(message.params.cwd))error='项目目录不存在或无法访问';else{const path=message.params.path+'?vclProjectCwd='+encodeURIComponent(message.params.cwd);mockNavigate(path);result={path,cwd:message.params.cwd}}}
else if(message.method==='new-chat'){mockNavigate(message.params.path);result={path:message.params.path}}
else if(message.method==='pick-project-folder')result=mockPickedFolder?{cwd:mockPickedFolder}:{cancelled:true};
else if(message.method==='copy-project-path'){mockCopiedPath=message.params.cwd;result={copied:true}}
else if(message.method==='add-project'||message.method==='remove-project'){
 const cwd=message.params.cwd;const index=mockRegistry.projects.findIndex(project=>project.path.toLowerCase()===cwd.toLowerCase());const add=message.method==='add-project';
 if(mockSaveFailure)error='保存失败';else if(add&&(!cwd.startsWith('D:/')||mockUnavailable.has(cwd)))error='项目目录不存在或无法访问';
 else{const changed=add?index<0:index>=0;if(changed){if(add)mockRegistry.projects.push({path:cwd});else mockRegistry.projects.splice(index,1);mockRegistry.revision++;window.postMessage({type:'vscodex-layer/event',event:{type:'projects-changed',...structuredClone(mockRegistry)}},location.origin)}result={...structuredClone(mockRegistry),cwd,changed}}
}

const respond=()=>window.postMessage({type:'vscodex-layer/response',id:message.id,result,error},location.origin);
if(message.method==='list'&&mockHoldView===(message.params.archived?'archived':'active'))mockHeldLists.push(respond);else setTimeout(respond,0)
}}};
</script>
<link rel="stylesheet" href="/webview/layer.css"><script src="/webview/bootstrap.js"></script>
<script type="module" src="/webview/layer.mjs"></script>
</head><body><main id="root"><header><button data-vcl-chat-back aria-label="返回">←</button><span id="native-title"></span></header><div data-vcl-home-history>聊天 · 最近聊天 · 查看全部</div><article><h1>右侧保留官方聊天界面</h1><p>这里使用模拟聊天区域检查导航布局。实际增强复用官方消息、输入框、模型选择、工具执行和审批。</p><p>选择左侧聊天，在同一个页面切换。项目可以折叠，支持全部项目和当前项目筛选。</p></article><textarea id="native-composer" aria-label="聊天输入框">未发送的草稿</textarea><div class="note">界面验证示意 · 模拟数据</div></main>
<script type="module">
import {overlayNavigationEdits} from '/webview/core.mjs';
window.mockApplyOperations=overlayNavigationEdits;
let mockTurnSequence=0;
window.addEventListener('message',message=>{
 const event=message.data?.event;if(event?.type!=='thread-activity'||event.__mockCanonical||!['started','completed'].includes(event.phase))return;
 message.stopImmediatePropagation();
 event.turnToken=event.turnToken??(event.phase==='started'?'mock-turn-'+(++mockTurnSequence):mockState.unreadTurns[event.threadId]??'mock-turn-'+(++mockTurnSequence));
 mockState.unreadTurns[event.threadId]=event.turnToken;
 mockState.unread=mockState.unread.filter(id=>id!==event.threadId);
 if(event.phase==='completed')mockState.unread.push(event.threadId);
 event.unread=event.phase==='completed';mockState.revision++;
 window.postMessage({type:'vscodex-layer/event',event:{type:'navigation-state-changed',state:structuredClone(mockState)}},location.origin);
 window.postMessage({type:'vscodex-layer/event',event:{...event,__mockCanonical:true}},location.origin);
});
window.nativeRoot=document.getElementById('root');window.nativeApi=acquireVsCodeApi();mockNavigate('/');nativeApi.postMessage({type:'ready'});
window.mockActionCalls=[];window.mockArchiveFailure=false;
window.mockArchivedThreads=Array.from({length:61},(_,index)=>({id:'archived-'+index,title:'归档聊天 '+index,
cwd:index<5?'D:/WRK/VSCodexLayer':index===60?null:'D:/Archive/Project',createdAt:1000+index,updatedAt:2000+index}));
window.mockArchiveListFailure=false;window.mockHoldView=null;window.mockHeldLists=[];
window.mockRestoreCalls=[];window.mockRestoreFailure=false;window.mockRestoreOpenError=false;window.mockHoldRestore=false;
__vscodexLayerBridge.registerArchiveActions({}, {restore:async target=>{
mockRestoreCalls.push(target.id);if(mockHoldRestore)await new Promise(resolve=>window.finishRestore=resolve);
if(mockRestoreFailure)throw Error('原生恢复失败');
const thread=mockArchivedThreads.find(thread=>thread.id===target.id);if(thread){mockThreads.push(thread);mockArchivedThreads=mockArchivedThreads.filter(thread=>thread.id!==target.id)}
window.postMessage({type:'vscodex-layer/event',event:'threads-changed'},location.origin);
return{restored:true,openable:!mockRestoreOpenError}
}});
__vscodexLayerBridge.registerThreadMenuSurface({});
__vscodexLayerBridge.subscribeThreadMenu(()=>{
  document.querySelector('.mock-native-menu')?.remove();
  const target=__vscodexLayerBridge.threadMenuTarget();if(!target)return;
  const trigger=document.createElement('button');trigger.dataset.state='closed';trigger.setAttribute('aria-expanded','false');
  const close=()=>{trigger.dataset.state='closed';trigger.setAttribute('aria-expanded','false');document.querySelector('.mock-native-menu')?.remove();trigger.focus()};
  trigger.onkeydown=event=>{
    if(!['ArrowDown','Enter'].includes(event.key))return;event.preventDefault();
    if(trigger.dataset.state==='open'){close();return}
    trigger.dataset.state='open';trigger.setAttribute('aria-expanded','true');
    const menu=document.createElement('div');menu.className='mock-native-menu';menu.setAttribute('role','menu');
    const rect=target.container.getBoundingClientRect();Object.assign(menu.style,{position:'fixed',left:Math.max(0,Math.min(rect.left,innerWidth-210))+'px',top:Math.max(0,Math.min(rect.bottom,innerHeight-180))+'px',width:'210px',padding:'8px',zIndex:100,background:'white',border:'1px solid #ddd'});
    for(const [id,label] of [['rename-thread','重命名'],['share-thread','分享'],['copy-deeplink','复制深度链接'],['copy-conversation-markdown','复制为 Markdown'],['copy-working-directory','复制工作目录'],['archive-thread','归档']]){
      const button=document.createElement('button');button.setAttribute('role','menuitem');button.dataset.action=id;button.textContent=label;button.style.display='block';
      button.onclick=()=>{mockActionCalls.push({id,threadId:target.thread.id});close();
        if(id==='rename-thread'){const chat=mockThreads.find(t=>t.id===target.thread.id);chat.title='重命名后的聊天';window.postMessage({type:'vscodex-layer/event',event:'threads-changed'},location.origin)}
        if(id==='archive-thread'){
          if(mockArchiveFailure){document.getElementById('native-title').textContent='归档失败';return}
          mockArchivedThreads.push(mockThreads.find(t=>t.id===target.thread.id));mockThreads=mockThreads.filter(t=>t.id!==target.thread.id);__vscodexLayerBridge.threadArchived(target.thread.id);
        }
      };menu.append(button);
    }
    menu.onkeydown=event=>{const buttons=[...menu.querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();close()}
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus()}
    };document.body.append(menu);menu.querySelector('button').focus();
  };target.container.replaceChildren(trigger);
});
</script>
</body></html>`;
const allowed = new Set(['bootstrap.js', 'client.mjs', 'core.mjs', 'reading.mjs', 'layer.mjs', 'layer.css']);
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
  const waitFor = (condition) => evaluate(`new Promise((resolve,reject)=>{let tries=0;const check=()=>{if(${condition})return resolve(true);if(++tries>150)return reject(Error('界面等待超时: '+${JSON.stringify(condition)}+' 状态: '+JSON.stringify({status:document.querySelector('.vcl-status')?.textContent,formHidden:document.getElementById('vcl-project-form')?.hidden,path:document.getElementById('vcl-project-path')?.value,requests:mockRequests.slice(-4).map(request=>request.method)})));setTimeout(check,30)};check()})`);
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
  if (archiveOnly) {
    await evaluate(`document.querySelector('[data-vcl-key="thread:thread-0"]').click();
      window.beforeArchiveRoute=mockRoute;document.getElementById('native-composer').value='保留当前草稿';
      document.querySelector('[data-vcl-key="project:d:/other/project"]').click();
      document.querySelector('[data-vcl-key="thread:thread-20"]').focus();document.querySelector('.vcl-list').scrollTop=180;
      window.beforeArchiveScroll=document.querySelector('.vcl-list').scrollTop;
      mockHoldView='active';document.querySelector('[aria-label="刷新聊天列表"]').click();document.getElementById('vcl-archive').click()`);
    await waitFor(`document.querySelector('.vcl-count').textContent.includes('61 个已归档聊天')`);
    await assertBrowser(`mockRoute===beforeArchiveRoute&&document.getElementById('native-composer').value==='保留当前草稿'`, '进入归档切换了聊天或丢失草稿');
    await assertBrowser(`mockRequests.filter(r=>r.method==='list'&&r.params.archived).some(r=>r.params.cursor==='page-2')`, '归档列表未读取后续分页');
    await assertBrowser(`!document.querySelector('.vcl-list .vcl-new-chat,.vcl-list .vcl-project-pin,.vcl-list .vcl-activity')&&document.getElementById('vcl-add-project').hidden`, '归档视图出现活动操作或状态');
    await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/wrk/vscodexlayer"]').closest('.vcl-project').querySelector('.vcl-thread').dataset.vclKey==='thread:archived-4'`, '归档未按最后更新时间排列');
    await screenshot('navigation-archived.png');
    await evaluate(`mockHoldView=null;mockHeldLists.splice(0).forEach(respond=>respond())`);
    await assertBrowser(`document.querySelector('.vcl-heading').textContent==='已归档聊天'&&!document.querySelector('[data-vcl-key="thread:thread-0"]')`, '普通列表迟到响应覆盖了归档视图');
    await evaluate(`{const search=document.querySelector('.vcl-input');search.value='归档聊天 60';search.dispatchEvent(new Event('input'))}`);
    await assertBrowser(`document.querySelector('[data-vcl-key="thread:archived-60"]')&&document.querySelector('.vcl-count').textContent.includes('1 个已归档聊天')`, '归档标题搜索失败');
    await evaluate(`document.getElementById('vcl-archive-back').click()`);
    await assertBrowser(`document.querySelector('.vcl-list').scrollTop===beforeArchiveScroll&&document.activeElement.dataset.vclKey==='thread:thread-20'&&document.querySelector('[data-vcl-key="project:d:/other/project"]').getAttribute('aria-expanded')==='false'`, '返回普通列表丢失滚动、折叠或键盘焦点');
    await evaluate(`{const mode=document.getElementById('vcl-mode');mode.value='current';mode.dispatchEvent(new Event('change'));const search=document.querySelector('.vcl-input');search.value='设计';search.dispatchEvent(new Event('input'));document.getElementById('vcl-archive').click()}`);
    await assertBrowser(`document.getElementById('vcl-mode').value==='all'&&document.querySelector('.vcl-input').value==='归档聊天 60'`, '普通筛选污染归档或归档搜索丢失');
    await evaluate(`document.querySelector('.vcl-input').value='';document.querySelector('.vcl-input').dispatchEvent(new Event('input'));
      mockRestoreFailure=true;document.querySelector('[data-vcl-key="restore:archived-4"]').click()`);
    await waitFor(`document.querySelector('.vcl-project-notice').textContent.includes('原生恢复失败')`);
    await assertBrowser(`document.querySelector('[data-vcl-key="restore:archived-4"]')&&!document.querySelector('[data-vcl-key="restore:archived-4"]').disabled&&mockRoute===beforeArchiveRoute`, '恢复失败删除记录、无法重试或切换聊天');
    await evaluate(`mockRestoreFailure=false;mockHoldRestore=true;document.querySelector('[data-vcl-key="restore:archived-4"]').click();document.querySelector('[data-vcl-key="restore:archived-4"]').click()`);
    await waitFor(`window.finishRestore`);
    await assertBrowser(`mockRestoreCalls.filter(id=>id==='archived-4').length===2&&document.querySelector('[data-vcl-key="thread:archived-4"]').disabled`, '恢复操作重复提交或未锁定目标行');
    await evaluate(`mockHoldRestore=false;finishRestore()`);
    await waitFor(`!document.querySelector('[data-vcl-key="thread:archived-4"]')`);
    await assertBrowser(`mockRoute===beforeArchiveRoute&&document.querySelector('.vcl-project-notice [aria-label="查看已恢复的聊天"]')`, '仅恢复切换了当前聊天或遗漏查看入口');
    await evaluate(`document.querySelector('.vcl-project-notice [aria-label="查看已恢复的聊天"]').click()`);
    await waitFor(`mockRoute==='/local/archived-4'&&document.querySelector('.vcl-heading').textContent==='项目聊天'`);
    await assertBrowser(`document.getElementById('vcl-mode').value==='current'&&document.querySelector('.vcl-input').value==='设计'`, '查看恢复聊天丢失普通列表筛选');
    await evaluate(`document.getElementById('vcl-archive').click();mockHoldView='archived';document.querySelector('[aria-label="刷新已归档聊天"]').click()`);
    await waitFor(`mockHeldLists.length>0`);
    await evaluate(`document.querySelector('[data-vcl-key="restore:archived-3"]').click()`);
    await waitFor(`mockRestoreCalls.includes('archived-3')&&!document.querySelector('[data-vcl-key="thread:archived-3"]')`);
    await evaluate(`mockHoldView=null;mockHeldLists.splice(0).forEach(respond=>respond())`);
    await waitFor(`document.querySelector('.vcl-count').textContent.includes('59 个已归档聊天')&&!document.querySelector('.vcl-loading')`);
    await assertBrowser(`!document.querySelector('[data-vcl-key="thread:archived-3"]')`, '恢复前的迟到分页把归档条目重新加回');
    await evaluate(`mockArchiveListFailure=true;document.querySelector('[aria-label="刷新已归档聊天"]').click()`);
    await waitFor(`document.querySelector('.vcl-status').textContent.includes('归档列表读取失败')`);
    await assertBrowser(`document.querySelector('[data-vcl-key="thread:archived-2"]')`, '归档读取失败清空已有列表');
    await evaluate(`document.getElementById('vcl-archive-back').click()`);
    await assertBrowser(`!document.querySelector('.vcl-status').textContent.includes('归档列表读取失败')`, '归档读取错误污染普通视图');
    await evaluate(`mockArchiveListFailure=false;document.getElementById('vcl-archive').click()`);
    await waitFor(`!document.querySelector('.vcl-loading')&&!document.querySelector('.vcl-status').textContent`);
    await evaluate(`mockRestoreOpenError=true;document.querySelector('[data-vcl-key="thread:archived-2"]').click()`);
    await waitFor(`document.querySelector('.vcl-project-notice').textContent.includes('原生聊天加载失败')`);
    await assertBrowser(`!document.querySelector('[data-vcl-key="thread:archived-2"]')&&mockRoute==='/local/archived-4'`, '部分恢复被误报失败或加载失败仍切换聊天');
    await evaluate(`mockRestoreOpenError=false;document.querySelector('[data-vcl-key="thread:archived-1"]').click()`);
    await waitFor(`mockRoute==='/local/archived-1'&&document.querySelector('.vcl-heading').textContent==='项目聊天'`);
    await evaluate(`document.getElementById('vcl-archive').click();document.querySelector('[aria-label="返回原版界面"]').click()`);
    await waitFor(`document.getElementById('vcl-launcher')`);
    await evaluate(`document.getElementById('vcl-launcher').click()`);
    await waitFor(`document.querySelector('.vcl-heading').textContent==='项目聊天'`);
    await assertBrowser(`!document.getElementById('vcl-archive').hidden`, '重开面板没有默认返回普通聊天');
    await evaluate(`document.getElementById('vcl-archive').click()`);
    await waitFor(`!document.querySelector('.vcl-loading')`);
    await evaluate(`mockArchivedThreads=[];document.querySelector('[aria-label="刷新已归档聊天"]').click()`);
    await waitFor(`document.querySelector('.vcl-empty')?.textContent==='暂无已归档聊天'`);
    await screenshot('navigation-archive-empty.png');
    console.log('归档专项无头检查通过：完整分页、独立搜索与筛选、折叠滚动与焦点恢复、迟到响应隔离、恢复失败与重试、重复点击保护、仅恢复与恢复后查看、部分恢复、读取失败保留和空状态。');
  } else if (reasoningOnly) {
    // Native disclosure and streaming transitions run in native-reasoning.mjs.
    // Here exercise the actual stylesheet in a narrow viewport with unbroken text.
    await send('Emulation.setDeviceMetricsOverride', { width: 580, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate(`const area=document.querySelector('article');area.style.padding='0';
      const summary=document.createElement('section');summary.dataset.vclReasoningSummary='true';
      const body=document.createElement('div');body.dataset.vclReasoningBody='true';
      const prose=document.createElement('p');prose.textContent='长路径/'+('abcdef0123456789'.repeat(180));
      const pre=document.createElement('pre');pre.style.whiteSpace='pre';
      const code=document.createElement('code');code.textContent='工具输出\\n'+('longtoken'.repeat(120));pre.append(code);
      body.append(prose,pre);const native=document.createElement('div');native.append(body);
      const reader=document.createElement('button');reader.className='vcl-reasoning-reader';reader.title='在主编辑区阅读实时摘要';reader.setAttribute('aria-label',reader.title);reader.textContent='↗';
      summary.append(native,reader);area.replaceChildren(summary);window.summaryBody=body;window.summaryBox=summary`);
    await assertBrowser('summaryBody.getBoundingClientRect().height>140', '摘要仍被限制在小窗口内');
    await assertBrowser('summaryBody.scrollWidth<=summaryBody.clientWidth+1', '长文本或代码撑出正文宽度');
    await assertBrowser(`getComputedStyle(summaryBody.querySelector('pre')).whiteSpace==='pre-wrap'`, '代码没有保留换行并折行');
    await assertBrowser(`getComputedStyle(summaryBody.querySelector('p')).whiteSpace==='pre-wrap'`, '正文换行没有保留');
    await assertBrowser(`getComputedStyle(summaryBody).overflowY==='visible'`, '摘要出现嵌套的纵向滚动容器');
    await assertBrowser('summaryBox.scrollWidth<=summaryBox.clientWidth+1', '阅读按钮或长内容撑出窄侧栏');
    console.log('摘要专项无头检查通过：窄侧栏、长路径、无空格长文本、代码折行、自然高度和单层纵向滚动。');
  } else if (readingOnly) {
    await send('Page.bringToFront', {}, sessionId);
    await evaluate(`document.querySelector('[data-vcl-key="thread:thread-0"]').click();
      const area=document.querySelector('article');area.className='thread-scroll-container';area.tabIndex=0;
      Object.assign(area.style,{height:'300px',flex:'none',overflow:'auto',padding:'0'});
      area.innerHTML='<div style="flex-shrink:0"><div style="height:1200px">旧消息</div><div data-vcl-reply-thread="thread-0" data-vcl-reply-item="reply" data-vcl-reply-completed="true"><div data-markdown-text-style="assistant-message" style="min-height:160px">最新完成的回复</div></div></div>';
      window.readingArea=area;window.replyBody=area.querySelector('[data-markdown-text-style]');
      window.activityEvent=(phase='completed',replyItemId='reply',status='idle',activeFlags=[])=>window.postMessage({type:'vscodex-layer/event',event:{type:'thread-activity',threadId:'thread-0',phase,replyItemId,status,activeFlags}},location.origin)`);
    const blue = `!!document.querySelector('[data-vcl-key="thread:thread-0"] .vcl-attention')`;
    const complete = async (item = 'reply', status = 'idle', flags = []) => {
      await evaluate(`activityEvent('started',${JSON.stringify(item)},'active');activityEvent('completed',${JSON.stringify(item)},${JSON.stringify(status)},${JSON.stringify(flags)})`);
      await waitFor(blue);
    };
    const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,400))');
    const gesture = async (key = null) => {
      const { x, y } = await evaluate(`(()=>{const r=readingArea.getBoundingClientRect();return{x:r.left+50,y:r.top+80}})()`);
      if (key) {
        await evaluate('readingArea.focus()');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key }, sessionId);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }, sessionId);
      } else await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 1 }, sessionId);
    };
    await complete();
    await gesture(); await settle();
    await assertBrowser(blue, '阅读旧消息误清除结束蓝点');
    await evaluate('readingArea.scrollTop=readingArea.scrollHeight');
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 40, y: 300, deltaX: 0, deltaY: 1 }, sessionId);
    // Cancel prior reading intent, then verify programmatic scrolling and sidebar gestures alone.
    await evaluate(`window.dispatchEvent(new Event('blur'));readingArea.scrollTop=readingArea.scrollHeight`);
    await settle(); await assertBrowser(blue, '自动滚动或导航区操作误清除蓝点');
    await gesture(); await waitFor(`!(${blue})`);
    await waitFor(`!mockState.unread.includes('thread-0')`);
    await complete();
    await evaluate(`replyBody.style.minHeight='1000px';readingArea.scrollTop=1250`);
    await gesture('ArrowDown'); await waitFor(`!(${blue})`);
    await assertBrowser('readingArea.scrollTop+readingArea.clientHeight<readingArea.scrollHeight-200', '长回复阅读被限制为必须到底部');
    await complete();
    await gesture();
    await evaluate(`activityEvent('started','new-reply','active');activityEvent('completed','new-reply')`);
    await settle(); await assertBrowser(blue, '旧阅读回调误清除新轮次蓝点');
    await gesture(); await settle(); await assertBrowser(blue, '旧回复误认作新轮次结果');
    await evaluate(`replyBody.parentElement.dataset.vclReplyItem='new-reply';replyBody.parentElement.dataset.vclReplyCompleted='false'`);
    await gesture(); await settle(); await assertBrowser(blue, '未完成的正文误清除蓝点');
    await evaluate(`replyBody.parentElement.dataset.vclReplyCompleted='true'`);
    await waitFor(`!(${blue})`);
    await complete('new-reply');
    await gesture(); await evaluate('readingArea.scrollTop=0');
    await settle(); await assertBrowser(blue, '结果闪过可视区域就被标记已读');
    await evaluate(`readingArea.scrollTop=1250;Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})`);
    await gesture(); await settle(); await assertBrowser(blue, '隐藏面板误清除蓝点');
    await evaluate(`delete document.visibilityState;document.hasFocus=()=>false`);
    await gesture(); await settle(); await assertBrowser(blue, '无焦点面板误清除蓝点');
    await evaluate('delete document.hasFocus');
    for (const [status, flags] of [['active',['waitingOnApproval']],['active',['waitingOnUserInput']],['systemError',[]]]) {
      await evaluate(`activityEvent('status','new-reply',${JSON.stringify(status)},${JSON.stringify(flags)})`);
      await gesture(); await settle(); await assertBrowser(blue, '阅读误清除审批、输入或错误提示');
    }
    await complete('new-reply');
    await evaluate(`replyBody.style.minHeight='160px';Object.assign(readingArea.style,{display:'flex',flexDirection:'column-reverse'});readingArea.scrollTop=0`);
    await gesture(); await waitFor(`!(${blue})`);
    await complete('new-reply');
    await evaluate(`readingArea.querySelector('[data-vcl-reply-thread]').remove()`);
    await gesture(); await settle(); await assertBrowser(blue, '正文定位失败时误清除蓝点');
    console.log('阅读回执无头检查通过：当前回复、长回复、反向滚动、旧消息、自动滚动、导航区、隐藏和焦点、完成前后时序、新轮次及审批／输入／错误提示。');
  } else {
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
  await evaluate(`window.originalRows=[...document.querySelectorAll('.vcl-thread')].map(node=>node.dataset.vclKey);window.originalGroups=[...document.querySelectorAll('.vcl-project-heading')].map(node=>node.dataset.vclKey);document.querySelector('[data-vcl-key="thread:thread-8"]').focus({preventScroll:true});document.querySelector('.vcl-list').scrollTop=80;window.originalScroll=document.querySelector('.vcl-list').scrollTop;mockThreads.find(thread=>thread.id==='thread-10').updatedAt=999999;document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`!document.querySelector('[aria-label="刷新聊天列表"]').disabled`);
  await assertBrowser(`JSON.stringify([...document.querySelectorAll('.vcl-thread')].map(node=>node.dataset.vclKey))===JSON.stringify(originalRows)&&JSON.stringify([...document.querySelectorAll('.vcl-project-heading')].map(node=>node.dataset.vclKey))===JSON.stringify(originalGroups)&&document.querySelector('.vcl-list').scrollTop===originalScroll&&document.activeElement.dataset.vclKey==='thread:thread-8'`, '最近活动刷新改变聊天／项目顺序、滚动位置或焦点');
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
  await evaluate(`document.querySelector('[data-vcl-key="pin:d:/other/project"]').click()`);
  await waitFor(`mockState.pinnedProjects?.length===1`);
  await assertBrowser(`document.querySelector('.vcl-project-heading').dataset.vclKey==='project:d:/other/project'
    && document.querySelector('[data-vcl-key="pin:d:/other/project"]').getAttribute('aria-pressed')==='true'
    && new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/WRK/VSCodexLayer'`, '置顶未生效或切换右侧聊天');
  await evaluate(`document.querySelector('[data-vcl-key="pin:d:/wrk/project"]').click()`);
  await waitFor(`mockState.pinnedProjects?.length===2`);
  await assertBrowser(`[...document.querySelectorAll('.vcl-project-heading')].slice(0,2).map(n=>n.dataset.vclKey).join('|')==='project:d:/other/project|project:d:/wrk/project'`, '新置顶项目扰乱已有顺序');
  await evaluate(`document.querySelector('[aria-label="返回原版界面"]').click()`);
  await waitFor(`document.getElementById('vcl-launcher')`);
  await evaluate(`document.getElementById('vcl-launcher').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="pin:d:/other/project"]')?.getAttribute('aria-pressed')==='true'`);
  await waitFor(`!document.querySelector('[aria-label="刷新聊天列表"]').disabled`);
  await evaluate(`mockThreads=mockThreads.filter(t=>t.cwd!=='D:/Other/Project');document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="project:d:/other/project"] .vcl-group-count')?.textContent==='0'`);
  await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/other/project"]') && document.querySelector('[data-vcl-key="new:d:/other/project"]') && document.querySelector('[data-vcl-key="project:d:/other/project"] .vcl-group-count').textContent==='0'`, '置顶空项目丢失');
  await evaluate(`document.querySelector('[data-vcl-key="pin:d:/other/project"]').click();document.querySelector('[data-vcl-key="pin:d:/wrk/project"]').click()`);
  await waitFor(`mockState.pinnedProjects?.length===0`);
  await assertBrowser(`document.querySelector('.vcl-project-heading').dataset.vclKey==='project:d:/wrk/vscodexlayer' && !document.querySelector('[data-vcl-key="pin:"]')`, '取消置顶未恢复排序或未分类可置顶');
  await evaluate(`document.querySelector('[data-vcl-key="thread:thread-0"]').click()`);
  await waitFor(`mockRoute==='/local/thread-0'`);
  await evaluate(`window.postMessage({type:'vscodex-layer/event',event:{type:'thread-activity',threadId:'thread-8',phase:'completed',status:'idle'}},location.origin)`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-8"] .vcl-attention')`);
  await evaluate(`document.querySelector('[data-vcl-key="more:thread-8"]').click()`);
  await waitFor(`document.querySelector('.mock-native-menu')`);
  await assertBrowser(`mockRoute==='/local/thread-0' && document.querySelector('[data-vcl-key="thread:thread-8"] .vcl-attention')`, '打开其他聊天菜单切换聊天或清除蓝点');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }, sessionId);
  await waitFor(`!document.querySelector('.mock-native-menu') && document.activeElement.dataset.vclKey==='more:thread-8'`);
  await evaluate(`document.querySelector('[data-vcl-key="more:thread-8"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}))`);
  await waitFor(`document.querySelector('.mock-native-menu')`);
  await assertBrowser(`(()=>{const r=document.querySelector('.mock-native-menu').getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight})()`, '菜单越过视口边界');
  await evaluate(`document.querySelector('[data-action="rename-thread"]').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="thread:thread-8"] .vcl-label').textContent==='重命名后的聊天'`);
  await assertBrowser(`mockRoute==='/local/thread-0' && mockActionCalls.at(-1).threadId==='thread-8'`, '重命名错误聊天或切换右侧');
  await evaluate(`document.querySelector('[data-vcl-key="more:thread-8"]').click()`);
  await waitFor(`document.querySelector('.mock-native-menu')`);
  await evaluate(`document.querySelector('[aria-label="刷新聊天列表"]').click()`);
  await waitFor(`!document.querySelector('[aria-label="刷新聊天列表"]').disabled`);
  await evaluate(`document.querySelector('[data-action="copy-working-directory"]').click()`);
  await assertBrowser(`mockActionCalls.at(-1).threadId==='thread-8' && mockRoute==='/local/thread-0'`, '刷新后菜单操作对象改变');
  await evaluate(`mockArchiveFailure=true;document.querySelector('[data-vcl-key="more:thread-8"]').click()`);
  await waitFor(`document.querySelector('.mock-native-menu')`);
  await evaluate(`document.querySelector('[data-action="archive-thread"]').click()`);
  await assertBrowser(`document.querySelector('[data-vcl-key="thread:thread-8"]') && mockRoute==='/local/thread-0' && document.getElementById('native-title').textContent==='归档失败'`, '归档失败仍删除聊天或改变右侧');
  await evaluate(`mockArchiveFailure=false;document.querySelector('[data-vcl-key="more:thread-8"]').click()`);
  await waitFor(`document.querySelector('.mock-native-menu')`);
  await evaluate(`document.querySelector('[data-action="archive-thread"]').click()`);
  await waitFor(`!document.querySelector('[data-vcl-key="thread:thread-8"]')`);
  await assertBrowser(`mockRoute==='/local/thread-0'`, '归档其他聊天切换了当前聊天');
  await evaluate(`document.querySelector('[data-vcl-key="more:thread-0"]').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  await waitFor(`document.querySelector('.mock-native-menu')`);
  await evaluate(`document.querySelector('[data-action="archive-thread"]').click()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/WRK/VSCodexLayer'`);
  await assertBrowser(`document.getElementById('native-composer').value==='当前项目的草稿' && !document.querySelector('[data-vcl-key="thread:thread-0"]')`, '归档当前聊天未返回草稿或丢失草稿');
  await evaluate(`window.beforeProjectRoute=mockRoute;window.beforeProjectThreads=mockThreads.length;const mode=document.getElementById('vcl-mode');mode.value='current';mode.dispatchEvent(new Event('change'));const search=document.querySelector('.vcl-input');search.value='不匹配';search.dispatchEvent(new Event('input'));document.getElementById('vcl-add-project').click();document.getElementById('vcl-project-path').value='relative';document.querySelectorAll('.vcl-form-actions button')[1].click()`);
  await waitFor(`document.getElementById('vcl-project-error').textContent.includes('无法访问')`);
  await assertBrowser(`!document.getElementById('vcl-project-form').hidden&&document.getElementById('vcl-project-path').value==='relative'&&mockRegistry.projects.length===0&&mockRoute===beforeProjectRoute`, '无效目录被添加或输入／当前聊天丢失');
  await evaluate(`document.querySelector('[aria-label="选择文件夹"]').click()`);
  await waitFor(`!document.querySelector('[aria-label="选择文件夹"]').disabled`);
  await assertBrowser(`document.getElementById('vcl-project-path').value==='relative'&&mockRegistry.projects.length===0`, '取消目录选择清除了输入或登记项目');
  await evaluate(`mockPickedFolder='D:/Manual/Project';document.querySelector('[aria-label="选择文件夹"]').click()`);
  await waitFor(`document.getElementById('vcl-project-path').value==='D:/Manual/Project'&&!document.querySelector('[aria-label="选择文件夹"]').disabled`);
  await evaluate(`mockSaveFailure=true;document.querySelectorAll('.vcl-form-actions button')[1].click()`);
  await waitFor(`document.getElementById('vcl-project-error').textContent==='保存失败'`);
  await assertBrowser(`document.getElementById('vcl-project-path').value==='D:/Manual/Project'&&mockRegistry.projects.length===0`, '保存失败仍登记项目或清除了路径');
  await evaluate(`mockSaveFailure=false;document.querySelectorAll('.vcl-form-actions button')[1].click()`);
  await waitFor(`document.getElementById('vcl-project-form').hidden&&document.querySelector('[data-vcl-key="project:d:/manual/project"]')`);
  await assertBrowser(`document.getElementById('vcl-mode').value==='all'&&document.querySelector('.vcl-input').value===''&&document.querySelector('[data-vcl-key="project:d:/manual/project"]').closest('.vcl-project').querySelector('.vcl-empty-project')&&mockRoute===beforeProjectRoute&&mockThreads.length===beforeProjectThreads`, '仅添加未显示空项目、未解除筛选或改变了聊天');
  await evaluate(`document.getElementById('vcl-add-project').click();document.getElementById('vcl-project-path').value='D:/Manual/Project';document.querySelectorAll('.vcl-form-actions button')[1].click()`);
  await waitFor(`document.getElementById('vcl-project-form').hidden`);
  await assertBrowser(`mockRegistry.projects.length===1&&document.querySelectorAll('[data-vcl-key="project:d:/manual/project"]').length===1`, '重复添加产生多个项目');
  await evaluate(`document.querySelector('[data-vcl-key="project:d:/manual/project"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}))`);
  await waitFor(`document.querySelector('.vcl-project-menu')`);
  await evaluate(`document.querySelector('.vcl-project-menu [data-action="copy-project-path"]').click()`);
  await waitFor(`mockCopiedPath==='D:/Manual/Project'`);
  await evaluate(`document.querySelector('[data-vcl-key="project:d:/manual/project"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}))`);
  await assertBrowser(`(()=>{const rect=document.querySelector('.vcl-project-menu').getBoundingClientRect();return rect.right<=innerWidth&&rect.bottom<=innerHeight})()`, '项目菜单越过视口边界');
  await evaluate(`document.querySelector('.vcl-project-menu [data-action="remove-project"]').click()`);
  await waitFor(`!document.querySelector('[data-vcl-key="project:d:/manual/project"]')`);
  await assertBrowser(`mockThreads.length===beforeProjectThreads&&mockRegistry.projects.length===0&&mockRoute===beforeProjectRoute`, '移除空项目影响聊天或当前路由');
  await evaluate(`document.getElementById('vcl-add-project').click();document.getElementById('vcl-project-path').value='D:/Else/Project';mockCannotOpen=true;document.querySelector('.vcl-primary').click()`);
  await waitFor(`document.querySelector('.vcl-project-notice').textContent.includes('项目已添加，打开聊天失败')`);
  await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/else/project"]')&&mockRoute===beforeProjectRoute&&mockThreads.length===beforeProjectThreads`, '打开草稿失败丢失已添加项目或创建聊天');
  await evaluate(`mockCannotOpen=false;document.querySelector('[data-vcl-key="new:d:/else/project"]').click()`);
  await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Else/Project'`);
  await assertBrowser(`mockThreads.length===beforeProjectThreads&&document.getElementById('native-composer').value===''`, '打开新项目草稿提前创建了聊天');
  for (let index = 3; index <= 5; index += 1) {
    await evaluate(`document.getElementById('native-composer').value='项目独立聊天 ${index}';document.getElementById('native-composer').dispatchEvent(new Event('input'));mockSubmit(true)`);
    await waitFor(`document.querySelector('[data-vcl-key="thread:sent-thread-${index}"]')?.getAttribute('aria-current')==='page'`);
    if (index < 5) {
      await evaluate(`mockNewChat()`);
      await waitFor(`new URL(mockRoute,location.origin).searchParams.get('vclProjectCwd')==='D:/Else/Project'`);
    }
  }
  await assertBrowser(`JSON.stringify([...document.querySelector('[data-vcl-key="project:d:/else/project"]').closest('.vcl-project').querySelectorAll('.vcl-thread')].map(node=>node.dataset.vclKey))===JSON.stringify(['thread:sent-thread-3','thread:sent-thread-4','thread:sent-thread-5'])`, '新项目连续聊天没有按创建顺序追加');
  for (let index = 3; index <= 5; index += 1) {
    await evaluate(`document.querySelector('[data-vcl-key="thread:sent-thread-${index}"]').click()`);
    await waitFor(`mockRoute==='/local/sent-thread-${index}'`);
  }
  await evaluate(`document.querySelector('[data-vcl-key="project:d:/else/project"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));document.querySelector('.vcl-project-menu [data-action="remove-project"]').click()`);
  await waitFor(`mockRegistry.projects.length===0`);
  await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/else/project"]')&&mockRoute==='/local/sent-thread-5'&&document.querySelector('.vcl-project-notice').textContent.includes('仍有聊天')`, '移除登记删除历史分组或改变当前聊天');
  await evaluate(`document.getElementById('vcl-add-project').click();document.getElementById('vcl-project-path').value='D:/Persist/Empty';document.querySelectorAll('.vcl-form-actions button')[1].click()`);
  await waitFor(`document.getElementById('vcl-project-form').hidden&&mockRegistry.projects.length===1`);
  await evaluate(`document.querySelector('[aria-label="返回原版界面"]').click()`);
  await waitFor(`document.getElementById('vcl-launcher')`);
  await evaluate(`document.getElementById('vcl-launcher').click()`);
  await waitFor(`document.querySelector('[data-vcl-key="project:d:/persist/empty"]')`);
  await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/persist/empty"]').closest('.vcl-project').querySelector('.vcl-empty-project')&&mockRoute==='/local/sent-thread-5'`, '重开导航丢失空项目或改变聊天');
  await evaluate(`window.postMessage({type:'vscodex-layer/event',event:{type:'projects-changed',revision:mockRegistry.revision-1,projects:[]}},location.origin)`);
  await assertBrowser(`document.querySelector('[data-vcl-key="project:d:/persist/empty"]')`, '迟到的项目列表事件覆盖新登记');
  await evaluate(`document.getElementById('vcl-add-project').click();document.getElementById('vcl-project-path').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await assertBrowser(`document.getElementById('vcl-project-form').hidden&&document.activeElement.id==='vcl-add-project'`, 'Esc 未取消表单或未恢复焦点');
  await screenshot('navigation-project-new-chat.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await waitFor(`!document.getElementById('vcl-navigation').classList.contains('vcl-collapsed')`);
  await toggleShortcut();
  await waitFor(`document.getElementById('vcl-navigation')?.classList.contains('vcl-collapsed')`);
  await screenshot('navigation-narrow.png');
  console.log('无头界面检查通过：固定排序与滚动焦点、目录选择与取消、添加／重复／保存失败／打开失败、移除记录、连续新建与空项目重开保留，以及置顶、原生菜单、导航、提醒、搜索与草稿隔离。');
  console.log(`模拟界面截图：${output}`);
  }
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
