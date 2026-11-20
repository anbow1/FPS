// Marchland's service worker, written into dist/sw.js by the build (tools/pwa/plugin.ts), which fills in
// every file of the game and a revision of each. It keeps the whole game on the device for offline play.
// A new version installs into a cache of its own: files whose revision has not changed are copied over
// from the old cache, only the changed ones are downloaded. It takes over when every window of the old
// version is closed (the next start of the game), or at once when the page asks ('take-over').

const VERSION = '35845cc1cd3f';
const FILES = {"assets/color-B5yQZoZf.jpg":"3de155226f8a","assets/color-BBrovOI2.jpg":"d7237ed4e394","assets/color-BCItct9D.jpg":"fe6b51dca6aa","assets/color-BQTqTFVi.jpg":"1a5906396a18","assets/color-BRUCdFVS.jpg":"15ebe2881ee5","assets/color-BhO69mBa.jpg":"ce61a2f98dee","assets/color-C5QOHQOx.jpg":"183b804c5ad3","assets/color-C7Ffsv5q.jpg":"0fe477a331dc","assets/color-C_ZFKLFe.jpg":"b491e6657524","assets/color-Ccd8nLbO.jpg":"15e476b0b5da","assets/color-Cym0ItPf.jpg":"481f5b4e8fe6","assets/color-Cz9YsDFQ.jpg":"d11f277b69b7","assets/color-DHnCkTPR.jpg":"230f2a3f18e2","assets/color-Dhwxj5f9.jpg":"4670bd9b30ee","assets/color-DmHNpRrw.jpg":"c106761bf6ed","assets/color-Do5NVwCm.jpg":"684903f2e487","assets/color-gKxNV2yC.jpg":"9fcd22842a04","assets/color-q1ffuJQS.jpg":"a4eabf3aefde","assets/index-BwrzWI7e.js":"f2215277c317","assets/index-CNpKyEq3.css":"82c907956a75","assets/normal-81p_xFrK.jpg":"49b765d56ec5","assets/normal-B39WWYAM.jpg":"44a4e468d108","assets/normal-B99yFZEw.jpg":"cc899561b6c6","assets/normal-Beho6wAN.jpg":"e1d4450ec690","assets/normal-CDxmJoGM.jpg":"c69a88bfdc4c","assets/normal-CVD3rpOb.jpg":"e8e3e01c4fb0","assets/normal-Ci6W0CPA.jpg":"f9e72d4aa4fe","assets/normal-CleI5DBX.jpg":"f603cac844bf","assets/normal-CsDKMQLL.jpg":"d13586b7ce33","assets/normal-CssbZkdr.jpg":"22fa74cc736a","assets/normal-CyGLiWD3.jpg":"97d2f0ac234c","assets/normal-DF7bjrSH.jpg":"ad9f3f7511f6","assets/normal-DNG7iH-H.jpg":"6e551e7c4a18","assets/normal-DSm9B56q.jpg":"b2db1aa896e0","assets/normal-Dfm0anJP.jpg":"5269101c9e77","assets/normal-DlSxE1TY.jpg":"f39b4cb0d6ac","assets/normal-OFQA3XBO.jpg":"2fb5f6658758","assets/normal-lzNVT9So.jpg":"cf809348f76f","assets/orm-BAdASIci.jpg":"5eaa7e67a095","assets/orm-BCHzBsHj.jpg":"c1963783e47f","assets/orm-BRVDil1D.jpg":"7c237c31fa7d","assets/orm-BZy53ugC.jpg":"47e4efb20654","assets/orm-BgJaZ-gQ.jpg":"d68916487b00","assets/orm-BzGmXs0v.jpg":"170262321d83","assets/orm-CAHkQUC4.jpg":"aeee753a2d80","assets/orm-Cj11jYNa.jpg":"69a98477dfa4","assets/orm-D8LrvLUR.jpg":"44460ccab74c","assets/orm-DUhLXAD9.jpg":"1fee8f747886","assets/orm-Deyl-3vp.jpg":"5d4c70e7e02e","assets/orm-Dm_HKLiC.jpg":"3dc8032a30c7","assets/orm-DnWnztN0.jpg":"f5dc06180e61","assets/orm-Dpjp34ui.jpg":"a057b491dc61","assets/orm-ScxRC40K.jpg":"d1279dbce1bc","assets/orm-XreAdkN6.jpg":"b4c82db4f032","assets/orm-m9UfitFe.jpg":"01a565809b7a","assets/orm-snZYWApN.jpg":"083331615b02","buildings/CREDITS.md":"5d82332710ee","buildings/armourer_1.glb":"7e1501268419","buildings/armourer_2.glb":"daea6a78c0cf","buildings/armourer_3.glb":"3def3857bdde","buildings/bakery_1.glb":"1e6defd18f2b","buildings/bakery_2.glb":"632c0aef630a","buildings/bakery_3.glb":"1c1b142cbbb3","buildings/barracks_1.glb":"eef47a752a8c","buildings/barracks_2.glb":"256351bf6d68","buildings/barracks_3.glb":"d5573e9b2d7f","buildings/butcher_1.glb":"1094b6a284f0","buildings/butcher_2.glb":"70f02c949cc2","buildings/butcher_3.glb":"496ef3aca102","buildings/farm_1.glb":"55b5e3f9fc2c","buildings/farm_2.glb":"b19012c3d353","buildings/farm_3.glb":"02f0dd6251f6","buildings/fisher_1.glb":"0ab56e16605e","buildings/fisher_2.glb":"abe4492f5281","buildings/fisher_3.glb":"046f82332a12","buildings/fletcher_1.glb":"e0582e321e70","buildings/fletcher_2.glb":"ebd5a3745a96","buildings/fletcher_3.glb":"30a2464cad43","buildings/fortress_1.glb":"302c9a336d5e","buildings/gate.glb":"581dbd8e49ac","buildings/house_1.glb":"3a229f100c15","buildings/house_2.glb":"6bd55fdcab67","buildings/house_3.glb":"f9617c20cef8","buildings/index.json":"b93c84e01191","buildings/ironMine_1.glb":"0d24252b1433","buildings/ironMine_2.glb":"9e410819ab91","buildings/ironMine_3.glb":"3ee3669a9de5","buildings/keep_1.glb":"6a43b63b0307","buildings/pigFarm_1.glb":"87c07b8a53ac","buildings/pigFarm_2.glb":"067b759dad57","buildings/pigFarm_3.glb":"2b6c90b3148e","buildings/quarry_1.glb":"c0e207f3baa6","buildings/quarry_2.glb":"086744f28cf0","buildings/quarry_3.glb":"49f06979f820","buildings/smelter_1.glb":"b83e972872ee","buildings/smelter_2.glb":"543a64f76c6d","buildings/smelter_3.glb":"755497a16d07","buildings/smithy_1.glb":"3003361e4706","buildings/smithy_2.glb":"238f801b30b0","buildings/smithy_3.glb":"37ff746586f6","buildings/stable_1.glb":"483b6877b121","buildings/stable_2.glb":"d20a346532f7","buildings/stable_3.glb":"b33743f4fc4c","buildings/tannery_1.glb":"b26e16a85fcb","buildings/tannery_2.glb":"49a60502b3aa","buildings/tannery_3.glb":"84bb35e804b8","buildings/tower_1.glb":"6fbe86bc342b","buildings/tower_2.glb":"5d991ab13fa5","buildings/tower_3.glb":"043b33503258","buildings/vineyard_1.glb":"a68598f218e3","buildings/vineyard_2.glb":"7dcc5dd575b6","buildings/vineyard_3.glb":"6d3879adb669","buildings/wall.glb":"fedf89abfae9","buildings/windmill_1.glb":"ea9910e51cd7","buildings/windmill_2.glb":"1ee1236212bf","buildings/windmill_3.glb":"109d6d022855","buildings/winery_1.glb":"0f9a4c1c0a09","buildings/winery_2.glb":"5c7ea6b22f69","buildings/winery_3.glb":"c0fdfa6df896","buildings/woodcutter_1.glb":"d85356d2018a","buildings/woodcutter_2.glb":"4750ec06aaa3","buildings/woodcutter_3.glb":"efc31ee7abff","icons/apple-touch-icon.png":"1b06135a071e","icons/favicon-32.png":"fb57d9c9d249","icons/icon-192.png":"c9ab19d1ebba","icons/icon-256.png":"93c79b979a97","icons/icon-512.png":"6eb1c12ad054","index.html":"f011387ef166","manifest.webmanifest":"40d1c64fd551","people/CREDITS.md":"5353cd9890e3","people/smith.json":"752d63e18b0f","people/townsman-beard.json":"9fbf0dc1f0ca","people/townsman-linen.json":"541e86df68ec","people/townsman-wool.json":"1f520555e117","people/townsman.json":"1aa8e03851e9","people/townswoman-dress.json":"e13f75874b77","people/townswoman-worker.json":"b7e0faab54d0","people/townswoman.json":"28187a3542a4","props/CREDITS.md":"e44dd1f0f511","props/cannon.json":"f000320fbf94","props/goods/arrows.json":"3507586000bc","props/goods/barrel.json":"823bf9b830b4","props/goods/bread.json":"caa0c352c015","props/goods/crate.json":"1dda25fe119b","props/goods/lumber.json":"7263c49bd504","props/goods/meat.json":"c4a07f2a507b","props/goods/sack.json":"80f923a52137","props/goods/stone.json":"fcfd87523ee1","props/handcart.json":"2c7e2c941057","props/mortar.json":"605582f15212","props/pig.json":"8dc9200c02ab","props/wagon.json":"b01aa9771c07","soldiers/CREDITS.md":"b0092d071295","soldiers/archer.json":"e9a6bc178436","soldiers/crossbowman.json":"7c16e90cee98","soldiers/halberdier.json":"91edfea19d7d","soldiers/horse.json":"9844fda144ac","soldiers/knight.json":"afbac501f7a7","soldiers/militia.json":"989bc3804dee","soldiers/pikeman.json":"3b2fa70568da","soldiers/rider.json":"6e09f8eea160","soldiers/swordsman.json":"238298049463","soldiers/warhorse.json":"a43a9f459aac","sounds/CREDITS.md":"0787d863354c","sounds/impact_metal_light_000.mp3":"65a996501e07","sounds/impact_metal_light_001.mp3":"901e54ca630b","sounds/impact_metal_medium_000.mp3":"18f8dab965f1","sounds/impact_metal_medium_001.mp3":"71d354a48a21","sounds/impact_metal_medium_002.mp3":"5582b767e414","sounds/impact_mining_000.mp3":"3759df0093f7","sounds/impact_mining_001.mp3":"07cced8e3a1e","sounds/impact_mining_002.mp3":"b92854b9472f","sounds/impact_plate_heavy_000.mp3":"196c2fff9752","sounds/impact_plate_medium_000.mp3":"fef35c459bdb","sounds/impact_plate_medium_001.mp3":"b4172a169526","sounds/impact_punch_heavy_000.mp3":"e8d9b6701710","sounds/impact_punch_medium_000.mp3":"3cf3b752b96b","sounds/impact_punch_medium_001.mp3":"80387c8af520","sounds/impact_soft_heavy_000.mp3":"8ccb78b11702","sounds/impact_soft_heavy_001.mp3":"b2529c926737","sounds/impact_soft_medium_000.mp3":"ec1232f01b88","sounds/impact_soft_medium_001.mp3":"568628db19a9","sounds/rpg_chop.mp3":"2facb3ebae4b","sounds/rpg_knife_slice.mp3":"e85f4b616491","sounds/rpg_knife_slice_2.mp3":"d9de31007359","sounds/rpg_metal_click.mp3":"16df29c6b302","sounds/rpg_metal_latch.mp3":"dda73f05b8b9"};
const CACHE = 'marchland-' + VERSION;
const REVISIONS = 'revisions.json';
const urlOf = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const older = [];
      for (const name of await caches.keys()) {
        if (!name.startsWith('marchland-') || name === CACHE) continue;
        const old = await caches.open(name);
        const listed = await old.match(urlOf(REVISIONS));
        older.push({ cache: old, revisions: listed ? await listed.json() : {} });
      }
      const entries = Object.entries(FILES);
      let next = 0;
      const one = async () => {
        while (next < entries.length) {
          const [path, revision] = entries[next++];
          const url = urlOf(path);
          let response;
          for (const old of older) {
            if (old.revisions[path] !== revision) continue;
            response = await old.cache.match(url, { ignoreVary: true });
            if (response) break;
          }
          if (!response) {
            response = await fetch(url, { cache: 'reload' });
            if (!response.ok) throw new Error(`${path}: ${response.status}`);
          }
          await cache.put(url, response);
        }
      };
      // Six downloads at a time.
      await Promise.all(Array.from({ length: 6 }, one));
      await cache.put(urlOf(REVISIONS), new Response(JSON.stringify(FILES), { headers: { 'Content-Type': 'application/json' } }));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('marchland-') && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'take-over') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = request.mode === 'navigate' ? urlOf('index.html') : request;
      // Whatever the request's headers: a module script asks with an Origin the stored copy's Vary would refuse.
      const kept = await cache.match(key, { ignoreSearch: true, ignoreVary: true });
      return kept ?? fetch(request);
    })(),
  );
});
