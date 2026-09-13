import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Test-only module resolver.
 *
 * The application source uses the two conventions Next.js provides but plain
 * Node does not: the `@/…` path alias, and extensionless relative imports.
 * This hook teaches Node both, so the real service modules can be imported
 * directly by the integration tests with no build step and no changes to the
 * source purely for testing's sake.
 *
 * Loaded via `node --import ./tests/helpers/loader.mjs`.
 */

const SRC = path.join(process.cwd(), "src");
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;

    // "@/lib/study" -> <cwd>/src/lib/study
    if (spec.startsWith("@/")) {
      spec = pathToFileURL(path.join(SRC, spec.slice(2))).href;
    }

    try {
      return nextResolve(spec, context);
    } catch (err) {
      // Bare package specifiers resolve above; only relative/absolute file
      // specifiers reach here, and only when the extension is missing.
      if (!spec.startsWith(".") && !spec.startsWith("file:") && !spec.startsWith("/")) throw err;

      const base = spec.startsWith("file:")
        ? spec
        : new URL(spec, context.parentURL ?? pathToFileURL(process.cwd() + "/")).href;

      for (const ext of EXTENSIONS) {
        const candidate = base + ext;
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate, context);
        }
      }
      throw err;
    }
  },
});
