import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import * as esbuild from "esbuild";
import {
  assertNoAssetCollision,
  cleanOutput,
  collidingAssetNames,
  listStaticAssets,
  logicalBundleName,
  staticAssetPlugin,
} from "./build.ts";

const vectors: { name: string; bytes: Uint8Array }[] = [
  { name: "logo.png", bytes: new TextEncoder().encode("hello asset\n") },
  { name: "file.asc", bytes: new TextEncoder().encode("-----BEGIN PGP SIGNATURE-----\n") },
  { name: "hero.2x.webp", bytes: new TextEncoder().encode("a.b") },
  { name: "empty.dat", bytes: new Uint8Array() },
  { name: "bin.woff2", bytes: Uint8Array.from({ length: 256 }, (_, i) => i) },
  { name: "vendor.js", bytes: new TextEncoder().encode("not a program") },
];

function outputNames(metafile: esbuild.Metafile | undefined): string[] {
  return Object.keys(metafile?.outputs ?? {})
    .filter((file) => !file.endsWith(".map"))
    .map((file) => file.slice(file.lastIndexOf("/") + 1))
    .sort();
}

describe("logicalBundleName", () => {
  test("script entries emit js and css stays css", () => {
    expect(logicalBundleName("home.tsx")).toBe("home.js");
    expect(logicalBundleName("about.ts")).toBe("about.js");
    expect(logicalBundleName("main.css")).toBe("main.css");
  });
});

describe("listStaticAssets", () => {
  test("skips dotfiles, directories, and extensionless names", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-list-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, ".gitkeep"), "");
    await writeFile(join(root, "README"), "no extension");
    await writeFile(join(root, "logo.png"), "x");
    await writeFile(join(root, "file.asc"), "y");
    try {
      expect(await listStaticAssets(root)).toEqual(["file.asc", "logo.png"]);
      expect(await listStaticAssets(join(root, "missing"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("static asset copy loader", () => {
  test("matches loader copy and does not parse the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-copy-"));
    const source = join(root, "assets");
    const out = join(root, "out");
    const native = join(root, "native");
    await mkdir(source);
    await writeFile(join(source, "home.ts"), "console.log(1)\n");
    const assetPaths: string[] = [];
    const loader: Record<string, "copy"> = {};
    for (const vector of vectors) {
      await writeFile(join(source, vector.name), vector.bytes);
      assetPaths.push(join(source, vector.name));
      loader[vector.name.slice(vector.name.lastIndexOf("."))] = "copy";
    }
    try {
      const copied = await esbuild.build({
        entryPoints: [join(source, "home.ts"), ...assetPaths],
        outdir: out,
        entryNames: "[name]-[hash]",
        bundle: true,
        format: "iife",
        write: true,
        metafile: true,
        plugins: [
          staticAssetPlugin({ distDir: out, assetPaths, bundleNames: ["home.js"] }),
        ],
        logLevel: "silent",
      });
      const direct = await esbuild.build({
        absWorkingDir: source,
        entryPoints: vectors.map((vector) => vector.name),
        outdir: native,
        entryNames: "[name]-[hash]",
        bundle: true,
        loader,
        write: true,
        metafile: true,
        logLevel: "silent",
      });
      const copiedAssets = outputNames(copied.metafile).filter((name) => !name.startsWith("home-"));
      expect(copiedAssets).toEqual(outputNames(direct.metafile));
      expect(outputNames(copied.metafile).some((name) => name.startsWith("home-") && name.endsWith(".js"))).toBe(
        true,
      );
      const vendor = copiedAssets.find((name) => name.startsWith("vendor-") && name.endsWith(".js"));
      expect(vendor).toBeDefined();
      expect(await readFile(join(out, vendor!))).toEqual(Buffer.from("not a program"));
      const home = outputNames(copied.metafile).find((name) => name.startsWith("home-"));
      expect(await readFile(join(out, home!), "utf8")).toContain("console.log");
      for (const vector of vectors) {
        if (vector.name === "vendor.js") continue;
        const ext = vector.name.slice(vector.name.lastIndexOf("."));
        const stem = vector.name.slice(0, vector.name.lastIndexOf("."));
        const file = copiedAssets.find((name) => name.startsWith(`${stem}-`) && name.endsWith(ext));
        expect(file, vector.name).toBeDefined();
        expect(await readFile(join(out, file!))).toEqual(Buffer.from(vector.bytes));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a bundle name before deleting the output", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-collide-"));
    const source = join(root, "assets");
    const out = join(root, "out");
    await mkdir(source);
    await mkdir(out);
    await writeFile(join(out, "keep.js"), "keep");
    await writeFile(join(source, "home.js"), "not a bundle");
    await writeFile(join(source, "logo.png"), "x");
    try {
      expect(collidingAssetNames(["home.js", "logo.png"], ["home.js"])).toEqual(["home.js"]);
      assertNoAssetCollision(["logo.png"], ["home.js"]);
      await expect(
        esbuild.build({
          entryPoints: [join(source, "home.js"), join(source, "logo.png")],
          outdir: out,
          entryNames: "[name]-[hash]",
          bundle: true,
          write: true,
          plugins: [
            staticAssetPlugin({
              distDir: out,
              assetPaths: [join(source, "home.js"), join(source, "logo.png")],
              bundleNames: ["home.js"],
            }),
          ],
          logLevel: "silent",
        }),
      ).rejects.toThrow(/home\.js/);
      expect(await readFile(join(out, "keep.js"), "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops a stale hashed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-stale-"));
    const source = join(root, "assets");
    const out = join(root, "out");
    await mkdir(source);
    await mkdir(out);
    await writeFile(join(out, ".gitkeep"), "");
    await writeFile(join(out, "logo-OLDHASH1.png"), "stale");
    await writeFile(join(source, "logo.png"), "fresh");
    const assetPath = join(source, "logo.png");
    try {
      await esbuild.build({
        entryPoints: [assetPath],
        outdir: out,
        entryNames: "[name]-[hash]",
        bundle: true,
        write: true,
        metafile: true,
        plugins: [
          staticAssetPlugin({ distDir: out, assetPaths: [assetPath], bundleNames: [] }),
        ],
        logLevel: "silent",
      });
      expect(await readFile(join(out, ".gitkeep"), "utf8")).toBe("");
      await expect(readFile(join(out, "logo-OLDHASH1.png"))).rejects.toThrow();
      const written = (await listStaticAssets(out)).filter((name) => name.startsWith("logo-"));
      expect(written).toHaveLength(1);
      expect(await readFile(join(out, written[0]!), "utf8")).toBe("fresh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleanOutput keeps dotfiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrogo-clean-"));
    await writeFile(join(root, ".gitkeep"), "");
    await writeFile(join(root, "gone.txt"), "x");
    try {
      await cleanOutput(root);
      expect(await readFile(join(root, ".gitkeep"), "utf8")).toBe("");
      await expect(readFile(join(root, "gone.txt"))).rejects.toThrow();
      await expect(cleanOutput(join(root, "missing"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
