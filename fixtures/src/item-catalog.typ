// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic fixture (spec §11). Single-column catalogue with bold item headers
// over a normal-weight body, plus a running head and a summary table (table +
// single-column reflow hazards). Fabricated equipment; no commercial text.

#set document(title: "Quartermaster's Ledger", author: "Synthetic Fixtures")
#set page(
  width: 612pt,
  height: 792pt,
  margin: (x: 72pt, y: 54pt),
  header: text(size: 8pt)[Quartermaster's Ledger],
)
#set text(font: "Libertinus Serif", size: 9pt, lang: "en")

#let entry(name, cost, weight, rarity, desc) = [
  #text(weight: "bold", size: 11pt)[#name]

  #desc

  Cost #cost

  Weight #weight

  Rarity #rarity
]

#entry("Lumen Torch", "12", "1", "Common",
  "A hand-cranked lantern favoured by tunnel-wardens. Its beam flickers when the
  crank tires, but it never wholly fails.")

#entry("Braided Cording", "5", "3", "Common",
  "Fifty spans of resin-stiffened cord. Fraying is rare; the fibres cling
  efficiently to stone and iron alike.")

#entry("Field Ration Tin", "3", "1", "Common",
  "A sealed tin of preserved fare. The flavour is forgettable, the sustenance
  sufficient for a fitful day's march.")

#entry("Warden's Signet", "150", "0", "Rare",
  "An engraved seal of office. Doors that would refuse a stranger often open for
  the bearer of such a fixture.")

#v(12pt)
#text(weight: "bold", size: 11pt)[Summary]
#table(
  columns: 4,
  [Item], [Cost], [Weight], [Rarity],
  [Lumen Torch], [12], [1], [Common],
  [Braided Cording], [5], [3], [Common],
  [Field Ration Tin], [3], [1], [Common],
  [Warden's Signet], [150], [0], [Rare],
)
