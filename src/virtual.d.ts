declare module "virtual:astro-content-vectors" {
    import type { RelatedContent } from "astro-content-vectors/runtime";

    export function getRelatedContent(
        collection: string,
        id: string,
    ): Promise<RelatedContent[]>;
}
