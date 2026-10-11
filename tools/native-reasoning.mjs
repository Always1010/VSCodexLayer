import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('}function ', start);
  assert.ok(start >= 0 && end >= 0, `推理摘要函数缺失：${name}`);
  return source.slice(start, end + 1);
}

// Exercise functions extracted from the installed official bundle, without loading the app,
// connecting a backend, creating a conversation, or touching the installation.
export async function checkNativeReasoning(plan) {
  const info = plan.compatibility.reasoning;
  const source = (relative) => plan.files.find((entry) => entry.path === relative).content.toString();
  const activity = functionSource(source(info.activity), info.classifier);
  const helper = /\.content\.trim\(\)\?([\w$]+)\(/.exec(activity)[1];
  const classification = vm.createContext({ [helper]: (item, grouping) => ({ item, grouping }) });
  vm.runInContext(activity, classification);
  const classify = classification[info.classifier];
  for (const completed of [false, true]) {
    for (const content of ['**仅有标题**', '**检查目录**\n\n读取文件后确认入口。', '<script>literal</script>']) {
      const item = { type: 'reasoning', content, completed };
      const result = classify(item);
      assert.equal(result.item, item, '摘要不得改写为助手消息或丢失原始文本');
      assert.equal(result.grouping, 'standalone');
    }
    for (const content of ['', ' \n ', undefined]) assert.equal(classify({ type: 'reasoning', content, completed }), null);
  }
  const message = { type: 'assistant-message', content: '最终回复', completed: true };
  assert.equal(classify(message).item, message);
  assert.equal(classify({ type: 'web-search', query: '' }), null);
  assert.equal(classify({ type: 'automatic-approval-review', status: 'approved' }), null);

  const renderer = source(info.renderer);
  const readWrapper = functionSource(renderer, info.readTarget);
  const readJsx = /\(0,([\w$]+)\.jsx\)/.exec(readWrapper)[1];
  const readContext = vm.createContext({ [readJsx]: { jsx: (type, props) => ({ type, props }) },
    __vclNativeAssistantMessage: (props) => props });
  vm.runInContext(readWrapper, readContext);
  for (const [completed, phase, expected] of [[false, 'final_answer', false], [true, 'commentary', false],
    [true, 'final_answer', true], [true, null, true]]) {
    const props = { conversationId: 'current', item: { searchItemId: 'reply', content: '正文', completed, phase } };
    const result = readContext[info.readTarget](props);
    assert.equal(result.props['data-vcl-reply-thread'], 'current');
    assert.equal(result.props['data-vcl-reply-item'], 'reply');
    assert.equal(result.props['data-vcl-reply-completed'], expected);
    assert.equal(result.props.children.props, props, '阅读标记不改写官方回复或渲染参数');
    assert.equal(result.props.style.display, 'contents', '阅读标记不增加布局盒子');
  }
  const wrapper = functionSource(renderer, info.component);
  const reactName = /\(0,([\w$]+)\.useSyncExternalStore\)/.exec(wrapper)[1];
  const jsxName = /\(0,([\w$]+)\.jsx\)/.exec(wrapper)[1];
  const context = vm.createContext({ document: { querySelector: () => null }, queueMicrotask, URLSearchParams,
    acquireVsCodeApi() {},
    [reactName]: { useSyncExternalStore(subscribe, getSnapshot) {
      subscribe(() => {});
      return getSnapshot();
    } },
    [jsxName]: { jsx: (type, props) => ({ type, props }) },
    __vclNativeReasoningSummary: (props) => props,
  });
  vm.runInContext(await fs.readFile(new URL('../webview/bootstrap.js', import.meta.url), 'utf8'), context);
  vm.runInContext(['__vclReasoningOff', '__vclReasoningNoop', info.component]
    .map((name) => functionSource(renderer, name)).join(';'), context);
  const render = context[info.component];
  const props = { item: { type: 'reasoning', content: '**推理摘要标题**\n\n完整正文', completed: true },
    conversationId: 'history-thread', hostId: 'local', cwd: '/project' };
  assert.equal(render(props), null);
  context.__vscodexLayerBridge.setReasoningEnabled(true);
  const visible = render(props);
  assert.equal(visible.props['data-vcl-reasoning-summary'], true);
  assert.equal(visible.props.children.type, context.__vclNativeReasoningSummary);
  assert.equal(visible.props.children.props, props, '历史摘要和当前宿主参数必须原样传入官方组件');
  context.__vscodexLayerBridge.setReasoningEnabled(false);
  assert.equal(render(props), null, '返回原版后必须隐藏摘要');
  context.__vscodexLayerBridge = undefined;
  assert.equal(render(props), null, '桥接缺失时保持官方视图');
  const native = functionSource(renderer, '__vclNativeReasoningSummary');
  assert.ok(native.includes('onToggle:') && native.includes('disclosure:') && native.includes('reasoning-markdown'),
    '保留官方折叠和 Markdown 渲染组件');
  assert.match(native, /\.content\.trimStart\(\)/, '流式摘要不能丢弃标题');
  checkNativeDisclosure(native, reactName, jsxName);
}

function checkNativeDisclosure(native, reactName, jsxName) {
  // Run the actual native component with React state, JSX and layout dependencies replaced.
  // This verifies the disclosure callback and reachable Markdown body, not just patch markers.
  let expanded = false;
  const bindings = {
    [reactName]: { useState: () => [expanded, (update) => { expanded = update(expanded); }] },
    [jsxName]: { jsx: (type, props) => ({ type, props }), Fragment: 'fragment' },
  };
  const match = (pattern) => {
    const result = pattern.exec(native);
    assert.ok(result, `官方摘要组件依赖结构变化：${pattern}`);
    return result;
  };
  const cache = match(/\(0,([\w$]+)\.c\)\((\d+)\)/);
  bindings[cache[1]] = { c: (size) => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) };
  const status = match(/=([\w$]+)\(([\w$]+),[\w$]+\),([\w$]+)=![\w$]+\.completed,[\w$]+=([\w$]+)\(\3\)/);
  bindings[status[1]] = () => null;
  bindings[status[2]] = 'conversation-status';
  bindings[status[4]] = () => null;
  const label = match(/\?\([\w$]+=([\w$]+)\([\w$]+,[\w$]+\),[\w$]+\[\d+\]=/);
  bindings[label[1]] = () => 'Thought';
  const layout = match(/\{elementHeightPx:[\w$]+,elementRef:[\w$]+\}=([\w$]+)\(\)/);
  bindings[layout[1]] = () => ({ elementHeightPx: 100, elementRef: null });
  const style = match(/=([\w$]+)\(([\w$]+)\.content,/);
  bindings[style[1]] = (...classes) => classes.join(' ');
  bindings[style[2]] = {};
  for (const [, component] of native.matchAll(/\.jsx\)\(([\w$]+),/g)) bindings[component] ??= component;
  const motion = match(/\.jsx\)\(([\w$]+)\.div,/);
  bindings[motion[1]] = { div: 'motion' };
  bindings[match(/transition:([\w$]+),/)[1]] = {};
  const toggle = match(/onToggle:\(\)=>\{[\w$]+\(([\w$]+)\)\}/);
  bindings[toggle[1]] = (value) => !value;
  const context = vm.createContext(bindings);
  vm.runInContext(native, context);
  const render = (item) => context.__vclNativeReasoningSummary({ item, conversationId: 'history', hostId: 'local' });
  function find(value, predicate) {
    if (value === null || typeof value !== 'object') return null;
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  }
  for (const content of ['**只有标题**', '**检查目录**\n\n完整摘要正文。']) {
    expanded = false;
    const item = { content, completed: true };
    const closed = render(item);
    const disclosure = find(closed, (value) => value.props?.disclosure)?.props.disclosure;
    assert.equal(disclosure?.expanded, false);
    assert.equal(find(closed, (value) => value.props?.isStreaming !== undefined), null);
    disclosure.onToggle();
    const open = render(item);
    assert.equal(find(open, (value) => value.props?.disclosure)?.props.disclosure.expanded, true);
    assert.equal(find(open, (value) => value.props?.isStreaming !== undefined)?.props.children, content);
    find(open, (value) => value.props?.disclosure).props.disclosure.onToggle();
    assert.equal(find(render(item), (value) => value.props?.isStreaming !== undefined), null);
  }
  expanded = false;
  for (const content of ['**思考', '**思考摘要**\n\n第一段', '**思考摘要**\n\n第一段\n第二段']) {
    const stream = find(render({ content, completed: false }), (value) => value.props?.isStreaming === true);
    assert.equal(stream?.props.children, content, '原生流式组件应显示逐步增长的完整摘要');
  }
}
