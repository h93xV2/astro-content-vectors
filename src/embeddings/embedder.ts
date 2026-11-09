import { log } from "../logging.ts";
import type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "../types.ts";
import cacheFactory from "./cache/factory.ts";
import {
    type ChunkPlan,
    flattenChunkPlan,
    makePendingDocuments,
    prepareChunks,
} from "./chunking.ts";
import {
    combineChunkVectors,
    requestChunkVectors,
    validateVectors,
} from "./vectors.ts";

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

export const embedAll = async (
    documents: ContentDocument[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<number[][]> => {
    const cache = config.cache ? await cacheFactory(config) : undefined;
    const cached = cache
        ? await cache.lookupCachedEmbeddings(documents, provider, config)
        : undefined;

    const vectors =
        cached?.vectors ?? new Array<number[] | undefined>(documents.length);
    const pending = cached?.pending ?? makePendingDocuments(documents);
    const plan = await prepareChunks(pending, provider, config);
    const inputs = flattenChunkPlan(plan);

    const hits = cached ? cached.hits : 0;
    logPreparation(plan, inputs, hits, Boolean(cache), provider, config);

    if (inputs.length > 0) {
        const chunkVectors = await requestChunkVectors(
            inputs,
            provider,
            config,
        );
        for (const document of plan) {
            const vector = combineChunkVectors(
                chunkVectors.get(document.index) ?? [],
                document.weights,
            );
            if (!vector) throw new Error("No embedding chunks were generated.");
            vectors[document.index] = vector;
        }
    }

    const completeVectors = validateVectors(vectors);
    if (cache) {
        await cache.saveCachedVectors(plan, vectors, config);
    }
    return completeVectors;
};
