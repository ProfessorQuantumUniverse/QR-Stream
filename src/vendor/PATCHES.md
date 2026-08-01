# Vendored dependencies

## jsQR 1.4.0

Source: <https://github.com/cozmo/jsQR> (Apache-2.0, see `jsqr-LICENSE.txt`)

Vendored rather than loaded from a CDN. QR-Stream's entire premise is that it
runs on a machine with no network, so a runtime dependency on `unpkg.com` would
defeat the point. The unminified build is kept deliberately: a tool you are
meant to trust with secrets on an offline machine should not ship an opaque blob.

### Patch 1 — version 23 alignment pattern centres

`src/vendor/jsqr.js`, in the `VERSIONS` table:

```diff
   versionNumber: 23,
-  alignmentPatternCenters: [6, 30, 54, 74, 102],
+  alignmentPatternCenters: [6, 30, 54, 78, 102],
```

Upstream lists `74` for the fourth centre. Every other entry in the table is
evenly spaced; version 23 alone has gaps of 24, 24, **20**, 28. ISO/IEC 18004
annex E gives `6, 30, 54, 78, 102`, and the general placement rule (centres
spaced `ceil((4V+4) / (2n-2)) * 2 = 24` apart, anchored at 6 and `size - 7`)
produces the same. With `74` the sampling grid is misaligned by four modules
across the lower right quadrant, so **no** version 23 symbol decodes — not just
ones produced by this project.

`tests/unit/qr-encoder.test.mjs` round-trips all 40 versions at all four ECC
levels and will fail loudly if this patch is ever lost during an upgrade.
