// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic fixture (spec §11). Reproduces TYPOGRAPHIC conventions only —
// two-column layout, bold stat headers, running head/footer, ligature-heavy
// body — with entirely fabricated content. No paraphrase of any commercial
// text; invented creatures and an invented "system".

#set document(title: "Bestiary of the Hollow Reaches", author: "Synthetic Fixtures")
#set page(
  width: 612pt,
  height: 792pt,
  margin: (x: 54pt, y: 54pt),
  header: text(size: 8pt)[Hollow Reaches — Bestiary],
  footer: align(center, text(size: 8pt)[folio],
  ),
)
#set text(font: "Libertinus Serif", size: 9pt, lang: "en")

#let statblock(name, ac, hp, speed, flavor) = [
  #text(weight: "bold", size: 10.5pt)[#name]

  #flavor

  Armor Class #ac

  Hit Points #hp

  Speed #speed
]

#columns(2, gutter: 24pt)[
  #statblock("Glimmerfin Drake", "14", "22", "40",
    "The glimmerfin drifts through fog-choked ravines, its scales fluttering with a
    faint efflorescence. Fisherfolk of the lower fens fear its silent glide.")

  #statblock("Cinder Wight", "12", "18", "30",
    "A shuffling husk wreathed in floating embers. The wight was first sighted
    inflicting slow burns upon the effigies of the marsh-shrine.")

  #colbreak()

  #statblock("Murk Basilisk", "16", "35", "20",
    "This basilisk's gaze fixes prey in place. Its influence flattens the reeds for
    fifty paces, and afflicted travellers report a fluttering in the fingers.")

  #statblock("Pale Grendly", "11", "9", "25",
    "A diminutive scavenger that flits between grave-fields. Efficient and furtive,
    the grendly hoards buttons, teeth, and other small trophies.")
]
