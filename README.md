# astro-content-vectors

An Astro integration that ranks entries in a content collection by embedding similarity. It uses OpenAI when `OPENAI_API_KEY` is available and automatically falls back to a local LM Studio server when the key is missing or OpenAI is unreachable.

Requires Astro 7 or later and Node.js 20 or later for the build process.

## Install

```sh
npm install astro-content-vectors
# or: pnpm add astro-content-vectors
# or: bun add astro-content-vectors
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

Set `OPENAI_API_KEY` in the environment where the Astro build runs. The integration detects it automatically and never puts the key into client bundles or injected configuration. Without the key, it tries the configured LM Studio fallback. If an OpenAI request fails, it tries the fallback once. If both providers fail, it logs a warning and returns no recommendations by default; set `failOnError: true` to fail the build instead. Start LM Studio's local server and load an embedding model for the fallback to work.

Astro `dev` uses the `development` override; `astro build` uses `production`. The integration selects an override using Astro's `import.meta.env.MODE`, so custom modes such as `astro build --mode preview` work as environment keys too. Set `environment` to explicitly override the detected mode. Each environment may override the single default `provider`; any omitted settings inherit from the default. OpenAI environments use the default LM Studio fallback; configure it with the top-level `fallback` option or set `fallback: false` to disable it. An environment configured with LM Studio uses only that provider.

### Provider configuration

Both providers use the OpenAI embeddings API format. OpenAI uses `https://api.openai.com/v1` by default; LM Studio uses `http://127.0.0.1:1234/v1`. Set `baseUrl` when your server listens elsewhere, and set `model` to a model available to that provider. LM Studio defaults to `text-embedding-nomic-embed-text-v1.5`; OpenAI defaults to `text-embedding-3-small`.

| Provider setting | Description |
| --- | --- |
| `type` | `"openai"` or `"lmstudio"`. Defaults to `"openai"`. |
| `baseUrl` | OpenAI-compatible API base URL. Defaults depend on `type`. |
| `model` | Embedding model name. Defaults depend on `type`. |
| `batchSize` | Content entries per embedding request. Defaults to `32`. |

The OpenAI SDK sends one request per batch, does not retry failed requests, and times out a request after 60 seconds. A failed OpenAI request can then use the configured LM Studio fallback.

### Integration options

| Option | Default | Description |
| --- | --- | --- |
| `collections` | all collections | Optional allowlist of Astro content collections to index. |
| `provider` | OpenAI | Default provider and its settings. |
| `environments` | `{}` | Provider overrides keyed by environment name. |
| `environment` | `"development"` for `astro dev`; `"production"` for `astro build` | Explicit environment key to select an override. |
| `fallback` | LM Studio | Fallback settings for an OpenAI provider. Set to `false` to disable fallback. |
| `threshold` | `0.65` | Minimum cosine similarity score for a recommendation. |
| `limit` | `3` | Maximum recommendations returned per entry. |
| `logLevel` | `"warn"` | One of `"silent"`, `"error"`, `"warn"`, `"info"`, or `"debug"`. |
| `failOnError` | `false` | Throw if no configured provider can generate embeddings. |
| `cache` | `true` | Store embeddings in SQLite during Astro builds. |
| `cachePath` | `.astro/embeddings.db` | SQLite file path, relative to the project root. |
| `outputSimilarityScores` | `false` | Write pairwise similarity score JSON files into the build output. |

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

Each collection is indexed once per server/build process. The integration embeds each entry's title, description (if any), and Markdown body. `getRelatedContent(collection, id)` returns an array of `{ id, score }` objects, ordered by descending cosine similarity. The current entry is excluded from its own recommendations. Entries scoring below `threshold` are omitted. Set `logLevel` to `silent` to disable logs.

By default, generated vectors are cached in `.astro/embeddings.db` using SQLite. The cache is keyed by collection, entry ID, provider, and model, and refreshes an entry when its source text changes. Set `cache: false` to disable it or `cachePath` to choose another database file.

The integration uses the OpenAI SDK for embedding requests. LM Studio works through its OpenAI-compatible API. The runtime API is also exported for custom content loaders:

The runtime helper accepts documents with an `id` and optional `title`, `text`, and `body` fields. Its configuration requires a provider `baseUrl` and `model`; SQLite caching is disabled for direct runtime calls unless `cache: true` is passed.

To inspect how your content compares while tuning `threshold`, enable the optional score report:

```ts
contentVectors({
    outputSimilarityScores: true,
    threshold: 0.7,
});
```

During a static build, this writes one JSON file per accessed collection to `.astro/content-vector-similarities/`, alongside the default embeddings cache. Each file contains every unique pair of entry IDs and its cosine similarity score, including scores below the configured threshold. The option is off by default. The reports stay out of `dist` and are not included in the deployed site unless you copy them there yourself.

```ts
import { getRelatedContent } from "astro-content-vectors/runtime";

const index = await getRelatedContent(documents, {
    provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "your-loaded-embedding-model",
    },
    cache: true,
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
bun run check
bun run typecheck
bun run test
bun run test:package
bun run test:astro-install
bun run build
```

`bun run test` runs the unit and integration suites. `bun run test:package` builds the package and checks its exports. `bun run test:astro-install` packs and installs the package into a temporary Astro 7 fixture, then runs a static build against a local mock embeddings server.
