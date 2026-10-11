import fs from 'node:fs/promises';
import path from 'node:path';
import { readUnpatched, sha256 } from '../lib/patch-engine.mjs';

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unique(matches, label) {
  if (matches.length !== 1) throw new Error(`${label}接入点数量异常：${matches.length}`);
  return matches[0];
}

export function patchReasoningActivity(source) {
  const signature = new RegExp(`function (${identifier})\\((${identifier}),\\{dynamicToolCallRenderer:[^}]+\\}=\\{\\}\\)\\{switch\\(\\2\\.type\\)\\{`, 'g');
  const match = unique([...source.matchAll(signature)], '推理摘要活动分类');
  const end = source.indexOf('}function ', match.index);
  if (end < 0) throw new Error('推理摘要活动分类函数边界异常。');
  const body = source.slice(match.index, end + 1);
  const helper = unique([...body.matchAll(new RegExp(`return (${identifier})\\(${escaped(match[2])},\`standalone\`\\);case\`reasoning\`:`, 'g'))], '推理摘要独立活动')[1];
  const start = match.index + match[0].indexOf('switch(');
  // Retain only readable summaries. Empty completed items must not create phantom rows.
  const insert = `if(${match[2]}.type===\`reasoning\`)return typeof ${match[2]}.content===\`string\`&&${match[2]}.content.trim()?${helper}(${match[2]},\`standalone\`):null;`;
  return { content: source.slice(0, start) + insert + source.slice(start), classifier: match[1] };
}

export function patchReasoningRenderer(source) {
  const signature = new RegExp(`function (${identifier})\\((${identifier})\\)\\{let ${identifier}=\\(0,${identifier}\\.c\\)\\(\\d+\\),\\{item:${identifier},conversationId:${identifier},cwd:${identifier},hideCodeBlocks:${identifier},hostId:${identifier}\\}=\\2,`, 'g');
  const matches = [...source.matchAll(signature)].filter((match) => {
    const end = source.indexOf('}function ', match.index);
    return end >= 0 && source.slice(match.index, end).includes('reasoning-markdown');
  });
  const match = unique(matches, '推理摘要组件');
  const end = source.indexOf('}function ', match.index);
  let body = source.slice(match.index, end + 1);
  const react = new RegExp(`\\(0,(${identifier})\\.useState\\)`).exec(body)?.[1];
  const jsx = new RegExp(`\\(0,(${identifier})\\.jsx\\)`).exec(body)?.[1];
  if (!react || !jsx || !body.includes('onToggle:') || !body.includes('disclosure:')) {
    throw new Error('官方推理摘要组件缺少 React 或展开控件。');
  }
  const item = new RegExp(`\\{item:(${identifier}),`).exec(body)[1];
  const completedText = new RegExp(`(${identifier})=(${identifier})\\?\`\`:(${identifier})\\(${escaped(item)}\\.content\\)`, 'g');
  const streamingText = new RegExp(`(${identifier})=(${identifier})\\(${escaped(item)}\\.content\\)\\.trimStart\\(\\)`, 'g');
  unique([...body.matchAll(completedText)], '完整推理摘要正文');
  unique([...body.matchAll(streamingText)], '完整流式推理摘要正文');
  // Native heading removal can turn a heading-only summary into an unexpandable item.
  // Keep all readable summary text in both the live and completed views.
  body = body.replace(completedText, `$1=$2?\`\`:${item}.content`)
    .replace(streamingText, `$1=${item}.content.trimStart()`);
  const wrapper = `function __vclReasoningOff(){return!1}function __vclReasoningNoop(){return()=>{}}`
    + `function ${match[1]}(${match[2]}){let __vclBridge=globalThis.__vscodexLayerBridge;`
    + `let __vclEnabled=(0,${react}.useSyncExternalStore)(__vclBridge?.subscribeReasoning??__vclReasoningNoop,__vclBridge?.reasoningEnabled??__vclReasoningOff,__vclReasoningOff);`
    + `return __vclEnabled?(0,${jsx}.jsx)(\`div\`,{\"data-vcl-reasoning-summary\":true,role:\`group\`,\"aria-label\":\`推理摘要\`,children:(0,${jsx}.jsx)(__vclNativeReasoningSummary,${match[2]})}):null;}`;
  return { content: source.slice(0, match.index) + wrapper
    + body.replace(`function ${match[1]}(`, 'function __vclNativeReasoningSummary(') + source.slice(end + 1),
  renderer: match[1] };
}

export function patchReadTarget(source) {
  if (source.includes('__vclNativeAssistantMessage')) throw new Error('最新回复阅读标记已存在，拒绝重复转换。');
  const signature = new RegExp(`function (${identifier})\\((${identifier})\\)\\{let ${identifier}=\\(0,${identifier}\\.c\\)\\(\\d+\\),\\{item:(${identifier}),assistantCopyText:${identifier},turnId:${identifier},[^}]+conversationId:${identifier},`, 'g');
  const match = unique([...source.matchAll(signature)], '最新回复阅读标记');
  const end = source.indexOf('}function ', match.index);
  if (end < 0) throw new Error('最新回复组件函数边界异常。');
  const body = source.slice(match.index, end + 1);
  const jsx = new RegExp(`\\(0,(${identifier})\\.jsx[s]?\\)`).exec(body)?.[1];
  if (!jsx) throw new Error('最新回复组件缺少 JSX 接入点。');
  const props = match[2];
  // display:contents preserves native layout; measure the native Markdown beneath this marker.
  const wrapper = `function ${match[1]}(${props}){let __vclItem=${props}.item;`
    + `return(0,${jsx}.jsx)(\`div\`,{style:{display:\`contents\`},`
    + `"data-vcl-reply-thread":${props}.conversationId,"data-vcl-reply-item":__vclItem.searchItemId,`
    + `"data-vcl-reply-completed":__vclItem.completed===true&&__vclItem.phase!==\`commentary\`&&!__vclItem.isSkippedCompletion,`
    + `children:(0,${jsx}.jsx)(__vclNativeAssistantMessage,${props})});}`;
  return { content: source.slice(0, match.index) + wrapper
    + body.replace(`function ${match[1]}(`, 'function __vclNativeAssistantMessage(') + source.slice(end + 1),
    component: match[1] };
}

export async function buildReasoningPatchFiles(root) {
  const entries = await fs.readdir(path.join(root, 'webview', 'assets'));
  async function select(prefix, marker) {
    const candidates = await Promise.all(entries.filter((name) => name.startsWith(prefix) && name.endsWith('.js'))
      .map(async (name) => {
        const relative = `webview/assets/${name}`;
        return { path: relative, bytes: await readUnpatched(root, relative) };
      }));
    return unique(candidates.filter(({ bytes }) => bytes.toString().includes(marker)), marker);
  }
  const activity = await select('agent-activity-item-', 'dynamicToolCallRenderer:');
  const renderer = await select('sites-end-resource-', 'reasoning-markdown');
  const activityPatch = patchReasoningActivity(activity.bytes.toString());
  const rendererPatch = patchReasoningRenderer(renderer.bytes.toString());
  const readTarget = patchReadTarget(rendererPatch.content);
  return {
    files: [
      { path: activity.path, originalHash: sha256(activity.bytes), content: activityPatch.content },
      { path: renderer.path, originalHash: sha256(renderer.bytes), content: readTarget.content },
    ],
    compatibility: { activity: activity.path, renderer: renderer.path,
      classifier: activityPatch.classifier, component: rendererPatch.renderer, readTarget: readTarget.component },
  };
}
