import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

type EmbeddingsRow = {
    post_id: string;
    post_hash: string;
    embedding: string;
};

const databases = new Map<string, Database.Database>();

export type PostEmbeddingCacheEntry = {
    hashedContent: string;
    row: EmbeddingsRow | undefined;
    vector: number[] | undefined;
};

/** Open the Astro project's persistent embedding database. */
export const getEmbeddingDatabase = (
    dbPath = resolve(process.cwd(), ".astro", "embeddings.db"),
): Database.Database => {
    const resolvedPath = resolve(dbPath);
    const existing = databases.get(resolvedPath);
    if (existing) return existing;

    const astroDir = dirname(resolvedPath);

    if (!existsSync(astroDir)) {
        mkdirSync(astroDir, { recursive: true });
    }

    const db = new Database(resolvedPath);
    initializeEmbeddingTable(db);
    databases.set(resolvedPath, db);
    return db;
};

export const closeEmbeddingDatabase = (
    dbPath = resolve(process.cwd(), ".astro", "embeddings.db"),
) => {
    const resolvedPath = resolve(dbPath);
    const db = databases.get(resolvedPath);
    if (db) {
        db.close();
        databases.delete(resolvedPath);
    }
};

export const initializeEmbeddingTable = (db: Database.Database) => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      post_id TEXT PRIMARY KEY,
      post_hash TEXT,
      embedding TEXT
    );
  `);
};

/** Look up an embedding and compare its stored content hash. */
export const getPostEmbeddingCacheEntry = (
    db: Database.Database,
    slug: string,
    content: string,
): PostEmbeddingCacheEntry => {
    const hash = createHash("sha256");
    hash.update(content);

    const hashedContent = hash.digest("hex");
    const row = db
        .prepare("SELECT * FROM embeddings WHERE post_id = ?")
        .get(slug) as EmbeddingsRow | undefined;

    return {
        hashedContent,
        row,
        vector:
            row && row.post_hash === hashedContent
                ? (JSON.parse(row.embedding) as number[])
                : undefined,
    };
};

/** Insert a new vector or replace the vector when its source text changed. */
export const savePostEmbedding = (
    db: Database.Database,
    slug: string,
    hashedContent: string,
    vector: number[],
    row: EmbeddingsRow | undefined,
) => {
    if (!row) {
        const insert = db.prepare(
            "INSERT INTO embeddings (post_id, post_hash, embedding) VALUES (?, ?, ?)",
        );
        insert.run(slug, hashedContent, JSON.stringify(vector));
    } else if (row.post_hash !== hashedContent) {
        const update = db.prepare(
            "UPDATE embeddings SET post_hash = ?, embedding = ? WHERE post_id = ?",
        );
        update.run(hashedContent, JSON.stringify(vector), slug);
    }
};
