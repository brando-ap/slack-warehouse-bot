# Slack Warehouse Bot

A Slack app for coordinating a fulfillment team remotely. Requests come in through Slack, the warehouse team works them, and everyone sees the same picture without being in the same building.

## What it does

- **Ticket tracking** — every request gets a sequential ticket number (REQ-0001, …) with a #category (receiving, ship, fulfillment, …), customer, company, due date, priority, and photos. Each one becomes a card in the team channel with Claim / In progress / Done buttons.
- **Morning digest** — a daily channel post summarizing what's overdue, due today, and still open.
- **Warehouse wallboard** — a live React app for a TV or touchscreen on the warehouse floor: urgency lanes, category filters, an overdue alert banner, and tap-to-Claim/Done that syncs back into Slack.

## How it's built

A TypeScript Worker on Cloudflare with a D1 (SQLite) database and an hourly cron trigger for the digest; the wallboard is a React app (Vite) served as static assets by the same Worker and driven by a small JSON API. Slack talks to the Worker through slash commands, interactive components, and the Events API; no server to maintain.
