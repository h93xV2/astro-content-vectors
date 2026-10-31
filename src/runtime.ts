import { embedAll } from "./embedder.js";
import { log } from "./logging.js";
import { providerApiKey, usesOpenAI } from "./provider.js";
import {
    type Embedding,
    getCosineSimilarity,
    getPairWiseSimilarityScores,
    getSlugToMostRelatedPostsMap,
} from "./related-posts.js";
import type {
    ContentDocument,
    ContentVectorsConfig,
    RelatedContent,
    SimilarityScore,
} from "./types.js";

/** Generate vectors and return ranked recommendations for every document. */
export async function getRelatedContent(
    documents: ContentDocument[],
    config: ContentVectorsConfig,
): Promise<Map<string, RelatedContent[]>> {
    const ids = new Set<string>();
    for (const document of documents) {
        if (ids.has(document.id))
            throw new Error(`Duplicate content id: ${document.id}`);
        ids.add(document.id);
    }

    let vectors: number[][] | undefined;
    let primaryError: unknown;
    const primaryApiKey = providerApiKey(config.provider);
    const primaryHasKey =
        !usesOpenAI(config.provider) || Boolean(primaryApiKey);

    if (!primaryHasKey) {
        log(
            config,
            "info",
            "OPENAI_API_KEY is not set; using the local fallback provider.",
        );
        primaryError = new Error(
            "OPENAI_API_KEY is required when using the OpenAI embeddings provider.",
        );
        if (!config.fallbackProvider) log(config, "warn", String(primaryError));
    } else {
        log(
            config,
            "info",
            `Generating embeddings for ${documents.length} content entries with ${config.provider.model}.`,
        );
        try {
            const primaryProvider = primaryApiKey
                ? { ...config.provider, apiKey: primaryApiKey }
                : config.provider;
            vectors = await embedAll(documents, primaryProvider, config);
        } catch (error) {
            primaryError = error;
            if (config.fallbackProvider) {
                log(
                    config,
                    "warn",
                    `Primary embedding provider failed; trying the fallback provider. ${error instanceof Error ? error.message : String(error)}`,
                );
            } else {
                log(
                    config,
                    "warn",
                    `Embedding provider failed. ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    if (!vectors && config.fallbackProvider) {
        log(
            config,
            "info",
            `Generating embeddings with fallback model ${config.fallbackProvider.model}.`,
        );
        try {
            vectors = await embedAll(
                documents,
                config.fallbackProvider,
                config,
            );
        } catch (fallbackError) {
            const message = `Fallback embedding provider failed. ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
            log(config, "warn", message);
            if (config.failOnError) {
                throw new AggregateError(
                    [primaryError, fallbackError],
                    message,
                );
            }
        }
    }

    if (!vectors) {
        const message =
            "No embedding provider could generate vectors; returning an empty related-content index.";
        log(config, "warn", message);
        if (config.failOnError) {
            throw primaryError instanceof Error
                ? primaryError
                : new Error(message);
        }
        return new Map(documents.map(({ id }) => [id, []]));
    }

    const embeddings: Embedding[] = documents.map((document, index) => {
        const vector = vectors[index];
        if (!vector) {
            throw new Error(
                "Embedding provider returned fewer vectors than documents.",
            );
        }
        return { slug: document.id, vector };
    });
    if (config.onSimilarityScores) {
        const scores: SimilarityScore[] = [];
        for (let i = 0; i < embeddings.length; i++) {
            for (let j = i + 1; j < embeddings.length; j++) {
                const source = embeddings[i];
                const target = embeddings[j];
                if (!source || !target) continue;
                scores.push({
                    sourceId: source.slug,
                    targetId: target.slug,
                    score: getCosineSimilarity(source.vector, target.vector),
                });
            }
        }
        await config.onSimilarityScores(scores);
    }
    const limit = Math.max(0, config.limit ?? 3);
    const rankedBySlug = getSlugToMostRelatedPostsMap(embeddings, {
        threshold: config.threshold,
        limit,
    });
    const related = new Map<string, RelatedContent[]>();
    for (const document of documents) {
        const ranked = rankedBySlug.get(document.id) ?? [];
        related.set(
            document.id,
            ranked.slice(0, limit).map(({ slug, score }) => ({
                id: slug,
                score,
            })),
        );
    }

    log(
        config,
        "info",
        `Built recommendations for ${documents.length} entries.`,
    );
    return related;
}

export type { Embedding, ScoredPost } from "./related-posts.js";
export type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
    FetchLike,
    RelatedContent,
    SimilarityScore,
} from "./types.js";
export {
    getCosineSimilarity as cosineSimilarity,
    getPairWiseSimilarityScores,
    getSlugToMostRelatedPostsMap,
};
