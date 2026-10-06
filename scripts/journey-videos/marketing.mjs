// The marketing profile of the journey videos (record.mjs --marketing, journeys/marketing.json):
// which tests are recorded, and the MP4 loop and poster made from each recording. Free of
// Playwright, for journey-videos.test.mjs; ffmpeg runs only in `encode`.
import { execFileSync } from "node:child_process";
import { journeyStatus } from "../journeys.mjs";

// The length is after the clips are slowed (journeys/marketing.json `slow`)
export const LIMITS = { bytes: 3_000_000, minSeconds: 15, maxSeconds: 45 };

// The clips to record: those of the journeys in `only` (default all), each checked against the
// registry, so a clip names a journey that exists and is Tested
export function planClips(config, registry, only = null) {
  const journeys = new Map(registry.journeys.map((j) => [j.id, j]));
  const clips = config.clips.filter((c) => !only || only.includes(c.journey));
  const unknown = (only || []).filter((id) => !config.clips.some((c) => c.journey === id));
  if (unknown.length) throw new Error(`No marketing clip for ${unknown.join(", ")}. There are ${config.clips.map((c) => c.journey).join(", ")}.`);
  const seen = new Set();
  for (const clip of clips) {
    const journey = journeys.get(clip.journey);
    if (!journey) throw new Error(`Marketing clip ${clip.slug} names ${clip.journey}, which isn't in journeys/registry.json`);
    const status = journeyStatus(journey);
    if (!status.startsWith("Tested")) throw new Error(`Marketing clip ${clip.slug}: ${clip.journey} is "${status}", and only Tested journeys are marketed`);
    if (seen.has(clip.slug)) throw new Error(`Two marketing clips are named ${clip.slug}`);
    seen.add(clip.slug);
  }
  return clips;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Playwright's --grep for the clips' tests
export const grepClips = (clips) => clips.map((c) => escapeRegExp(c.test)).join("|");

// A clip's result in the report's results (assemble.readReport), whose keys are file:line:title
export function resultFor(clip, results) {
  const hits = [...results].filter(([key]) => key.startsWith(`${clip.file}:`) && (key.endsWith(`:${clip.test}`) || key.endsWith(` › ${clip.test}`)));
  return hits.length === 1 ? hits[0][1] : null;
}

// ffmpeg's arguments for the MP4 loop (H.264, no audio, streamable, `width` px wide) and the
// poster (a JPEG of the frame `at` seconds in)
// `slow` stretches the playback: 1.5 plays 50% slower
export const mp4Args = (input, output, width, slow = 1) => ["-y", "-loglevel", "error", "-i", input, "-an", "-vf", `setpts=${slow}*PTS,fps=24,scale=${width}:-2:flags=lanczos`, "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output];
export const posterArgs = (input, output, at, width) => ["-y", "-loglevel", "error", "-ss", String(at), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2:flags=lanczos`, "-q:v", "4", output];

export function durationOf(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
}

// What's wrong with a clip's size or length, if anything
export function problems(slug, { bytes, seconds }) {
  const out = [];
  if (bytes > LIMITS.bytes) out.push(`${slug}: ${(bytes / 1e6).toFixed(1)} MB is over ${LIMITS.bytes / 1e6} MB`);
  if (seconds < LIMITS.minSeconds) out.push(`${slug}: ${seconds.toFixed(0)} s is under ${LIMITS.minSeconds} s`);
  if (seconds > LIMITS.maxSeconds) out.push(`${slug}: ${seconds.toFixed(0)} s is over ${LIMITS.maxSeconds} s`);
  return out;
}

// The MP4 and poster for one recording. The poster is a frame from the middle, where the app is
// showing something, not the blank page the video starts on.
export function encode(webm, mp4, poster, { width, slow = 1 }) {
  execFileSync("ffmpeg", mp4Args(webm, mp4, width, slow));
  const seconds = durationOf(mp4);
  execFileSync("ffmpeg", posterArgs(mp4, poster, (seconds * 0.55).toFixed(2), width));
  return seconds;
}
