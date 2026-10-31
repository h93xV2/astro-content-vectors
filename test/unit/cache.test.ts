import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";

import {
    getPostEmbeddingCacheEntry,
    initializeEmbeddingTable,
    savePostEmbedding,
} from "../../src/cache.js";

const makeDatabase = () => {
    const db = new Database(":memory:");
    initializeEmbeddingTable(db);
    return db;
};

describe("SQLite embedding cache", () => {
    test("creates the source-compatible embeddings table", () => {
        const db = makeDatabase();
        try {
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

    test("inserts a vector and returns it when the source text is unchanged", () => {
        const db = makeDatabase();
        try {
            const first = getPostEmbeddingCacheEntry(
                db,
                "post-a",
                "article text",
            );
            expect(first.row).toBeUndefined();
            expect(first.vector).toBeUndefined();

            savePostEmbedding(
                db,
                "post-a",
                first.hashedContent,
                [0.1, 0.2, 0.3],
                first.row,
            );

            const cached = getPostEmbeddingCacheEntry(
                db,
                "post-a",
                "article text",
            );
            expect(cached.vector).toEqual([0.1, 0.2, 0.3]);
            expect(cached.row?.post_hash).toBe(first.hashedContent);
            expect(
                db.prepare("SELECT COUNT(*) as count FROM embeddings").get(),
            ).toEqual({ count: 1 });
        } finally {
            db.close();
        }
    });

    test("updates the stored hash and vector when the source text changes", () => {
        const db = makeDatabase();
        try {
            const original = getPostEmbeddingCacheEntry(
                db,
                "post-a",
                "old article text",
            );
            savePostEmbedding(
                db,
                "post-a",
                original.hashedContent,
                [0.1, 0.2],
                original.row,
            );

            const changed = getPostEmbeddingCacheEntry(
                db,
                "post-a",
                "new article text",
            );
            expect(changed.vector).toBeUndefined();
            expect(changed.hashedContent).not.toBe(original.hashedContent);

            savePostEmbedding(
                db,
                "post-a",
                changed.hashedContent,
                [0.8, 0.9],
                changed.row,
            );

            const refreshed = getPostEmbeddingCacheEntry(
                db,
                "post-a",
                "new article text",
            );
            expect(refreshed.vector).toEqual([0.8, 0.9]);
            expect(refreshed.row?.post_hash).toBe(changed.hashedContent);
            expect(
                db.prepare("SELECT COUNT(*) as count FROM embeddings").get(),
            ).toEqual({ count: 1 });
        } finally {
            db.close();
        }
    });
});
