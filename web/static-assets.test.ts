import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import * as esbuild from "esbuild";
import {
  assetContentHash,
  cleanCopiedAssets,
  collidingAssetNames,
  copyStaticAssets,
  hashedAssetFilename,
  isBundleOutput,
  logicalBundleName,
} from "./static-assets.ts";

const vectors: { name: string; bytes: Uint8Array; hash: string }[] = [
  { name: "logo.png", bytes: new TextEncoder().encode("hello asset\n"), hash: "FP6SD33N" },
  {
    name: "file.asc",
    bytes: new TextEncoder().encode("-----BEGIN PGP SIGNATURE-----\n"),
    hash: "FNLXQN5F",
  },
  { name: "hero.2x.webp", bytes: new TextEncoder().encode("a.b"), hash: "ACI3MOJ2" },
  { name: "empty.dat", bytes: new Uint8Array(), hash: "55DNWN2R" },
  { name: "bin.woff2", bytes: Uint8Array.from({ length: 256 }, (_, i) => i), hash: "D6WL5BAG" },
];

describe("assetContentHash", () => {
  for (const vector of vectors) {
    test(vector.name, () => {
      expect(assetContentHash(vector.bytes)).toBe(vector.hash);
      expect(hashedAssetFilename(vector.name, vector.bytes)).toBe(
        `${vector.name.slice(0, vector.name.lastIndexOf("."))}-${vector.hash}${vector.name.slice(vector.name.lastIndexOf("."))}`,
      );
    });
  }

  test("matches esbuild copy loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-hash-"));
    const source = join(root, "src");
    const out = join(root, "out");
    await mkdir(source);
    try {
      const entryPoints: string[] = [];
      const loader: Record<string, "copy"> = {};
      for (const vector of vectors) {
        const path = join(source, vector.name);
        await writeFile(path, vector.bytes);
        entryPoints.push(path);
        loader[vector.name.slice(vector.name.lastIndexOf("."))] = "copy";
      }
      const result = await esbuild.build({
        entryPoints,
        outdir: out,
        entryNames: "[name]-[hash]",
        assetNames: "[name]-[hash]",
        loader,
        bundle: true,
        write: true,
        metafile: true,
      });
      const built = Object.keys(result.metafile?.outputs ?? {})
        .map((path) => path.slice(path.lastIndexOf("/") + 1))
        .sort();
      const copied = vectors
        .map((vector) => hashedAssetFilename(vector.name, vector.bytes))
        .sort();
      expect(built).toEqual(copied);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("logicalBundleName", () => {
  test("script entries emit js and css stays css", () => {
    expect(logicalBundleName("home.tsx")).toBe("home.js");
    expect(logicalBundleName("about.ts")).toBe("about.js");
    expect(logicalBundleName("main.css")).toBe("main.css");
  });
});

describe("copyStaticAssets", () => {
  test("copies hashed bytes and drops the previous hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-copy-"));
    const source = join(root, "assets");
    const dist = join(root, "dist");
    await mkdir(source);
    await mkdir(dist);
    await writeFile(join(dist, ".gitkeep"), "");
    await writeFile(join(dist, "home-AAAAAAAA.js"), "bundle");
    await writeFile(join(source, ".gitkeep"), "");
    await writeFile(join(source, "logo.png"), vectors[0]!.bytes);
    await writeFile(join(source, "file.asc"), vectors[1]!.bytes);
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "README"), "no extension");
    try {
      const first = await copyStaticAssets(source, dist, ["home.js", "main.css"]);
      expect(first.sort()).toEqual(["file-FNLXQN5F.asc", "logo-FP6SD33N.png"]);
      expect(await readFile(join(dist, "logo-FP6SD33N.png"), "utf8")).toBe("hello asset\n");
      expect(await readFile(join(dist, "home-AAAAAAAA.js"), "utf8")).toBe("bundle");
      expect(await readFile(join(dist, ".gitkeep"), "utf8")).toBe("");

      await writeFile(join(source, "logo.png"), "changed");
      await writeFile(join(source, "vendor.js"), "plain");
      await writeFile(join(dist, "vendor-AAAAAAAA.js"), "stale");
      await cleanCopiedAssets(dist, ["home.js", "main.css"]);
      expect(await readFile(join(dist, "home-AAAAAAAA.js"), "utf8")).toBe("bundle");
      await expect(readFile(join(dist, "vendor-AAAAAAAA.js"))).rejects.toThrow();
      const second = await copyStaticAssets(source, dist, ["home.js", "main.css"]);
      expect(second.sort()).toEqual([
        "file-FNLXQN5F.asc",
        hashedAssetFilename("logo.png", new TextEncoder().encode("changed")),
        hashedAssetFilename("vendor.js", new TextEncoder().encode("plain")),
      ]);
      expect(isBundleOutput("home-AAAAAAAA.js", ["home.js"])).toBe(true);
      expect(isBundleOutput("home-AAAAAAAA.js.map", ["home.js"])).toBe(true);
      expect(isBundleOutput(hashedAssetFilename("vendor.js", new TextEncoder().encode("plain")), ["home.js"])).toBe(
        false,
      );
      await expect(readFile(join(dist, "logo-FP6SD33N.png"))).rejects.toThrow();
      expect(await readFile(join(dist, "home-AAAAAAAA.js"), "utf8")).toBe("bundle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a name esbuild will also emit", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-collide-"));
    const source = join(root, "assets");
    const dist = join(root, "dist");
    await mkdir(source);
    await writeFile(join(source, "home.js"), "not a bundle");
    await writeFile(join(source, "logo.png"), vectors[0]!.bytes);
    try {
      await expect(copyStaticAssets(source, dist, ["home.js"])).rejects.toThrow(/home\.js/);
      expect(collidingAssetNames(["home.js", "logo.png"], ["home.js", "main.css"])).toEqual(["home.js"]);
      await expect(readFile(join(dist, "logo-FP6SD33N.png"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("missing source directory copies nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-empty-"));
    try {
      expect(await copyStaticAssets(join(root, "missing"), join(root, "dist"))).toEqual([]);
      await expect(cleanCopiedAssets(join(root, "missing"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
