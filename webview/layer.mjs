import { LayerClient } from './client.mjs';

const bridge = globalThis.__vscodexLayerBridge;
let started = false;
bridge?.subscribe(async ({ ready }) => {
  if (!ready || started) return;
  started = true;
  const client = new LayerClient(bridge);
  try {
    const info = await client.request('init');
    if (!info.supported) { client.dispose(); return; }
    const page = await client.request('list');
    const rail = document.createElement('aside');
    rail.id = 'vcl-navigation';
    rail.setAttribute('aria-label', '项目聊天导航');
    const title = document.createElement('strong');
    title.textContent = '项目聊天';
    rail.append(title);
    for (const thread of page.data) {
      const row = document.createElement('button');
      row.textContent = thread.title;
      row.title = thread.cwd ?? '未分类';
      row.addEventListener('click', () => client.request('navigate', { threadId: thread.id }).catch(console.error));
      rail.append(row);
    }
    document.body.append(rail);
    document.body.classList.add('vcl-enabled');
  } catch (error) { console.warn('VSCodexLayer:', error.message); client.dispose(); }
});
