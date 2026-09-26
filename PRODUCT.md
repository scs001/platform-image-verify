# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

The primary user is the product's owner-developer: locally, Platform is a personal, daily AI assistant used in the browser (`npm start`, the app at `localhost:3000`, or `npm run web:dev` on Vite :5173) and as the packaged Electron desktop app. The hosted deployment (`fd-prod`) is the second, equally real product home: it serves demo/early external users who arrive through the WeChat mini-program (bind-code login), the registry marketplace (Logto SSO with roles), and social bots on WeCom/Feishu/Telegram/微信公众号. The job is the same in both homes: chat with a capable agent runtime, retrieve over the user's own documents, and manage models/extensions/agents from one place.

## Product Purpose

Platform is an AI-assistant platform built on the DeepSeek Harness (dsh) runtime, run in two topologies: a local self-contained assistant (one process, one launcher) and a hosted multi-user deployment where a gateway fronts per-user "cells". It streams dsh agent chat (thinking, tools, skills), answers over first-party documents via RAG, manages the surrounding stack (models, MCP extensions, skills, agents, scheduled jobs, bots), and assembles registry resources into customer-demoable vertical packs. Success means the owner relies on it daily as the primary assistant, and the hosted product demos and serves early external users credibly.

## Positioning

Locally: one process, one launcher, no cloud setup — the complete assistant (dsh runtime, first-party documents RAG, management UI) boots from a single command, and the desktop app carries the same thing. Hosted: per-user isolation on the same unit — each user gets a dedicated cell (one `server.js` process + its dsh runtime + a private data directory), so multi-user hosting adds a topology, not a sidecar. This rests on mechanisms a hosted chat product cannot truthfully copy: the depth of the dsh agent runtime (skills, tools, persistent sessions, model routing, native MCP connectors), first-party docs RAG over the user's own corpus, and a registry marketplace whose vertical packs (one entry skill + MCP servers + one conversational agent + one visibility role) assemble industry workflows without forking the product.

## Operating Context

- **Run modes (local):** `npm start` (headless launcher supervising `server.js`), `npm run web:dev` (Vite HMR), Electron desktop (`npm run start:electron`; arm64/x64 `.dmg` and Windows `.exe`).
- **Run modes (hosted):** `fd-prod` on K8s — a `gateway/` fronts many per-user cells; image and config ship via the Jenkins `platform` job → Harbor → GitOps tag bump → ArgoCD (details in `DEPLOY.md`).
- **Design languages (adaptive):** the dark-first web workbench (documented in `DESIGN.md`; browser + desktop render the identical UI) and the WeChat-native mini-program language (`miniapp/`, Taro 4 + React, compiled to weapp). The MP follows WeChat platform conventions — not iOS HIG or Material.
- **Surfaces (web routes):** `/chat` (default) and `/chat/:sessionId`, `/knowledge` (Documents), `/agents` (Agents & Apps catalog), `/bots`, `/trace` and `/trace/:turnId`, `/tasks` (cron), `/settings/:section` (models, mcp, skills, status — older `/models`, `/mcp`, `/skills`, `/dashboard` routes redirect here), `/external/:appId` (catalog-declared embedded apps), and public read-only `/share/:token`.
- **Surfaces (mini-program pages):** chat (home; history lives in its slide-up drawer), login (account bind), share, cron.
- **Configuration:** `.env` in dev, `userData/settings.json` in the desktop app, ConfigMap + Secrets on hosted; every optional component degrades gracefully — the server always starts.
- **Data:** SQLite under `PLATFORM_DATA_DIR` (sessions, chat history, documents index, cron, extension/MCP config); on hosted, that directory is per-user inside the cell.
- **Auth:** local — optional, default open access or `forward_auth` behind a proxy (oauth2-proxy → Logto). Hosted — MP bind-code login and Logto SSO for market credentials. The public `/share/:token` view is exempt from every auth posture: an anonymous recipient must land on the shared session.

## Capabilities and Constraints

Confirmed capabilities: streaming dsh agent chat with thinking/tool/skill rendering, plan progress, composer control dialogs, outline navigation, collapsible activity groups, chart rendering, and copy/regenerate; model and agent selection including locally-run pack agents with a configurable persona name; documents RAG ingestion (PDF, Markdown, plain text, web URLs) plus a bundled WeKnora knowledge sidecar (spawned by the Electron supervisor when `WEKNORA_BASE_URL` points at localhost); MCP extension runtime management and an extension marketplace fed by the mcp-gateway-registry with per-user registry credentials (silent Logto SSO connect, paste fallback); agents/apps catalog with cloud refresh; external-app embedding behind the token-injecting `/external/:appId` proxy; scheduled jobs (cron) with notifications; social bot channels (WeCom self-built apps, Feishu custom apps, Telegram, 微信公众号) with verified webhooks, per-(bot, chat) sessions, and a machine-caller relay (`bot-relay`); workspaces (sidebar grouping of past sessions by workspace, workspace selection with persisted recents); tool discovery (`tool_search` + unknown-tool candidates); public session share (read-only `/share/:token`); the WeChat mini-program thin client (streaming chat, session history, model/agent selection, attachment upload, bind-code login, accountless demo sandbox); and four vertical packs — 法律-合同, 法律-案件, 数据-股票, 数据-中国经济 (composition documented in `docs/vertical-packs.md`).

Confirmed constraints:

- **Chinese-first copy** — zh-CN is the primary product language; en/es/fr/ja are secondary. All UI strings flow through the checked locale files (`npm run check:locales` gates the build).
- **Desktop app parity** — the Electron app is a first-class surface; browser and desktop render the same web UI and neither may regress the other.
- **One cell per user** — per-user state (history, documents, config, skills, cron, bots) lives in that user's data directory and is never readable or writable from another cell; registry tokens and secrets are never committed in plaintext and never reach the browser.
- One dsh session serves all connected clients; the WS message contract in `openspec/specs/` is binding.
- **Mini-program lifecycle** — backgrounding kills sockets (resume on foreground) and the absence of DOM forces degraded rendering; the MP shares `@platform/core` (`packages/core`) with the web app and stays a thin client over the same WS/REST contracts.

## Brand Commitments

Product name: **Platform** (repo `fd-craw-private`, FindData Technology). The assistant persona's display name is configurable via `ASSISTANT_NAME` (default "Platform"; the hosted deployment runs "FD") and names the built-in agent's picker row and sidebar presence. README is Chinese-first with an English appendix; versioned releases ship via GitHub Actions. No logo, identity assets, or voice guide exist yet — none is binding.

## Evidence on Hand

- Working codebase: Express + WS backend (`server.js`, one process per cell), React 19 + Vite + Tailwind v4 + shadcn/ui frontend (`web/`), Taro 4 + React 18 mini-program (`miniapp/`), shared core (`packages/core`), hosted gateway (`gateway/`).
- Documentation: `README.md` (zh + en), `CLAUDE.md` (architecture), `DEPLOY.md` (live fd-prod layout: registry market, `ASSISTANT_NAME=FD`, MP auth + demo sandbox live), `docs/vertical-packs.md`, ~90 OpenSpec capability specs under `openspec/specs/`, Playwright e2e suites under `e2e/`.
- Absences future work must not fabricate: no logos or brand assets, no product screenshots, no testimonials, customers, benchmarks, or pricing.

## Product Principles

1. **Local-first, always-runs.** The whole assistant boots from one launcher, and every optional component degrades gracefully rather than blocking startup — locally and per cell on hosted alike.
2. **Chat is the center.** The chat surface is the product; every panel exists to feed it (models, documents, extensions, agents, tasks, bots, status).
3. **Chinese-first, locale-checked.** zh-CN leads; every user-facing string lives in the checked locale files, never inline.
4. **One product, two design languages.** Browser and desktop are the identical web UI (parity is a constraint, not a nicety); the WeChat MP is the WeChat-native dialect of the same contracts — each surface speaks its platform, not a port.
5. **Secrets stay server-side; one cell per user.** API keys, external-service tokens, and per-user state never reach another client, another cell, or the repository.
