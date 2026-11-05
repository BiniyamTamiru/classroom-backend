import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  throw new Error("DATABASE_URL is not defined");
}

const mask = (url: string) => url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");

console.log("[db] DATABASE_URL loaded:", mask(raw));

export const sql = neon(raw);
export const db = drizzle(sql);

export async function dbHealthCheck() {
  try {
    const result = await sql`SELECT 1 as ok`;
    console.log("[db] connectivity OK:", result);

    return true;
  } catch (error) {
    console.error(
        "[db] connectivity failed:",
        error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}