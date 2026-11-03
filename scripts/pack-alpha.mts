import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = mkdtempSync(
    join(tmpdir(), "astro-content-vectors-alpha-"),
);
const temporaryPackage = mkdtempSync(
    join(tmpdir(), "astro-content-vectors-package-"),
);
const packageJsonPath = join(projectRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const baseVersion = packageJson.version.split("-")[0];
packageJson.version = `${baseVersion}-alpha.${Date.now()}`;

try {
    writeFileSync(
        join(temporaryPackage, "package.json"),
        `${JSON.stringify(packageJson, null, 4)}\n`,
    );
    cpSync(join(projectRoot, "dist"), join(temporaryPackage, "dist"), {
        recursive: true,
    });
    cpSync(join(projectRoot, "README.md"), join(temporaryPackage, "README.md"));
    cpSync(join(projectRoot, "LICENSE"), join(temporaryPackage, "LICENSE"));

    const result = spawnSync(
        "bun",
        [
            "pm",
            "pack",
            "--ignore-scripts",
            "--quiet",
            "--destination",
            outputDirectory,
        ],
        { cwd: temporaryPackage, encoding: "utf8" },
    );
    if (result.status !== 0) {
        process.stderr.write(result.stderr);
        process.exitCode = result.status ?? 1;
    } else {
        const archivePath = resolve(outputDirectory, result.stdout.trim());
        const escapedArchivePath = archivePath.replaceAll("'", "'\\''");
        process.stdout.write(
            [
                `Alpha version: ${packageJson.version}`,
                `Package: ${archivePath}`,
                "Install it from the project you want to test:",
                `  bun add '${escapedArchivePath}'`,
                "",
            ].join("\n"),
        );
    }
} finally {
    rmSync(temporaryPackage, { recursive: true, force: true });
}
