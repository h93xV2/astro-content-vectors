import { log } from "../logging.js";
import type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "../types.js";
import {
    getEmbeddingDatabase,
    getPostEmbeddingCacheEntry,
    type PostEmbeddingCacheEntry,
    savePostEmbedding,
} from "./cache.js";
import {
    type ChunkPlan,
    contentText,
    documentParagraphs,
    flattenChunkPlan,
    prepareChunks,
} from "./chunking.js";
import {
    combineChunkVectors,
    requestChunkVectors,
    validateVectors,
} from "./vectors.js";

const embeddingCacheId = (
    id: string,
    provider: EmbeddingProviderConfig,
    namespace?: string,
    bodyFormat?: ContentDocument["bodyFormat"],
) =>
    JSON.stringify([
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

type PendingDocument = {
    index: number;
    id: string;
    text: string;
    paragraphs: ReturnType<typeof documentParagraphs>;
    cacheId: string;
    cacheEntry: PostEmbeddingCacheEntry | undefined;
};

const lookupCachedEmbeddings = (
    documents: ContentDocument[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
    database: ReturnType<typeof getEmbeddingDatabase> | undefined,
) => {
    const vectors: Array<number[] | undefined> = new Array(documents.length);
    const pending: PendingDocument[] = [];
    let hits = 0;
    documents.forEach((document, index) => {
        const text = contentText(document);
        const cacheId = embeddingCacheId(
            document.id,
            provider,
            config.cacheNamespace,
            document.bodyFormat,
        );
        const cacheEntry = database
            ? getPostEmbeddingCacheEntry(database, cacheId, text)
            : undefined;
        if (cacheEntry?.vector) {
            vectors[index] = cacheEntry.vector;
            hits++;
            return;
        }
        pending.push({
            index,
            id: document.id,
            text,
            paragraphs: documentParagraphs(document),
            cacheId,
            cacheEntry,
        });
    });
    return { vectors, pending, hits };
};

const logPreparation = (
    plan: ChunkPlan[],
    inputs: ReturnType<typeof flattenChunkPlan>,
    hits: number,
    cacheEnabled: boolean,
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
) => {
    const misses = plan.length;
    const splitEntries = plan.filter(({ chunks }) => chunks.length > 1).length;
    const cacheStatus = cacheEnabled
        ? `cache: ${hits} hit${hits === 1 ? "" : "s"}, ${misses} miss${misses === 1 ? "" : "es"}`
        : "cache disabled";
    const chunkStatus =
        misses === 0
            ? "chunking skipped because all vectors are cached"
            : provider.alwaysChunk
              ? `paragraph chunking enabled, ${inputs.length} input${inputs.length === 1 ? "" : "s"}`
              : splitEntries > 0
                ? `chunking split ${splitEntries} entr${splitEntries === 1 ? "y" : "ies"} into ${inputs.length} inputs`
                : `chunking not needed for ${misses} entr${misses === 1 ? "y" : "ies"}`;
    const batchSize = Math.max(1, provider.batchSize ?? 32);
    const batches = Math.ceil(inputs.length / batchSize);
    log(
        config,
        "info",
        misses === 0
            ? `Embedding preparation complete: ${cacheStatus}; ${chunkStatus}.`
            : `Preparing ${inputs.length} embedding inputs for ${misses} entries with ${provider.model} (${cacheStatus}; ${chunkStatus}; ${batches} batch${batches === 1 ? "" : "es"}).`,
    );
};

const saveCachedVectors = (
    database: ReturnType<typeof getEmbeddingDatabase> | undefined,
    plan: ChunkPlan[],
    vectors: Array<number[] | undefined>,
    config: ContentVectorsConfig,
) => {
    if (!database) return;
    let saved = 0;
    for (const document of plan) {
        const vector = vectors[document.index];
        if (!document.cacheEntry || !vector) continue;
        savePostEmbedding(
            database,
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
};

export const embedAll = async (
    documents: ContentDocument[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<number[][]> => {
    const database =
        config.cache === true
            ? getEmbeddingDatabase(config.cachePath)
            : undefined;
    const cache = lookupCachedEmbeddings(documents, provider, config, database);
    const plan = await prepareChunks(cache.pending, provider, config);
    const inputs = flattenChunkPlan(plan);
    logPreparation(
        plan,
        inputs,
        cache.hits,
        Boolean(database),
        provider,
        config,
    );

    const chunkVectors = await requestChunkVectors(inputs, provider, config);
    for (const document of plan) {
        const vector = combineChunkVectors(
            chunkVectors.get(document.index) ?? [],
            document.weights,
        );
        if (!vector) throw new Error("No embedding chunks were generated.");
        cache.vectors[document.index] = vector;
    }

    const completeVectors = validateVectors(cache.vectors);
    saveCachedVectors(database, plan, cache.vectors, config);
    return completeVectors;
};
