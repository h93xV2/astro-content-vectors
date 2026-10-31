import { defineConfig } from "astro/config";
import astroContentVectors from "astro-content-vectors";

export default defineConfig({
    integrations: [
        astroContentVectors({
            provider: {
                type: "lmstudio",
                baseUrl: process.env.TEST_EMBEDDING_BASE_URL,
                model: "fixture-embedding-model",
            },
            fallback: false,
            cache: false,
        }),
    ],
});
