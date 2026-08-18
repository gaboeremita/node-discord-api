# node-discord-api

Discord bridge for [laravel-vera](https://github.com/gaboeremita) — connects Discord bots to laravel-vera's assistants, so each assistant can hold conversations in Discord the same way it does through the web app.

## How it works

This service holds no conversation state of its own. It's a relay:

- Connects one or more Discord bots to the Gateway (each bot maps to one laravel-vera assistant)
- On a message, checks that channel's trigger mode (`off` / `always` / `mention`) — fetched from laravel-vera and refreshed periodically
- If the message should get a response, calls laravel-vera's `discord-messages` endpoint with the channel id and message content, and relays the reply back to Discord — chunked if it's over Discord's 2000-character limit
- Exposes a small HTTP server (`GET /assistants/:assistantId/discovery`) that laravel-vera's settings UI calls to see which servers/channels each bot is currently in

Everything else — conversation history, prompts, trigger-mode config, per-server/per-channel context — lives in laravel-vera's database. This service never stores anything to disk beyond its own `.env` and `bots.config.json`.

## Setup

```bash
npm install
cp .env.example .env
cp bots.config.example.json bots.config.json
```

Fill in `.env`:

| Variable | Purpose |
|---|---|
| `<NAME>_DISCORD_TOKEN` | Bot token from the Discord Developer Portal, one per bot |
| `<NAME>_ASSISTANT_ID` | The laravel-vera assistant id that bot maps to |
| `DISCORD_API_PORT` | Port for the discovery server (default 3001) |
| `DISCORD_API_SECRET` | Shared secret laravel-vera sends when calling the discovery endpoint |
| `LARAVEL_VERA_API_URL` | Base URL of laravel-vera's API |
| `DISCORD_API_TOKEN` | Sanctum token authenticating this service as your laravel-vera user |

Fill in `bots.config.json` — one entry per bot, referencing the env var names above:

```json
[
  { "name": "vera", "tokenEnv": "VERA_DISCORD_TOKEN", "assistantIdEnv": "VERA_ASSISTANT_ID" }
]
```

Each bot needs, in the Discord Developer Portal: a bot user, Message Content Intent enabled (Bot page → Privileged Gateway Intents), and an invite via OAuth2 → URL Generator with the `bot` scope and View Channel / Send Messages / Read Message History permissions.

## Running

```bash
npm start
```

Logs in every bot listed in `bots.config.json` and starts the discovery server. A bot with a missing token or assistant id is skipped with a warning rather than crashing the process.
