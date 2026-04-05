# Meeting Transcription Pipeline

A reliable, chunk-based meeting transcription system with speaker diarization, automatic language detection, and zero data loss guarantees — built for long recordings (1 hour+).

---

## What This Does

Records audio in the browser, splits it into 5-second chunks, stores each chunk reliably, then stitches everything into one complete meeting transcript after recording stops. Multiple speakers are labeled automatically. Language is detected automatically.

**The core problem this solves:** Audio recording is unreliable — tabs crash, networks drop, servers fail. This system guarantees no chunk of a meeting is ever lost, even under failure.

---

## How It Works

### Phase 1 — Recording (Reliability Only)

```
Browser records audio
        ↓
Every 5 seconds → WAV chunk created
        ↓
Chunk saved to OPFS (browser's private file system) ← survives tab crash
        ↓
POST /api/chunks/upload
        ↓
Server: save to .bucket/ folder (filesystem) ← durable storage
Server: write DB acknowledgment               ← only after bucket confirms
        ↓
Client: delete from OPFS only after DB ack received
        ↓
On any failure → client retries from OPFS automatically
```

No transcription happens during recording. Zero Deepgram calls. Pure reliability.

### Phase 2 — Transcription (After Recording)

```
User clicks "Get Transcript"
        ↓
Server fetches all chunks ordered by chunkIndex
        ↓
Reads all chunk files from bucket
        ↓
Stitches into one WAV file (correct WAV headers)
        ↓
Sends full audio to Deepgram ONCE
  - model: nova-2-meeting (optimized for multi-speaker meetings)
  - diarize: true  → speaker labels
  - detect_language: true → auto language detection
  - punctuate + smart_format: true
        ↓
Stores transcript in DB (cached — no repeat Deepgram calls)
        ↓
Returns speaker-labeled transcript
```

Sending the full recording at once (not per-chunk) gives Deepgram the full context of all speakers — significantly more accurate diarization.

---

## Key Design Properties

**Idempotent uploads** — The same chunk uploaded twice produces exactly one DB entry. Safe to retry on network failure without creating duplicates.

**Ordered stitching** — Chunks are assembled by `chunkIndex`, not arrival time. Chunk 3 arriving before chunk 2 under load still produces a correct transcript.

**Reconciliation** — A dedicated endpoint cross-checks every DB acknowledgment against the bucket. If a file is missing (bucket wiped, restart), it's flagged so the client can re-upload from OPFS.

**Transcript caching** — Once a recording is transcribed, the result is stored in DB and returned immediately on repeat requests. No second Deepgram call.

**Works without Deepgram key** — The reliability pipeline (OPFS, upload, bucket, DB ack, reconciliation) works fully without a Deepgram key. Transcripts will be empty but everything else is testable independently.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (App Router) |
| Backend | Hono on Bun |
| Database | PostgreSQL + Drizzle ORM |
| Transcription | Deepgram nova-2-meeting |
| Client storage | OPFS (Origin Private File System) |
| Monorepo | Turborepo |

---

## Local Setup

### Prerequisites

- Node.js 18+
- Bun (`npm install -g bun`)
- Docker (for local PostgreSQL)

### Step 1 — Get a Free Deepgram API Key

1. Go to [console.deepgram.com](https://console.deepgram.com)
2. Sign up — free, no credit card, $200 credit included
3. Click **Create API Key** → copy it

### Step 2 — Start the Database

```bash
npm run db:start
```

This starts a PostgreSQL container via Docker on port 5432.

### Step 3 — Configure Environment Variables

```bash
# Server
cp apps/server/.env.example apps/server/.env
```

Open `apps/server/.env` and fill in:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/my-better-t-app
CORS_ORIGIN=http://localhost:3001
NODE_ENV=development
DEEPGRAM_API_KEY=your_deepgram_key_here
```

```bash
# Web (no changes needed, defaults work)
cp apps/web/.env.example apps/web/.env.local
```

### Step 4 — Install, Migrate, Run

```bash
npm install
npm run db:push     # creates tables in PostgreSQL
npm run dev         # starts server (port 3000) + web (port 3001)
```

- Recorder UI: **http://localhost:3001/recorder**
- API server: **http://localhost:3000**

---

## Testing the System

### UI Flow

1. Open **http://localhost:3001/recorder**
2. Click **Record** → allow microphone access when prompted
3. Speak for 20–60 seconds — have multiple people speak if possible
4. Click **Stop**
5. Click **Get Transcript** — wait a few seconds for Deepgram
6. See the full speaker-labeled transcript:
   ```
   [Speaker 1]: Hello everyone, let's get started.

   [Speaker 2]: Sure, I'll share my screen now.

   [Speaker 1]: Perfect, go ahead.
   ```
7. Click **Reconcile** — confirms all chunks are consistent between DB and bucket

### API Testing with curl

```bash
# 1. Start a recording session
curl -X POST http://localhost:3000/api/recordings

# Response:
# { "recordingId": "abc-123" }

# 2. Upload a chunk
curl -X POST http://localhost:3000/api/chunks/upload \
  -F "recordingId=abc-123" \
  -F "chunkId=$(uuidgen)" \
  -F "chunkIndex=0" \
  -F "durationMs=5000" \
  -F "file=@/path/to/audio.wav"

# Response:
# { "status": "acked", "chunkId": "..." }

# 3. Get full transcript (after all chunks uploaded)
curl http://localhost:3000/api/recordings/abc-123/transcript

# 4. Run reconciliation
curl -X POST http://localhost:3000/api/recordings/abc-123/reconcile

# 5. List all recording sessions
curl http://localhost:3000/api/recordings

# 6. Mark recording complete
curl -X PUT http://localhost:3000/api/recordings/abc-123/complete
```

### Testing Reliability (Retry from OPFS)

1. Start recording
2. Disconnect your internet mid-recording
3. Reconnect — failed chunks automatically retry from OPFS
4. Stop recording → Get Transcript — no chunks missing

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/recordings` | Start a new recording session |
| `GET` | `/api/recordings` | List all sessions |
| `POST` | `/api/chunks/upload` | Upload a chunk (idempotent) |
| `GET` | `/api/recordings/:id/transcript` | Get stitched transcript with speaker labels |
| `POST` | `/api/recordings/:id/reconcile` | Check DB ↔ bucket consistency |
| `PUT` | `/api/recordings/:id/complete` | Mark session as complete |

### POST /api/chunks/upload — Request Fields

| Field | Type | Description |
|-------|------|-------------|
| `recordingId` | string | Session ID from `/api/recordings` |
| `chunkId` | string (UUID) | Unique chunk ID — generated by client |
| `chunkIndex` | number | Chunk order: 0, 1, 2, ... |
| `durationMs` | number | Duration in milliseconds |
| `file` | File (multipart) | WAV audio blob |

### GET /api/recordings/:id/transcript — Response

```json
{
  "recordingId": "abc-123",
  "totalChunks": 12,
  "detectedLanguage": "en",
  "plainTranscript": "Hello everyone let's get started...",
  "speakerTranscript": "[Speaker 1]: Hello everyone\n\n[Speaker 2]: Let's get started..."
}
```

### POST /api/recordings/:id/reconcile — Response

```json
{
  "recordingId": "abc-123",
  "totalChecked": 12,
  "healthy": 12,
  "missing": 0,
  "missingChunks": [],
  "consistent": true
}
```

---

## Database Schema

```
recordings
  id                text        PRIMARY KEY
  status            enum        recording | completed | failed
  detected_language text
  created_at        timestamp

chunk_acks
  id                text        PRIMARY KEY (chunkId from client)
  recording_id      text        FK → recordings.id
  chunk_index       integer     ordering key for WAV stitching
  bucket_key        text        filename in .bucket/ folder
  size_bytes        integer
  duration_ms       integer
  transcript        text        Deepgram raw output (stored after transcription)
  speaker_data      text        JSON array of speaker segments
  detected_language text
  reconciliation_needed boolean
  acked_at          timestamp
```

---

## Deployment

### Railway (Server + Database)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set root directory to `apps/server`
4. Add **PostgreSQL** plugin inside Railway — it provides `DATABASE_URL` automatically
5. Run `db:push` against the Railway database URL:
   ```bash
   DATABASE_URL=<railway_url> npm run db:push
   ```
6. Set environment variables in Railway:
   ```
   DATABASE_URL=      (from Railway PostgreSQL plugin)
   CORS_ORIGIN=       (your Vercel frontend URL)
   DEEPGRAM_API_KEY=  (your key)
   NODE_ENV=production
   ```

### Vercel (Frontend)

1. Go to [vercel.com](https://vercel.com) → New Project → import same repo
2. Set root directory to `apps/web`
3. Add environment variable:
   ```
   NEXT_PUBLIC_SERVER_URL=https://your-server.railway.app
   ```
4. Deploy

---

## Design Decisions

| Decision | Reason |
|----------|--------|
| Deepgram over Whisper | Single API call for transcription + speaker diarization + language detection. No GPU. Free tier sufficient. |
| `nova-2-meeting` model | Specifically trained for multi-speaker meeting audio. Better diarization than general models. |
| Transcribe after recording, not per-chunk | Full audio gives Deepgram complete speaker context → more accurate labels. No API calls during recording → no mid-recording failures. |
| OPFS over localStorage | Handles binary blobs natively, no size limit, survives crashes. localStorage is string-only and limited to ~5MB. |
| Local bucket over S3 | Zero external dependency for reviewers. Swap `saveChunkToBucket` for an S3 `PutObject` call in production — one function change. |
| Idempotency by chunkId | Client retries on failure → same chunk arrives twice → server returns cached ack, no duplicate entry. |
| Ordered stitching by chunkIndex | Network delivery order ≠ correct order. `chunkIndex` assigned at record time is the only reliable ordering key. |
| WAV header stripping on stitch | Each 5s chunk is a valid WAV with its own header. Concatenating directly corrupts audio. Strip headers from all chunks except first, fix RIFF size fields in the combined header. |
