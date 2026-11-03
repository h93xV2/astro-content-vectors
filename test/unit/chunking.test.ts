import { describe, expect, test } from "bun:test";
import {
    documentParagraphs,
    prepareChunks,
} from "../../src/embeddings/chunking.js";
import type { ContentVectorsConfig } from "../../src/types.js";

const config: ContentVectorsConfig = {
    provider: {
        baseUrl: "https://api.openai.com/v1",
        model: "test-model",
    },
    logLevel: "silent",
};

describe("prepareChunks", () => {
    test("keeps Markdown headings with their paragraph and starts a chunk at each heading", async () => {
        const document = {
            id: "article",
            bodyFormat: "markdown" as const,
            body: "# First section\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Second section\n\nThird paragraph.",
        };
        const plan = await prepareChunks(
            [
                {
                    index: 0,
                    id: document.id,
                    text: document.body,
                    paragraphs: documentParagraphs(document),
                    cacheId: "article",
                    cacheEntry: undefined,
                },
            ],
            config.provider,
            config,
        );

        expect(plan[0]?.chunks).toEqual([
            "# First section\nFirst paragraph.\n\nSecond paragraph.",
            "## Second section\nThird paragraph.",
        ]);
    });

    test("alwaysChunk emits one chunk per paragraph", async () => {
        const document = {
            id: "article",
            bodyFormat: "markdown" as const,
            body: "# First section\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Second section\n\nThird paragraph.",
        };
        const plan = await prepareChunks(
            [
                {
                    index: 0,
                    id: document.id,
                    text: document.body,
                    paragraphs: documentParagraphs(document),
                    cacheId: "article",
                    cacheEntry: undefined,
                },
            ],
            { ...config.provider, alwaysChunk: true },
            config,
        );

        expect(plan[0]?.chunks).toEqual([
            "# First section\nFirst paragraph.",
            "Second paragraph.",
            "## Second section\nThird paragraph.",
        ]);
        expect(plan[0]?.weights).toHaveLength(3);
        expect(plan[0]?.weights.every((weight) => weight > 0)).toBe(true);
    });

    test("splits an oversized paragraph so every chunk stays within the token limit", async () => {
        const text = "one two three four five six seven eight nine ten";
        const document = { id: "article", body: text };
        const plan = await prepareChunks(
            [
                {
                    index: 0,
                    id: document.id,
                    text,
                    paragraphs: documentParagraphs(document),
                    cacheId: "article",
                    cacheEntry: undefined,
                },
            ],
            { ...config.provider, chunkTokens: 4 },
            config,
        );

        expect(plan[0]?.chunks.length).toBeGreaterThan(1);
        expect(plan[0]?.weights.every((weight) => weight <= 4)).toBe(true);
        expect(plan[0]?.chunks.join(" ").replace(/\s+/g, " ")).toBe(text);
    });
});
