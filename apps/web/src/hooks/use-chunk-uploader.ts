"use client"

import { useCallback, useRef } from "react"
import type { WavChunk } from "./use-recorder"

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000"

// ─── OPFS helpers ────────────────────────────────────────────
async function saveChunkToOPFS(chunkId: string, blob: Blob): Promise<void> {
    const root = await navigator.storage.getDirectory()
    const file = await root.getFileHandle(`chunk_${chunkId}.wav`, { create: true })
    const writable = await file.createWritable()
    await writable.write(blob)
    await writable.close()
}

async function loadChunkFromOPFS(chunkId: string): Promise<Blob | null> {
    try {
        const root = await navigator.storage.getDirectory()
        const file = await root.getFileHandle(`chunk_${chunkId}.wav`)
        return await file.getFile()
    } catch {
        return null
    }
}

async function deleteChunkFromOPFS(chunkId: string): Promise<void> {
    try {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry(`chunk_${chunkId}.wav`)
    } catch {
        // already gone, fine
    }
}

// ─── Upload with retry ───────────────────────────────────────
async function uploadChunk(
    chunk: WavChunk,
    index: number,
    recordingId: string,
    retries = 3
): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const form = new FormData()
            form.append("recordingId", recordingId)
            form.append("chunkId", chunk.id)
            form.append("chunkIndex", String(index))
            form.append("durationMs", String(Math.round(chunk.duration * 1000)))
            form.append("file", chunk.blob, `chunk_${index}.wav`)

            const res = await fetch(`${SERVER_URL}/api/chunks/upload`, {
                method: "POST",
                body: form,
            })

            if (!res.ok) throw new Error(`Server responded ${res.status}`)
            return
        } catch (err) {
            console.warn(`Chunk ${chunk.id} upload attempt ${attempt} failed:`, err)
            if (attempt === retries) throw err
            await new Promise(r => setTimeout(r, 500 * attempt))
        }
    }
}

// ─── Types ───────────────────────────────────────────────────
export interface ChunkUploadResult {
    chunkId: string
    chunkIndex: number
    status: "uploading" | "uploaded" | "failed"
}

interface UseChunkUploaderOptions {
    recordingId: string | null
    onChunkResult?: (result: ChunkUploadResult) => void
}

// ─── Main hook ───────────────────────────────────────────────
export function useChunkUploader({ recordingId, onChunkResult }: UseChunkUploaderOptions) {
    const chunkIndexRef = useRef(0)

    const processChunk = useCallback(async (chunk: WavChunk) => {
        if (!recordingId) return

        const index = chunkIndexRef.current++

        // Step 1: Save to OPFS first — survives tab crash
        await saveChunkToOPFS(chunk.id, chunk.blob)

        onChunkResult?.({ chunkId: chunk.id, chunkIndex: index, status: "uploading" })

        try {
            // Step 2: Upload to server (bucket → DB ack only, no transcription)
            await uploadChunk(chunk, index, recordingId)

            // Step 3: Delete from OPFS only after server confirms ack
            await deleteChunkFromOPFS(chunk.id)

            onChunkResult?.({ chunkId: chunk.id, chunkIndex: index, status: "uploaded" })
        } catch (err) {
            console.error(`Chunk ${chunk.id} failed — kept in OPFS for recovery`, err)
            onChunkResult?.({ chunkId: chunk.id, chunkIndex: index, status: "failed" })
        }
    }, [recordingId, onChunkResult])

    const recoverFromOPFS = useCallback(async (chunks: WavChunk[]) => {
        if (!recordingId) return
        for (let i = 0; i < chunks.length; i++) {
            const opfsBlob = await loadChunkFromOPFS(chunks[i].id)
            if (opfsBlob) {
                console.log(`Recovering chunk ${chunks[i].id} from OPFS`)
                await uploadChunk({ ...chunks[i], blob: opfsBlob }, i, recordingId)
                await deleteChunkFromOPFS(chunks[i].id)
            }
        }
    }, [recordingId])

    const reset = useCallback(() => {
        chunkIndexRef.current = 0
    }, [])

    return { processChunk, recoverFromOPFS, reset }
}