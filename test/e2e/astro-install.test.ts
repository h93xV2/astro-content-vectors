import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
) =>
    new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, {
            ...options,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);

        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", (code, signal) => {
            clearTimeout(timeout);
            if (code !== 0) {
                reject(
                    new Error(
                        `${command} ${args.join(" ")} failed (${signal ?? code}).\n${stdout}\n${stderr}`,
                    ),
                );
                return;
            }
            resolve(stdout);
        });
    });

describe("installed Astro package", () => {
    test("installs the packed package and builds a static Astro fixture", async () => {
        const projectRoot = process.cwd();
        const tempDirectory = mkdtempSync(
            join(tmpdir(), "astro-content-vectors-install-"),
        );
        const siteDirectory = join(tempDirectory, "site");
        const fixtureDirectory = join(projectRoot, "test/fixtures/astro-build");
        const manifest = JSON.parse(
            readFileSync(join(projectRoot, "package.json"), "utf8"),
        ) as {
            name: string;
            version: string;
            devDependencies: { astro: string };
        };
        const archive = join(
            tempDirectory,
            `${manifest.name}-${manifest.version}.tgz`,
        );

        let embeddingRequestCount = 0;
        let embeddingInputs: string[] = [];
        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const payload = JSON.parse(
                    Buffer.concat(chunks).toString("utf8"),
                ) as { input: string[] };
                embeddingRequestCount++;
                embeddingInputs = payload.input;
                response.writeHead(200, {
                    "content-type": "application/json",
                });
                response.end(
                    JSON.stringify({
                        data: payload.input.map((_, index) => ({
                            index,
                            embedding: index === 0 ? [1, 0] : [0.9, 0.1],
                        })),
                    }),
                );
            });
        });

        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("Could not start the mock embeddings server.");
            }

            cpSync(fixtureDirectory, siteDirectory, { recursive: true });
            const fixtureManifest = JSON.parse(
                readFileSync(join(siteDirectory, "package.json"), "utf8"),
            ) as {
                dependencies?: Record<string, string>;
            };
            fixtureManifest.dependencies = {
                astro: manifest.devDependencies.astro,
                [manifest.name]: `file:${archive}`,
            };
            await Bun.write(
                join(siteDirectory, "package.json"),
                `${JSON.stringify(fixtureManifest, null, 2)}\n`,
            );

            await run(
                "npm",
                [
                    "pack",
                    "--ignore-scripts",
                    "--pack-destination",
                    tempDirectory,
                ],
                { cwd: projectRoot },
            );
            await run(process.execPath, ["install", "--prefer-offline"], {
                cwd: siteDirectory,
            });
            const buildOutput = await run(process.execPath, ["run", "build"], {
                cwd: siteDirectory,
                env: {
                    ...process.env,
                    TEST_EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
                },
            });

            const builtHtml = readFileSync(
                join(siteDirectory, "dist/index.html"),
                "utf8",
            );
            expect(
                builtHtml.includes("second"),
                `Expected the build to render a related entry.\nInputs: ${JSON.stringify(embeddingInputs)}\nBuild output:\n${buildOutput}`,
            ).toBe(true);
            expect(embeddingRequestCount).toBe(1);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(tempDirectory, { recursive: true, force: true });
        }
    }, 30_000);
});
