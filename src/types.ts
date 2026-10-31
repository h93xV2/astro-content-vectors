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

export type RelatedContent = { id: string; score: number };
export type SimilarityScore = {
    sourceId: string;
    targetId: string;
    score: number;
};

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
