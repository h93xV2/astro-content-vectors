import { describe, expect, test } from "bun:test";

import astroContentVectors from "../../dist/index.js";
import { getRelatedContent } from "../../dist/runtime.js";

describe("built package", () => {
    test("exports the Astro integration and runtime API", () => {
        expect(astroContentVectors()).toMatchObject({
            name: "astro-content-vectors",
        });
        expect(typeof getRelatedContent).toBe("function");
    });
});
