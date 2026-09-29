// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic fixture. Reproduces only the TYPOGRAPHIC conventions the engine
// recognizes — captioned stat tables, two-column catalogue entries with bold
// field labels under small-caps headings, a characteristic-grid statblock, and
// a d100 result table — filled with entirely invented content. Field labels and
// abbreviations are the target Foundry system's own schema vocabulary.

#set document(title: "Wayfarer's Field Manual", author: "Synthetic Fixtures")
#set page(
  width: 612pt,
  height: 792pt,
  margin: (x: 54pt, y: 54pt),
  footer: context align(right, text(size: 8pt, style: "italic")[#counter(page).display()]),
)
#set text(font: "Libertinus Serif", size: 10pt, lang: "en")
#set par(justify: true)

#let caption(body) = text(font: "DejaVu Sans", weight: "bold", size: 12pt)[#body]
#let section(body) = text(font: "Liberation Serif", size: 15pt)[#smallcaps(body)]
#let entry-heading(body) = text(font: "Liberation Serif", size: 11pt)[#smallcaps(body)]
#let hdr(body) = text(font: "DejaVu Sans", weight: "bold", size: 8.5pt)[#upper(body)]

// ---- Page 1: equipment tables -------------------------------------------

#section[Armaments]

Every wayfarer carries some means of defence. The tables below list the common
patterns issued at the waystations of the northern marches.

#v(6pt)
#caption[Table 1-1: Wayfarer Weapons]
#v(4pt)
#table(
  columns: 10,
  stroke: none,
  inset: 3pt,
  hdr[Name], hdr[Class], hdr[Range], hdr[RoF], hdr[Dam], hdr[Pen], hdr[Clip], hdr[Rld], hdr[Wt], hdr[Availability],
  [Thornbow], [Basic], [60m], [S/–/–], [1d10+2 I], [0], [1], [Full], [2kg], [Common],
  [Pellet Caster], [Pistol], [20m], [S/2/–], [1d10 I], [0], [8], [Half], [1.5kg], [Plentiful],
  [Arc Lance], [Heavy], [120m], [S/–/–], [2d10+4 E], [6], [4], [2 Full], [18kg], [Rare],
  [Hookblade], [Melee], [—], [—], [1d10+1 R], [2], [—], [—], [3kg], [Average],
  [Glass Dart], [Thrown], [SBx3], [S/–/–], [1d5 R], [0], [1], [—], [0.5kg], [Scarce],
)

#v(10pt)
#caption[Table 1-2: Wayfarer Armour]
#v(4pt)
#table(
  columns: 5,
  stroke: none,
  inset: 3pt,
  hdr[Name], hdr[Locations Covered], hdr[AP], hdr[Wt], hdr[Availability],
  [Quilted Jerkin], [Body, Arms], [2], [4kg], [Plentiful],
  [Scale Hauberk], [Body, Arms, Legs], [4], [12kg], [Average],
  [Warden Helm], [Head], [3], [2kg], [Scarce],
)

#pagebreak()

// ---- Page 2: talents (two columns) ---------------------------------------

#section[Talents]

#columns(2, gutter: 18pt)[
  #entry-heading[Steady Hand]

  *Tier:* 1 \
  *Prerequisites:* Agility 30 \
  *Aptitudes:* Ballistic Skill, Finesse

  The wayfarer has learned to still a trembling grip. Once per round, he may
  ignore a penalty imposed by his own movement when making a ranged attack.

  #entry-heading[Lantern Sense]

  *Tier:* 2 \
  *Prerequisites:* Perception 35 \
  *Aptitudes:* Perception, Fieldcraft

  Long nights on the road have taught the wayfarer to read shapes at the edge
  of the lamp's reach. He suffers no penalty to Awareness tests in dim light.

  #colbreak()

  #entry-heading[Iron Stomach]

  *Tier:* 1 \
  *Prerequisites:* Toughness 30 \
  *Aptitudes:* Toughness, Defence

  Spoiled rations and brackish water rarely trouble the wayfarer. He may
  re-roll failed tests to resist ingested toxins.

  #entry-heading[Quiet Tread]

  *Tier:* 3 \
  *Prerequisites:* Agility 40, Steady Hand \
  *Aptitudes:* Agility, Finesse

  The wayfarer moves without disturbing gravel or leaf. Opponents suffer a -20
  penalty to hear him approach.
]

#pagebreak()

// ---- Page 3: a statblock -------------------------------------------------

#section[Denizens]

The marshes harbour many strange beasts. One is described below.

#v(12pt)
#box(width: 260pt, inset: 8pt, stroke: 0.5pt)[
  #grid(
    columns: (1fr, auto),
    text(font: "Liberation Serif", weight: "bold", size: 11pt)[#upper[Reedstalker] (Elite)],
    text(font: "DejaVu Sans", weight: "bold", size: 12pt)[14],
  )
  #v(8pt)
  #align(right)[
    #grid(
      columns: (32pt, 32pt, 32pt),
      row-gutter: 8pt,
      align: center,
      text(size: 7pt, style: "italic")[WS], text(size: 7pt, style: "italic")[BS], text(size: 7pt, style: "italic")[S],
      text(font: "DejaVu Sans", weight: "bold", size: 12pt)[41], text(font: "DejaVu Sans", weight: "bold", size: 12pt)[18], text(font: "DejaVu Sans", weight: "bold", size: 12pt)[37],
      text(size: 7pt, style: "italic")[T], text(size: 7pt, style: "italic")[Ag], text(size: 7pt, style: "italic")[Int],
      text(font: "DejaVu Sans", weight: "bold", size: 12pt)[42], text(font: "DejaVu Sans", weight: "bold", size: 12pt)[46], text(font: "DejaVu Sans", weight: "bold", size: 12pt)[15],
      text(size: 7pt, style: "italic")[Per], text(size: 7pt, style: "italic")[WP], text(size: 7pt, style: "italic")[Fel],
      text(font: "DejaVu Sans", weight: "bold", size: 12pt)[39], text(font: "DejaVu Sans", weight: "bold", size: 12pt)[28], text(font: "DejaVu Sans", weight: "bold", size: 12pt)[9],
    )
  ]
  #v(8pt)
  #text(size: 8pt)[*HALF* 4 #h(6pt) *FULL* 8 #h(6pt) *CHARGE* 12 #h(6pt) *RUN* 24 #h(6pt) *THREAT* 11]
]

#pagebreak()

// ---- Page 4: a result table ---------------------------------------------

#section[Afflictions]

Prolonged exposure to the marsh-mists leaves its mark. Roll on the table below.

#v(6pt)
#caption[Table 2-1: Mutations]
#v(4pt)
#table(
  columns: (40pt, 1fr),
  stroke: none,
  inset: 3pt,
  hdr[d100], hdr[Effect],
  [01–30], [*Mottled Skin:* Patches of the wayfarer's skin turn grey and rough, like bark after rain.],
  [31–60], [*Webbed Fingers:* Thin membranes grow between the fingers; the wayfarer swims with ease.],
  [61–90], [*Lantern Eyes:* The wayfarer's eyes catch the light and glow faintly in the dark.],
  [91–100], [*Reed Voice:* The wayfarer's voice becomes a thin whistle, carrying far across water.],
)
