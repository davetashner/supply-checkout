// The marketing profile (marketing.mjs, journeys/marketing.json): which clips are recorded, how
// a result is found, what ffmpeg is asked for, and what is wrong with a clip.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { LIMITS, grepClips, mp4Args, planClips, posterArgs, problems, resultFor } from "./marketing.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const registry = read("../../journeys/registry.json");
const config = read("../../journeys/marketing.json");

test("the configured clips are Tested journeys, each with a test that exists in its file", () => {
  const clips = planClips(config, registry);
  assert.deepEqual(clips.map((c) => c.journey), ["J4", "J13", "J14", "J5"]);
  for (const clip of clips) {
    const file = new URL(`../../${clip.file}`, import.meta.url);
    assert.ok(existsSync(file), clip.file);
    assert.ok(readFileSync(file, "utf8").includes(clip.test), `${clip.file} has no test "${clip.test}"`);
    assert.ok(clip.caption.length > 10 && clip.caption.length < 90, clip.slug);
  }
});

test("a clip for a journey that isn't Tested, or doesn't exist, or a name used twice, is refused", () => {
  const clip = { slug: "x", file: "tests/a.spec.js", test: "t", caption: "c" };
  assert.throws(() => planClips({ clips: [{ ...clip, journey: "J12" }] }, registry), /only Tested journeys are marketed/);
  assert.throws(() => planClips({ clips: [{ ...clip, journey: "J1" }] }, registry), /"Partly built"/);
  assert.throws(() => planClips({ clips: [{ ...clip, journey: "J99" }] }, registry), /isn't in journeys\/registry\.json/);
  assert.throws(() => planClips({ clips: [{ ...clip, journey: "J4" }, { ...clip, journey: "J13" }] }, registry), /Two marketing clips are named x/);
});

test("--only picks clips by journey, and names the ones there are when it's wrong", () => {
  assert.deepEqual(planClips(config, registry, ["J5", "J4"]).map((c) => c.slug), ["checkout", "receipt"]);
  assert.throws(() => planClips(config, registry, ["J6"]), /No marketing clip for J6\. There are J4, J13, J14, J5/);
});

test("the grep matches each clip's test literally", () => {
  const clips = [{ test: "a (b) [c]. $1" }, { test: "plain" }];
  const re = new RegExp(grepClips(clips));
  assert.ok(re.test("x a (b) [c]. $1 @J4"));
  assert.ok(!re.test("a (b) c  $1"));
  assert.equal(grepClips(clips).split("|").length, 2);
});

test("a result is found by file and test title, with or without its describe block, and only when it's the one", () => {
  const clip = { file: "tests/a.spec.js", test: "does it" };
  const results = new Map([
    ["tests/a.spec.js:10:1:does it", { status: "passed" }],
    ["tests/b.spec.js:10:1:does it", { status: "failed" }],
  ]);
  assert.equal(resultFor(clip, results).status, "passed");
  assert.equal(resultFor(clip, new Map([["tests/a.spec.js:5:3:J1. Group › does it", { status: "passed" }]])).status, "passed");
  assert.equal(resultFor(clip, new Map()), null);
  assert.equal(resultFor(clip, new Map([["tests/a.spec.js:1:1:does it", {}], ["tests/a.spec.js:9:1:does it", {}]])), null);
  assert.equal(resultFor(clip, new Map([["tests/a.spec.js:1:1:also does it", {}]])), null);
});

test("ffmpeg makes an even-sized, streamable H.264 loop with no sound, and a poster", () => {
  const args = mp4Args("in.webm", "out.mp4", 390);
  assert.ok(args.includes("-an") && args.includes("libx264") && args.includes("yuv420p"));
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
  assert.match(args[args.indexOf("-vf") + 1], /^scale=390:-2/);
  assert.equal(args.at(-1), "out.mp4");
  const poster = posterArgs("out.mp4", "p.jpg", "9.50", 390);
  assert.equal(poster[poster.indexOf("-ss") + 1], "9.50");
  assert.ok(poster.includes("-frames:v") && poster.at(-1) === "p.jpg");
});

test("a clip over 3 MB, or outside 15 to 30 seconds, is a problem", () => {
  assert.deepEqual(problems("a", { bytes: 1e6, seconds: 20 }), []);
  assert.deepEqual(problems("a", { bytes: LIMITS.bytes, seconds: 15 }), []);
  assert.deepEqual(problems("a", { bytes: LIMITS.bytes + 1, seconds: 30 }).length, 1);
  assert.match(problems("a", { bytes: 1, seconds: 14.9 })[0], /under 15 s/);
  assert.match(problems("a", { bytes: 1, seconds: 31 })[0], /over 30 s/);
  assert.equal(problems("a", { bytes: 9e6, seconds: 1 }).length, 2);
});

test("the committed clips match the config: an MP4 and poster each, in range, with a manifest in order", () => {
  const manifest = read("../../site/clips/clips.json");
  assert.deepEqual(manifest.clips.map((c) => c.slug), config.clips.map((c) => c.slug));
  for (const c of manifest.clips) {
    assert.ok(existsSync(new URL(`../../site/clips/${c.mp4}`, import.meta.url)), c.mp4);
    assert.ok(existsSync(new URL(`../../site/clips/${c.poster}`, import.meta.url)), c.poster);
    assert.deepEqual(problems(c.slug, { bytes: c.bytes, seconds: c.seconds }), []);
    assert.equal(c.caption, config.clips.find((x) => x.slug === c.slug).caption);
  }
});
