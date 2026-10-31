import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeEmbeddingDatabase } from "../../src/cache.js";
import {
    type ContentVectorsConfig,
    cosineSimilarity,
    getPairWiseSimilarityScores,
    getRelatedContent,
    getSlugToMostRelatedPostsMap,
} from "../../src/runtime.js";

const response = (vectors: number[][]) =>
    new Response(
        JSON.stringify({
            data: vectors.map((embedding, index) => ({ index, embedding })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );

describe("cosineSimilarity", () => {
    test("scores identical and orthogonal vectors", () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });

    test("handles a zero vector without NaN", () => {
        expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    });
});

describe("copied related-post helpers", () => {
    const embeddings = [
        { slug: "a", vector: [1, 0] },
        { slug: "b", vector: [0.8, 0.6] },
        { slug: "c", vector: [0, 1] },
    ];

    test("ranks the closest posts with the original slug-based helper", () => {
        const related = getSlugToMostRelatedPostsMap(embeddings, {
            threshold: 0.65,
            limit: 1,
        });
        expect(related.get("a")).toEqual([{ slug: "b", score: 0.8 }]);
    });

    test("scores each pair once for similarity analysis", () => {
        expect(getPairWiseSimilarityScores(embeddings)).toEqual([0.8, 0, 0.6]);
    });
});

describe("getRelatedContent", () => {
    test("reuses cached vectors and regenerates an entry when its text changes", async () => {
        const directory = mkdtempSync(join(tmpdir(), "astro-content-vectors-"));
        const cachePath = join(directory, "embeddings.db");
        const calls: string[][] = [];
        const config: ContentVectorsConfig = {
            provider: {
                baseUrl: "http://localhost:1234/v1",
                model: "cache-test-model",
            },
            cache: true,
            cachePath,
            cacheNamespace: "blog",
            fetch: async (_input, init) => {
                const { input } = JSON.parse(String(init?.body)) as {
                    input: string[];
                };
                calls.push(input);
                return response(
                    input.map((text) =>
                        text === "Alpha" ? [1, 0] : [0.8, 0.6],
                    ),
                );
            },
            logLevel: "silent",
        };

        try {
            const documents = [
                { id: "a", title: "Alpha" },
                { id: "b", title: "Beta" },
            ];
            await getRelatedContent(documents, config);
            await getRelatedContent(documents, config);
            await getRelatedContent(
                [documents[0]!, { id: "b", title: "Beta updated" }],
                config,
            );

            expect(calls).toEqual([["Alpha", "Beta"], ["Beta updated"]]);
        } finally {
            closeEmbeddingDatabase(cachePath);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("reports every pairwise similarity score when requested", async () => {
        const scores: Array<{
            sourceId: string;
            targetId: string;
            score: number;
        }> = [];
        await getRelatedContent([{ id: "a" }, { id: "b" }, { id: "c" }], {
            provider: { baseUrl: "http://localhost:1234/v1", model: "test" },
            fetch: async () =>
                response([
                    [1, 0],
                    [0.8, 0.6],
                    [0, 1],
                ]),
            onSimilarityScores: (pairs) => {
                scores.push(...pairs);
            },
            logLevel: "silent",
        });

        expect(scores).toEqual([
            { sourceId: "a", targetId: "b", score: 0.8 },
            { sourceId: "a", targetId: "c", score: 0 },
            { sourceId: "b", targetId: "c", score: 0.6 },
        ]);
    });

    test("batches requests and ranks matches without self-links", async () => {
        const calls: string[] = [];
        const vectors = [
            [1, 0],
            [0.9, 0.1],
            [0, 1],
        ];
        const fetchMock: NonNullable<ContentVectorsConfig["fetch"]> = async (
            _input,
            init,
        ) => {
            const body = JSON.parse(String(init?.body)) as { input: string[] };
            calls.push(...body.input);
            return response(
                body.input.map(
                    (text) =>
                        vectors[["Alpha", "Beta", "Gamma"].indexOf(text)]!,
                ),
            );
        };
        const logs: string[] = [];
        const index = await getRelatedContent(
            [
                { id: "a", title: "Alpha" },
                { id: "b", title: "Beta" },
                { id: "c", title: "Gamma" },
            ],
            {
                provider: {
                    baseUrl: "http://localhost:1234/v1",
                    model: "test",
                    batchSize: 2,
                },
                threshold: 0.8,
                logger: (_level, message) => logs.push(message),
                logLevel: "info",
                fetch: fetchMock,
            },
        );

        expect(calls).toEqual(["Alpha", "Beta", "Gamma"]);
        expect(index.get("a")?.map(({ id }) => id)).toEqual(["b"]);
        expect(index.get("b")?.map(({ id }) => id)).toEqual(["a"]);
        expect(index.get("c")).toEqual([]);
        expect(logs).toHaveLength(2);
    });

    test("includes an API key and batches input in the OpenAI request", async () => {
        let authorization = "";
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "test-key";
        try {
            const result = await getRelatedContent(
                [{ id: "one", body: "article" }],
                {
                    provider: {
                        baseUrl: "https://api.openai.com/v1",
                        model: "text-embedding-3-small",
                    },
                    fetch: async (_input, init) => {
                        authorization =
                            new Headers(init?.headers).get("authorization") ??
                            "";
                        return response([[1, 0]]);
                    },
                    logLevel: "silent",
                },
            );
            expect(authorization).toBe("Bearer test-key");
            expect(result.get("one")).toEqual([]);
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });

    test("uses the local provider when OPENAI_API_KEY is missing", async () => {
        const previous = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        const requests: string[] = [];
        try {
            const result = await getRelatedContent(
                [{ id: "one", body: "article" }],
                {
                    provider: {
                        baseUrl: "https://api.openai.com/v1",
                        model: "text-embedding-3-small",
                    },
                    fallbackProvider: {
                        baseUrl: "http://127.0.0.1:1234/v1",
                        model: "local-embed",
                    },
                    fetch: async (input) => {
                        requests.push(String(input));
                        return response([[1, 0]]);
                    },
                    logLevel: "silent",
                },
            );
            expect(requests).toEqual(["http://127.0.0.1:1234/v1/embeddings"]);
            expect(result.get("one")).toEqual([]);
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });

    test("falls back after a network failure and returns an empty index non-fatally if both fail", async () => {
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "test-key";
        const warnings: string[] = [];
        try {
            const result = await getRelatedContent(
                [{ id: "one", body: "article" }],
                {
                    provider: {
                        baseUrl: "https://api.openai.com/v1",
                        model: "openai-model",
                    },
                    fallbackProvider: {
                        baseUrl: "http://127.0.0.1:1234/v1",
                        model: "local-model",
                    },
                    fetch: async (input) => {
                        if (String(input).includes("api.openai.com"))
                            throw new Error("network down");
                        return response([[1, 0]]);
                    },
                    logger: (level, message) => {
                        if (level === "warn") warnings.push(message);
                    },
                    logLevel: "warn",
                },
            );
            expect(result.has("one")).toBe(true);
            expect(warnings[0]).toContain("network down");

            const unavailable = await getRelatedContent([{ id: "one" }], {
                provider: {
                    baseUrl: "https://api.openai.com/v1",
                    model: "openai-model",
                },
                fallbackProvider: {
                    baseUrl: "http://127.0.0.1:1234/v1",
                    model: "local-model",
                },
                fetch: async () => {
                    throw new Error("offline");
                },
                logger: (level, message) => {
                    if (level === "warn") warnings.push(message);
                },
                logLevel: "warn",
            });
            expect(unavailable.get("one")).toEqual([]);
            expect(
                warnings.some((message) =>
                    message.includes("Fallback embedding provider failed"),
                ),
            ).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });

    test("failOnError makes provider outages fatal", async () => {
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "test-key";
        try {
            await expect(
                getRelatedContent([{ id: "one" }], {
                    provider: {
                        baseUrl: "https://api.openai.com/v1",
                        model: "openai-model",
                    },
                    fallbackProvider: {
                        baseUrl: "http://127.0.0.1:1234/v1",
                        model: "local-model",
                    },
                    failOnError: true,
                    fetch: async () => {
                        throw new Error("offline");
                    },
                    logLevel: "silent",
                }),
            ).rejects.toThrow("Fallback embedding provider failed");
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });

    test("rejects malformed dimensions, duplicate IDs, and provider errors", async () => {
        await expect(
            getRelatedContent([{ id: "same" }, { id: "same" }], {
                provider: { baseUrl: "http://localhost/v1", model: "test" },
            }),
        ).rejects.toThrow("Duplicate content id");

        const warnings: string[] = [];
        const result = await getRelatedContent([{ id: "one" }], {
            provider: { baseUrl: "http://localhost/v1", model: "test" },
            logger: (level, message) => {
                if (level === "warn") warnings.push(message);
            },
            logLevel: "warn",
            fetch: async () => new Response("offline", { status: 503 }),
        });
        expect(result.get("one")).toEqual([]);
        expect(warnings[0]).toContain("503 offline");

        await expect(
            getRelatedContent([{ id: "one" }, { id: "two" }], {
                provider: { baseUrl: "http://localhost/v1", model: "test" },
                failOnError: true,
                logLevel: "silent",
                fetch: async () => response([[1, 0], [1]]),
            }),
        ).rejects.toThrow("incompatible dimensions");
    });
});
