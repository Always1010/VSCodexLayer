// Keep the official watchdog for local and unsupported remote hosts.
export function patchWebviewStartup(source, vscode) {
  const pattern = /let s=new ([\w$]+)\(u=>\{this\.logger\.error\("Webview renderer did not become ready"/g;
  if ([...source.matchAll(pattern)].length !== 1) throw new Error('界面启动监控接入点数量异常。');
  source = source.replace(pattern, (_match, nativeGuard) =>
    `let s=new (process.platform==="linux"&&${vscode}.env.remoteName==="ssh-remote"?`
    + `require(${vscode}.Uri.joinPath(this.extensionUri,"out","vscodex-layer-startup.cjs").fsPath).createRemoteStartupGuard({`
    + 'onSlow:()=>{this.logger.warning("VSCodexLayer: remote renderer is still loading after 30000ms; waiting up to 90000ms");'
    + `return ${vscode}.window.setStatusBarMessage("Codex：远程界面加载较慢，正在继续等待…",60000)},`
    + 'webview:e,loadContent:()=>this.getWebviewContent(e),'
    + 'onError:error=>this.logger.warning("VSCodexLayer: renderer retry failed: "+String(error?.stack??error)),'
    + 'beforeRetry:()=>{this.disposeClientCoordinationForWebview(e);this.clearPendingRequestsForWebview(e);'
    + 'this.chunkedMessageSender.dispose(e);this.registerClientCoordinationForWebview(e,n,s);'
    + 'if(r==="sidebar"){for(let view of this.sidebarViews){if(view.webview===e)this.readySidebarViews.delete(view)}'
    + 'if(this.sidebarView?.webview===e)this.sidebarWebviewReady=false}'
    + 'else{let panel=this.findPanelByWebview(e);if(panel)this.editorPanels.get(panel).ready=false}}'
    + `}):${nativeGuard})(u=>{`
    + 'this.logger.error("Webview renderer did not become ready"');
  const message = 'let a=e.onDidReceiveMessage(u=>{';
  if (source.split(message).length !== 2) throw new Error('界面重试消息接入点数量异常。');
  return source.replace(message, message + 'if(s.handleMessage?.(u))return;');
}
