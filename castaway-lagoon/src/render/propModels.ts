// Every interactable `model` the render layer knows (render/props.ts): what it
// draws, plus the handles drawn by something else (the outpost, the boat, the
// jeep) or by nothing (the cot). A model missing here throws while the props
// are built, which stops the game loading, so tests/lagoon.test.ts checks
// every interactable of a new game against this list. No imports: tests read
// it without three.js.

export const PROP_MODELS: ReadonlySet<string> = new Set([
  'aloe',
  'ammoBox',
  'backpack',
  'beans',
  'canteen',
  'coconut',
  'crate',
  'flare',
  'herb',
  'hibiscus',
  'jeepBonnet',
  'jeepDriver',
  'jeepPassenger',
  'journal',
  'knife',
  'lantern',
  'log',
  'map',
  'medkit',
  'none',
  'photo',
  'radio',
  'rifle',
  'rope',
  'stone',
  'woodpile',
]);
