import OpenAI from "openai";

import type { ContentVectorsConfig, EmbeddingProviderConfig } from "./types.js";

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

export const usesOpenAI = (provider: EmbeddingProviderConfig) =>
    provider.providerName === "openai" ||
    provider.baseUrl.includes("api.openai.com");

export const providerApiKey = (provider: EmbeddingProviderConfig) => {
    if (provider.apiKey) return provider.apiKey;
    if (!usesOpenAI(provider)) return undefined;
    return environment().OPENAI_API_KEY;
};

export const requestEmbeddings = async (
    texts: string[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<number[][]> => {
    const apiKey = providerApiKey(provider);
    if (usesOpenAI(provider) && !apiKey) {
        throw new Error(
            "OPENAI_API_KEY is required when using the OpenAI embeddings provider.",
        );
    }
    const client = new OpenAI({
        apiKey: apiKey ?? "lm-studio",
        baseURL: provider.baseUrl,
        defaultHeaders: provider.headers,
        fetch: config.fetch,
        maxRetries: 0,
        timeout: 60_000,
    });
    let payload: Awaited<ReturnType<typeof client.embeddings.create>>;
    try {
        payload = await client.embeddings.create({
            model: provider.model,
            input: texts,
        });
    } catch (error) {
        if (
            error instanceof OpenAI.APIConnectionError &&
            error.cause instanceof Error
        ) {
            throw new Error(`${error.message}: ${error.cause.message}`, {
                cause: error,
            });
        }
        throw error;
    }
    if (payload.data.length !== texts.length) {
        throw new Error("Embedding provider returned an unexpected response.");
    }

    return [...payload.data]
        .sort((a, b) => a.index - b.index)
        .map(({ embedding }) => embedding);
};
