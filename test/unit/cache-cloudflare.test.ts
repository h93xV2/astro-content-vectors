import { describe, expect, test } from "bun:test";
import type Cloudflare from "cloudflare";
import { D1Driver } from "../../src/embeddings/cache/drivers/cloudflare.js";
import type { ContentVectorsConfig } from "../../src/types.js";

type D1Response = {
    result: Array<{
        success: boolean;
        results?: unknown[];
    }>;
};

const makeDriver = (responses: Array<D1Response | Error>) => {
    const calls: Array<{
        databaseId: string;
        params: { account_id: string; sql: string; params?: string[] };
    }> = [];
    const client = {
        d1: {
            database: {
                query: async (
                    databaseId: string,
                    params: {
                        account_id: string;
                        sql: string;
                        params?: string[];
                    },
                ) => {
                    calls.push({ databaseId, params });
                    const response = responses.shift();
                    if (response instanceof Error) throw response;
                    return response;
                },
            },
        },
    } as unknown as Cloudflare;

    return {
        driver: new D1Driver(client, "database-id", "account-id"),
        calls,
    };
};

const config = { logLevel: "silent" } as ContentVectorsConfig;

describe("D1 embedding cache driver", () => {
    test("initializes the table and passes the configured database IDs", async () => {
        const { driver, calls } = makeDriver([{ result: [{ success: true }] }]);
        await driver.initialize(config, "CREATE TABLE embeddings (...)");

        expect(calls).toEqual([
            {
                databaseId: "database-id",
                params: {
                    account_id: "account-id",
                    sql: "CREATE TABLE embeddings (...)",
                },
            },
        ]);
    });

    test("throws when D1 reports an unsuccessful initialization", async () => {
        const { driver } = makeDriver([{ result: [{ success: false }] }]);

        await expect(
            driver.initialize(config, "CREATE TABLE embeddings (...)"),
        ).rejects.toThrow("D1 query failed");
    });

    test("returns the first row from a successful query", async () => {
        const row = {
            post_id: "post-a",
            post_hash: "hash-a",
            embedding: "[0.1,0.2]",
        };
        const { driver, calls } = makeDriver([
            { result: [{ success: true, results: [row] }] },
        ]);

        await expect(
            driver.query("SELECT * FROM embeddings WHERE post_id = ?", [
                "post-a",
            ]),
        ).resolves.toEqual(row);
        expect(calls[0]?.params).toEqual({
            account_id: "account-id",
            sql: "SELECT * FROM embeddings WHERE post_id = ?",
            params: ["post-a"],
        });
    });

    test("returns undefined when a successful query finds no row", async () => {
        const { driver } = makeDriver([
            { result: [{ success: true, results: [] }] },
        ]);

        await expect(
            driver.query("SELECT * FROM embeddings WHERE post_id = ?", [
                "missing",
            ]),
        ).resolves.toBeUndefined();
    });

    test("throws instead of treating a failed query as a cache miss", async () => {
        const { driver } = makeDriver([{ result: [{ success: false }] }]);

        await expect(
            driver.query("SELECT * FROM embeddings", []),
        ).rejects.toThrow("D1 query failed");
    });

    test("executes writes and propagates unsuccessful write responses", async () => {
        const { driver, calls } = makeDriver([
            { result: [{ success: true }] },
            { result: [{ success: false }] },
        ]);

        await driver.update("INSERT INTO embeddings VALUES (?, ?, ?)", [
            "post-a",
            "hash-a",
            "[0.1,0.2]",
        ]);
        expect(calls[0]?.params.params).toEqual([
            "post-a",
            "hash-a",
            "[0.1,0.2]",
        ]);

        await expect(
            driver.update("INSERT INTO embeddings VALUES (?, ?, ?)", []),
        ).rejects.toThrow("D1 query failed");
    });

    test("propagates transport errors", async () => {
        const { driver } = makeDriver([new Error("network unavailable")]);

        await expect(
            driver.query("SELECT * FROM embeddings", []),
        ).rejects.toThrow("network unavailable");
    });
});
