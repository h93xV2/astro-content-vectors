import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = tmpdir();
const alphaDirectoryPrefix = "astro-content-vectors-alpha-";
const alphaArchivePattern = /^astro-content-vectors-.+-alpha\.\d+\.tgz$/;
let removed = 0;

for (const entry of readdirSync(temporaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(alphaDirectoryPrefix)) {
        continue;
    }
    const directory = join(temporaryRoot, entry.name);
    const containsAlphaArchive = readdirSync(directory).some((file) =>
        alphaArchivePattern.test(file),
    );
    if (containsAlphaArchive) {
        rmSync(directory, { recursive: true, force: true });
        removed++;
    }
}

console.log(
    `Removed ${removed} local alpha package${removed === 1 ? "" : "s"}.`,
);
