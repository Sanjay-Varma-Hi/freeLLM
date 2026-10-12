# FreeLLMAPI

**One OpenAI-compatible API key for many free LLM providers.**

FreeLLMAPI is a self-hosted gateway that pools the free tiers of many AI providers
(Google Gemini, Groq, Cerebras, OpenRouter, Mistral, Cloudflare, NVIDIA, Hugging Face
and more) behind a single `/v1` endpoint. You add your provider keys once in the
dashboard; your apps only ever use one `freellmapi-…` key. A router picks the best
available model for each request, fails over when a provider is rate-limited, and
tracks usage so you stay inside every free-tier limit.

Built and maintained by **[Sanjay Varma](https://github.com/Sanjay-Varma-Hi)**.

---

## Features

- **OpenAI-compatible API** — `/v1/chat/completions` (streaming, tools, vision, JSON
  output), `/v1/responses`, `/v1/completions`, `/v1/embeddings`, `/v1/models`.
- **Images, video and speech** — `/v1/images/generations`, `/v1/videos/generations`,
  `/v1/audio/speech`, `/v1/audio/transcriptions`.
- **Anthropic and Gemini wire formats** — `/v1/messages` and `/v1beta`, so Claude- and
  Gemini-style clients work too.
- **Smart routing** — `model: "auto"` (or `auto:fast`, `auto:smart`, a named profile,
  or an exact model id) with automatic failover on 429/5xx and per-key cooldowns.
- **Fusion** — the virtual `fusion` model asks several models in parallel and merges
  their answers.
- **Rate-limit tracking** — per provider, model and key (requests and tokens per
  minute/day).
- **Encrypted storage** — provider keys are AES-256-GCM encrypted at rest.
- **Persistent on free hosting** — optional MongoDB persistence keeps your account,
  provider keys and settings across restarts on hosts with temporary disks (Render).
- **Dashboard** — manage keys, fallback chains and profiles, try models in the
  playground, and view analytics (latency, usage, errors).

## Quick start (local)

Requirements: Node.js 20.18+ and npm 10+.

```bash
git clone https://github.com/Sanjay-Varma-Hi/freeLLM.git
cd freeLLM
cp .env.example .env
# set ENCRYPTION_KEY in .env (64 hex characters):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm ci
npm run dev
```

Open the dashboard at http://localhost:5173 (dev) and create your account. Add your
provider keys on the **Keys** page and copy your unified API key from the same page.

For a production build: `npm run build`, then `node server/dist/index.js`
(serves the dashboard and API on port 3001).

### Docker

```bash
cp .env.example .env   # set ENCRYPTION_KEY
docker compose up -d --build
```

## Deploying on Render (free plan) with MongoDB

Render's free plan wipes the disk whenever the service sleeps or redeploys. Connect
MongoDB so nothing is lost:

1. **MongoDB Atlas** — create a cluster and a database user. Under
   **Security → Network Access**, add `0.0.0.0/0` (Render has no fixed outbound IP).
2. **Render** — create a *Web Service* from this repository (it builds the
   `Dockerfile`) and set these environment variables:

   | Variable | Value |
   | --- | --- |
   | `ENCRYPTION_KEY` | 64 hex characters. Generate once and **never change it** — saved keys can't be decrypted with a different one. |
   | `MONGODB_URI` | Your Atlas connection string (`mongodb+srv://user:password@…`). |
   | `UNIFIED_API_KEY` | *(optional)* Pin your unified key so it never changes. |

3. Deploy. The log shows `[db-backup] persisting to MongoDB (…)`. Create your account
   and add provider keys once — they now survive every restart.

How persistence works: the whole SQLite database is gzipped, encrypted with
`ENCRYPTION_KEY` and stored in MongoDB GridFS a few seconds after every dashboard
change, every two minutes while anything changes, and on shutdown. On boot, an empty
disk is restored from it. Readable copies of your accounts and provider keys (keys
stay encrypted) are kept in the `accounts` and `provider_keys` collections.

## Using the API

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-deployment>/v1",
    api_key="freellmapi-…",          # your unified key from the dashboard
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
```

```bash
curl https://<your-deployment>/v1/images/generations \
  -H "Authorization: Bearer freellmapi-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","prompt":"a lighthouse at dusk","size":"1024x1024"}'
```

Every response includes an `X-Routed-Via: <provider>/<model>` header showing which
provider served it. Interactive API docs are available at `/v1/docs`.

Any OpenAI-compatible tool (Claude Code, Codex CLI, Cline, Continue, Aider, Cursor,
OpenCode…) can use the gateway: set its base URL to `https://<your-deployment>/v1`
and its API key to your unified key. The dashboard's **Coding agents** page lists the
exact settings for each tool.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the
full, commented list. The most important ones:

| Variable | Purpose |
| --- | --- |
| `ENCRYPTION_KEY` | Encrypts provider keys and backups. Required in production. |
| `MONGODB_URI` / `MONGODB_DB` | MongoDB persistence (database defaults to `freellmapi`). |
| `UNIFIED_API_KEY` | Pins the `/v1` API key. |
| `PORT` / `HOST` | Listen address (default `3001`). |

## Project structure

```
server/   Express API, router, provider adapters, SQLite storage (TypeScript)
client/   Dashboard (React + Vite + Tailwind)
shared/   Types shared by server and client
examples/ Optional extras (fetch-relay worker, ChatGPT tunnel config)
```

Useful scripts: `npm run dev`, `npm run build`, `npm test`, `npm run lint`.

## Limits

Free tiers come with real trade-offs: availability and speed vary by provider, the
strongest models have the smallest daily allowances (so quality can dip late in the
day until limits reset at UTC midnight), and providers can change their free tiers
at any time. Follow each provider's terms of service, keep the gateway for your own
use, and don't share your unified key.

## License

[MIT](LICENSE).
