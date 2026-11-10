# Baked character atlases

`<character>_<full|far>.ktx2`: the MPFB soldiers' texture atlases, drawn by `render/mpfbCast.ts` from the
pieces in `../tex/` and encoded to KTX2 by `tools/assets/bake_atlases.mjs`. The near atlases are UASTC
with rate-distortion 1, the far ones ETC1S. Those pieces are MakeHuman system assets, released
under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (as `../../hand/LICENSE.md`);
the encoding adds no terms.

Bake again whenever a character, its textures or the atlas layout change. A stale atlas puts the wrong
picture under the uvs.

The transcoder that unpacks them at load (`public/basis/basis_transcoder.js`, `.wasm`) is copied
unchanged from three.js (`examples/jsm/libs/basis/`). It is Basis Universal by Binomial LLC,
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The encoder is the npm package
`ktx2-encoder` (MIT) and is used only at bake time; it does not ship.
