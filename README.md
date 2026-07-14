# KrishiApp Backend

The API powering **KrishiApp** — a multilingual (English / Hindi / Telugu) platform built to give Indian farmers an AI farming advisor, crop-disease diagnosis, weather and market data, government scheme info, and a farmer community, all in one place. This service powers both the [KrishiApp mobile app](https://github.com/GovindSharma0708/KrishiApp) and a companion web client.

## What it does

- **AI farming advisor** — chat-based guidance for crop and farming questions, with streaming responses and voice input
- **Crop disease detection** — snap a photo of a plant and get an AI diagnosis with treatment suggestions
- **Weather & market prices** — local weather and crop price trends, so farmers can plan around them
- **Government schemes** — a browsable, kept-up-to-date list of schemes farmers can benefit from
- **Farmer community** — posts, comments, and topic-based chat channels for farmers to help each other
- **Accounts** — secure signup/login with password reset, in the farmer's language of choice

## Tech stack

Node.js + Express, MongoDB, Socket.IO for real-time chat, JWT-based auth, and a LangGraph-orchestrated AI pipeline (Groq / Gemini / Hugging Face) for the advisor and disease detection features. Images go through Cloudinary; voice queries through Deepgram.

## Getting started

### Prerequisites

- Node.js 20 (see `.nvmrc`)
- A MongoDB connection string

### Install & run

```bash
npm install
cp .env.example .env   # fill in your own keys and connection string
npm run dev             # http://localhost:<PORT>, auto-reloads
```

`GET /health` reports whether the service and its database connection are up.

### Seed reference data

```bash
npm run seed:schemes
```

### Test & lint

```bash
npm test
npm run lint
```

## Project structure

Each feature (auth, disease detection, advisor chat, community, community chat, schemes, etc.) lives in its own module under `src/modules/`, following the same routes → controller → service → model layering, with shared middleware and utilities under `src/shared/`.

## License

MIT
