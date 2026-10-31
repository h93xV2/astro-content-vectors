import { describe, expect, test } from "bun:test";

import astroContentVectors, {
    type AstroContentVectorsOptions,
} from "../../src/index.js";

type CapturedConfig = { vite: { define: Record<string, string> } };

const getViteDefines = (
    command: "dev" | "build",
    options: AstroContentVectorsOptions = {},
) => {
    const integration = astroContentVectors(options);
    const setup = integration.hooks?.[
        "astro:config:setup"
    ] as unknown as (context: {
        command: "dev" | "build";
        config: { outDir: URL };
        updateConfig: (config: CapturedConfig) => void;
    }) => void;
    let configured: CapturedConfig | undefined;
    setup({
        command,
        config: { outDir: new URL("file:///tmp/astro-content-vectors-dist/") },
        updateConfig: (config) => (configured = config),
    });
    return configured!.vite.define;
};

const getRuntimeConfig = (
    command: "dev" | "build",
    options: AstroContentVectorsOptions = {},
) =>
    JSON.parse(
        getViteDefines(command, options).__ASTRO_CONTENT_VECTORS_CONFIG__!,
    ) as Record<string, unknown>;

describe("Astro integration provider selection", () => {
    test("selects one configured LM Studio provider for development", () => {
        const source = JSON.stringify(
            getRuntimeConfig("dev", {
                environments: {
                    development: {
                        provider: {
                            type: "lmstudio",
                            model: "my-local-embedding",
                            apiKey: "must-not-leak",
                        },
                    },
                },
                provider: { type: "openai", model: "default-openai-model" },
            }),
        );

        expect(source).toContain("http://127.0.0.1:1234/v1");
        expect(source).toContain("my-local-embedding");
        expect(source).toContain('"failOnError":false');
        expect(source).not.toContain("must-not-leak");
    });

    test("selects one OpenAI provider and configures a separate fallback", () => {
        const source = JSON.stringify(
            getRuntimeConfig("build", {
                failOnError: true,
                provider: { type: "openai", model: "default-openai-model" },
                environments: {
                    production: { provider: { model: "prod-openai-model" } },
                },
                fallback: { model: "prod-local-model" },
            }),
        );

        expect(source).toContain("https://api.openai.com/v1");
        expect(source).toContain("prod-openai-model");
        expect(source).toContain("prod-local-model");
        expect(source).toContain('"failOnError":true');
        expect(source).not.toContain("apiKey");
    });

    test("supports custom environment keys and keeps the default local fallback", () => {
        const source = JSON.stringify(
            getRuntimeConfig("build", {
                environment: "preview",
                provider: { type: "openai", model: "default-model" },
                environments: {
                    preview: { provider: { model: "preview-embedding-model" } },
                },
            }),
        );

        expect(source).toContain("preview-embedding-model");
        expect(source).toContain("http://127.0.0.1:1234/v1");
        expect(source).toContain("text-embedding-nomic-embed-text-v1.5");
    });

    test("environment overrides inherit unspecified default provider settings", () => {
        const source = JSON.stringify(
            getRuntimeConfig("build", {
                provider: { type: "openai", model: "default-model" },
                environments: {
                    preview: { provider: { model: "preview-model" } },
                },
            }),
        );

        expect(source).toContain("preview-model");
        expect(source).toContain("default-model");
    });

    test("writes opt-in pairwise scores under Astro's dist directory", () => {
        const source = JSON.stringify(
            getRuntimeConfig("build", {
                outputSimilarityScores: true,
            }),
        );

        expect(source).toContain('"outputSimilarityScores":true');
        expect(source).toContain("content-vector-similarities");
    });
});
