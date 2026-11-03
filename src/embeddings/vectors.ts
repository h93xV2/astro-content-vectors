import { log } from "../logging.js";
import type {
    ContentVectorsConfig,
    EmbeddingProviderConfig,
} from "../types.js";
import type { ChunkInput } from "./chunking.js";
import { requestEmbeddings } from "./provider.js";

export const requestChunkVectors = async (
    inputs: ChunkInput[],
    provider: EmbeddingProviderConfig,
    config: ContentVectorsConfig,
): Promise<Map<number, number[][]>> => {
    const batchSize = Math.max(1, provider.batchSize ?? 32);
    const batchCount = Math.ceil(inputs.length / batchSize);
    const vectorsByDocument = new Map<number, number[][]>();
    for (let start = 0; start < inputs.length; start += batchSize) {
        const batch = inputs.slice(start, start + batchSize);
        log(
            config,
            "debug",
            `Sending embedding batch ${Math.floor(start / batchSize) + 1}/${batchCount} (${batch.length} inputs) with ${provider.model}.`,
        );
        const vectors = await requestEmbeddings(
            batch.map(({ text }) => text),
            provider,
            config,
        );
        batch.forEach(({ index, chunkIndex }, batchIndex) => {
            const vector = vectors[batchIndex];
            if (!vector)
                throw new Error(
                    "Embedding provider returned fewer vectors than requested.",
                );
            const documentVectors = vectorsByDocument.get(index) ?? [];
            documentVectors[chunkIndex] = vector;
            vectorsByDocument.set(index, documentVectors);
        });
    }
    return vectorsByDocument;
};

export const combineChunkVectors = (
    vectors: number[][],
    weights: number[],
): number[] | undefined => {
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    return vectors[0]?.map((_, dimension) =>
        vectors.reduce(
            (sum, vector, index) =>
                sum +
                (vector[dimension] ?? 0) *
                    (totalWeight === 0
                        ? 1 / vectors.length
                        : (weights[index] ?? 0) / totalWeight),
            0,
        ),
    );
};

export const validateVectors = (
    vectors: Array<number[] | undefined>,
): number[][] => {
    const complete = vectors.map((vector) => {
        if (!vector)
            throw new Error(
                "Embedding provider returned fewer vectors than documents.",
            );
        return vector;
    });
    const dimensions = complete[0]?.length;
    if (
        complete.some(
            (vector) => vector.length === 0 || vector.length !== dimensions,
        )
    ) {
        throw new Error(
            "Embedding provider returned vectors with incompatible dimensions.",
        );
    }
    return complete;
};
