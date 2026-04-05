import { env } from "@my-better-t-app/env/server";
import { db } from "@my-better-t-app/db";
import { chunkAcks, recordings } from "@my-better-t-app/db/schema";
import { eq, asc } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

// Local bucket — simulates S3/MinIO with a local folder
const BUCKET_DIR = join(process.cwd(), ".bucket");
if (!existsSync(BUCKET_DIR)) mkdirSync(BUCKET_DIR, { recursive: true });

function bucketPath(key: string) {
    return join(BUCKET_DIR, key.replace("/", "_"));
}

function chunkExistsInBucket(key: string): boolean {
    return existsSync(bucketPath(key));
}

function saveChunkToBucket(key: string, data: Buffer): void {
    writeFileSync(bucketPath(key), data);
}

// WAV header is always 44 bytes for PCM WAV
const WAV_HEADER_SIZE = 44;

function stitchWavBuffers(buffers: Buffer[]): Buffer {
    if (buffers.length === 0) throw new Error("No buffers to stitch");
    if (buffers.length === 1) return buffers[0];

    // Keep header from first chunk only
    const header = buffers[0].slice(0, WAV_HEADER_SIZE);

    // Collect all PCM data: full first chunk + stripped subsequent chunks
    const dataParts: Buffer[] = [];
    for (let i = 0; i < buffers.length; i++) {
        if (i === 0) {
            dataParts.push(buffers[i].slice(WAV_HEADER_SIZE));
        } else {
            // Strip 44-byte WAV header from each subsequent chunk
            dataParts.push(buffers[i].slice(WAV_HEADER_SIZE));
        }
    }

    const pcmData = Buffer.concat(dataParts);
    const totalDataSize = pcmData.length;

    // Clone header and fix sizes
    const newHeader = Buffer.from(header);
    // RIFF chunk size = totalDataSize + 36
    newHeader.writeUInt32LE(totalDataSize + 36, 4);
    // data chunk size
    newHeader.writeUInt32LE(totalDataSize, 40);

    return Buffer.concat([newHeader, pcmData]);
}

async function transcribeWithDeepgram(
    audioBuffer: Buffer,
    apiKey: string
): Promise<{ transcript: string; speakerData: string; detectedLanguage: string }> {
    const response = await fetch(
        "https://api.deepgram.com/v1/listen?model=nova-2-meeting&diarize=true&punctuate=true&detect_language=true&smart_format=true",
        {
            method: "POST",
            headers: {
                Authorization: `Token ${apiKey}`,
                "Content-Type": "audio/wav",
            },
            body: audioBuffer,
        }
    );

    if (!response.ok) {
        throw new Error(`Deepgram error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    const channel = data?.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    const detectedLanguage = channel?.detected_language ?? "unknown";

    const words = alternative?.words ?? [];
    const speakerSegments: { speaker: number; text: string; start: number; end: number }[] = [];
    let currentSpeaker = -1;
    let currentText = "";
    let segStart = 0;
    let segEnd = 0;

    for (const word of words) {
        const speaker = word.speaker ?? 0;
        if (speaker !== currentSpeaker) {
            if (currentText.trim()) {
                speakerSegments.push({ speaker: currentSpeaker, text: currentText.trim(), start: segStart, end: segEnd });
            }
            currentSpeaker = speaker;
            currentText = word.punctuated_word ?? word.word;
            segStart = word.start;
        } else {
            currentText += " " + (word.punctuated_word ?? word.word);
        }
        segEnd = word.end;
    }
    if (currentText.trim()) {
        speakerSegments.push({ speaker: currentSpeaker, text: currentText.trim(), start: segStart, end: segEnd });
    }

    return {
        transcript: alternative?.transcript ?? "",
        speakerData: JSON.stringify(speakerSegments),
        detectedLanguage,
    };
}

const app = new Hono();
app.use(logger());
app.use("/*", cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
}));

app.get("/", (c) => c.json({ status: "ok", service: "meeting-transcription-backend" }));

// ── POST /api/recordings ─────────────────────────────────────
app.post("/api/recordings", async (c) => {
    const id = crypto.randomUUID();
    await db.insert(recordings).values({ id });
    return c.json({ recordingId: id }, 201);
});

// ── GET /api/recordings ──────────────────────────────────────
app.get("/api/recordings", async (c) => {
    const all = await db.select().from(recordings).orderBy(recordings.createdAt);
    return c.json({ recordings: all });
});

// ── POST /api/chunks/upload ──────────────────────────────────
// PHASE 1: Reliability only — save to bucket + DB ack. NO transcription.
app.post("/api/chunks/upload", async (c) => {
    const body = await c.req.parseBody();
    const recordingId = body["recordingId"] as string;
    const chunkId     = body["chunkId"] as string;
    const chunkIndex  = Number(body["chunkIndex"]);
    const durationMs  = Number(body["durationMs"] ?? 0);
    const file        = body["file"] as File;

    if (!recordingId || !chunkId || !file || isNaN(chunkIndex)) {
        return c.json({ error: "Missing required fields: recordingId, chunkId, chunkIndex, file" }, 400);
    }

    // Idempotency: already acked → skip, return success
    const existing = await db.select().from(chunkAcks).where(eq(chunkAcks.id, chunkId)).limit(1);
    if (existing.length > 0) {
        return c.json({ status: "already_acked", chunkId }, 200);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const key = `${recordingId}_chunk${chunkIndex}_${chunkId}`;

    // Step 1: Save to bucket
    saveChunkToBucket(key, buffer);

    // Step 2: Write DB ack ONLY after bucket confirms
    await db.insert(chunkAcks).values({
        id: chunkId,
        recordingId,
        chunkIndex,
        bucketKey: key,
        sizeBytes: buffer.length,
        durationMs,
        reconciliationNeeded: false,
    });

    return c.json({ status: "acked", chunkId }, 200);
});

// ── GET /api/recordings/:id/transcript ───────────────────────
// PHASE 2: Fetch all chunks → stitch WAV → send to Deepgram ONCE → return transcript
app.get("/api/recordings/:id/transcript", async (c) => {
    const recordingId = c.req.param("id");

    const chunks = await db
        .select()
        .from(chunkAcks)
        .where(eq(chunkAcks.recordingId, recordingId))
        .orderBy(asc(chunkAcks.chunkIndex));

    if (chunks.length === 0) {
        return c.json({ error: "No chunks found for this recording" }, 404);
    }

    // If already transcribed, return cached result
    const firstChunk = chunks[0];
    if (firstChunk.transcript) {
        const speakerSegments = JSON.parse(chunks.find(ch => ch.speakerData)?.speakerData ?? "[]") as any[];
        return c.json({
            recordingId,
            totalChunks: chunks.length,
            cached: true,
            speakerTranscript: buildSpeakerTranscript(speakerSegments),
            plainTranscript: chunks.map(ch => ch.transcript ?? "").join(" ").trim(),
        });
    }

    const apiKey = process.env.DEEPGRAM_API_KEY ?? "";
    if (!apiKey) {
        return c.json({ error: "DEEPGRAM_API_KEY not set" }, 500);
    }

    // Read all chunk files from bucket in order
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
        const path = bucketPath(chunk.bucketKey);
        if (!existsSync(path)) {
            return c.json({ error: `Chunk ${chunk.chunkIndex} missing from bucket. Run reconcile first.` }, 409);
        }
        buffers.push(readFileSync(path));
    }

    // Stitch into one WAV file
    const stitched = stitchWavBuffers(buffers);

    // Send full audio to Deepgram ONCE
    const result = await transcribeWithDeepgram(stitched, apiKey);

    // Store transcript on first chunk (as the recording-level result)
    await db.update(chunkAcks)
        .set({ transcript: result.transcript, speakerData: result.speakerData, detectedLanguage: result.detectedLanguage })
        .where(eq(chunkAcks.id, firstChunk.id));

    // Update recording with detected language
    await db.update(recordings)
        .set({ detectedLanguage: result.detectedLanguage })
        .where(eq(recordings.id, recordingId));

    const speakerSegments = JSON.parse(result.speakerData) as any[];

    return c.json({
        recordingId,
        totalChunks: chunks.length,
        detectedLanguage: result.detectedLanguage,
        plainTranscript: result.transcript,
        speakerTranscript: buildSpeakerTranscript(speakerSegments),
    });
});

function buildSpeakerTranscript(segments: { speaker: number; text: string }[]): string {
    let out = "";
    let lastSpeaker = -1;
    for (const seg of segments) {
        if (seg.speaker !== lastSpeaker) {
            out += `\n\n[Speaker ${seg.speaker + 1}]: `;
            lastSpeaker = seg.speaker;
        }
        out += seg.text + " ";
    }
    return out.trim();
}

// ── POST /api/recordings/:id/reconcile ───────────────────────
app.post("/api/recordings/:id/reconcile", async (c) => {
    const recordingId = c.req.param("id");

    const chunks = await db
        .select()
        .from(chunkAcks)
        .where(eq(chunkAcks.recordingId, recordingId))
        .orderBy(asc(chunkAcks.chunkIndex));

    const missing: { chunkId: string; chunkIndex: number }[] = [];
    const healthy: string[] = [];

    for (const chunk of chunks) {
        if (!chunkExistsInBucket(chunk.bucketKey)) {
            missing.push({ chunkId: chunk.id, chunkIndex: chunk.chunkIndex });
            await db.update(chunkAcks).set({ reconciliationNeeded: true }).where(eq(chunkAcks.id, chunk.id));
        } else {
            healthy.push(chunk.id);
        }
    }

    return c.json({
        recordingId,
        totalChecked: chunks.length,
        healthy: healthy.length,
        missing: missing.length,
        missingChunks: missing,
        consistent: missing.length === 0,
    });
});

// ── PUT /api/recordings/:id/complete ─────────────────────────
app.put("/api/recordings/:id/complete", async (c) => {
    const recordingId = c.req.param("id");
    await db.update(recordings).set({ status: "completed" }).where(eq(recordings.id, recordingId));
    return c.json({ status: "completed", recordingId });
});

export default app;