import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { releaseCompose } from "../release-compose.mjs";

const source = await readFile(new URL("../../compose.yaml", import.meta.url), "utf8");

test("bundle replaces a stale source tag with the shipped image, without environment overrides", () => {
  const stale = source.replace(/^    image:.*$/m, "    image: ${EZPZ_IMAGE:-ezpz-studio:old-version}");
  for (const image of ["ezpz-studio:0.1.5", "ezpz-studio:future-version", "localhost:5000/studio:ci-test"]) {
    const result = releaseCompose(stale, image);
    assert.equal(result.match(/^    image: (.*)$/m)[1], JSON.stringify(image));
    assert.doesNotMatch(result, /EZPZ_IMAGE|old-version|^    build:/m);
    // Preserve ports, volumes, provider configuration, and runtime restrictions.
    assert.equal(result.slice(result.indexOf("    ports:")), stale.slice(stale.indexOf("    ports:")));
  }
});

test("unexpected Compose structure fails instead of producing an ambiguous installer", () => {
  assert.throws(() => releaseCompose(source.replace(/^    image:.*\n/m, ""), "studio:test"), /Expected one studio image/);
  assert.throws(() => releaseCompose(source + "    image: another-service\n", "studio:test"), /Expected one studio image/);
  assert.throws(() => releaseCompose(source.replace("    build: .", "    build: ./other"), "studio:test"), /Expected one studio image/);
});
