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
  } catch (e) {
    log(`❌ 無法啟動 Extension 通訊 server：${(e as Error).message}`);
    process.exit(1);
  }
  log('   等待 Extension 連線…');

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
