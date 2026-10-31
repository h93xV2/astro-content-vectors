import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

import type { EmbeddingProviderConfig } from "./runtime.js";

export type AstroContentVectorsOptions = {
    /** Optional collection allowlist. Calls for other collections return no results. */
    collections?: string[];
    /** Default provider configuration, used unless an environment overrides it. */
    provider?: ProviderSelection;
    /** Select a custom environment key. Defaults to Astro's dev/build command. */
    environment?: string;
    environments?: Record<string, { provider?: ProviderOverride }>;
    /** LM Studio fallback used when an OpenAI provider has no key or fails. */
    fallback?: false | ProviderOverride;
    threshold?: number;
    limit?: number;
    logLevel?: "silent" | "error" | "warn" | "info" | "debug";
    /** Throw when both OpenAI and the local fallback fail. Defaults to false. */
    failOnError?: boolean;
    /** Write all pairwise scores to `.astro/content-vector-similarities/`. */
    outputSimilarityScores?: boolean;
    /** Persist generated vectors in SQLite. Defaults to true. */
    cache?: boolean;
    /** SQLite file path, relative to the Astro project root. */
    cachePath?: string;
};

export type ProviderSelection = {
    type: "lmstudio" | "openai";
    baseUrl?: string;
    model?: string;
    batchSize?: number;
    headers?: Record<string, string>;
    apiKey?: string;
};

export type ProviderOverride = Partial<ProviderSelection>;

const VECTORS_CONFIG_DEFINE = "__ASTRO_CONTENT_VECTORS_CONFIG__";

const defineProvider = (
    name: "lmstudio" | "openai",
    configured: Partial<EmbeddingProviderConfig>,
) => {
    // API keys are resolved in the server runtime; never serialize secrets into
    // the settings injected into Astro's Vite build.
    const { apiKey: _apiKey, headers: _headers, ...safeOptions } = configured;
    if (name === "lmstudio") {
        return {
            ...safeOptions,
            providerName: name,
            baseUrl: safeOptions.baseUrl ?? "http://127.0.0.1:1234/v1",
            model: safeOptions.model ?? "text-embedding-nomic-embed-text-v1.5",
        };
    }
    return {
        ...safeOptions,
        providerName: name,
        baseUrl: safeOptions.baseUrl ?? "https://api.openai.com/v1",
        model: safeOptions.model ?? "text-embedding-3-small",
    };
};

const defineEnvironment = (
    name: string,
    options: AstroContentVectorsOptions,
    projectRoot: string,
) => {
    const selected = {
        type: "openai" as const,
        ...options.provider,
        ...options.environments?.[name]?.provider,
    };
    const { type: providerName, ...providerOptions } = selected;
    const primaryProvider = defineProvider(providerName, providerOptions);
    const fallbackProvider =
        providerName === "openai" && options.fallback !== false
            ? defineProvider("lmstudio", options.fallback ?? {})
            : undefined;

    return {
        provider: primaryProvider,
        fallbackProvider,
        threshold: options.threshold,
        limit: options.limit,
        logLevel: options.logLevel,
        failOnError: options.failOnError ?? false,
        collections: options.collections ?? null,
        cache: options.cache ?? true,
        cachePath: resolve(
            projectRoot,
            options.cachePath ?? ".astro/embeddings.db",
        ),
    };
};

/**
 * Adds the Astro content-vector helper to a site. It uses OpenAI when
 * OPENAI_API_KEY is available and falls back to the local LM Studio endpoint.
 */
export default function astroContentVectors(
    options: AstroContentVectorsOptions = {},
): AstroIntegration {
    return {
        name: "astro-content-vectors",
        hooks: {
            "astro:config:setup": ({ command, updateConfig, config }) => {
                const defaultEnvironment =
                    command === "dev" ? "development" : "production";
                const environmentNames = new Set([
                    "development",
                    "production",
                    ...Object.keys(options.environments ?? {}),
                    ...(options.environment ? [options.environment] : []),
                ]);
                const projectRoot = fileURLToPath(config.root);
                const environments = Object.fromEntries(
                    [...environmentNames].map((name) => [
                        name,
                        defineEnvironment(name, options, projectRoot),
                    ]),
                );

                const runtimeConfig = {
                    environments,
                    environment: options.environment,
                    defaultEnvironment,
                    outputSimilarityScores:
                        options.outputSimilarityScores ?? false,
                    outputDirectory: resolve(
                        projectRoot,
                        ".astro",
                        "content-vector-similarities",
                    ),
                };

                updateConfig({
                    vite: {
                        define: {
                            [VECTORS_CONFIG_DEFINE]:
                                JSON.stringify(runtimeConfig),
                        },
                    },
                });
            },
        },
    };
}

export type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
    RelatedContent,
    SimilarityScore,
} from "./runtime.js";

export {
    cosineSimilarity,
    getPairWiseSimilarityScores,
    getSlugToMostRelatedPostsMap,
} from "./runtime.js";
