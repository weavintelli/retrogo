// Bundles every entry in src/entries into dist/<name>-<hash>.<ext>.
// JS and TSX entries are self-contained IIFEs. CSS entries are compiled by
// the official Tailwind PostCSS plugin, then emitted by esbuild with the
// same hashed name. Go serves those files and resolves the hash from the
// entry name, so the output shape stays <name>-<hash>.<ext>.
//
//   bun run build.ts           production build (minified)
//   bun run build.ts --watch   rebuild on change

import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const watch = process.argv.includes("--watch");
const entryDir = "src/entries";

const entrypoints = (await readdir(entryDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .map((name) => join(entryDir, name));

if (entrypoints.length === 0) {
  console.error(`no entries found in ${entryDir}`);
  process.exit(1);
}

const tailwind = postcss([
  tailwindcss({ optimize: watch ? false : { minify: true } }),
]);

const tailwindPlugin: esbuild.Plugin = {
  name: "tailwind",
  setup(build) {
    build.onStart(async () => {
      await cleanDist();
    });
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const result = await tailwind.process(source, { from: args.path });
      const watchFiles = [args.path];
      for (const message of result.messages) {
        if (message.type === "dependency" && message.file) watchFiles.push(message.file);
      }
      return { contents: result.css, loader: "css", watchFiles };
    });
    build.onEnd((result) => {
      for (const file of Object.keys(result.metafile?.outputs ?? {})) {
        if (file.endsWith(".map")) continue;
        console.log("built", file);
      }
    });
  },
};

async function cleanDist(): Promise<void> {
  let entries;
  try {
    entries = await readdir("dist", { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      if (entry.name === ".gitkeep") return;
      if (/\.(js|css|map)$/.test(entry.name)) await rm(join("dist", entry.name));
    }),
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const options: esbuild.BuildOptions = {
  entryPoints: entrypoints,
  outdir: "dist",
  entryNames: "[name]-[hash]",
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  metafile: true,
  plugins: [tailwindPlugin],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching");
  await new Promise(() => {});
} else {
  await esbuild.build(options);
}
