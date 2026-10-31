import type { ContentVectorsConfig } from "./types.js";

const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

const defaultLogger: NonNullable<ContentVectorsConfig["logger"]> = (
    level,
    message,
) => {
    const method = level === "debug" ? "log" : level;
    console[method](`[astro-content-vectors] ${message}`);
};

export const log = (
    config: ContentVectorsConfig,
    level: "error" | "warn" | "info" | "debug",
    message: string,
) => {
    if (levels[config.logLevel ?? "warn"] >= levels[level]) {
        (config.logger ?? defaultLogger)(level, message);
    }
};
