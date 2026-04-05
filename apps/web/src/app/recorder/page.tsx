"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CheckCircle, Loader2, Mic, Pause, Play, Square, AlertCircle } from "lucide-react"
import { Button } from "@my-better-t-app/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { useRecorder } from "@/hooks/use-recorder"
import { useChunkUploader, type ChunkUploadResult } from "@/hooks/use-chunk-uploader"

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000"

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`
}

export default function RecorderPage() {
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [chunkResults, setChunkResults] = useState<ChunkUploadResult[]>([])
  const [fullTranscript, setFullTranscript] = useState<string>("")
  const [isFetchingTranscript, setIsFetchingTranscript] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<any>(null)
  const processedChunkIds = useRef<Set<string>>(new Set())

  const handleChunkResult = useCallback((result: ChunkUploadResult) => {
    setChunkResults(prev => {
      const existing = prev.findIndex(r => r.chunkId === result.chunkId)
      if (existing >= 0) {
        const updated = [...prev]
        updated[existing] = result
        return updated
      }
      return [...prev, result]
    })
  }, [])

  const { processChunk, reset: resetUploader } = useChunkUploader({
    recordingId,
    onChunkResult: handleChunkResult,
  })

  const { status, start, stop, pause, resume, chunks, elapsed, stream } =
      useRecorder({ chunkDuration: 5 })

  // Process new chunks as they arrive from recorder
  useEffect(() => {
    for (const chunk of chunks) {
      if (!processedChunkIds.current.has(chunk.id)) {
        processedChunkIds.current.add(chunk.id)
        processChunk(chunk)
      }
    }
  }, [chunks, processChunk])

  const startRecording = useCallback(async () => {
    const res = await fetch(`${SERVER_URL}/api/recordings`, { method: "POST" })
    const data = await res.json() as { recordingId: string }
    setRecordingId(data.recordingId)
    setChunkResults([])
    setFullTranscript("")
    setReconcileResult(null)
    processedChunkIds.current = new Set()
    resetUploader()
    start()
  }, [start, resetUploader])

  const stopRecording = useCallback(async () => {
    stop()
    if (recordingId) {
      await fetch(`${SERVER_URL}/api/recordings/${recordingId}/complete`, { method: "PUT" })
    }
  }, [stop, recordingId])

  const fetchTranscript = useCallback(async () => {
    if (!recordingId) return
    setIsFetchingTranscript(true)
    setFullTranscript("")
    try {
      const res = await fetch(`${SERVER_URL}/api/recordings/${recordingId}/transcript`)
      const data = await res.json() as any
      if (!res.ok) {
        setFullTranscript(`Error: ${data.error ?? "Failed to fetch transcript"}`)
        return
      }
      setFullTranscript(data.speakerTranscript ?? data.plainTranscript ?? "No transcript available")
    } catch {
      setFullTranscript("Failed to connect to server")
    } finally {
      setIsFetchingTranscript(false)
    }
  }, [recordingId])

  const runReconcile = useCallback(async () => {
    if (!recordingId) return
    const res = await fetch(`${SERVER_URL}/api/recordings/${recordingId}/reconcile`, { method: "POST" })
    const data = await res.json()
    setReconcileResult(data)
  }, [recordingId])

  const isRecording = status === "recording"
  const isPaused = status === "paused"
  const isActive = isRecording || isPaused
  const uploadedCount = chunkResults.filter(r => r.status === "uploaded").length
  const uploadingCount = chunkResults.filter(r => r.status === "uploading").length
  const failedCount = chunkResults.filter(r => r.status === "failed").length

  return (
      <div className="container mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">

        {/* Recorder */}
        <Card>
          <CardHeader>
            <CardTitle>Meeting Recorder</CardTitle>
            <CardDescription>
              Records in 5s chunks · Saved to OPFS → bucket → DB · Transcribed after recording stops
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20">
              <LiveWaveform
                  active={isRecording}
                  processing={isPaused}
                  stream={stream}
                  height={80}
                  barWidth={3}
                  barGap={1}
                  barRadius={2}
                  sensitivity={1.8}
                  smoothingTimeConstant={0.85}
                  fadeEdges
                  fadeWidth={32}
                  mode="static"
              />
            </div>

            <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
              {formatTime(elapsed)}
            </div>

            {recordingId && (
                <p className="text-center text-xs text-muted-foreground font-mono">
                  Session: {recordingId.slice(0, 8)}…
                </p>
            )}

            {/* Chunk status summary — during recording */}
            {chunkResults.length > 0 && (
                <div className="text-center text-sm text-muted-foreground">
                  {uploadedCount} chunks saved
                  {uploadingCount > 0 && ` · ${uploadingCount} uploading`}
                  {failedCount > 0 && ` · ${failedCount} failed (kept in OPFS)`}
                </div>
            )}

            <div className="flex items-center justify-center gap-3 flex-wrap">
              <Button
                  size="lg"
                  variant={isActive ? "destructive" : "default"}
                  className="gap-2 px-5"
                  onClick={isActive ? stopRecording : startRecording}
                  disabled={status === "requesting"}
              >
                {isActive
                    ? <><Square className="size-4" /> Stop</>
                    : <><Mic className="size-4" /> Record</>}
              </Button>

              {isActive && (
                  <Button size="lg" variant="outline" className="gap-2" onClick={isPaused ? resume : pause}>
                    {isPaused
                        ? <><Play className="size-4" /> Resume</>
                        : <><Pause className="size-4" /> Pause</>}
                  </Button>
              )}

              {!isActive && recordingId && (
                  <>
                    <Button
                        size="lg"
                        variant="outline"
                        onClick={fetchTranscript}
                        disabled={isFetchingTranscript || uploadingCount > 0}
                        title={uploadingCount > 0 ? "Waiting for chunks to finish uploading…" : undefined}
                    >
                      {isFetchingTranscript
                          ? <><Loader2 className="size-4 animate-spin" /> Transcribing…</>
                          : uploadingCount > 0
                              ? <><Loader2 className="size-4 animate-spin" /> Uploading {uploadingCount} chunks…</>
                              : "Get Transcript"}
                    </Button>
                    <Button
                        size="lg"
                        variant="outline"
                        onClick={runReconcile}
                        disabled={uploadingCount > 0}
                    >
                      Reconcile
                    </Button>
                  </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Chunk upload status — simple list, no transcripts */}
        {chunkResults.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Chunk Upload Status</CardTitle>
                <CardDescription>
                  {uploadedCount} of {chunkResults.length} chunks saved to server
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {chunkResults
                    .sort((a, b) => a.chunkIndex - b.chunkIndex)
                    .map(r => (
                        <div
                            key={r.chunkId}
                            className="flex items-center gap-3 rounded border border-border/50 bg-muted/20 px-3 py-2 text-sm"
                        >
                          {r.status === "uploading" && <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />}
                          {r.status === "uploaded" && <CheckCircle className="size-4 text-green-500 shrink-0" />}
                          {r.status === "failed" && <AlertCircle className="size-4 text-destructive shrink-0" />}
                          <span className="font-mono text-xs text-muted-foreground">
                    Chunk #{r.chunkIndex + 1} — {r.status}
                  </span>
                        </div>
                    ))}
              </CardContent>
            </Card>
        )}

        {/* Full transcript — shown after "Get Transcript" */}
        {fullTranscript && (
            <Card>
              <CardHeader>
                <CardTitle>Meeting Transcript</CardTitle>
                <CardDescription>Speaker-labeled · Full recording transcribed at once</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">{fullTranscript}</pre>
              </CardContent>
            </Card>
        )}

        {/* Reconciliation result */}
        {reconcileResult && (
            <Card>
              <CardHeader>
                <CardTitle>Reconciliation Report</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm space-y-1">
                  <p>Total checked: <strong>{reconcileResult.totalChecked}</strong></p>
                  <p>Healthy: <strong className="text-green-500">{reconcileResult.healthy}</strong></p>
                  <p>Missing from bucket: <strong className={reconcileResult.missing > 0 ? "text-destructive" : "text-green-500"}>{reconcileResult.missing}</strong></p>
                  <p>Consistent: <strong>{reconcileResult.consistent ? "✅ Yes" : "❌ No — re-upload from OPFS needed"}</strong></p>
                </div>
              </CardContent>
            </Card>
        )}
      </div>
  )
}