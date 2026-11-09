import type Database from "better-sqlite3";
import type { ContentVectorsConfig } from "../../../types.ts";
import type { CacheDatabaseDriver } from "../cache.ts";
import type { EmbeddingsRow } from "../types.ts";

export class SqliteDriver implements CacheDatabaseDriver {
    constructor(private db: Database.Database) {}

    async initialize(
        _config: ContentVectorsConfig,
        sql: string,
    ): Promise<void> {
        this.db.exec(sql);
    }

    async query(
        sql: string,
        params: string[],
    ): Promise<EmbeddingsRow | undefined> {
        const query = this.db.prepare(sql);
        const result = query.get(...params);
        return result as EmbeddingsRow | undefined;
    }

    async update(sql: string, params: string[]): Promise<void> {
        const query = this.db.prepare(sql);
        query.run(...params);
    }
}
