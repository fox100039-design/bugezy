// PM-374：方案改由 BUGEZY_SESSION_TOKEN 向 Workers 查，**不再讀自由字串環境變數**。
// 端到端因此要起一個本機 mock Workers 回傳指定方案。
// ⚠ 這不是「用環境變數繞過閘門」——BUGEZY_WORKERS_URL 只決定「去哪裡問」，
//   閘門仍然照常執行，而且這樣才真的走過 token → tier 的完整路徑。
import http from 'node:http';
export function startMockWorkers(tier) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const quota = JSON.stringify({ tier, unlimited: tier !== 'free' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: quota }] },
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
