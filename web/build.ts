// Bundles every entry in src/entries into a self-contained IIFE per entry in
// dist/, named "<name>-<content-hash>.<ext>" so Go can serve them with
// immutable caching and templates only need to match the entry name prefix.
// main.css is the site-wide stylesheet: Tailwind utilities scanned from the
// Go templates.
//
//   bun run build.ts          one-off production build (minified)
//   bun --watch run build.ts  dev loop (rebuilds on change, inline sourcemaps)

import { readdir, rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const dev = process.argv.includes("--watch") || !!process.env.BUN_WATCH;

const entryDir = "src/entries";
const entrypoints = (await readdir(entryDir, { withFileTypes: true }))
  .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".css")))
  .map((e) => e.name)
  .sort()
  .map((name) => `${entryDir}/${name}`);

if (entrypoints.length === 0) {
  console.error(`no entries found in ${entryDir}`);
  process.exit(1);
}

// Drop stale hashed outputs from previous builds.
try {
  for (const ent of await readdir("dist", { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (ent.name.endsWith(".js") || ent.name.endsWith(".css") || ent.name.endsWith(".map")) {
      await rm(`dist/${ent.name}`);
    }
  }
} catch (err) {
  // dist does not exist yet; Bun.build creates it.
  if (!isEnoent(err)) throw err;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  naming: "[name]-[hash].[ext]",
  target: "browser",
  format: "iife",
  minify: !dev,
  sourcemap: dev ? "inline" : "none",
  plugins: [tailwind],
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}
for (const out of result.outputs) console.log("built", out.path);
