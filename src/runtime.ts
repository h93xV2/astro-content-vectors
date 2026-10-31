import {
    getEmbeddingDatabase,
    getPostEmbeddingCacheEntry,
    type PostEmbeddingCacheEntry,
    savePostEmbedding,
} from "./cache.js";
import {
    type Embedding,
    getCosineSimilarity,
    getPairWiseSimilarityScores,
    getSlugToMostRelatedPostsMap,
} from "./related-posts.js";

export type ContentDocument = {
    id: string;
    title?: string;
    body?: string;
    /** Optional extra text such as tags or a description. */
    text?: string;
};

export type EmbeddingProviderConfig = {
    /** Provider identifier set by the Astro integration. */
    providerName?: "openai" | "lmstudio";
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** Number of documents sent in one request. Defaults to 32. */
    batchSize?: number;
    headers?: Record<string, string>;
};

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export type ContentVectorsConfig = {
    provider: EmbeddingProviderConfig;
    /** Used if the primary provider cannot be reached or has no API key. */
    fallbackProvider?: EmbeddingProviderConfig;
    /** Throw if no configured provider can generate vectors. Defaults to false. */
    failOnError?: boolean;
    logLevel?: "silent" | "error" | "warn" | "info" | "debug";
    threshold?: number;
    limit?: number;
    /** Persist vectors in SQLite. Direct runtime use defaults to false. */
    cache?: boolean;
    /** SQLite database file. Relative paths resolve from the Astro project root. */
    cachePath?: string;
    /** Prevent ID collisions between independently processed collections. */
    cacheNamespace?: string;
    /** Inject fetch in tests or non-standard runtimes. */
    fetch?: FetchLike;
    onSimilarityScores?: (scores: SimilarityScore[]) => void | Promise<void>;
    logger?: (
        level: "error" | "warn" | "info" | "debug",
        message: string,
    ) => void;
};

export type RelatedContent = { id: string; score: number };
export type SimilarityScore = {
    sourceId: string;
    targetId: string;
    score: number;
};

const environment = () => {
    const vite = (
        import.meta as ImportMeta & { env?: Record<string, string | undefined> }
    ).env;
    const node = (
        globalThis as typeof globalThis & {
            process?: { env?: Record<string, string | undefined> };
        }
    ).process?.env;
    return { ...node, ...vite };
};

const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
const defaultLogger: NonNullable<ContentVectorsConfig["logger"]> = (
    level,
    message,
) => {
    const method = level === "debug" ? "log" : level;
    console[method](`[astro-content-vectors] ${message}`);
};

const log = (
    config: ContentVectorsConfig,
    level: "error" | "warn" | "info" | "debug",
    message: string,
) => {
    if (levels[config.logLevel ?? "warn"] >= levels[level]) {
        (config.logger ?? defaultLogger)(level, message);
    }
};

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

const usesOpenAI = (provider: EmbeddingProviderConfig) =>
    provider.providerName === "openai" ||
    provider.baseUrl.includes("api.openai.com");

const providerApiKey = (provider: EmbeddingProviderConfig) => {
    if (provider.apiKey) return provider.apiKey;
    if (!usesOpenAI(provider)) return undefined;
    return environment().OPENAI_API_KEY;
};

const requestEmbeddings = async (
    texts: string[],
    config: ContentVectorsConfig,
): Promise<number[][]> => {
    const { provider } = config;
    const requestFetch = config.fetch ?? fetch;
    const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/embeddings`;
    const apiKey = providerApiKey(provider);
    if (usesOpenAI(provider) && !apiKey) {
        throw new Error(
            "OPENAI_API_KEY is required when using the OpenAI embeddings provider.",
        );
    }
    const response = await requestFetch(endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...provider.headers,
        },
        body: JSON.stringify({ model: provider.model, input: texts }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
            `Embedding request failed (${response.status}): ${detail || response.statusText}`,
        );
    }

    const payload = (await response.json()) as {
        data?: Array<{ index: number; embedding: number[] }>;
        error?: { message?: string };
    };
    if (!payload.data || payload.data.length !== texts.length) {
        throw new Error(
            payload.error?.message ??
                "Embedding provider returned an unexpected response.",
        );
    }

    return [...payload.data]
        .sort((a, b) => a.index - b.index)
        .map(({ embedding }) => embedding);
};

const embedAll = async (
    texts: string[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
    ids: string[],
): Promise<number[][]> => {
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
        index: number;
        cacheId: string;
        vector: number[];
        entry: PostEmbeddingCacheEntry;
    }> = [];
    for (let start = 0; start < missing.length; start += batchSize) {
        const indices = missing.slice(start, start + batchSize);
        const batch = indices.map((index) => texts[index]!);
        const batchVectors = await requestEmbeddings(batch, {
            ...config,
            provider,
        });
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
                const id = ids[index]!;
                updates.push({
                    index,
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
        log(
            config,
            "debug",
            `Embedded ${Math.min(start + indices.length, missing.length)} of ${missing.length} uncached entries with ${provider.model}.`,
        );
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

    const texts = documents.map(contentText);
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
            vectors = await embedAll(
                texts,
                primaryProvider,
                config,
                documents.map(({ id }) => id),
            );
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
                texts,
                config.fallbackProvider,
                config,
                documents.map(({ id }) => id),
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
                scores.push({
                    sourceId: embeddings[i]!.slug,
                    targetId: embeddings[j]!.slug,
                    score: getCosineSimilarity(
                        embeddings[i]!.vector,
                        embeddings[j]!.vector,
                    ),
                });
            }
        }
        await config.onSimilarityScores(scores);
    }
    const rankedBySlug = getSlugToMostRelatedPostsMap(embeddings, {
        threshold: config.threshold,
        limit: Math.max(0, config.limit ?? 3),
    });
    const limit = Math.max(0, config.limit ?? 3);
    const related = new Map<string, RelatedContent[]>();
    for (const document of documents) {
        const ranked = rankedBySlug.get(document.id) ?? [];
        related.set(
            document.id,
            ranked
                .slice(0, limit)
                .map(({ slug, score }) => ({ id: slug, score })),
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
export {
    getCosineSimilarity as cosineSimilarity,
    getPairWiseSimilarityScores,
    getSlugToMostRelatedPostsMap,
};
