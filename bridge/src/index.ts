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
import { stopAllTerminalMonitors } from './terminal-monitor.js';
import { initMemoryStore } from './memory-store.js';
import { resolveTier, isGateEnabled, tierResolutionNote, TIER_LABEL } from './tier-gate.js';

async function main(): Promise<void> {
  const port = Number(process.env.BUGEZY_BRIDGE_PORT) || BRIDGE_PORT;

  log('🔌 BugEzy Bridge 已啟動');
  log('   MCP Server: stdio 模式（供 AI 工具連接）');

  // PM-355：§14 記憶矩陣——從 CWD 往上找 `.bugezy/`（跟 git 找 `.git/` 一樣）。
  // **找不到不是錯誤**：回空白記憶，等第一次 memory_save 才自動建立。
  // bridge 由 AI 工具以 stdio 啟動，CWD 就是當下的專案目錄 → 換專案自動切換記憶（§14.12.3）。
  const mem = initMemoryStore(process.cwd());
  log(mem.found ? `   記憶矩陣: ${mem.root}` : '   記憶矩陣: 尚未建立（第一次 memory_save 會自動建立 .bugezy/）');

  // PM-374：**閘門預設開啟**，方案改由 BUGEZY_SESSION_TOKEN 向 Workers 查（不再讀自由字串環境變數）。
  //   啟動時先查一次並印出結果 —— 被擋的時候使用者要能一眼看出是「沒設 token」還是「真的沒訂閱」。
  if (isGateEnabled()) {
    const tier = await resolveTier();
    log(`   方案閘門: 開啟；目前判定為 ${TIER_LABEL[tier]}`);
    log(`   ${tierResolutionNote()}`);
  } else {
    log('   方案閘門: 已由 ENFORCE_TIER_GATE=false 明確關閉');
  }

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
    // PM-327：先收掉被監控的子程序，否則 `npm run dev` 之類會變成孤兒繼續占著 port
    //   （PM-310 已經被自己留下的孤兒 bridge 卡過兩次，這裡不重蹈覆轍）
    stopAllTerminalMonitors();
    link.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', stopAllTerminalMonitors); // 正常結束（stdio 關閉）也要收
}

main().catch((e) => {
  log('❌ bridge 啟動失敗:', String(e));
  process.exit(1);
});
