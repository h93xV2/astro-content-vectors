import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import { SqliteDriver } from "../../src/embeddings/cache/drivers/sqlite.js";
import type { ContentVectorsConfig } from "../../src/types.js";

const makeDatabase = () => {
    const db = new Database(":memory:");
    return { db, driver: new SqliteDriver(db) };
};

const initialize = (driver: SqliteDriver) =>
    driver.initialize(
        {} as ContentVectorsConfig,
        `
        CREATE TABLE IF NOT EXISTS embeddings (
            post_id TEXT PRIMARY KEY,
            post_hash TEXT,
            embedding TEXT
        );
    `,
    );

describe("SQLite embedding cache", () => {
    test("creates the embeddings table", async () => {
        const { db, driver } = makeDatabase();
        try {
            await initialize(driver);
            const columns = db
                .prepare("PRAGMA table_info(embeddings)")
                .all() as Array<{ name: string }>;

            expect(columns.map(({ name }) => name)).toEqual([
                "post_id",
                "post_hash",
                "embedding",
            ]);
        } finally {
            db.close();
        }
    });

    test("inserts a vector and reads it back", async () => {
        const { db, driver } = makeDatabase();
        try {
            await initialize(driver);
            await driver.update(
                "INSERT INTO embeddings (post_id, post_hash, embedding) VALUES (?, ?, ?)",
                ["post-a", "hash-a", JSON.stringify([0.1, 0.2, 0.3])],
            );
            const cached = await driver.query(
                "SELECT * FROM embeddings WHERE post_id = ?",
                ["post-a"],
            );
            expect(cached).toEqual({
                post_id: "post-a",
                post_hash: "hash-a",
                embedding: "[0.1,0.2,0.3]",
            });
            expect(
                db.prepare("SELECT COUNT(*) as count FROM embeddings").get(),
            ).toEqual({ count: 1 });
        } finally {
            db.close();
        }
    });

    test("updates the stored hash and vector", async () => {
        const { db, driver } = makeDatabase();
        try {
            await initialize(driver);
            await driver.update(
                "INSERT INTO embeddings (post_id, post_hash, embedding) VALUES (?, ?, ?)",
                ["post-a", "old-hash", JSON.stringify([0.1, 0.2])],
            );
            await driver.update(
                "UPDATE embeddings SET post_hash = ?, embedding = ? WHERE post_id = ?",
                ["new-hash", JSON.stringify([0.8, 0.9]), "post-a"],
            );
            const refreshed = await driver.query(
                "SELECT * FROM embeddings WHERE post_id = ?",
                ["post-a"],
            );
            expect(refreshed?.post_hash).toBe("new-hash");
            expect(JSON.parse(refreshed?.embedding ?? "null")).toEqual([
                0.8, 0.9,
            ]);
            expect(
                db.prepare("SELECT COUNT(*) as count FROM embeddings").get(),
            ).toEqual({ count: 1 });
        } finally {
            db.close();
        }
    });
});
