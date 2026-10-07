# Contrail — look decisions

Decisions the brief asks to have written down, with the evidence behind them.

## Tone mapping: ACES by default, AgX on `T`

Compared on the two hardest cases: the afterburner at dusk above the overcast,
and the afterburner at noon over farmland (`?tm=agx` to start in AgX). The
pictures were taken with the debug hooks; to repeat the comparison, fly those
two scenes and press `T`.

| | ACES (default) | AgX |
|---|---|---|
| Dusk sky and cloud tops | warm pink-orange, deep blue above: the look of air-to-air photography | greyer and paler; the sunset loses most of its colour |
| Afterburner core | burns to yellow-white with an orange rim, as a camera sees it | keeps an orange-pink hue all the way into the core |
| Noon terrain and haze | good contrast, fields read at altitude | flatter, slightly washed out |

ACES wins on the sky, which the brief calls the star of the game. AgX's
better-preserved flame hue is not worth a desaturated sunset. AgX stays one key
away for players who prefer it.

## Afterburner in physical units

The flame is emission in cd/m², pre-exposed like the sun and the sky: a black body
at 1900 K cooling to 1300 K along the plume, plus the blue-violet of the shock
diamonds (band emission, not black body). Peak luminance is about 60 000 cd/m².
At noon (EV100 15) the flame is a bright orange tongue; at dusk (EV100 12.8) the
same flame is about five times brighter on screen, as it is to the eye. No
per-preset tweaking.

## Contrails and vapour

Contrails form in air colder than about −40 °C (ISA: above about 8 km), which is
a simplified Schmidt–Appleman criterion. Wingtip vapour forms above about 4.5 G
at speed and is stronger lower down. Both are lit by the atmosphere's sun with a
strong forward lobe for ice. They are drawn in an overlay pass after the clouds,
so a trail over a cloud deck stays visible. Over a white deck a contrail has
little contrast, as in reality.

## Airframes

Both jets are built in code (`render/airframe.ts`, `render/jetModels.ts`) to
the scale sheet. They are not imported models: the brief asks for invented
types with no markings, and building them in code keeps them inside the repo's
rules.

- **Shape.** Fuselages are lofted from a few stations through smooth Bézier
  cross-sections. The chine is a vertex seam, so the stealth type's sharp edge
  and the twin's round body come from the same code. Wings and tails are cut
  into fixed panels and hinged surfaces that move on their real hinge lines.
- **Paint.** The paint works in skin coordinates (metres along and around the
  hull): panels, access covers, rivets on the twin, seam tape on the stealth
  type, flow streaks and exhaust soot. Seams get bump shading.
- **Ambient occlusion.** Baked once at load from a voxel grid of the airframe
  (`render/aoBake.ts`) into a per-vertex value that dims only the indirect
  light. Wing roots, inlets, gear wells and the space under the stores darken.
  GTAO was tried and dropped: three r186's GTAO unprojects depth with the
  WebGL convention, which is wrong with a reversed depth buffer on the WebGL2
  fallback that phones use.
