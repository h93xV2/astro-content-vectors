import { describe, expect, test } from "bun:test";

import astroContentVectors, {
    type AstroContentVectorsOptions,
} from "../../src/index.js";

type VirtualPlugin = {
    resolveId(id: string): string | null;
    load(id: string): string | null;
};
type CapturedConfig = { vite: { plugins: VirtualPlugin[] } };

const getVirtualModule = (
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
    return configured!.vite.plugins[0]!;
};

describe("Astro integration provider selection", () => {
    test("selects one configured LM Studio provider for development", () => {
        const plugin = getVirtualModule("dev", {
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
        });
        const source = plugin.load(
            plugin.resolveId("virtual:astro-content-vectors")!,
        )!;

        expect(source).toContain("http://127.0.0.1:1234/v1");
        expect(source).toContain("my-local-embedding");
        expect(source).toContain('"failOnError":false');
        expect(source).not.toContain("must-not-leak");
    });

    test("selects one OpenAI provider and configures a separate fallback", () => {
        const plugin = getVirtualModule("build", {
            failOnError: true,
            provider: { type: "openai", model: "default-openai-model" },
            environments: {
                production: { provider: { model: "prod-openai-model" } },
            },
            fallback: { model: "prod-local-model" },
        });
        const source = plugin.load(
            plugin.resolveId("virtual:astro-content-vectors")!,
        )!;

        expect(source).toContain("https://api.openai.com/v1");
        expect(source).toContain("prod-openai-model");
        expect(source).toContain("prod-local-model");
        expect(source).toContain('"failOnError":true');
        expect(source).not.toContain("apiKey");
    });

    test("supports custom environment keys and keeps the default local fallback", () => {
        const plugin = getVirtualModule("build", {
            environment: "preview",
            provider: { type: "openai", model: "default-model" },
            environments: {
                preview: { provider: { model: "preview-embedding-model" } },
            },
        });
        const source = plugin.load(
            plugin.resolveId("virtual:astro-content-vectors")!,
        )!;

        expect(source).toContain("preview-embedding-model");
        expect(source).toContain("http://127.0.0.1:1234/v1");
        expect(source).toContain("text-embedding-nomic-embed-text-v1.5");
    });

    test("environment overrides inherit unspecified default provider settings", () => {
        const plugin = getVirtualModule("build", {
            provider: { type: "openai", model: "default-model" },
            environments: {
                preview: { provider: { model: "preview-model" } },
            },
        });
        const source = plugin.load(
            plugin.resolveId("virtual:astro-content-vectors")!,
        )!;

        expect(source).toContain("preview-model");
        expect(source).toContain("default-model");
    });

    test("writes opt-in pairwise scores under Astro's dist directory", () => {
        const plugin = getVirtualModule("build", {
            outputSimilarityScores: true,
        });
        const source = plugin.load(
            plugin.resolveId("virtual:astro-content-vectors")!,
        )!;

        expect(source).toContain("const outputSimilarityScores = true");
        expect(source).toContain("content-vector-similarities");
        expect(source).toContain("onSimilarityScores");
    });
});
