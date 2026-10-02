import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import postgres from "postgres";
import type { Stroke } from "@drawx/protocol";

export const boards = pgTable("boards", {
  id: text("id").primaryKey(),
  strokes: jsonb("strokes").$type<Stroke[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  ownerId: text("owner_id"),
  collab: boolean("collab").notNull().default(false),
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("neon.tech")) {
  throw new Error(
    "Set DATABASE_URL in apps/server/.env to your Neon connection string. The host should contain neon.tech.",
  );
}

const connectionUrl = new URL(databaseUrl);
connectionUrl.searchParams.delete("channel_binding");

const sql = postgres(connectionUrl.toString(), {
  ssl: "require",
  prepare: !connectionUrl.hostname.includes("-pooler"),
});
export const db = drizzle(sql);

export async function ensureBoardsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS boards (
      id text PRIMARY KEY,
      strokes jsonb NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      owner_id text,
      collab boolean DEFAULT false NOT NULL
    )
  `;
  await sql`ALTER TABLE boards ADD COLUMN IF NOT EXISTS owner_id text`;
  await sql`ALTER TABLE boards ADD COLUMN IF NOT EXISTS collab boolean DEFAULT false NOT NULL`;
}

export async function insertBoard(id: string, ownerId: string) {
  await db.insert(boards).values({ id, strokes: [], ownerId, collab: false });
}

export async function setOwner(id: string, ownerId: string) {
  await db.update(boards).set({ ownerId }).where(eq(boards.id, id));
}

export async function setCollab(id: string, collab: boolean) {
  await db.update(boards).set({ collab }).where(eq(boards.id, id));
}

export async function readBoard(id: string) {
  const rows = await db.select().from(boards).where(eq(boards.id, id));
  return rows[0] ?? null;
}

export async function writeStrokes(id: string, strokes: Stroke[]) {
  await db.update(boards).set({ strokes }).where(eq(boards.id, id));
}
