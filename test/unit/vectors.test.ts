import { describe, expect, test } from "bun:test";

import { combineChunkVectors } from "../../src/embeddings/vectors.js";

describe("combineChunkVectors", () => {
    test("weights vectors by their token counts", () => {
        expect(
            combineChunkVectors(
                [
                    [1, 0],
                    [0, 1],
                ],
                [1, 3],
            ),
        ).toEqual([0.25, 0.75]);
    });

    test("uses an even average when all token counts are zero", () => {
        expect(
            combineChunkVectors(
                [
                    [1, 0],
                    [0, 1],
                ],
                [0, 0],
            ),
        ).toEqual([0.5, 0.5]);
    });
});
