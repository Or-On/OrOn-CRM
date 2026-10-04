function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new TypeError("Incomplete MP4 or H.264 structure");
  return value;
}

function h264Bits(packet: Uint8Array) {
  const data: number[] = [];
  for (let index = 1; index < packet.length; index++) {
    if (
      index >= 3 &&
      packet[index] === 3 &&
      packet[index - 1] === 0 &&
      packet[index - 2] === 0
    )
      continue;
    data.push(required(packet[index]));
  }
  let bit = 0;
  const read = (count: number): number => {
    if (count > 32 || bit + count > data.length * 8)
      throw new TypeError("Truncated H.264 bitstream");
    let value = 0;
    for (let index = 0; index < count; index++, bit++)
      value = value * 2 + ((required(data[bit >>> 3]) >>> (7 - (bit & 7))) & 1);
    return value;
  };
  const ue = (): number => {
    let zeros = 0;
    while (!read(1))
      if (++zeros > 24)
        throw new TypeError("H.264 syntax exceeds its safety limit");
    return 2 ** zeros - 1 + read(zeros);
  };
  return { read, ue };
}

function validateSps(
  packet: Uint8Array,
  width: number,
  height: number,
): number {
  if (packet.length > 4096)
    throw new TypeError("H.264 sequence parameters exceed the safety limit");
  const bits = h264Bits(packet);
  const profile = bits.read(8);
  bits.read(8);
  const level = bits.read(8);
  const identity = bits.ue();
  if (![66, 77, 100].includes(profile) || level > 42 || identity > 31)
    throw new TypeError("Unsupported H.264 sequence profile");
  let chroma = 1;
  if (profile === 100) {
    chroma = bits.ue();
    if (chroma !== 1 || bits.ue() !== 0 || bits.ue() !== 0)
      throw new TypeError("Only 8-bit H.264 4:2:0 is supported");
    bits.read(1);
    if (bits.read(1))
      throw new TypeError("Custom H.264 scaling matrices are unsupported");
  }
  if (bits.ue() > 12) throw new TypeError("Invalid H.264 frame counter");
  const order = bits.ue();
  if (order === 0) {
    if (bits.ue() > 12) throw new TypeError("Invalid H.264 picture counter");
  } else if (order === 1) {
    bits.read(1);
    bits.ue();
    bits.ue();
    const cycle = bits.ue();
    if (cycle > 256)
      throw new TypeError("H.264 picture cycle exceeds its safety limit");
    for (let i = 0; i < cycle; i++) bits.ue();
  } else if (order !== 2) throw new TypeError("Invalid H.264 picture order");
  if (bits.ue() > 16)
    throw new TypeError("H.264 reference frames exceed the safety limit");
  bits.read(1);
  const columns = bits.ue() + 1;
  const rows = bits.ue() + 1;
  const frameOnly = bits.read(1);
  if (!frameOnly) throw new TypeError("Interlaced H.264 is unsupported");
  bits.read(1);
  let cropX = 0;
  let cropY = 0;
  if (bits.read(1)) {
    cropX = bits.ue() + bits.ue();
    cropY = bits.ue() + bits.ue();
  }
  if (
    chroma !== 1 ||
    columns * 16 - cropX * 2 !== width ||
    rows * 16 - cropY * 2 !== height
  )
    throw new TypeError("H.264 sequence dimensions do not match the MP4 track");
  return identity;
}

function validatePps(packet: Uint8Array, sequenceIds: Set<number>): number {
  if (packet.length > 4096)
    throw new TypeError("H.264 picture parameters exceed the safety limit");
  const bits = h264Bits(packet);
  const identity = bits.ue();
  if (identity > 255 || !sequenceIds.has(bits.ue()))
    throw new TypeError("Invalid H.264 picture parameter identity");
  bits.read(1);
  bits.read(1);
  if (bits.ue() !== 0 || bits.ue() > 15 || bits.ue() > 15)
    throw new TypeError("Unsupported H.264 slice groups or reference count");
  bits.read(1);
  bits.read(2);
  if (bits.ue() > 103 || bits.ue() > 103 || bits.ue() > 24)
    throw new TypeError("Invalid H.264 quantization parameters");
  bits.read(3);
  return identity;
}

/** Bounded, self-contained progressive MP4; no decoder or remote references. */
export function validatePrivateMp4(input: Uint8Array): void {
  if (input.byteLength < 128 || input.byteLength > 16 * 1024 * 1024)
    throw new TypeError("MP4 size must be between 128 bytes and 16 MiB");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  interface Box {
    type: string;
    start: number;
    end: number;
  }
  let boxesRead = 0;
  let packetsRead = 0;
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      if (++boxesRead > 4096 || start + 8 > end)
        throw new TypeError("MP4 box table exceeds its safety limit");
      let size = bytes.readUInt32BE(start);
      const type = bytes.toString("ascii", start + 4, start + 8);
      let header = 8;
      if (size === 1) {
        if (start + 16 > end)
          throw new TypeError("MP4 extended box is truncated");
        const large = bytes.readBigUInt64BE(start + 8);
        if (large > BigInt(input.byteLength))
          throw new TypeError("MP4 box is too large");
        size = Number(large);
        header = 16;
      }
      if (size < header || start + size > end)
        throw new TypeError("MP4 box length is invalid");
      result.push({ type, start: start + header, end: start + size });
      start += size;
    }
    return result;
  }
  function one(list: Box[], type: string): Box {
    const found = list.filter((box) => box.type === type);
    if (found.length !== 1) throw new TypeError(`MP4 requires one ${type} box`);
    return required(found[0]);
  }
  function full(box: Box, minimum: number): void {
    if (box.end - box.start < minimum || bytes.readUInt32BE(box.start) !== 0)
      throw new TypeError(`Unsupported or incomplete MP4 ${box.type} box`);
  }
  const top = boxes(0, bytes.length);
  if (top[0]?.type !== "ftyp" || top.some((box) => box.type === "moof"))
    throw new TypeError("Only progressive MP4 is supported");
  const ftyp = one(top, "ftyp");
  if (ftyp.end - ftyp.start < 12 || (ftyp.end - ftyp.start) % 4 !== 0)
    throw new TypeError("MP4 file type is invalid");
  const brands = new Set(["isom", "iso2", "mp41", "mp42", "avc1"]);
  if (!brands.has(bytes.toString("ascii", ftyp.start, ftyp.start + 4)))
    throw new TypeError("Unsupported MP4 container brand");
  const media = top.filter((box) => box.type === "mdat");
  if (!media.length || media.some((box) => box.start === box.end))
    throw new TypeError("MP4 has no complete media data");
  const movie = boxes(one(top, "moov").start, one(top, "moov").end);
  const movieHeader = one(movie, "mvhd");
  full(movieHeader, 100);
  const movieScale = bytes.readUInt32BE(movieHeader.start + 12);
  const movieDuration = bytes.readUInt32BE(movieHeader.start + 16);
  if (!movieScale || !movieDuration || movieDuration / movieScale > 180)
    throw new TypeError("MP4 movie duration exceeds the safety limit");
  if (movie.some((box) => box.type === "mvex"))
    throw new TypeError("Fragmented MP4 is not supported");
  const tracks = movie.filter((box) => box.type === "trak");
  if (tracks.length < 1 || tracks.length > 2)
    throw new TypeError("MP4 supports one video and optional AAC audio track");
  let videoTracks = 0;
  let audioTracks = 0;
  const occupied: { start: number; end: number }[] = [];
  for (const track of tracks) {
    const trackChildren = boxes(track.start, track.end);
    const trackHeader = one(trackChildren, "tkhd");
    if (
      trackHeader.end - trackHeader.start < 84 ||
      bytes[trackHeader.start] !== 0 ||
      bytes.readUInt32BE(trackHeader.start + 20) / movieScale > 180
    )
      throw new TypeError("Unsupported MP4 track header");
    const edits = trackChildren.filter((box) => box.type === "edts");
    if (edits.length > 1) throw new TypeError("Invalid MP4 edit list");
    if (edits[0]) {
      const edit = one(boxes(edits[0].start, edits[0].end), "elst");
      full(edit, 8);
      const count = bytes.readUInt32BE(edit.start + 4);
      if (!count || count > 2 || edit.end - edit.start !== 8 + count * 12)
        throw new TypeError("Unsupported MP4 edit table");
      let editDuration = 0;
      for (let index = 0; index < count; index++) {
        const position = edit.start + 8 + index * 12;
        editDuration += bytes.readUInt32BE(position);
        if (
          bytes.readInt32BE(position + 4) < -1 ||
          bytes.readUInt32BE(position + 8) !== 65536
        )
          throw new TypeError("Unsupported MP4 edit rate or origin");
      }
      if (editDuration / movieScale > 180)
        throw new TypeError("MP4 edit duration exceeds the limit");
    }
    const mdiaBox = one(trackChildren, "mdia");
    const mdia = boxes(mdiaBox.start, mdiaBox.end);
    const header = one(mdia, "mdhd");
    full(header, 24);
    const timescale = bytes.readUInt32BE(header.start + 12);
    const duration = bytes.readUInt32BE(header.start + 16);
    if (!timescale || !duration || duration / timescale > 180)
      throw new TypeError(
        "MP4 duration must be positive and at most 180 seconds",
      );
    const handler = one(mdia, "hdlr");
    full(handler, 12);
    const kind = bytes.toString("ascii", handler.start + 8, handler.start + 12);
    if (kind === "vide") videoTracks++;
    else if (kind === "soun") audioTracks++;
    else throw new TypeError("Unsupported MP4 track type");
    const minfBox = one(mdia, "minf");
    const minf = boxes(minfBox.start, minfBox.end);
    const dinfBox = one(minf, "dinf");
    const references = one(boxes(dinfBox.start, dinfBox.end), "dref");
    full(references, 8);
    const urls = boxes(references.start + 8, references.end);
    if (
      bytes.readUInt32BE(references.start + 4) !== 1 ||
      urls.length !== 1 ||
      urls[0]?.type !== "url " ||
      urls[0].end - urls[0].start !== 4 ||
      bytes.readUInt32BE(urls[0].start) !== 1
    )
      throw new TypeError("MP4 external media references are forbidden");
    const stblBox = one(minf, "stbl");
    const table = boxes(stblBox.start, stblBox.end);
    const descriptions = one(table, "stsd");
    full(descriptions, 8);
    const entries = boxes(descriptions.start + 8, descriptions.end);
    if (
      bytes.readUInt32BE(descriptions.start + 4) !== 1 ||
      entries.length !== 1
    )
      throw new TypeError("MP4 requires one codec description per track");
    const entry = required(entries[0]);
    if (
      entry.end - entry.start < 8 ||
      bytes.readUInt16BE(entry.start + 6) !== 1
    )
      throw new TypeError("MP4 media reference index is invalid");
    let nalLength = 0;
    let videoWidth = 0;
    let videoHeight = 0;
    const sequenceIds = new Set<number>();
    const pictureIds = new Set<number>();
    if (kind === "vide") {
      if (entry.type !== "avc1" || entry.end - entry.start < 78)
        throw new TypeError("Only H.264 avc1 MP4 video is supported");
      const width = bytes.readUInt16BE(entry.start + 24);
      const height = bytes.readUInt16BE(entry.start + 26);
      videoWidth = width;
      videoHeight = height;
      if (
        Math.min(width, height) < 16 ||
        Math.max(width, height) > 1920 ||
        Math.min(width, height) > 1080 ||
        width * height > 2_073_600
      )
        throw new TypeError("MP4 dimensions exceed the supported 1080p limit");
      if (
        bytes.readUInt32BE(trackHeader.start + 76) !== width * 65536 ||
        bytes.readUInt32BE(trackHeader.start + 80) !== height * 65536
      )
        throw new TypeError("MP4 displayed dimensions do not match its codec");
      const codecBoxes = boxes(entry.start + 78, entry.end);
      if (codecBoxes.some((box) => box.type === "sinf"))
        throw new TypeError("Encrypted MP4 is not supported");
      const avc = one(codecBoxes, "avcC");
      if (
        avc.end - avc.start < 11 ||
        bytes[avc.start] !== 1 ||
        ![66, 77, 100].includes(required(bytes[avc.start + 1])) ||
        required(bytes[avc.start + 3]) > 42
      )
        throw new TypeError(
          "Unsupported H.264 profile or decoder configuration",
        );
      nalLength = (required(bytes[avc.start + 4]) & 3) + 1;
      if (![1, 2, 4].includes(nalLength))
        throw new TypeError("Invalid H.264 NAL length");
      let offset = avc.start + 6;
      const parameters = (count: number, nalType: number) => {
        if (count < 1 || count > 16)
          throw new TypeError("Invalid H.264 parameters");
        for (let index = 0; index < count; index++) {
          if (offset + 2 > avc.end)
            throw new TypeError("Truncated H.264 parameters");
          const size = bytes.readUInt16BE(offset);
          offset += 2;
          if (
            size < 4 ||
            offset + size > avc.end ||
            required(bytes[offset]) & 128 ||
            (required(bytes[offset]) & 31) !== nalType
          )
            throw new TypeError("Invalid H.264 parameter packet");
          if (
            nalType === 7 &&
            (bytes[offset + 1] !== bytes[avc.start + 1] ||
              bytes[offset + 2] !== bytes[avc.start + 2] ||
              bytes[offset + 3] !== bytes[avc.start + 3])
          )
            throw new TypeError(
              "H.264 sequence profile does not match its codec description",
            );
          if (nalType === 7)
            sequenceIds.add(
              validateSps(bytes.subarray(offset, offset + size), width, height),
            );
          else {
            pictureIds.add(
              validatePps(bytes.subarray(offset, offset + size), sequenceIds),
            );
          }
          offset += size;
        }
      };
      parameters(required(bytes[avc.start + 5]) & 31, 7);
      if (offset >= avc.end)
        throw new TypeError("Missing H.264 picture parameters");
      parameters(required(bytes[offset++]), 8);
      // High-profile extension bytes are optional; no arbitrary trailing boxes.
      if (
        offset < avc.end &&
        (bytes[avc.start + 1] !== 100 ||
          avc.end - offset !== 4 ||
          (required(bytes[offset]) & 3) !== 1 ||
          (required(bytes[offset + 1]) & 7) !== 0 ||
          (required(bytes[offset + 2]) & 7) !== 0 ||
          bytes[offset + 3] !== 0)
      )
        throw new TypeError("Unexpected H.264 decoder data");
    } else {
      if (
        entry.type !== "mp4a" ||
        entry.end - entry.start < 28 ||
        bytes.readUInt16BE(entry.start + 8) !== 0
      )
        throw new TypeError("Only AAC-LC mp4a audio is supported");
      if (![1, 2].includes(bytes.readUInt16BE(entry.start + 16)))
        throw new TypeError("Only mono or stereo AAC audio is supported");
      const rate = bytes.readUInt32BE(entry.start + 24) >>> 16;
      if (rate < 8000 || rate > 48000)
        throw new TypeError("Unsupported AAC sample rate");
      const esds = one(boxes(entry.start + 28, entry.end), "esds");
      full(esds, 6);
      function descriptor(
        offset: number,
        end: number,
      ): { tag: number; start: number; end: number } {
        if (offset >= end) throw new TypeError("Missing AAC descriptor");
        const tag = required(bytes[offset++]);
        let size = 0;
        let done = false;
        for (let i = 0; i < 4 && offset < end; i++) {
          const value = required(bytes[offset++]);
          size = size * 128 + (value & 127);
          if (!(value & 128)) {
            done = true;
            break;
          }
        }
        if (!done || size < 1 || offset + size > end)
          throw new TypeError("Invalid AAC descriptor size");
        return { tag, start: offset, end: offset + size };
      }
      const es = descriptor(esds.start + 4, esds.end);
      if (
        es.tag !== 3 ||
        es.end !== esds.end ||
        es.end - es.start < 3 ||
        bytes[es.start + 2] !== 0
      )
        throw new TypeError("Unsupported AAC ES descriptor");
      const decoder = descriptor(es.start + 3, es.end);
      if (
        decoder.tag !== 4 ||
        decoder.end - decoder.start < 15 ||
        bytes[decoder.start] !== 0x40 ||
        required(bytes[decoder.start + 1]) >> 2 !== 5
      )
        throw new TypeError("Unsupported AAC decoder configuration");
      const specific = descriptor(decoder.start + 13, decoder.end);
      if (specific.tag !== 5 || specific.end - specific.start < 2)
        throw new TypeError("Missing AAC AudioSpecificConfig");
      const value = bytes.readUInt16BE(specific.start);
      if (
        value >>> 11 !== 2 ||
        ((value >>> 7) & 15) > 12 ||
        ![1, 2].includes((value >>> 3) & 15) ||
        (value & 7) !== 0 ||
        [
          96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
          11025, 8000, 7350,
        ][(value >>> 7) & 15] !== rate ||
        ((value >>> 3) & 15) !== bytes.readUInt16BE(entry.start + 16)
      )
        throw new TypeError("Only AAC-LC mono/stereo is supported");
    }
    const sizes = one(table, "stsz");
    full(sizes, 12);
    const uniform = bytes.readUInt32BE(sizes.start + 4);
    const count = bytes.readUInt32BE(sizes.start + 8);
    if (
      !count ||
      count > 20_000 ||
      (kind === "vide" && count / (duration / timescale) > 60) ||
      sizes.end - sizes.start !== 12 + (uniform ? 0 : count * 4)
    )
      throw new TypeError("MP4 sample sizes exceed the safety limit");
    const timing = one(table, "stts");
    full(timing, 8);
    const timingCount = bytes.readUInt32BE(timing.start + 4);
    if (
      timingCount > count ||
      timing.end - timing.start !== 8 + timingCount * 8
    )
      throw new TypeError("MP4 sample timing is incomplete");
    let timedSamples = 0;
    let ticks = 0;
    for (let index = 0; index < timingCount; index++) {
      const n = bytes.readUInt32BE(timing.start + 8 + index * 8);
      const delta = bytes.readUInt32BE(timing.start + 12 + index * 8);
      if (!n || !delta) throw new TypeError("MP4 sample duration is invalid");
      timedSamples += n;
      ticks += n * delta;
    }
    if (timedSamples !== count || ticks / timescale > 180 || ticks !== duration)
      throw new TypeError("MP4 sample timing does not match the track");
    const composition = table.filter((box) => box.type === "ctts");
    if (composition.length > 1)
      throw new TypeError("Duplicate MP4 composition timing");
    if (composition[0]) {
      const box = composition[0];
      if (
        box.end - box.start < 8 ||
        (bytes[box.start] !== 0 && bytes[box.start] !== 1) ||
        (bytes.readUInt32BE(box.start) & 0xffffff) !== 0
      )
        throw new TypeError("Unsupported MP4 composition timing");
      const n = bytes.readUInt32BE(box.start + 4);
      if (!n || n > count || box.end - box.start !== 8 + n * 8)
        throw new TypeError("MP4 composition timing is incomplete");
      let composedSamples = 0;
      for (let index = 0; index < n; index++) {
        const at = box.start + 8 + index * 8;
        const samples = bytes.readUInt32BE(at);
        const offset =
          bytes[box.start] === 1
            ? bytes.readInt32BE(at + 4)
            : bytes.readUInt32BE(at + 4);
        if (!samples || Math.abs(offset) > duration)
          throw new TypeError(
            "MP4 composition offsets exceed the track duration",
          );
        composedSamples += samples;
      }
      if (composedSamples !== count)
        throw new TypeError("MP4 composition sample count is invalid");
    }
    const offsets = table.filter(
      (box) => box.type === "stco" || box.type === "co64",
    );
    if (offsets.length !== 1)
      throw new TypeError("MP4 chunk offsets are invalid");
    const chunks = required(offsets[0]);
    full(chunks, 8);
    const chunkCount = bytes.readUInt32BE(chunks.start + 4);
    const chunkWidth = chunks.type === "stco" ? 4 : 8;
    if (
      !chunkCount ||
      chunkCount > count ||
      chunks.end - chunks.start !== 8 + chunkCount * chunkWidth
    )
      throw new TypeError("MP4 chunk offset table is incomplete");
    const mapping = one(table, "stsc");
    full(mapping, 8);
    const mappingCount = bytes.readUInt32BE(mapping.start + 4);
    if (
      !mappingCount ||
      mappingCount > chunkCount ||
      mapping.end - mapping.start !== 8 + mappingCount * 12
    )
      throw new TypeError("MP4 sample-to-chunk table is invalid");
    const map: { first: number; samples: number }[] = [];
    for (let index = 0; index < mappingCount; index++) {
      const position = mapping.start + 8 + index * 12;
      const first = bytes.readUInt32BE(position);
      const samples = bytes.readUInt32BE(position + 4);
      if (
        (!index && first !== 1) ||
        first > chunkCount ||
        first <= (map.at(-1)?.first ?? 0) ||
        !samples ||
        samples > count ||
        bytes.readUInt32BE(position + 8) !== 1
      )
        throw new TypeError("MP4 chunk mapping is invalid");
      map.push({ first, samples });
    }
    let sample = 0;
    let mappingIndex = 0;
    let hasKeyFrame = false;
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      if (map[mappingIndex + 1]?.first === chunk) mappingIndex++;
      const position = chunks.start + 8 + (chunk - 1) * chunkWidth;
      const large =
        chunkWidth === 8
          ? bytes.readBigUInt64BE(position)
          : BigInt(bytes.readUInt32BE(position));
      if (large > BigInt(bytes.length))
        throw new TypeError("MP4 chunk points outside its file");
      let offset = Number(large);
      for (
        let index = 0;
        index < required(map[mappingIndex]).samples;
        index++
      ) {
        if (sample >= count) throw new TypeError("MP4 contains excess samples");
        const size =
          uniform || bytes.readUInt32BE(sizes.start + 12 + sample * 4);
        const end = offset + size;
        if (
          !size ||
          !media.some((box) => offset >= box.start && end <= box.end)
        )
          throw new TypeError("MP4 sample lies outside private media data");
        occupied.push({ start: offset, end });
        if (kind === "vide") {
          let cursor = offset;
          let hasPicture = false;
          while (cursor < end) {
            if (++packetsRead > 100_000)
              throw new TypeError(
                "H.264 packet count exceeds its safety limit",
              );
            if (cursor + nalLength > end)
              throw new TypeError("H.264 sample length is truncated");
            const length = bytes.readUIntBE(cursor, nalLength);
            cursor += nalLength;
            if (
              !length ||
              cursor + length > end ||
              required(bytes[cursor]) & 128
            )
              throw new TypeError("H.264 packet is incomplete");
            const type = required(bytes[cursor]) & 31;
            if (![1, 5, 6, 7, 8, 9, 12].includes(type))
              throw new TypeError("Unsupported H.264 packet");
            if (
              type === 7 &&
              !sequenceIds.has(
                validateSps(
                  bytes.subarray(cursor, cursor + length),
                  videoWidth,
                  videoHeight,
                ),
              )
            )
              throw new TypeError("H.264 in-band sequence identity changed");
            if (
              type === 8 &&
              !pictureIds.has(
                validatePps(
                  bytes.subarray(cursor, cursor + length),
                  sequenceIds,
                ),
              )
            )
              throw new TypeError("H.264 in-band picture identity changed");
            if (type === 1 || type === 5) {
              // Slice authority uses its bounded header, never a copy of the full frame.
              const bits = h264Bits(
                bytes.subarray(cursor, Math.min(cursor + length, cursor + 64)),
              );
              if (
                bits.ue() > 8160 ||
                bits.ue() > 9 ||
                !pictureIds.has(bits.ue())
              )
                throw new TypeError("Invalid H.264 picture slice header");
            }
            hasPicture ||= type === 1 || type === 5;
            hasKeyFrame ||= type === 5;
            cursor += length;
          }
          if (!hasPicture)
            throw new TypeError("MP4 video sample has no picture data");
        }
        offset = end;
        sample++;
      }
    }
    if (sample !== count || (kind === "vide" && !hasKeyFrame))
      throw new TypeError("MP4 track is incomplete or has no key frame");
  }
  if (videoTracks !== 1 || audioTracks > 1)
    throw new TypeError("MP4 must contain one video track");
  occupied.sort((a, b) => a.start - b.start);
  if (
    occupied.some(
      (sample, index) =>
        index > 0 && sample.start < required(occupied[index - 1]).end,
    )
  )
    throw new TypeError("MP4 media samples overlap");
}
