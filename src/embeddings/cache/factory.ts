import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import Cloudflare from "cloudflare";
import type { ContentVectorsConfig } from "../../types.ts";
import { type CacheDatabaseDriver, EmbeddingCache } from "./cache.ts";
import { D1Driver } from "./drivers/cloudflare.ts";
import { SqliteDriver } from "./drivers/sqlite.ts";

const databases = new Map<string, Database.Database>();

const getSqliteDb = (
    dbPath = resolve(process.cwd(), ".astro", "embeddings.db"),
) => {
    const resolvedPath = resolve(dbPath);
    const existing = databases.get(resolvedPath);
    if (existing) return existing;

    const astroDir = dirname(resolvedPath);

    if (!existsSync(astroDir)) {
        mkdirSync(astroDir, { recursive: true });
    }

    const db = new Database(resolvedPath);
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

export default async (
    config: ContentVectorsConfig,
): Promise<EmbeddingCache> => {
    let driver: CacheDatabaseDriver;

    if (config.cacheDriver === "D1") {
        const apiTokenEnvVar =
            config.cloudflareApiTokenEnvVar ?? "CLOUDFLARE_API_TOKEN";
        const client = new Cloudflare({
            apiToken: process.env[apiTokenEnvVar],
        });
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;

        if (!accountId || !databaseId) {
            throw new Error(
                "Cloudflare D1 database ID or account ID are not configured",
            );
        }

        driver = new D1Driver(client, databaseId, accountId);
    } else {
        const db = getSqliteDb(config.cachePath);
        driver = new SqliteDriver(db);
    }

    await driver.initialize(
        config,
        `
        CREATE TABLE IF NOT EXISTS embeddings (
            post_id TEXT PRIMARY KEY,
            post_hash TEXT,
            embedding TEXT
        );
    `,
    );

    return new EmbeddingCache(driver);
};
