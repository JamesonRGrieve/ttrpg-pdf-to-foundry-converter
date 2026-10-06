// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic fixture for the dnd5e target. Reproduces only the TYPOGRAPHIC
// conventions the engine recognizes for character options — a class's traits
// table and level-headed features with its level table set across both
// columns, a subclass heading, species and background fields, feats opened by
// an italic category line, bold-italic trait leads — filled with entirely
// invented content. Field labels are the target system's own vocabulary.

#set document(title: "Tinker Compendium", author: "Synthetic Fixtures")
#set page(
  width: 612pt,
  height: 792pt,
  margin: (x: 54pt, y: 54pt),
  columns: 2,
  footer: context align(center, text(size: 8pt)[#counter(page).display()]),
)
#set columns(gutter: 18pt)
#set text(font: "Libertinus Serif", size: 10pt, lang: "en")
#set par(justify: false)

#let hd(size, body) = block(above: 1em, below: 0.6em, text(font: "DejaVu Sans", weight: "bold", size: size, body))
#let cell(body) = text(font: "DejaVu Sans", size: 9.5pt, body)
#let head(body) = text(font: "DejaVu Sans", weight: "bold", size: 9.25pt, body)
#let trait(name, body) = par[#text(weight: "bold", style: "italic")[#name.] #body]

// ---- Page 1: a class ---------------------------------------------------------

#hd(18pt)[Tinker]

Tinkers mend clocks, springs and small engines, and carry a satchel of odd
parts wherever they wander.

#hd(10.5pt)[Core Tinker Traits]
#table(
  columns: (auto, 1fr),
  stroke: none,
  inset: (x: 5pt, y: 2pt),
  cell[*Primary Ability*], cell[Intelligence],
  cell[*Hit Point Die*], cell[D8 per Tinker level],
  cell[*Saving Throws*], cell[Intelligence and Dexterity],
  cell[*Skill Proficiencies*], cell[_Choose 2:_ Arcana, History, Investigation, or Perception],
  cell[*Weapon Proficiencies*], cell[Simple weapons],
  cell[*Armor Training*], cell[Light armor],
  cell[*Starting Equipment*], cell[Tool Satchel and 9 GP, or 40 GP],
)

#hd(14pt)[Becoming a Tinker]

- Gain the traits in the Core Tinker Traits table.
- Gain the Tinker's level 1 features.

#colbreak()

#hd(14pt)[Tinker Class Features]

As a Tinker, you gain these features at the Tinker levels shown in the Tinker
Features table.

#hd(12pt)[Level 1: Spark]

You can strike a harmless spark from your fingertips as a Bonus Action. You can
do so the number of times shown in the Charges column of the Tinker Features
table, and you regain every use when you finish a Long Rest.

#hd(12pt)[Level 2: Gadget]

You build a palm-sized gadget that can hold one small object.

#hd(12pt)[Level 3: Tinker Subclass]

You choose a Tinker subclass, such as the Clockwork Path.

#hd(12pt)[Level 4: Ability Score Improvement]

You gain the Ability Score Improvement feat or another feat of your choice.

#hd(12pt)[Level 5: Overclock]

Your gadgets run faster. Roll the die in the Dice column when one of them acts.

#place(bottom, scope: "parent", float: true, clearance: 14pt)[
  #hd(10.5pt)[Tinker Features]
  #table(
    columns: (auto, auto, 1fr, auto, auto),
    stroke: none,
    inset: (x: 5pt, y: 2pt),
    head[Level], head[Proficiency Bonus], head[Class Features], head[Charges], head[Dice],
    cell[1], cell[+2], cell[Spark], cell[2], cell[1d4],
    cell[2], cell[+2], cell[Gadget], cell[2], cell[1d4],
    cell[3], cell[+2], cell[Tinker Subclass], cell[3], cell[1d6],
    cell[4], cell[+2], cell[Ability Score Improvement], cell[3], cell[1d6],
    cell[5], cell[+3], cell[Overclock], cell[4], cell[1d8],
  )
]

#pagebreak()

// ---- Page 2: a subclass and a background ------------------------------------

#hd(14pt)[Tinker Subclass: Clockwork Path]

Clockwork tinkers listen to the ticking of the world and keep its time.

#hd(12pt)[Level 3: Gears]

You fit tiny gears into any device you touch, and it works a little better.

#hd(12pt)[Level 5: Escapement]

Once per Short Rest, you slip free of anything that holds you.

#colbreak()

#hd(18pt)[Character Origins]

#hd(14pt)[Background Descriptions]

#hd(12pt)[Tinkerer]

*Ability Scores:* Intelligence, Dexterity, Constitution \
*Feat:* Quick Study (see "Feats") \
*Skill Proficiencies:* Arcana and Investigation \
*Equipment:* Tool Satchel and 12 GP, or 40 GP

You grew up among workbenches, sorting screws by size and listening to the
small complaints of worn machines.

#pagebreak()

// ---- Page 3: a species and feats ----------------------------------------------

#hd(14pt)[Species Descriptions]

#hd(12pt)[Gearling]

*Creature Type:* Construct \
*Size:* Small or Medium \
*Speed:* 30 feet

As a Gearling, you have these special traits.

#trait[Cog Heart][Your heart ticks steadily, and magic can't put you to sleep.]

#trait[Spring Leap][When you reach character level 5, you can leap twice as far
as normal.]

#colbreak()

#hd(18pt)[Feats]

#hd(14pt)[Origin Feats]

#hd(12pt)[Quick Study]

_Origin Feat_

You learn quickly. You gain proficiency in one skill of your choice.

#hd(14pt)[General Feats]

#hd(12pt)[Tough Hide]

_General Feat (Prerequisite: Level 4+)_

Your skin hardens like old bark.

#trait[Repeatable][You can take this feat more than once.]

#pagebreak()

// ---- Page 4: notes in both columns --------------------------------------------

#hd(18pt)[Workshop Notes]

#for n in range(1, 9) [
  Note #n: keep the springs dry, the gears oiled and the satchel closed when
  the wind picks up.

]

#colbreak()

#for n in range(9, 17) [
  Note #n: a gadget left alone overnight tends to wander off by morning.

]
