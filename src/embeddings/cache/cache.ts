import { createHash } from "node:crypto";
import { log } from "../../logging.ts";
import type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "../../types.ts";
import {
    type ChunkPlan,
    contentText,
    documentParagraphs,
} from "../chunking.ts";

type EmbeddingsRow = {
    post_id: string;
    post_hash: string;
    embedding: string;
};

export type PostEmbeddingCacheEntry = {
    hashedContent: string;
    row: EmbeddingsRow | undefined;
    vector: number[] | undefined;
};

type PendingDocument = {
    index: number;
    id: string;
    text: string;
    paragraphs: ReturnType<typeof documentParagraphs>;
    cacheId: string;
    cacheEntry: PostEmbeddingCacheEntry | undefined;
};

export interface CacheDatabaseDriver {
    initialize(config: ContentVectorsConfig, sql: string): Promise<void>;

    query(sql: string, params: string[]): Promise<EmbeddingsRow | undefined>;

    update(sql: string, params: string[]): Promise<void>;
}

export class EmbeddingCache {
    constructor(private database: CacheDatabaseDriver) {}

    public async lookupCachedEmbeddings(
        documents: ContentDocument[],
        provider: EmbeddingProviderConfig,
        config: ContentVectorsConfig,
    ) {
        const vectors: Array<number[] | undefined> = new Array(
            documents.length,
        );
        const pending: PendingDocument[] = [];
        let hits = 0;
        for (let index = 0; index < documents.length; index++) {
            const document = documents[index];
            if (!document) continue;
            const { cacheId, cacheEntry, text } =
                await this.getEmbeddingMetaData(document, provider, config);
            if (cacheEntry?.vector) {
                vectors[index] = cacheEntry.vector;
                hits++;
                continue;
            }
            pending.push({
                index,
                id: document.id,
                text,
                paragraphs: documentParagraphs(document),
                cacheId,
                cacheEntry,
            });
        }
        return { vectors, pending, hits };
    }

    private async getEmbeddingMetaData(
        document: ContentDocument,
        provider: EmbeddingProviderConfig,
        config: ContentVectorsConfig,
    ) {
        const text = contentText(document);
        const cacheId = this.embeddingCacheId(
            document.id,
            provider,
            config.cacheNamespace,
            document.bodyFormat,
        );
        const cacheEntry = await this.getPostEmbeddingCacheEntry(cacheId, text);
        return { cacheId, cacheEntry, text };
    }

    private async getPostEmbeddingCacheEntry(cacheId: string, text: string) {
        const hash = createHash("sha256");
        hash.update(text);

        const hashedContent = hash.digest("hex");
        const row = await this.database.query(
            "SELECT * FROM embeddings WHERE post_id = ?",
            [cacheId],
        );

        return {
            hashedContent,
            row,
            vector:
                row && row.post_hash === hashedContent
                    ? (JSON.parse(row.embedding) as number[])
                    : undefined,
        };
    }

    private embeddingCacheId(
        id: string,
        provider: EmbeddingProviderConfig,
        namespace?: string,
        bodyFormat?: ContentDocument["bodyFormat"],
    ) {
        return JSON.stringify([
            provider.providerName ?? provider.baseUrl,
            provider.baseUrl,
            provider.model,
            provider.chunkTokens ?? 2000,
            provider.alwaysChunk ?? false,
            provider.tokenizer ?? "model-default",
            bodyFormat ?? "text",
            namespace ?? "",
            id,
        ]);
    }

    public async saveCachedVectors(
        plan: ChunkPlan[],
        vectors: Array<number[] | undefined>,
        config: ContentVectorsConfig,
    ) {
        let saved = 0;
        for (const document of plan) {
            const vector = vectors[document.index];
            if (!document.cacheEntry || !vector) continue;
            await this.savePostEmbedding(
                document.cacheId,
                document.cacheEntry.hashedContent,
                vector,
                document.cacheEntry.row,
            );
            saved++;
        }
        if (saved > 0)
            log(
                config,
                "debug",
                `Saved ${saved} new vector${saved === 1 ? "" : "s"} to the embedding cache.`,
            );
    }

    private async savePostEmbedding(
        slug: string,
        hashedContent: string,
        vector: number[],
        row: EmbeddingsRow | undefined,
    ) {
        if (!row) {
            await this.database.update(
                "INSERT INTO embeddings (post_id, post_hash, embedding) VALUES (?, ?, ?)",
                [slug, hashedContent, JSON.stringify(vector)],
            );
        } else if (row.post_hash !== hashedContent) {
            await this.database.update(
                "UPDATE embeddings SET post_hash = ?, embedding = ? WHERE post_id = ?",
                [hashedContent, JSON.stringify(vector), slug],
            );
        }
    }
}
