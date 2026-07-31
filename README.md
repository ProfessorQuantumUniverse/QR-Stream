<div align="center">

# 📡 QR-Stream

**Optical data transfer across an air gap.**
Move a file between two machines that share no network, using nothing but a screen and a camera.

[![CI](https://github.com/ProfessorQuantumUniverse/QR-Stream/actions/workflows/ci.yml/badge.svg)](https://github.com/ProfessorQuantumUniverse/QR-Stream/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat)](LICENSE)
![Runtime dependencies: none](https://img.shields.io/badge/runtime%20deps-none-success?style=flat)

[**Launch →**](https://professorquantumuniverse.github.io/QR-Stream/) &nbsp;·&nbsp;
[Send](https://professorquantumuniverse.github.io/QR-Stream/app/send.html) &nbsp;·&nbsp;
[Receive](https://professorquantumuniverse.github.io/QR-Stream/app/receive.html) &nbsp;·&nbsp;
[Loopback Lab](https://professorquantumuniverse.github.io/QR-Stream/app/lab.html)

</div>

---

## What it does

The sender paints an endless stream of QR codes on screen. The receiver films them and
rebuilds the payload from whatever it caught. There is no network in the loop at any
point — not Wi-Fi, not Bluetooth, not NFC — which makes it useful for getting a key, a
config file or a signed transaction off a machine that is deliberately not connected to
anything.

Because an air gap is physically one-way, there is no handshake, no acknowledgement and no
way to request a retransmission. That single constraint shapes the whole design.

## The core idea: the sender never repeats itself

The obvious way to send *N* chunks over a one-way channel is to loop over them: `1, 2, 3,
… N, 1, 2, 3, …`. It works, and it is what this project did originally. But it makes the
receiver responsible for catching one **specific** frame. Miss chunk 7 and you wait a full
cycle for it to come round again — and a camera that drops frames periodically can miss
the same chunk on every single pass and never finish at all.

QR-Stream uses **[LT fountain codes](https://en.wikipedia.org/wiki/Luby_transform_code)**
instead. Every frame carries the XOR of a pseudo-randomly chosen set of blocks, labelled
only with the 32-bit seed that selected them:

```
frame  = XOR( block[i] for i in blocks_from_seed(seed, k) )
```

The receiver collects *whatever it happens to see*. Any frame that combines exactly one
unknown block reveals that block, which may reduce other stored frames to a single
unknown, cascading until the payload falls out. No frame is special, order does not
matter, and losses cost only time.

|                             | Cyclic chunks (v1)              | Fountain codes (v2)                |
| :-------------------------- | :------------------------------ | :--------------------------------- |
| Missing one frame           | Wait a full cycle               | Irrelevant — take the next one     |
| Periodic frame drops        | Can starve forever              | No effect                          |
| Starting mid-stream         | Must wait for the cycle to wrap | Works immediately                  |
| Frames needed               | Exactly *k* distinct ones       | Any ≈1.1 × *k*                     |
| Receiver → sender channel   | Needed to recover in practice   | Not needed at all                  |

The first *k* frames are sent **uncoded**, so a clean run costs nothing extra over the
naive scheme; the coding only starts paying for itself once frames actually go missing.

Watch it happen in the [Loopback Lab](https://professorquantumuniverse.github.io/QR-Stream/app/lab.html):
turn frame loss up to 90% and the transfer still completes.

## What else changed

- **Files, not just text.** Arbitrary binary payloads, with filename and media type carried
  in the stream. The old protocol was UTF-8 only.
- **Compression.** Payloads are DEFLATE'd when that actually helps, which for text and
  source code typically means less than half as many frames. Incompressible input is sent
  as-is rather than padded out.
- **Integrity.** Every frame is CRC-32 framed, and the manifest carries a checksum of the
  whole payload. A transfer either verifies or reports failure — it never hands you
  plausible-looking wrong bytes.
- **Stream identity.** Two senders in view of one camera no longer merge into one corrupt
  file.
- **No runtime dependencies.** The old version fetched bwip-js and ZXing from CDNs, so the
  air-gapped machine needed internet to load the air-gap tool. The QR *encoder* is now
  written from scratch in this repo; the *decoder* is vendored locally, unminified.
- **A single-file build.** `npm run build` produces one self-contained HTML file per page.
  Copy it to a USB stick, open it on the offline machine, done.

## Getting started

Open [the hosted version](https://professorquantumuniverse.github.io/QR-Stream/), or:

```bash
git clone https://github.com/ProfessorQuantumUniverse/QR-Stream.git
cd QR-Stream
npm run serve          # http://localhost:8000
```

A server is needed because ES modules do not load over `file://`, and because the camera
only works in a secure context (HTTPS or `localhost`).

### Offline / air-gapped use

```bash
npm run build          # writes dist/{index,send,receive,lab}.html
```

Each file in `dist/` is completely self-contained — no stylesheet, script or icon is
fetched at runtime — and opens directly from the filesystem with no server at all. Put
`send.html` on the offline machine and `receive.html` on the phone.

## How to use it

**Sending.** Paste text or drop a file, pick a density and frame rate, press *Start
stream*. Press <kbd>F</kbd> to go fullscreen for an easier target.

**Receiving.** Press *Start camera* and point it at the sender's screen. The progress ring
and the block map fill in as blocks are recovered; when the payload is complete it is
checksum-verified and offered for download.

**Tuning.** If the receiver is struggling: lower the symbol density, raise the error
correction level, or slow the frame rate down. Denser symbols carry more per frame but
need a steadier hand and a better camera. Roughly 2–10 kB/s is realistic.

## The protocol

Every frame is self-delimiting and independently verifiable, because a receiver may join
at any point having missed anything.

```
  offset  size  field
  0       2     magic 'Q' 'S'
  2       1     high nibble protocol version | low nibble frame type
  3       2     stream id
  5       …     body
  n-4     4     CRC-32 of everything preceding
```

**Manifest** (type 1) — describes the transfer; re-sent every twelfth frame so a late
receiver can catch up:

```
  5       4     payload length, after compression
  9       4     CRC-32 of the complete payload
  13      2     block size
  15      2     block count (k)
  17      1     flags: bit 0 compressed, bit 1 binary
  18      1     name length, then that many UTF-8 bytes
  …       1     mime length, then that many UTF-8 bytes
```

**Block** (type 2) — one coded packet:

```
  5       4     seed identifying the block combination
  9       2     block count (k), repeated so blocks are usable before the
                first manifest arrives
  11      …     blockSize bytes of XORed payload
```

Seeds below *k* map to a single source block (the uncoded first pass); seeds at or above
*k* drive a robust soliton degree distribution. Both ends derive the block selection from
the seed alone, so no membership list is ever transmitted.

## Architecture

```
src/
  qr/            from-scratch QR encoder
    galois.js      GF(2^8) arithmetic and Reed-Solomon
    tables.js      ISO/IEC 18004 capacity tables and geometry
    encoder.js     byte-mode encoder, versions 1-40, all ECC levels, all 8 masks
  core/
    fountain.js    LT encoder and peeling decoder
    protocol.js    binary framing
    transmit.js    payload -> endless frame stream
    receive.js     frames -> verified payload
    compress.js    DEFLATE via CompressionStream
    crc32.js       integrity checking
  ui/              sender, receiver and lab pages
  vendor/          jsQR, vendored and patched (see PATCHES.md)
```

The QR encoder implements byte mode only. Every payload here is high-entropy compressed
binary, so alphanumeric and kanji segments would never be selected — leaving them out
keeps the encoder small enough to actually read, which matters for a tool you are asked to
trust on an offline machine.

## Testing

```bash
npm test               # unit tests, no browser and no dependencies needed
npm run test:e2e       # browser tests (requires Chromium via Playwright)
npm run test:camera    # drives the real camera path against a synthetic feed
npm run test:dist      # builds and verifies the offline single-file pages
```

The unit suite round-trips the encoder against **jsQR — an entirely independent
implementation — at every one of the 160 version/ECC-level combinations**, so a wrong
capacity table entry, mask pattern or interleaving order fails the build. Full transfers
are exercised through real rendered pixels, including 50% frame loss, mid-stream joins,
interference from unrelated QR codes, and corrupted-payload detection.

> While building this, that round-trip test surfaced a genuine bug in jsQR: its version 23
> alignment pattern table reads `[6, 30, 54, 74, 102]` where the standard gives
> `[6, 30, 54, 78, 102]`, which makes **every** version 23 QR code undecodable by that
> library. The vendored copy is patched; see [`src/vendor/PATCHES.md`](src/vendor/PATCHES.md).

## Limitations

- **No confidentiality.** Anything on the screen is readable by anything that can see the
  screen, including a camera you did not notice. Encrypt sensitive payloads *before*
  sending them.
- **Slow.** A few kilobytes per second. This is for small, valuable things — keys, configs,
  seed phrases — not for moving a video.
- **One-way.** There is no reverse channel, so the sender cannot know whether anyone
  received anything. Watch the receiver.
- **Browser support.** Needs `CompressionStream` for compressed streams (Chrome 80+,
  Safari 16.4+, Firefox 113+); uncompressed transfers work without it.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR; if you
change the protocol, bump `PROTOCOL_VERSION` in `src/core/protocol.js` so that mismatched
peers reject each other cleanly rather than producing garbage.

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

The vendored decoder, [jsQR](https://github.com/cozmo/jsQR), is Apache-2.0; its licence is
kept alongside it in `src/vendor/`.

<div align="center">
<br>
Made with ❤️ and physics by <strong>ProfessorQuantumUniverse</strong>
</div>
