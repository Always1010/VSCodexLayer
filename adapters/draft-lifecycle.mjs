const identifier = String.raw`[A-Za-z_$][\w$]*`;

export function patchProjectDraftReset(source) {
  const pattern = new RegExp(`function (${identifier})\\((${identifier}),\\{clientNewThreadId:(${identifier}),draftThreadLocationId:(${identifier})\\}\\)\\{(?=if\\(\\2\\.get\\(${identifier},\\4\\)!==\\3\\)return;)`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`项目草稿身份重置接入点数量异常：${matches.length}`);
  // Completion still passes the native home/panel slot. Keep its client guard,
  // but reset the project slot that actually owns the completed draft identity.
  return source.replace(pattern, (head, _name, scope, _client, location) => head
    + `if(typeof ${scope}.value?.vclDraftKey===\`string\`&&${scope}.value.vclDraftKey.startsWith(\`vscodex-layer-new:\`)`
    + `&&(${location}===\`new-conversation\`||${location}===\`panel-new-conversation\`))${location}=${scope}.value.vclDraftKey;`);
}
