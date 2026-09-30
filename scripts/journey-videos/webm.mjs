// Joins WebM videos end to end without re-encoding, for journey videos (record.mjs): each
// test's Playwright video, and the cards between them. Playwright's own ffmpeg can't join videos
// (it has no concat), so this rewrites the Matroska structure itself: the first video's header,
// info and tracks, then every video's clusters with their timestamps moved along, then cues so
// players can seek. The videos must share their codec, size and timestamp scale, as Playwright's
// VP8 videos of one size do.
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Info: 0x1549a966, Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675, Cues: 0x1c53bb6b, Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469, Void: 0xec,
  TimecodeScale: 0x2ad7b1, Duration: 0x4489, Timecode: 0xe7, PrevSize: 0xab, Position: 0xa7,
  SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb, BlockDuration: 0x9b,
  Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  TrackEntry: 0xae, CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
};
const TOP_LEVEL = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);

// An element's ID (with its marker bits, as IDs are written) and its size
function readId(buf, pos) {
  const first = buf[pos];
  const len = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (!len) throw new Error(`Not a WebM element at byte ${pos}`);
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

function readSize(buf, pos) {
  const first = buf[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error(`Bad element size at byte ${pos}`);
  let value = first & (0xff >> len), unknown = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { size: unknown ? null : value, len };
}

// The elements between start and end, one level down
function* children(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const { id, len: idLen } = readId(buf, pos);
    const { size, len: sizeLen } = readSize(buf, pos + idLen);
    const data = pos + idLen + sizeLen;
    // A cluster of unknown size runs until the next top-level element
    let stop = size === null ? end : data + size;
    if (size === null && id === ID.Cluster) {
      let p = data;
      while (p < end) {
        const child = readId(buf, p);
        if (TOP_LEVEL.has(child.id)) break;
        const s = readSize(buf, p + child.len);
        p += child.len + s.len + (s.size ?? 0);
      }
      stop = p;
    }
    yield { id, start: pos, data, end: Math.min(stop, end) };
    pos = Math.min(stop, end);
  }
}

const readUint = (buf, start, end) => { let v = 0; for (let i = start; i < end; i++) v = v * 256 + buf[i]; return v; };

// The parts of a WebM file that joining needs
export function parseWebm(buf) {
  const top = [...children(buf, 0, buf.length)];
  const ebml = top.find((e) => e.id === ID.EBML);
  const segment = top.find((e) => e.id === ID.Segment);
  if (!ebml || !segment) throw new Error("Not a WebM file");
  const video = { header: buf.subarray(ebml.start, ebml.end), info: [], tracks: null, scale: 1e6, clusters: [], track: 1 };
  for (const el of children(buf, segment.data, segment.end)) {
    if (el.id === ID.Info) {
      for (const c of children(buf, el.data, el.end)) {
        if (c.id === ID.TimecodeScale) video.scale = readUint(buf, c.data, c.end);
        if (c.id !== ID.Duration) video.info.push(buf.subarray(c.start, c.end));
      }
    } else if (el.id === ID.Tracks) {
      video.tracks = buf.subarray(el.start, el.end);
      video.format = trackFormat(buf, el);
    } else if (el.id === ID.Cluster) {
      const cluster = { timecode: 0, body: [], last: 0, key: null };
      for (const c of children(buf, el.data, el.end)) {
        if (c.id === ID.Timecode) { cluster.timecode = readUint(buf, c.data, c.end); continue; }
        if (c.id === ID.PrevSize || c.id === ID.Position) continue;
        cluster.body.push(buf.subarray(c.start, c.end));
        const block = c.id === ID.SimpleBlock ? { data: c.data, key: !!(buf[c.data + readSize(buf, c.data).len + 2] & 0x80) }
          : c.id === ID.BlockGroup ? blockGroup(buf, c) : null;
        if (!block) continue;
        const track = readSize(buf, block.data);
        const offset = buf.readInt16BE(block.data + track.len);
        if (cluster.key === null) { cluster.key = block.key; video.track = track.size; }
        cluster.last = Math.max(cluster.last, offset);
      }
      video.clusters.push(cluster);
    }
  }
  if (!video.tracks) throw new Error("A WebM file without tracks");
  const last = video.clusters.at(-1);
  // One frame past the last one's start (Playwright records at 25 frames a second)
  video.duration = last ? last.timecode + last.last + Math.round(40e6 / video.scale) : 0;
  return video;
}

// Each track's codec and picture size, e.g. "V_VP8 1280x804": what joined videos must share
function trackFormat(buf, tracks) {
  const formats = [];
  for (const entry of children(buf, tracks.data, tracks.end)) {
    if (entry.id !== ID.TrackEntry) continue;
    let codec = "", size = "";
    for (const c of children(buf, entry.data, entry.end)) {
      if (c.id === ID.CodecID) codec = buf.toString("latin1", c.data, c.end);
      if (c.id === ID.Video) {
        const dims = {};
        for (const d of children(buf, c.data, c.end)) if (d.id === ID.PixelWidth || d.id === ID.PixelHeight) dims[d.id] = readUint(buf, d.data, d.end);
        size = `${dims[ID.PixelWidth]}x${dims[ID.PixelHeight]}`;
      }
    }
    formats.push(`${codec} ${size}`.trim());
  }
  return formats.join(", ");
}

function blockGroup(buf, group) {
  let data = null, key = true;
  for (const c of children(buf, group.data, group.end)) {
    if (c.id === ID.Block) data = c.data;
    if (c.id === ID.ReferenceBlock) key = false;
  }
  return data === null ? null : { data, key };
}

// Writing: IDs as they are, sizes and numbers in a fixed 8 bytes, so sizes are known in advance
const idBytes = (id) => { const out = []; while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); } return Buffer.from(out); };
const size8 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); b[0] = 0x01; return b; };
const uint8 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const element = (id, ...body) => { const data = Buffer.concat(body); return Buffer.concat([idBytes(id), size8(data.length), data]); };
const uintElement = (id, n) => element(id, uint8(n));
const floatElement = (id, n) => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return element(id, b); };

// Joins the videos into out; returns each input's start and the total, in seconds. It reads each
// video twice (once to lay out the joined file, once to write it) so only one is in memory at a time.
export function concatWebm(files, out) {
  if (!files.length) throw new Error("No videos to join");
  const layout = [];
  let offset = 0, first;
  for (const file of files) {
    const video = parseWebm(readFileSync(file));
    if (!first) first = { header: video.header, info: video.info, tracks: video.tracks, scale: video.scale, track: video.track, format: video.format };
    else if (video.scale !== first.scale) throw new Error(`${file} has a different timestamp scale from ${files[0]}`);
    else if (video.format !== first.format) throw new Error(`${file} is ${video.format}, but ${files[0]} is ${first.format}: joined videos need the same codec and size`);
    layout.push({ file, offset, clusters: video.clusters.map((c) => ({ time: offset + c.timecode, key: c.key, size: clusterSize(c) })) });
    offset += video.duration;
  }
  const info = element(ID.Info, ...first.info, floatElement(ID.Duration, offset));
  // Positions are from the start of the segment's data. The seek head and cues have fixed sizes:
  // every number in them takes 8 bytes.
  const seekEntry = (id, pos) => element(ID.Seek, element(ID.SeekID, idBytes(id)), uintElement(ID.SeekPosition, pos));
  const seekHeadSize = element(ID.SeekHead, seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)).length;
  const infoPos = seekHeadSize, tracksPos = infoPos + info.length;
  let pos = tracksPos + first.tracks.length;
  const cuePoints = [];
  for (const c of layout.flatMap((v) => v.clusters)) {
    if (c.key) cuePoints.push(element(ID.CuePoint, uintElement(ID.CueTime, c.time), element(ID.CueTrackPositions, uintElement(ID.CueTrack, first.track), uintElement(ID.CueClusterPosition, pos))));
    pos += c.size;
  }
  const cues = element(ID.Cues, ...cuePoints);
  const seekHead = element(ID.SeekHead, seekEntry(ID.Info, infoPos), seekEntry(ID.Tracks, tracksPos), seekEntry(ID.Cues, pos));
  const fd = openSync(out, "w");
  try {
    for (const part of [first.header, idBytes(ID.Segment), size8(pos + cues.length), seekHead, info, first.tracks]) writeSync(fd, part);
    for (const v of layout) {
      for (const c of parseWebm(readFileSync(v.file)).clusters) writeSync(fd, clusterBytes(c, v.offset));
    }
    writeSync(fd, cues);
  } finally {
    closeSync(fd);
  }
  const seconds = (t) => (t * first.scale) / 1e9;
  return { starts: layout.map((v) => seconds(v.offset)), duration: seconds(offset) };
}

const clusterBytes = (c, offset) => element(ID.Cluster, uintElement(ID.Timecode, offset + c.timecode), ...c.body);
// ID (4 bytes), size (8), the timecode element (1 + 8 + 8), and the blocks
const clusterSize = (c) => 4 + 8 + 17 + c.body.reduce((n, b) => n + b.length, 0);

// A video's length in seconds
export const webmDuration = (file) => { const v = parseWebm(readFileSync(file)); return (v.duration * v.scale) / 1e9; };
