import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const recordings = pgTable("recordings", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  status: text("status", { enum: ["recording", "completed", "failed"] })
      .default("recording")
      .notNull(),
  detectedLanguage: text("detected_language"),
});

export const chunkAcks = pgTable("chunk_acks", {
  id: text("id").primaryKey(),
  recordingId: text("recording_id")
      .references(() => recordings.id)
      .notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  bucketKey: text("bucket_key").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  durationMs: integer("duration_ms").notNull(),
  transcript: text("transcript"),
  speakerData: text("speaker_data"),
  detectedLanguage: text("detected_language"),
  ackedAt: timestamp("acked_at").defaultNow().notNull(),
  reconciliationNeeded: boolean("reconciliation_needed").default(false).notNull(),
});