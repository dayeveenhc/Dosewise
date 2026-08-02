import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The text-size setting works by multiplying every px-sized text class by
// `--dw-text` (see accessibility.tsx). That is opt-in per class, so a plain
// `text-[15px]` written later silently ignores the setting — invisible in
// review, and only noticeable to the person who needs the larger type.
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

describe("text scale", () => {
  it("has no px text size that opts out of the accessibility setting", () => {
    const offenders = tsxFiles("src").flatMap(file => {
      const lines = readFileSync(file, "utf8").split("\n");
      return lines.flatMap((line, i) =>
        /text-\[\d+(\.\d+)?px\]/.test(line) ? [`${file}:${i + 1}`] : []);
    });
    expect(offenders, "use text-[calc(NNpx*var(--dw-text,1))] instead").toEqual([]);
  });
});
