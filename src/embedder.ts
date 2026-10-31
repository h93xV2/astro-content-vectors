import {
    getEmbeddingDatabase,
    getPostEmbeddingCacheEntry,
    type PostEmbeddingCacheEntry,
    savePostEmbedding,
} from "./cache.js";
import { requestEmbeddings } from "./provider.js";
import type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "./types.js";

const contentText = (document: ContentDocument) =>
    [document.title, document.text, document.body].filter(Boolean).join("\n\n");

const embeddingCacheId = (
    id: string,
    provider: EmbeddingProviderConfig,
    namespace?: string,
) =>
    JSON.stringify([
        provider.providerName ?? provider.baseUrl,
        provider.baseUrl,
        provider.model,
        namespace ?? "",
        id,
    ]);

export const embedAll = async (
    documents: ContentDocument[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<number[][]> => {
    const texts = documents.map(contentText);
    const ids = documents.map(({ id }) => id);
    const batchSize = Math.max(1, provider.batchSize ?? 32);
    const database =
        config.cache === true
            ? getEmbeddingDatabase(config.cachePath)
            : undefined;
    const vectors: Array<number[] | undefined> = new Array(texts.length);
    const cacheEntries: Array<PostEmbeddingCacheEntry | undefined> = new Array(
        texts.length,
    );
    const missing: number[] = [];

    for (let index = 0; index < texts.length; index++) {
        const id = ids[index];
        const text = texts[index];
        if (id === undefined || text === undefined) {
            throw new Error("Content IDs and text must have matching lengths.");
        }
        const cacheId = embeddingCacheId(id, provider, config.cacheNamespace);
        const entry = database
            ? getPostEmbeddingCacheEntry(database, cacheId, text)
            : undefined;
        if (entry?.vector) {
            vectors[index] = entry.vector;
        } else {
            missing.push(index);
            cacheEntries[index] = entry;
        }
    }

    const updates: Array<{
        cacheId: string;
        vector: number[];
        entry: PostEmbeddingCacheEntry;
    }> = [];
    for (let start = 0; start < missing.length; start += batchSize) {
        const indices = missing.slice(start, start + batchSize);
        const batch = indices.map((index) => {
            const text = texts[index];
            if (text === undefined) {
                throw new Error("Missing content text for embedding.");
            }
            return text;
        });
        const batchVectors = await requestEmbeddings(batch, provider, config);
        indices.forEach((index, batchIndex) => {
            const vector = batchVectors[batchIndex];
            if (!vector) {
                throw new Error(
                    "Embedding provider returned fewer vectors than requested.",
                );
            }
            vectors[index] = vector;
            const entry = cacheEntries[index];
            if (database && entry) {
                const id = ids[index];
                if (id === undefined) {
                    throw new Error("Missing content ID for embedding.");
                }
                updates.push({
                    cacheId: embeddingCacheId(
                        id,
                        provider,
                        config.cacheNamespace,
                    ),
                    vector,
                    entry,
                });
            }
        });
    }

    const completeVectors = vectors.map((vector) => {
        if (!vector) {
            throw new Error(
                "Embedding provider returned fewer vectors than documents.",
            );
        }
        return vector;
    });
    const dimensions = completeVectors[0]?.length;
    if (
        completeVectors.some(
            (vector) => vector.length === 0 || vector.length !== dimensions,
        )
    ) {
        throw new Error(
            "Embedding provider returned vectors with incompatible dimensions.",
        );
    }
    if (database) {
        for (const { cacheId, vector, entry } of updates) {
            savePostEmbedding(
                database,
                cacheId,
                entry.hashedContent,
                vector,
                entry.row,
            );
        }
    }
    return completeVectors;
};
