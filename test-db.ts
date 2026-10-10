import "dotenv/config";
import pg from "pg";

const { Client } = pg;

async function main() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error("DATABASE_URL is missing from .env");
    }

    const client = new Client({
        connectionString,
        connectionTimeoutMillis: 10000,
    });

    try {
        await client.connect();
        const result = await client.query(
            "SELECT current_database(), current_schema()"
        );
        console.log("Database connection successful:", result.rows);
    } catch (error) {
        console.error("Database connection failed:", error);
    } finally {
        await client.end().catch(() => {});
    }
}

main();