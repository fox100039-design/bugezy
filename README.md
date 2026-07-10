# 🐛 BugEzy — Voice-Powered Bug Reporting for Developers

> Capture bugs by talking. Let AI fix them.

BugEzy is a Chrome extension + MCP server that lets developers report bugs using voice. It captures console logs, network errors, DOM traces, and your voice description automatically — so AI can find the root cause and give you the fix.

🌐 [bugezy.dev](https://bugezy.dev) · 🧩 [Chrome Web Store](https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj) · 📖 [SKILL.md (AI Guide)](https://bugezy.dev/skill)

## How It Works

1. **🎙️ Hit Record** — Open BugEzy popup, hit record. Talk about the bug while operating.
2. **📋 Auto-organized** — BugEzy captures screen replay, console logs, network errors, and action timeline into a structured report.
3. **🤖 AI Fixes It** — Hand the report to any MCP-compatible AI assistant. AI finds root causes and gives you the fix.

## MCP Server (13 Tools)

Connect your AI assistant to BugEzy:

**MCP Endpoint:** `https://bugezy.dev/mcp` (Streamable HTTP)

| Tool | Description |
|------|-------------|
| `get_report_overview` | Report metadata + AI bug navigation summary |
| `get_timeline` | Complete event timeline (console + network + voice + markers) |
| `get_console_logs` | Console logs (warn/error) |
| `get_network_errors` | Network errors (4xx/5xx) |
| `get_voice_transcript` | Developer voice transcript |
| `get_screenshots` | Report screenshots |
| `get_rrweb_summary` | DOM trace summary |
| `get_rrweb_events` | Full DOM events |
| `get_page_info` | Page info (URL/title/browser/resolution) |
| `get_metadata` | Custom metadata via SDK |
| `list_reports` | List user's bug reports |
| `get_live_errors` | Live console/network errors |
| `get_terminal_logs` | Terminal error logs |

### MCP Config (Claude Desktop / Cursor / Windsurf)

```json
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}
```

## Features

- **Voice Input** — Chinese, Cantonese, English (Japanese, Korean, Vietnamese coming soon)
- **Dual Voice Engine** — Web Speech API (free) + Groq Whisper (paid, high accuracy)
- **6 Recording Modes** — Record, Rewind 30s, Screenshot, Keyboard, Monitor, CLI
- **Bug Capture 10/10** — Console, Network, Resource errors, Web Vitals, DOM replay, Storage, Voice, Screenshots
- **Privacy First** — Sensitive data auto-masked (PII, JWT, API keys, credit cards)
- **AI Auto-correction** — Voice transcript cleanup + summarization
- **Save 93% Tokens** — Structured MCP data vs raw screenshots

## Python / Node CLI

```bash
npm install -g bugezy-watch
```

Captures Python tracebacks, Node.js errors, environment snapshots, and PII-masked terminal logs.

## Pricing

| Plan | Price | Includes |
|------|-------|----------|
| Free | $0 | 10 recordings, 5 rewinds, 20 MCP calls/month |
| Monthly | NT$80/mo (~$2.50) | Unlimited everything |
| Day Pass | NT$20 (~$0.65) | 24-hour full access |

## Security

- Fable5 4-round audit: 9.5+/10
- Supabase RLS on all 6 tables
- CSP with frame-ancestors
- Session token fragment-based (never in URL query string)
- ECPay payment with idempotent callback

## Tech Stack

Chrome Extension (TypeScript) · Cloudflare Workers · Supabase · R2 · Groq Whisper · ECPay

## Links

- 🌐 Website: [bugezy.dev](https://bugezy.dev)
- 🧩 Chrome Web Store: [Install](https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj)
- 📖 AI Guide: [SKILL.md](https://bugezy.dev/skill)
- 📋 Features: [bugezy.dev/features](https://bugezy.dev/features)
- 📝 Changelog: [bugezy.dev/changelog](https://bugezy.dev/changelog)
- ❓ FAQ: [bugezy.dev/faq](https://bugezy.dev/faq)

## License

Proprietary — © 2026 BugEzy
