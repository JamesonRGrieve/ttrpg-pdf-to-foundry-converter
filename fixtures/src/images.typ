// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic image fixture (spec §11). Exercises the Tier A image paths: a JPEG
// (DCTDecode passthrough), an RGB PNG (FlateDecode → PNG re-encode), an RGBA PNG
// (FlateDecode + /SMask sibling), a CMYK JPEG (DCTDecode DeviceCMYK), and one
// image reused across two pages (content-addressed dedup). Fabricated content.

#set document(title: "Image Fixture Plates", author: "Synthetic Fixtures")
#set page(width: 300pt, height: 400pt, margin: 24pt)
#set text(font: "Libertinus Serif", size: 10pt)

#text(weight: "bold", size: 12pt)[Plate Alpha]

#image("assets/test-rgb.png", width: 48pt)
#image("assets/test.jpg", width: 48pt)
#image("assets/test-alpha.png", width: 48pt)
#image("assets/test-cmyk.jpg", width: 48pt)

#pagebreak()

#text(weight: "bold", size: 12pt)[Plate Beta]

// Reused image — must dedup to the same content-addressed asset as page 1.
#image("assets/test-rgb.png", width: 48pt)
