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
    /** Write all pairwise scores to `<outDir>/content-vector-similarities/`. */
    outputSimilarityScores?: boolean;
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

const VIRTUAL_ID = "virtual:astro-content-vectors";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const defineProvider = (
    name: "lmstudio" | "openai",
    configured: Partial<EmbeddingProviderConfig>,
) => {
    // API keys are resolved in the server runtime; never serialize secrets into
    // the generated virtual module.
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
    };
};

/**
 * Adds `virtual:astro-content-vectors` to an Astro site. It uses OpenAI when
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
                const environments = Object.fromEntries(
                    [...environmentNames].map((name) => [
                        name,
                        defineEnvironment(name, options),
                    ]),
                );

                updateConfig({
                    vite: {
                        plugins: [
                            {
                                name: "astro-content-vectors-virtual-module",
                                resolveId(id: string) {
                                    return id === VIRTUAL_ID
                                        ? RESOLVED_ID
                                        : null;
                                },
                                load(id: string) {
                                    if (id !== RESOLVED_ID) return null;
                                    return `
                    import { mkdir, writeFile } from "node:fs/promises";
                    import { join } from "node:path";
                    import { getCollection } from "astro:content";
                    import { getRelatedContent as buildRelatedContent } from "astro-content-vectors/runtime";
                    const environments = ${JSON.stringify(environments)};
                    const activeEnvironment = ${JSON.stringify(options.environment)} ?? import.meta.env.MODE ?? ${JSON.stringify(defaultEnvironment)};
                    const config = environments[activeEnvironment] ?? environments[${JSON.stringify(defaultEnvironment)}];
                    const outputSimilarityScores = ${JSON.stringify(options.outputSimilarityScores ?? false)};
                    const outputDirectory = ${JSON.stringify(fileURLToPath(new URL("content-vector-similarities/", config.outDir)))};
                    if (!config?.provider) throw new Error('astro-content-vectors has no providers configured for environment: ' + activeEnvironment);
                    let indexes = new Map();
                    export async function getRelatedContent(collection, id) {
                      if (config.collections && !config.collections.includes(collection)) {
                        throw new Error('Collection is not enabled in astro-content-vectors: ' + collection);
                      }
                      if (!indexes.has(collection)) {
                        const pending = getCollection(collection).then((entries) => {
                          const documents = entries.map((entry) => ({
                            id: entry.id,
                            title: entry.data.title,
                            description: entry.data.description,
                            body: entry.body ?? '',
                          }));
                          const reportConfig = outputSimilarityScores ? {
                            ...config,
                            onSimilarityScores: async (pairs) => {
                              await mkdir(outputDirectory, { recursive: true });
                              const file = join(outputDirectory, encodeURIComponent(collection) + '.json');
                              await writeFile(file, JSON.stringify({ collection, threshold: config.threshold ?? 0.65, pairs }, null, 2) + '\\n');
                            }
                          } : config;
                          return buildRelatedContent(documents.map(({ description, ...doc }) => ({ ...doc, text: description })), reportConfig);
                        });
                        indexes.set(collection, pending);
                        pending.catch(() => indexes.delete(collection));
                      }
                      const index = await indexes.get(collection);
                      return index.get(id) ?? [];
                    }
                  `;
                                },
                            },
                        ],
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
