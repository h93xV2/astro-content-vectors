type Embedding = {
    slug: string;
    vector: number[];
};

const getCosineSimilarity = (vectorA: number[], vectorB: number[]) => {
    // See https://stackoverflow.com/a/64816824 for dot product calculation explained.
    const dot = vectorA.reduce(
        (sum, val, i) => sum + val * (vectorB[i] ?? 0),
        0.0,
    );
    const magnitudeA = Math.sqrt(
        vectorA.reduce((sum, val) => sum + val * val, 0.0),
    );
    const magnitudeB = Math.sqrt(
        vectorB.reduce((sum, val) => sum + val * val, 0.0),
    );
    const denominator = magnitudeA * magnitudeB;
    return denominator === 0 ? 0 : dot / denominator;
};

type ScoredPost = {
    slug: string;
    score: number;
};

const COSINE_THRESHOLD = 0.65;

const getSlugToMostRelatedPostsMap = (
    embeddings: Embedding[],
    options: { threshold?: number; limit?: number } = {},
) => {
    const threshold = options.threshold ?? COSINE_THRESHOLD;
    const limit = options.limit ?? 3;
    const slugToMostRelatedPosts: Map<string, ScoredPost[]> = new Map();

    for (const a of embeddings) {
        const sims: ScoredPost[] = embeddings
            .filter((b) => b.slug !== a.slug)
            .map((b) => ({
                slug: b.slug,
                score: getCosineSimilarity(a.vector, b.vector),
            }))
            .filter((c) => threshold <= c.score)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        slugToMostRelatedPosts.set(a.slug, sims);
    }

    return slugToMostRelatedPosts;
};

const getPairWiseSimilarityScores = (embeddings: Embedding[]) => {
    const pairs: number[] = [];

    for (let i = 0; i < embeddings.length; i++) {
        for (let j = i + 1; j < embeddings.length; j++) {
            const embeddingA = embeddings[i];
            const embeddingB = embeddings[j];
            if (!embeddingA || !embeddingB) continue;
            const sim = getCosineSimilarity(
                embeddingA.vector,
                embeddingB.vector,
            );
            pairs.push(sim);
        }
    }

    return pairs;
};

export {
    COSINE_THRESHOLD,
    type Embedding,
    getCosineSimilarity,
    getPairWiseSimilarityScores,
    getSlugToMostRelatedPostsMap,
    type ScoredPost,
};
