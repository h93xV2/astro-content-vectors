import { getEncoding, type TiktokenEncoding } from "js-tiktoken";
import type { EmbeddingProviderConfig } from "../types.ts";
import { usesOpenAI } from "./provider.ts";

export type Tokenizer = {
    count: (texts: string[]) => Promise<number[]>;
    close: () => Promise<void>;
};

const openAITokenizers = new Map<
    TiktokenEncoding,
    ReturnType<typeof getEncoding>
>();

export const createTokenizer = async (
    provider: EmbeddingProviderConfig,
): Promise<Tokenizer> => {
    if (usesOpenAI(provider)) {
        const encodingName = provider.tokenizer ?? "cl100k_base";
        let encoding = openAITokenizers.get(encodingName);
        if (!encoding) {
            encoding = getEncoding(encodingName);
            openAITokenizers.set(encodingName, encoding);
        }
        return {
            count: async (texts) =>
                texts.map((text) => encoding.encode(text, [], []).length),
            close: async () => {},
        };
    }

    const { LMStudioClient } = await import("@lmstudio/sdk");
    const serverUrl = new URL(provider.baseUrl);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    serverUrl.pathname = "";
    serverUrl.search = "";
    serverUrl.hash = "";
    const authHeader = provider.headers
        ? new Headers(provider.headers).get("authorization")
        : null;
    const headerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    const client = new LMStudioClient({
        baseUrl: serverUrl.toString().replace(/\/$/, ""),
        apiToken: provider.apiKey ?? headerToken,
    });
    try {
        const model = await client.embedding.model(provider.model);
        return {
            count: async (texts) =>
                (await model.tokenize(texts)).map((tokens) => tokens.length),
            close: async () => client[Symbol.asyncDispose](),
        };
    } catch (error) {
        await client[Symbol.asyncDispose]();
        throw error;
    }
};
