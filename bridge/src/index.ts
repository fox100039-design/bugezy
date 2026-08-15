#!/usr/bin/env node
// PM-297：bugezy-bridge 入口。
//   ① 開一個 localhost WebSocket server 等 BugEzy Extension 連上
//   ② 用 stdio 跑 MCP server 讓 AI 工具連上
//   ③ AI 呼叫工具 → 轉發給 Extension → 取回結果 → 回給 AI
//
// ⚠ stdio 模式下 **stdout 專屬於 MCP 協定**，所有人看的訊息一律走 stderr（見 extension-link.ts 的 log）。

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExtensionLink, log } from './extension-link.js';
import { createMcpServer } from './mcp-server.js';
import { BRIDGE_PORT } from './types.js';

async function main(): Promise<void> {
  const port = Number(process.env.BUGEZY_BRIDGE_PORT) || BRIDGE_PORT;

  log('🔌 BugEzy Bridge 已啟動');
  log('   MCP Server: stdio 模式（供 AI 工具連接）');

  const link = new ExtensionLink();
  try {
    await link.start(port);
    log('   等待 Extension 連線…');
  } catch (e) {
    // PM-298：**不要 exit**。多個 AI 工具會各自 spawn 一個 bridge，只有第一個綁得到 port；
    //   後起的若直接死掉，AI 端只看到空的「Failed to connect」，看不到原因。
    //   繼續把 MCP server 起起來，讓工具能回一句人看得懂的話。
    const reason = `另一個 bugezy-bridge 已在運行（port ${port} 被占用），請關閉後重試。若要同時跑多個，可用環境變數 BUGEZY_BRIDGE_PORT 指定其他 port（Extension 端目前固定連 ${BRIDGE_PORT}）。`;
    log(`⚠ ${reason}`);
    log('   MCP server 仍會啟動，但所有瀏覽器指令都會回報這個錯誤。');
    link.disable(reason);
  }

  const server = createMcpServer(link);
  await server.connect(new StdioServerTransport());

  const shutdown = () => {
    log('\n👋 BugEzy Bridge 結束');
    link.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('❌ bridge 啟動失敗:', String(e));
  process.exit(1);
});
