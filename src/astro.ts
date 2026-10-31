/// <reference types="astro/client" />

import { getCollection } from "astro:content";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
    ContentDocument,
    ContentVectorsConfig,
    RelatedContent,
    SimilarityScore,
} from "./runtime.js";
import { getRelatedContent as buildRelatedContent } from "./runtime.js";

type AstroContentVectorsRuntimeConfig = {
    environments: Record<string, AstroRuntimeProviderConfig>;
    environment?: string;
    defaultEnvironment: string;
    outputSimilarityScores: boolean;
    outputDirectory: string;
};

type AstroRuntimeProviderConfig = ContentVectorsConfig & {
    collections?: string[] | null;
};

declare const __ASTRO_CONTENT_VECTORS_CONFIG__: AstroContentVectorsRuntimeConfig;

const {
    environments,
    environment,
    defaultEnvironment,
    outputSimilarityScores,
    outputDirectory,
} = __ASTRO_CONTENT_VECTORS_CONFIG__;

const viteEnvironment = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.MODE;
const activeEnvironment = environment ?? viteEnvironment ?? defaultEnvironment;
const selectedConfig =
    environments[activeEnvironment] ?? environments[defaultEnvironment];

if (!selectedConfig?.provider) {
    throw new Error(
        `astro-content-vectors has no providers configured for environment: ${activeEnvironment}`,
    );
}
const config = selectedConfig;

const indexes = new Map<string, Promise<Map<string, RelatedContent[]>>>();

type AstroContentEntry = {
    id: string;
    data: { title?: unknown; description?: unknown };
    body?: string;
};

const optionalString = (value: unknown) =>
    typeof value === "string" ? value : undefined;

/** Return ranked related entries from an Astro content collection. */
export async function getRelatedContent(
    collection: string,
    id: string,
): Promise<RelatedContent[]> {
    if (config.collections && !config.collections.includes(collection)) {
        throw new Error(
            `Collection is not enabled in astro-content-vectors: ${collection}`,
        );
    }

    let pending = indexes.get(collection);
    if (!pending) {
        const created = getCollection(collection as never).then(
            (entries: AstroContentEntry[]) => {
                const documents: ContentDocument[] = (
                    entries as unknown as AstroContentEntry[]
                ).map((entry) => ({
                    id: entry.id,
                    title: optionalString(entry.data.title),
                    text: optionalString(entry.data.description),
                    body: entry.body ?? "",
                }));

                const reportConfig: ContentVectorsConfig = {
                    ...config,
                    cacheNamespace: collection,
                };
                if (outputSimilarityScores) {
                    reportConfig.onSimilarityScores = async (
                        pairs: SimilarityScore[],
                    ) => {
                        await mkdir(outputDirectory, { recursive: true });
                        const file = join(
                            outputDirectory,
                            `${encodeURIComponent(collection)}.json`,
                        );
                        const report = {
                            collection,
                            threshold: config.threshold ?? 0.65,
                            pairs,
                        };
                        await writeFile(
                            file,
                            `${JSON.stringify(report, null, 2)}\n`,
                        );
                    };
                }

                return buildRelatedContent(documents, reportConfig);
            },
        );
        indexes.set(collection, created);
        void created.catch(() => indexes.delete(collection));
        pending = created;
    }

    if (!pending) {
        throw new Error("Failed to create the content-vector index.");
    }
    const index = await pending;
    return index.get(id) ?? [];
}
