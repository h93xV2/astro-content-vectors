import { log } from "../logging.ts";
import type {
    ContentDocument,
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "../types.ts";
import type { PostEmbeddingCacheEntry } from "./cache/cache.ts";
import { createTokenizer, type Tokenizer } from "./tokenizer.ts";

export type Paragraph = { text: string; startsSection: boolean };
export type ChunkPlan = {
    index: number;
    id: string;
    text: string;
    paragraphs: Paragraph[];
    cacheId: string;
    cacheEntry: PostEmbeddingCacheEntry | undefined;
    chunks: string[];
    weights: number[];
};

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

export const contentText = (document: ContentDocument) =>
    [document.title, document.text, document.body].filter(Boolean).join("\n\n");

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
    if (headings.length)
        paragraphs.push({ text: headings.join("\n"), startsSection: true });
    return paragraphs.length ? paragraphs : [{ text, startsSection: false }];
};

export const documentParagraphs = (document: ContentDocument): Paragraph[] => {
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

/** Build the chunking inputs for documents that have no cache metadata. */
export const makePendingDocuments = (
    documents: ContentDocument[],
): Omit<ChunkPlan, "chunks" | "weights">[] =>
    documents.map((document, index) => ({
        index,
        id: document.id,
        text: contentText(document),
        paragraphs: documentParagraphs(document),
        cacheId: "",
        cacheEntry: undefined,
    }));

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
            if (unit.tokens > maxTokens)
                throw new Error(
                    `A single text segment exceeds the chunk token limit of ${maxTokens}. Increase chunkTokens.`,
                );
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
    if (tokenCounts.some((count) => count > maxTokens))
        throw new Error(
            "Tokenizer boundary merging caused a chunk to exceed chunkTokens; lower the configured limit.",
        );
    return { texts: chunks, tokenCounts };
};

export const prepareChunks = async (
    pending: Omit<ChunkPlan, "chunks" | "weights">[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<ChunkPlan[]> => {
    const chunkTokens = Math.max(1, provider.chunkTokens ?? 2000);
    const alwaysChunk = provider.alwaysChunk ?? false;
    const oversized = pending.filter(
        (document) =>
            alwaysChunk ||
            document.paragraphs.some(({ startsSection }) => startsSection) ||
            utf8Length(document.text) > chunkTokens,
    );
    if (oversized.length)
        log(
            config,
            "info",
            `Counting tokens for ${oversized.length} entries with ${provider.model} before chunking.`,
        );

    const tokenizer = oversized.length
        ? await createTokenizer(provider)
        : undefined;
    try {
        const plan: ChunkPlan[] = [];
        for (const document of pending) {
            if (
                !alwaysChunk &&
                !document.paragraphs.some(
                    ({ startsSection }) => startsSection,
                ) &&
                utf8Length(document.text) <= chunkTokens
            ) {
                plan.push({
                    ...document,
                    chunks: [document.text],
                    weights: [1],
                });
                continue;
            }
            if (!tokenizer) throw new Error("Tokenizer was not initialized.");
            const split = await splitIntoChunks(
                document.text,
                document.paragraphs,
                chunkTokens,
                alwaysChunk,
                tokenizer,
            );
            plan.push({
                ...document,
                chunks: split.texts,
                weights: split.tokenCounts,
            });
        }
        return plan;
    } finally {
        await tokenizer?.close();
    }
};

export type ChunkInput = { index: number; chunkIndex: number; text: string };
export const flattenChunkPlan = (plan: ChunkPlan[]): ChunkInput[] =>
    plan.flatMap((document) =>
        document.chunks.map((text, chunkIndex) => ({
            index: document.index,
            chunkIndex,
            text,
        })),
    );
