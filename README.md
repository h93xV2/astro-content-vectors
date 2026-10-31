# astro-content-vectors

An Astro integration that ranks entries in a content collection by embedding similarity. It uses OpenAI when `OPENAI_API_KEY` is available and automatically falls back to a local LM Studio server when the key is missing or OpenAI is unreachable.

## Install

```sh
bun add astro-content-vectors
```

Add the integration in `astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import contentVectors from "astro-content-vectors";

export default defineConfig({
    integrations: [
        contentVectors({
            collections: ["blog"],
            provider: {
                type: "openai",
                model: "text-embedding-3-small",
            },
            environments: {
                development: {
                    provider: {
                        type: "lmstudio",
                        // Match the model name loaded in LM Studio.
                        baseUrl: "http://127.0.0.1:1234/v1",
                        model: "text-embedding-nomic-embed-text-v1.5",
                    },
                },
                production: {
                    provider: { model: "text-embedding-3-small" },
                },
            },
            fallback: {
                baseUrl: "http://127.0.0.1:1234/v1",
                model: "text-embedding-nomic-embed-text-v1.5",
            },
            threshold: 0.65,
            limit: 3,
            logLevel: "info",
            // Set true to fail the Astro build if neither provider works.
            failOnError: false,
        }),
    ],
});
```

Set `OPENAI_API_KEY` in the environment where Astro runs. The integration detects it automatically and never puts the key into client bundles or injected configuration. Without the key it uses LM Studio directly. If an OpenAI request fails, it retries through LM Studio. If both providers fail, it logs a warning and returns no recommendations by default; set `failOnError: true` to fail the build instead. Start LM Studio's local server and load an embedding model for the fallback to work.

Astro `dev` uses the `development` override; `astro build` uses `production`. The integration selects an override using Astro's `import.meta.env.MODE`, so custom modes such as `astro build --mode preview` work as environment keys too. Set `environment` to explicitly override the detected mode. Each environment may override the single default `provider`; any omitted settings inherit from the default. OpenAI environments use the default LM Studio fallback; configure it with the top-level `fallback` option or set `fallback: false` to disable it. An environment configured with LM Studio uses only that provider.

```js
contentVectors({
    environment: process.env.DEPLOY_ENV ?? "preview",
    provider: { type: "openai", model: "text-embedding-3-small" },
    environments: {
        preview: { provider: { model: "text-embedding-3-large" } },
    },
});
```

Import the Astro-aware helper from the package's `astro` entry point in an Astro component or page frontmatter. Its types are included automatically:

```astro
---
import { getCollection } from "astro:content";
import { getRelatedContent } from "astro-content-vectors/astro";

const post = Astro.props.post;
const recommendations = await getRelatedContent("blog", post.id);
const posts = await getCollection("blog");
const relatedPosts = recommendations
  .map(({ id }) => posts.find((entry) => entry.id === id))
  .filter(Boolean);
---

{relatedPosts.map((entry) => <a href={`/blog/${entry.id}/`}>{entry.data.title}</a>)}
```

Each collection is indexed once per server/build process. The integration embeds each entry's title, description (if any), and Markdown body. Collections can be restricted with `collections`; `threshold`, `limit`, and `logLevel` control recommendation output and diagnostics. Set `logLevel` to `silent` to disable logs.

The integration calls the embeddings endpoint directly with `fetch`, so LM Studio and OpenAI use the same request format. The runtime API is also exported for custom content loaders:

To inspect how your content compares while tuning `threshold`, enable the optional score report:

```ts
astroContentVectors({
    outputSimilarityScores: true,
    threshold: 0.7,
});
```

During a static build, this writes one JSON file per accessed collection to `dist/content-vector-similarities/`. Each file contains every unique pair of entry IDs and its cosine similarity score, including scores below the configured threshold. The option is off by default.

```ts
import { getRelatedContent } from "astro-content-vectors/runtime";

const index = await getRelatedContent(documents, {
    provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "your-loaded-embedding-model",
    },
});
```

## Static builds on Cloudflare

Cloudflare Secrets Store values cannot be retrieved through Cloudflare's management API or dashboard after they are stored. Its `get()` binding is available to a running Worker, so it cannot provide the OpenAI key to a regular static build. See [Secrets Store management](https://developers.cloudflare.com/secrets-store/manage-secrets/) and the [Workers binding guide](https://developers.cloudflare.com/secrets-store/integrations/workers/).

For a static build, configure `OPENAI_API_KEY` as a protected build environment variable instead. For example, in GitHub Actions:

```yaml
- name: Build Astro site
  run: bun run build
  env:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The integration picks up this variable automatically. Keep it in the CI or hosting provider's secret settings; do not place its value in Astro config or commit it to the repository.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```
