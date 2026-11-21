// ESM resolve hooks for modules the standalone server loads FROM DISK.
//
// Next's webpack build resolves jsconfig `paths` (`@/*` → `./src/*`, and the
// `open-sse` bare specifier); the tracing output is then only ever imported by
// the bundled server, so nothing at runtime ever needed those aliases. That
// changed when custom-server.js began importing `src/` modules directly by path
// (background token refresh) — Node has no jsconfig, so `@/lib/dataDir.js`
// resolved to nothing and the tick died with "Cannot find package '@/lib'".
//
// These hooks apply the same aliases for any specifier that is not a URL, not a
// Node builtin and not a package in node_modules. Registered by custom-server.js
// via module.register(), so `next dev` (which never loads custom-server.js) and
// the webpack build are unaffected.
import { pathToFileURL } from "node:url";
import path from "node:path";

const ALIASES = [
  { prefix: "@/", target: "src/" },
  { prefix: "open-sse/", target: "open-sse/" },
];

const isBare = (specifier) =>
  typeof specifier === "string" &&
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !specifier.startsWith("file:") &&
  !specifier.startsWith("node:") &&
  !specifier.startsWith("data:");

const isBuiltin = (specifier) => {
  try {
    return typeof process.getBuiltinModule === "function" && process.getBuiltinModule(specifier) !== undefined;
  } catch {
    return false;
  }
};

const rewrite = (specifier) => {
  if (!isBare(specifier) || isBuiltin(specifier)) return null;
  // "open-sse" (no slash) points at the package root; the directory has no
  // index at that level, so let Node fail there exactly as it did before.
  if (specifier === "open-sse") return null;
  for (const { prefix, target } of ALIASES) {
    if (specifier.startsWith(prefix)) return pathToFileURL(path.join(process.cwd(), target, specifier.slice(prefix.length))).href;
  }
  return null;
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = rewrite(specifier);
  if (mapped) return nextResolve(mapped, context);
  return nextResolve(specifier, context);
}
