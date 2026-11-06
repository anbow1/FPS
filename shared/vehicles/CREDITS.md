# Vehicles: sources and credits

Prepared for the games by `paris/tools/vehicles/prepare_vehicle.py` (one car picked from the pack,
turned along its wheelbase, scaled to a real length, wheels and lamps split out, three levels of detail,
ambient occlusion baked by Cycles). The tanks and IFVs (mbt_*, ifv_*) by `prepare_tank.py`: split into hull, turret
and gun about their pivots, inward-facing pieces turned, ambient occlusion cast per face corner. The helicopters (heli_*) by
`prepare_heli.py`: rotors (hub and blades), tail rotor, chin gun and missiles split out, scaled to the
flight model's rotor; the Bulat's posed gun mount turned straight ahead, its sealed launchers and rocket
pods given as launch points. The fighters (jet_*) by `prepare_jet.py`: tailplanes, flaperons and rudders (the Talon's whole fins) on
their hinge lines, the landing gear and squadron badges taken off. The lorries (cargo_truck, staff_car) and the lagoon's cutter and skiff (boat_cutter, boat_skiff) by
`prepare_truck.py`: one body, wheels and all, after `scrub_marks.py` painted the staff car's door stars
and maker's plates and the cargo lorry's door chevron out of their textures. The lagoon's jeep (jeep_open) by
`prepare_vehicle.py`: its wheels and its bonnet (`--part`) as their own nodes, after `scrub_marks.py` painted the
stencilled star, numbers and data plate out of its colour and roughness maps.

| Folder | Source | Author | Licence |
| --- | --- | --- | --- |
| compact, coupe, hatchback, minivan, offroad, pickup, sedan, sport, suv, wagon | [Generic passenger car pack](https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5) | [Comrade1280](https://sketchfab.com/comrade1280) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| mbt_west | [M1A2 main battle tank, woodland camouflage](https://sketchfab.com/3d-models/m1a2-abrams-main-battle-tank-woodland-camouflage-5a4e7e7e036e4f8cb4ac0d48bc8de352) | [Muhamad Mirza Arrafi](https://sketchfab.com/nazidefenseforceofficial) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| mbt_east | [T-90AM main battle tank](https://sketchfab.com/3d-models/uralvagonzavod-t-90am-main-battle-tank-619de9f0908e4c8395fe036ffe6e3884) | [Muhamad Mirza Arrafi](https://sketchfab.com/nazidefenseforceofficial) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| ifv_west | [M2 Bradley IFV](https://sketchfab.com/3d-models/m2-bradley-ifv-ab022158ab5f4fbfa55d4142db7595ab) | [42manako](https://sketchfab.com/42manako) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| ifv_east | [BMP-2](https://sketchfab.com/3d-models/bmp-2-a843e922897c499ca53e718235b3875a) | [42manako](https://sketchfab.com/42manako) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| heli_warden | [AH-64D attack helicopter](https://sketchfab.com/3d-models/boeing-ah-64d-apache-combat-helicopter-c3b58008c46b45048fdd7dd283a3c8c8) | [Muhamad Mirza Arrafi](https://sketchfab.com/nazidefenseforceofficial) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| cargo_truck | [M939 utility truck](https://sketchfab.com/3d-models/m939-utility-truck-7613cbde1857466ab4dd49b44fbfb959) (door chevron painted out) | [42manako](https://sketchfab.com/42manako) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| staff_car | [Military Truck](https://sketchfab.com/3d-models/military-truck-d3a85af5faef4fddb217b3fce073614c) (door stars and plates painted out) | [Raphael Escamilla](https://sketchfab.com/Raffey) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| heli_bulat | [Mi-28N Havoc](https://sketchfab.com/3d-models/mi-28n-havoc-3e80c95bbadf46abbafba9d9a08afc68) (its turned gun mount straightened) | [Rukh3D](https://sketchfab.com/rukh3d) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| jet_talon | [Sukhoi Su-57 3D Model](https://sketchfab.com/3d-models/sukhoi-su-57-3d-model-0626205c69204081b3fe416616ad8cf0) (stars, bort numbers and emblem painted out; lowered gear left out) | [thomas333](https://sketchfab.com/thomas333) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| boat_cutter | [Fisher boat](https://sketchfab.com/3d-models/fisher-boat-385b039e95754dca8d8c045ed0c515cf) (its name painted off the bow) | [Batuhan13](https://sketchfab.com/Batuhan13) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| boat_skiff | [«Progress» motorboat](https://sketchfab.com/3d-models/progress-motorboat-4d0e69bb45a34f669709c416eec37b15) (its own outboard left out: the game clamps its own on the transom) | [isiosiusin](https://sketchfab.com/isiosiusin) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| jeep_open | [Jeep](https://sketchfab.com/3d-models/jeep-ae6528c1735848a99de368936413fb9b) (its bonnet star, serial numbers and data plate painted out) | [rajibkc](https://sketchfab.com/rajibkc) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| jet_wraith | [F-35B Lightning II](https://sketchfab.com/3d-models/f-35b-lightning-ii-raf-617-squadron-1161f64164ce481189ce67d39502c068) (squadron badges and landing gear removed) | [mgg8](https://sketchfab.com/mgg8) | [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) |

Credit line for the games' credits (CC BY requires it):

> This work is based on "Generic passenger car pack" by Comrade1280, licensed under CC BY 4.0.
> This work is based on "M1A2 Abrams Main Battle Tank Woodland Camouflage" and "Uralvagonzavod T-90AM
> Main Battle Tank" by Muhamad Mirza Arrafi, licensed under CC BY 4.0.
> This work is based on "M2 Bradley IFV", "BMP-2" and "M939 utility truck" by 42manako, licensed under CC BY 4.0.
> This work is based on "Military Truck" by Raphael Escamilla, licensed under CC BY 4.0.
> This work is based on "Boeing AH-64D Apache Combat Helicopter" by Muhamad Mirza Arrafi, licensed under CC BY 4.0.
> This work is based on "Mi-28N Havoc" by Rukh3D, licensed under CC BY 4.0.
> This work is based on "Sukhoi Su-57 3D Model" by thomas333, licensed under CC BY 4.0.
> This work is based on "Fisher boat" by Batuhan13, licensed under CC BY 4.0.
> This work is based on "«Progress» motorboat" by isiosiusin, licensed under CC BY 4.0.
> This work is based on "Jeep" by rajibkc, licensed under CC BY 4.0.
