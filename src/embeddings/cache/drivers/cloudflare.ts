import type Cloudflare from "cloudflare";
import { log } from "../../../logging.ts";
import type { ContentVectorsConfig } from "../../../types.ts";
import type { CacheDatabaseDriver } from "../cache.ts";
import type { EmbeddingsRow } from "../types.ts";

export class D1Driver implements CacheDatabaseDriver {
    constructor(
        private client: Cloudflare,
        private databaseId: string,
        private accountId: string,
    ) {}

    private async execute(sql: string, params?: string[]) {
        const response = await this.client.d1.database.query(this.databaseId, {
            account_id: this.accountId,
            sql,
            ...(params ? { params } : {}),
        });
        const result = response.result?.[0];

        if (!result?.success) {
            throw new Error(`D1 query failed: ${sql}`);
        }

        return result;
    }

    async initialize(config: ContentVectorsConfig, sql: string) {
        try {
            await this.execute(sql);
            log(config, "info", "D1 cache initialized");
        } catch (error) {
            const message =
                error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error);

            log(config, "error", `D1 initialization failed: ${message}`);
            throw error;
        }
    }

    async query(
        sql: string,
        params: string[],
    ): Promise<EmbeddingsRow | undefined> {
        const result = await this.execute(sql, params);
        return result.results?.[0] as EmbeddingsRow | undefined;
    }

    async update(sql: string, params: string[]): Promise<void> {
        await this.execute(sql, params);
    }
}
