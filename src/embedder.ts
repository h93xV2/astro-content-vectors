import {
    getEmbeddingDatabase,
    getPostEmbeddingCacheEntry,
    type PostEmbeddingCacheEntry,
    savePostEmbedding,
} from "./cache.js";
import { log } from "./logging.js";
import { requestEmbeddings } from "./provider.js";
import { createTokenizer, type Tokenizer } from "./tokenizer.js";
import type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "./types.js";

const contentText = (document: ContentDocument) =>
    [document.title, document.text, document.body].filter(Boolean).join("\n\n");

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

type Paragraph = { text: string; startsSection: boolean };

const getParagraphs = (text: string, isMarkdown: boolean): Paragraph[] => {
    const paragraphs: Paragraph[] = [];
    let lines: string[] = [];
    let headings: string[] = [];
    const flush = () => {
        if (lines.length) {
            paragraphs.push({
                text: [...headings, ...lines].join("\n").trim(),
                startsSection: headings.length > 0,
            });
            headings = [];
            lines = [];
        }
    };

    for (const line of text.split(/\r?\n/)) {
        if (isMarkdown && /^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
            flush();
            headings.push(line);
        } else if (/^\s*$/.test(line)) {
            flush();
        } else {
            lines.push(line);
        }
    }
    flush();
    if (headings.length) {
        paragraphs.push({ text: headings.join("\n"), startsSection: true });
    }
    return paragraphs.length ? paragraphs : [{ text, startsSection: false }];
};

const documentParagraphs = (document: ContentDocument): Paragraph[] => {
    const paragraphs = [document.title, document.text]
        .filter((field): field is string => Boolean(field))
        .flatMap((field) => getParagraphs(field, false));
    if (document.body) {
        paragraphs.push(
            ...getParagraphs(document.body, document.bodyFormat === "markdown"),
        );
    }
    return paragraphs.length
        ? paragraphs
        : [{ text: contentText(document), startsSection: false }];
};

const splitIntoChunks = async (
    text: string,
    paragraphs: Paragraph[],
    maxTokens: number,
    alwaysChunk: boolean,
    tokenizer: Tokenizer,
): Promise<{ texts: string[]; tokenCounts: number[] }> => {
    const chunks: string[] = [];
    let current = "";
    let currentTokens = 0;
    const separatorTokens = (await tokenizer.count(["\n\n"]))[0] ?? 0;
    const flush = () => {
        if (current.trim()) chunks.push(current.trim());
        current = "";
        currentTokens = 0;
    };

    for (const paragraph of paragraphs) {
        if (paragraph.startsSection && current) flush();
        if (alwaysChunk && current) flush();
        const parts = paragraph.text.split(/(\s+)/).filter(Boolean);
        const counts = await tokenizer.count(parts);
        const units: Array<{ text: string; tokens: number }> = [];
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index] ?? "";
            const count = counts[index] ?? 0;
            if (count <= maxTokens) {
                units.push({ text: part, tokens: count });
                continue;
            }
            const characters = [...part];
            const characterCounts = await tokenizer.count(characters);
            units.push(
                ...characters.map((character, characterIndex) => ({
                    text: character,
                    tokens: characterCounts[characterIndex] ?? 0,
                })),
            );
        }
        for (const unit of units) {
            if (unit.tokens > maxTokens) {
                throw new Error(
                    `A single text segment exceeds the chunk token limit of ${maxTokens}. Increase chunkTokens.`,
                );
            }
            if (current && currentTokens + unit.tokens > maxTokens) flush();
            current += unit.text;
            currentTokens += unit.tokens;
        }
        if (alwaysChunk) flush();
        else if (current) {
            current += "\n\n";
            currentTokens += separatorTokens;
        }
    }
    flush();
    if (chunks.length === 0) chunks.push(text);
    const tokenCounts = await tokenizer.count(chunks);
    if (tokenCounts.some((count) => count > maxTokens)) {
        throw new Error(
            "Tokenizer boundary merging caused a chunk to exceed chunkTokens; lower the configured limit.",
        );
    }
    return { texts: chunks, tokenCounts };
};

const embeddingCacheId = (
    id: string,
    provider: EmbeddingProviderConfig,
    namespace?: string,
    bodyFormat?: ContentDocument["bodyFormat"],
) =>
    JSON.stringify([
        provider.providerName ?? provider.baseUrl,
        provider.baseUrl,
        provider.model,
        provider.chunkTokens ?? 2000,
        provider.alwaysChunk ?? false,
        provider.tokenizer ?? "model-default",
        bodyFormat ?? "text",
        namespace ?? "",
        id,
    ]);

export const embedAll = async (
    documents: ContentDocument[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<number[][]> => {
    const texts = documents.map(contentText);
    const paragraphs = documents.map(documentParagraphs);
    const chunkTokens = Math.max(1, provider.chunkTokens ?? 2000);
    const alwaysChunk = provider.alwaysChunk ?? false;
    const ids = documents.map(({ id }) => id);
    const batchSize = Math.max(1, provider.batchSize ?? 32);
    const database =
        config.cache === true
            ? getEmbeddingDatabase(config.cachePath)
            : undefined;
    const vectors: Array<number[] | undefined> = new Array(texts.length);
    const cacheEntries: Array<PostEmbeddingCacheEntry | undefined> = new Array(
        texts.length,
    );
    const missing: number[] = [];
    let cacheHits = 0;

    for (let index = 0; index < texts.length; index++) {
        const id = ids[index];
        const text = texts[index];
        if (id === undefined || text === undefined) {
            throw new Error("Content IDs and text must have matching lengths.");
        }
        const cacheId = embeddingCacheId(
            id,
            provider,
            config.cacheNamespace,
            documents[index]?.bodyFormat,
        );
        const entry = database
            ? getPostEmbeddingCacheEntry(database, cacheId, text)
            : undefined;
        if (entry?.vector) {
            vectors[index] = entry.vector;
            cacheHits++;
        } else {
            missing.push(index);
            cacheEntries[index] = entry;
        }
    }

    const updates: Array<{
        cacheId: string;
        vector: number[];
        entry: PostEmbeddingCacheEntry;
    }> = [];
    const chunkTexts = new Map<number, string[]>();
    const chunkWeights = new Map<number, number[]>();
    const oversized = missing.filter(
        (index) =>
            alwaysChunk ||
            paragraphs[index]?.some(({ startsSection }) => startsSection) ||
            utf8Length(texts[index] ?? "") > chunkTokens,
    );
    if (oversized.length) {
        log(
            config,
            "info",
            `Counting tokens for ${oversized.length} entries with ${provider.model} before chunking.`,
        );
    }
    const tokenizer = oversized.length
        ? await createTokenizer(provider)
        : undefined;
    try {
        for (const index of missing) {
            const text = texts[index] ?? "";
            if (
                !alwaysChunk &&
                !paragraphs[index]?.some(
                    ({ startsSection }) => startsSection,
                ) &&
                utf8Length(text) <= chunkTokens
            ) {
                chunkTexts.set(index, [text]);
                chunkWeights.set(index, [1]);
            } else {
                if (!tokenizer)
                    throw new Error("Tokenizer was not initialized.");
                const split = await splitIntoChunks(
                    text,
                    paragraphs[index] ?? [],
                    chunkTokens,
                    alwaysChunk,
                    tokenizer,
                );
                chunkTexts.set(index, split.texts);
                chunkWeights.set(index, split.tokenCounts);
            }
        }

        const pending = missing.flatMap((index) =>
            (chunkTexts.get(index) ?? []).map((text, chunkIndex) => ({
                index,
                chunkIndex,
                text,
            })),
        );
        const batchCount = Math.ceil(pending.length / batchSize);
        const splitEntries = missing.filter(
            (index) => (chunkTexts.get(index)?.length ?? 0) > 1,
        ).length;
        const inputCount = missing.reduce(
            (sum, index) => sum + (chunkTexts.get(index)?.length ?? 0),
            0,
        );
        const cacheStatus = database
            ? `cache: ${cacheHits} hit${cacheHits === 1 ? "" : "s"}, ${missing.length} miss${missing.length === 1 ? "" : "es"}`
            : "cache disabled";
        const chunkStatus =
            texts.length === 0
                ? "no entries to process"
                : missing.length === 0
                  ? "chunking skipped because all vectors are cached"
                  : alwaysChunk
                    ? `paragraph chunking enabled, ${inputCount} input${inputCount === 1 ? "" : "s"}`
                    : splitEntries > 0
                      ? `chunking split ${splitEntries} entr${splitEntries === 1 ? "y" : "ies"} into ${inputCount} inputs`
                      : `chunking not needed for ${missing.length} entr${missing.length === 1 ? "y" : "ies"}`;
        log(
            config,
            "info",
            missing.length === 0
                ? `Embedding preparation complete: ${cacheStatus}; ${chunkStatus}.`
                : `Preparing ${pending.length} embedding inputs for ${missing.length} entries with ${provider.model} (${cacheStatus}; ${chunkStatus}; ${batchCount} batch${batchCount === 1 ? "" : "es"}).`,
        );
        const chunkVectors = new Map<number, number[][]>();
        for (let start = 0; start < pending.length; start += batchSize) {
            const batch = pending.slice(start, start + batchSize);
            log(
                config,
                "debug",
                `Sending embedding batch ${Math.floor(start / batchSize) + 1}/${batchCount} (${batch.length} inputs) with ${provider.model}.`,
            );
            const batchVectors = await requestEmbeddings(
                batch.map(({ text }) => text),
                provider,
                config,
            );
            batch.forEach(({ index, chunkIndex }, batchIndex) => {
                const vector = batchVectors[batchIndex];
                if (!vector) {
                    throw new Error(
                        "Embedding provider returned fewer vectors than requested.",
                    );
                }
                const vectorsForDocument = chunkVectors.get(index) ?? [];
                vectorsForDocument[chunkIndex] = vector;
                chunkVectors.set(index, vectorsForDocument);
            });
        }

        for (const index of missing) {
            const parts = chunkVectors.get(index) ?? [];
            const weights = chunkWeights.get(index) ?? [];
            const totalWeight = weights.reduce(
                (sum, weight) => sum + weight,
                0,
            );
            const vector = parts[0]?.map((_, dimension) =>
                parts.reduce(
                    (sum, part, partIndex) =>
                        sum +
                        (part[dimension] ?? 0) *
                            (totalWeight === 0
                                ? 1 / parts.length
                                : (weights[partIndex] ?? 0) / totalWeight),
                    0,
                ),
            );
            if (!vector) throw new Error("No embedding chunks were generated.");
            vectors[index] = vector;
            const entry = cacheEntries[index];
            if (database && entry) {
                const id = ids[index];
                if (id === undefined) {
                    throw new Error("Missing content ID for embedding.");
                }
                updates.push({
                    cacheId: embeddingCacheId(
                        id,
                        provider,
                        config.cacheNamespace,
                        documents[index]?.bodyFormat,
                    ),
                    vector,
                    entry,
                });
            }
        }
    } finally {
        await tokenizer?.close();
    }

    const completeVectors = vectors.map((vector) => {
        if (!vector) {
            throw new Error(
                "Embedding provider returned fewer vectors than documents.",
            );
        }
        return vector;
    });
    const dimensions = completeVectors[0]?.length;
    if (
        completeVectors.some(
            (vector) => vector.length === 0 || vector.length !== dimensions,
        )
    ) {
        throw new Error(
            "Embedding provider returned vectors with incompatible dimensions.",
        );
    }
    if (database) {
        for (const { cacheId, vector, entry } of updates) {
            savePostEmbedding(
                database,
                cacheId,
                entry.hashedContent,
                vector,
                entry.row,
            );
        }
        if (updates.length > 0) {
            log(
                config,
                "debug",
                `Saved ${updates.length} new vector${updates.length === 1 ? "" : "s"} to the embedding cache.`,
            );
        }
    }
    return completeVectors;
};
