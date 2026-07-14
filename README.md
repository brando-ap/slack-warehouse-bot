# Slack Warehouse Bot

A Slack app for coordinating a fulfillment team remotely. Requests come in through Slack, the warehouse team works them, and everyone sees the same picture without being in the same building.

## What it does

- **Ticket tracking** — every request gets a sequential ticket number (REQ-0001, …) with a customer, company, due date, and priority, picked from managed dropdown lists. Each one becomes a card in the team channel with Claim / In progress / Done buttons.
- **Shipping calendar** — schedule future shipments and see what ships today, this week, or this month.
- **Morning digest** — a daily channel post summarizing what's overdue, due today, still open, and shipping soon.
- **Warehouse wallboard** — a live, auto-refreshing web page of the open queue and shipping calendar, made for a TV on the warehouse floor.

## How it's built

TypeScript on Cloudflare Workers, with a D1 (SQLite) database and an hourly cron trigger for the digest. Slack talks to the Worker through slash commands and interactive components; no server to maintain.
