import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { attribute, float, mix, positionGeometry, smoothstep, vec3 } from 'three/tsl';
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Quaternion, TorusGeometry, Vector3 } from 'three/webgpu';
import { buildCar, type CarPart, type CarVariant } from '../render/carModel.ts';
import { merge, tube } from '../render/meshkit.ts';
import { linearRgb, SCENE } from '../render/nodes.ts';
import { sharedCar } from '../render/sharedCars.ts';
import type { Placed } from '../city/plan.ts';
import { placeOf, type Vehicle } from './traffic.ts';

// The traffic drawn: Field Line's lofted cars (render/carModel.ts, two
// invented bodies) instanced per part, their wheels split off so they turn
// with the distance driven, tail lamps brightening when they brake; parked
// cars along both kerbs; city buses in an invented two-tone livery; bicycles
// (their riders are people, posed in people.ts).

/** Car colours as a car park has them: white, black, greys and silver most, then blues, reds, a green, a beige. */
const PAINTS = [0xe8e8e6, 0xf0f0ee, 0xdedcd8, 0xe6e4e0, 0x111214, 0x18191b, 0x0c0c0d, 0x7a7d80, 0x9a9da0, 0xb4b6b8, 0x4a4d52, 0x1d2c4a, 0x6b1414, 0x23382c, 0xb8ab8e, 0x5d7fa0].map(linearRgb);
const TAXI_PAINT = linearRgb(0x16181b);
const WHEEL_R = 0.316;
const TRACK_HALF = 0.76;
const AXLE_Z = [-1.3, 1.3];

interface CarSet {
  parts: Map<CarPart, InstancedMesh>;
  /** Left and right wheel meshes (a tyre and a rim each for the procedural car, one textured wheel for a model). */
  wheels: [InstancedMesh, InstancedMesh][];
  paint: InstancedBufferAttribute;
  brake: InstancedBufferAttribute;
  axleZ: readonly [number, number];
  trackHalf: number;
  wheelR: number;
}

export class VehiclesView {
  readonly group = new Group();
  private readonly cars: CarSet[] = [];
  private readonly carList: { set: CarSet; index: number; v: Vehicle | null; parked: Placed | null }[] = [];
  private buses!: { mesh: InstancedMesh[]; wheels: InstancedMesh; list: Vehicle[] };
  private bikes!: { frame: InstancedMesh; wheels: InstancedMesh; list: Vehicle[] };
  private readonly taxiSigns: { mesh: InstancedMesh; list: { set: CarSet; index: number; v: Vehicle | null }[] };

  /**
   * `near` says which cars come close enough to the camera to need the full model (~8 k triangles); the
   * rest get the coarse one (~2 k). Decided once, so no car changes model (and instance slot) mid-shot: a
   * slot that changed would give the velocity buffer a jump and the motion blur a streak.
   */
  constructor(vehicles: readonly Vehicle[], parked: readonly Placed[], near: (car: Vehicle | Placed) => boolean) {
    this.group.name = 'traffic';
    const mats = carMaterials();
    for (const variant of ['hatch', 'saloon'] as const) {
      for (const fine of [true, false]) this.addCars(variant, fine, vehicles, parked, near, mats);
    }
    const taxis = this.carList.filter((c) => c.v?.kind === 'taxi');
    this.taxiSigns = { mesh: this.instanced(new BoxGeometry(0.42, 0.11, 0.16).translate(0, 1.5, 0.15), mats.taxiSign, Math.max(1, taxis.length), false), list: taxis };
    this.addBusesAndBikes(vehicles, mats);
  }

  /** One car set: a body (fine or coarse) instanced per part, for the cars of that variant and detail. */
  private addCars(variant: CarVariant, fine: boolean, vehicles: readonly Vehicle[], parked: readonly Placed[], near: (car: Vehicle | Placed) => boolean, mats: ReturnType<typeof carMaterials>): void {
    const isVariant = (k: number): boolean => k % 2 === (variant === 'hatch' ? 0 : 1);
    const moving = vehicles.filter((v) => (v.kind === 'car' || v.kind === 'taxi') && isVariant(v.variant) && near(v) === fine);
    const still = parked.filter((p) => isVariant(p.seed) && near(p) === fine);
    const n = moving.length + still.length;
    if (n === 0) return;
    const paint = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const brake = new InstancedBufferAttribute(new Float32Array(n), 1);
    const parts = new Map<CarPart, InstancedMesh>();
    const set = this.sharedSet(variant, fine, n, paint, brake, mats) ?? this.proceduralSet(variant, fine, n, paint, brake, mats, parts);
    this.cars.push(set);
    let i = 0;
    for (const v of moving) {
      paint.setXYZ(i, ...((v.kind === 'taxi' ? TAXI_PAINT : PAINTS[v.paint % PAINTS.length]) as [number, number, number]));
      this.carList.push({ set, index: i++, v, parked: null });
    }
    for (const p of still) {
      paint.setXYZ(i, ...(PAINTS[(p.seed >> 3) % PAINTS.length] as [number, number, number]));
      this.carList.push({ set, index: i++, v: null, parked: p });
    }
  }

  /**
   * A car set from the shared models (render/sharedCars.ts): textured body recoloured per car, glass, lamps
   * (the tail lamps brightening when braking) and its own wheels. Null when the model did not load.
   */
  private sharedSet(variant: CarVariant, fine: boolean, n: number, paint: InstancedBufferAttribute, brake: InstancedBufferAttribute, mats: ReturnType<typeof carMaterials>): CarSet | null {
    const car = sharedCar(variant, fine);
    if (!car) return null;
    const parts = new Map<CarPart, InstancedMesh>();
    car.paint.setAttribute('paint', paint);
    parts.set('paint', this.instanced(car.paint, car.paintMaterial, n, true));
    if (car.glass) parts.set('glass', this.instanced(car.glass, mats.glass, n, false));
    if (car.headlamp) parts.set('headlamp', this.instanced(car.headlamp, mats.headlamp, n, false));
    if (car.taillamp) {
      car.taillamp.setAttribute('brake', brake);
      parts.set('taillamp', this.instanced(car.taillamp, mats.taillamp, n, false));
    }
    return {
      parts,
      wheels: [[this.instanced(car.wheel[0], car.wheelMaterial, n * 2, true), this.instanced(car.wheel[1], car.wheelMaterial, n * 2, true)]],
      paint,
      brake,
      axleZ: car.axleZ,
      trackHalf: car.trackHalf,
      wheelR: car.wheelR,
    };
  }

  /** The lofted procedural car (render/carModel.ts), drawn per part. */
  private proceduralSet(variant: CarVariant, fine: boolean, n: number, paint: InstancedBufferAttribute, brake: InstancedBufferAttribute, mats: ReturnType<typeof carMaterials>, parts: Map<CarPart, InstancedMesh>): CarSet {
    const geo = buildCar(variant, !fine);
    for (const part of ['paint', 'glass', 'trim', 'headlamp', 'taillamp', 'plate'] as const) {
      const g = geo[part];
      if (!g) continue;
      if (part === 'paint') g.setAttribute('paint', paint);
      if (part === 'taillamp') g.setAttribute('brake', brake);
      parts.set(part, this.instanced(g, mats[part], n, part !== 'headlamp' && part !== 'taillamp' && part !== 'plate'));
    }
    return {
      parts,
      wheels: [
        [this.instanced(wheelOf(geo.tyre, -1), mats.tyre, n * 2, true), this.instanced(wheelOf(geo.tyre, 1), mats.tyre, n * 2, true)],
        [this.instanced(wheelOf(geo.rim, -1), mats.rim, n * 2, false), this.instanced(wheelOf(geo.rim, 1), mats.rim, n * 2, false)],
      ],
      paint,
      brake,
      axleZ: AXLE_Z as [number, number],
      trackHalf: TRACK_HALF,
      wheelR: WHEEL_R,
    };
  }

  private addBusesAndBikes(vehicles: readonly Vehicle[], mats: ReturnType<typeof carMaterials>): void {
    const busList = vehicles.filter((v) => v.kind === 'bus');
    const bus = busGeometry();
    this.buses = {
      mesh: [this.instanced(bus.body, busMaterial(), Math.max(1, busList.length), true), this.instanced(bus.glass, mats.glass, Math.max(1, busList.length), false)],
      wheels: this.instanced(bus.wheel, mats.tyre, Math.max(1, busList.length * 4), true),
      list: busList,
    };
    const bikeList = vehicles.filter((v) => v.kind === 'bike');
    const bike = bikeGeometry();
    this.bikes = { frame: this.instanced(bike.frame, mats.bike, Math.max(1, bikeList.length), true), wheels: this.instanced(bike.wheel, mats.bike, Math.max(1, bikeList.length * 2), true), list: bikeList };
  }

  private instanced(g: BufferGeometry, m: MeshStandardNodeMaterial, n: number, shadow: boolean): InstancedMesh {
    const mesh = new InstancedMesh(g, m, n);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  update(): void {
    for (const c of this.carList) {
      const at = c.v ? placeOf(c.v) : { x: (c.parked as Placed).x, z: (c.parked as Placed).z, yawRad: (c.parked as Placed).x > 0 ? 0 : Math.PI };
      _car.compose(_p.set(at.x, 0, at.z), _q.setFromAxisAngle(_y, at.yawRad), _one);
      for (const mesh of c.set.parts.values()) mesh.setMatrixAt(c.index, _car);
      c.set.brake.setX(c.index, c.v?.braking ? 1 : 0);
      const turn = c.v ? c.v.wheelRad : 0;
      const set = c.set;
      // Each wheel rolls through its own circumference: a model's wheel radius is not the procedural one's.
      const spin = (turn * WHEEL_R) / set.wheelR;
      set.axleZ.forEach((z, k) => {
        for (const side of [0, 1] as const) {
          _w.makeTranslation(side === 0 ? -set.trackHalf : set.trackHalf, set.wheelR, z).multiply(_r.makeRotationX(-spin));
          _w.premultiply(_car);
          for (const pair of set.wheels) pair[side].setMatrixAt(c.index * 2 + k, _w);
        }
      });
    }
    this.taxiSigns.list.forEach((t, i) => {
      const at = placeOf(t.v as Vehicle);
      this.taxiSigns.mesh.setMatrixAt(i, _car.compose(_p.set(at.x, 0, at.z), _q.setFromAxisAngle(_y, at.yawRad), _one));
    });
    this.buses.list.forEach((b, i) => {
      const at = placeOf(b);
      _car.compose(_p.set(at.x, 0, at.z), _q.setFromAxisAngle(_y, at.yawRad), _one);
      for (const m of this.buses.mesh) m.setMatrixAt(i, _car);
      [[-1.25, -3.6], [1.25, -3.6], [-1.25, 2.4], [1.25, 2.4]].forEach(([x, z], k) => {
        _w.makeTranslation(x as number, 0.5, z as number).multiply(_r.makeRotationX(-b.wheelRad)).premultiply(_car);
        this.buses.wheels.setMatrixAt(i * 4 + k, _w);
      });
    });
    this.bikes.list.forEach((b, i) => {
      const at = placeOf(b);
      _car.compose(_p.set(at.x, 0, at.z), _q.setFromAxisAngle(_y, at.yawRad), _one);
      this.bikes.frame.setMatrixAt(i, _car);
      [-0.53, 0.53].forEach((z, k) => {
        _w.makeTranslation(0, 0.34, z).multiply(_r.makeRotationX(-b.wheelRad)).premultiply(_car);
        this.bikes.wheels.setMatrixAt(i * 2 + k, _w);
      });
    });
    for (const m of this.group.children) if (m instanceof InstancedMesh) m.instanceMatrix.needsUpdate = true;
    for (const set of this.cars) set.brake.needsUpdate = true;
  }
}

/** One wheel of the car's four (left: side −1), moved so its axle is at the origin. */
function wheelOf(g: BufferGeometry | undefined, side: -1 | 1): BufferGeometry {
  if (!g) throw new Error('car model has no wheel part');
  const src = g.index ? g.toNonIndexed() : g;
  const pos = src.getAttribute('position');
  const nor = src.getAttribute('normal');
  const keepP: number[] = [];
  const keepN: number[] = [];
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    if (Math.sign(cx) !== side || cz > 0) continue;
    for (let k = 0; k < 3; k++) {
      keepP.push(pos.getX(t + k) - side * TRACK_HALF, pos.getY(t + k) - WHEEL_R, pos.getZ(t + k) - (AXLE_Z[0] as number));
      keepN.push(nor.getX(t + k), nor.getY(t + k), nor.getZ(t + k));
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(keepP), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(keepN), 3));
  return out;
}

/** A 12 m city bus, low floor, glazed down both sides (front −Z, ground y = 0). */
function busGeometry(): { body: BufferGeometry; glass: BufferGeometry; wheel: BufferGeometry } {
  const body = new RoundedBoxGeometry(2.55, 2.75, 12, 3, 0.18).translate(0, 0.32 + 1.375, 0);
  const glass: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (let z = -4.6; z < 5.2; z += 1.42) glass.push(new BoxGeometry(0.03, 1.2, 1.3).translate(sx * 1.28, 1.95, z));
  }
  glass.push(new BoxGeometry(2.3, 1.75, 0.04).translate(0, 1.85, -6.0));
  glass.push(new BoxGeometry(2.1, 0.9, 0.04).translate(0, 2.2, 6.0));
  // Doors: tall glazed leaves on the kerb side.
  for (const z of [-4.9, 0.4]) glass.push(new BoxGeometry(0.035, 2.3, 1.15).translate(1.285, 1.45, z));
  const wheel = new CylinderGeometry(0.5, 0.5, 0.3, 18).rotateZ(Math.PI / 2);
  return { body: body.toNonIndexed(), glass: merge(glass, 'bus glass'), wheel };
}

/** A city bicycle: diamond frame, fork, bars, saddle, rack; the wheels separate so they turn. */
function bikeGeometry(): { frame: BufferGeometry; wheel: BufferGeometry } {
  const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  const bb = v(0, 0.3, 0);
  const seat = v(0, 0.86, 0.16);
  const head = v(0, 0.82, -0.42);
  const headLow = v(0, 0.66, -0.45);
  const rear = v(0, 0.34, 0.53);
  const front = v(0, 0.34, -0.53);
  const t = (a: Vector3, b: Vector3, r = 0.016): BufferGeometry => tube([a, b], [r, r], 6, 1);
  const frame = [t(bb, seat), t(seat, head), t(bb, headLow), t(bb, rear.clone().setX(0.05)), t(bb, rear.clone().setX(-0.05)), t(seat, rear.clone().setX(0.05), 0.012), t(seat, rear.clone().setX(-0.05), 0.012), t(head, front, 0.015), t(head, v(0, 1.0, -0.47), 0.016)];
  frame.push(new BoxGeometry(0.56, 0.025, 0.025).translate(0, 1.0, -0.47));
  frame.push(new BoxGeometry(0.14, 0.05, 0.26).translate(0, 0.95, 0.2));
  frame.push(t(seat, v(0, 0.95, 0.2), 0.012));
  frame.push(new BoxGeometry(0.16, 0.02, 0.36).translate(0, 0.72, 0.5));
  frame.push(new CylinderGeometry(0.08, 0.08, 0.02, 14).rotateZ(Math.PI / 2).translate(0.05, 0.3, 0));
  const wheelParts: BufferGeometry[] = [new TorusGeometry(0.33, 0.018, 6, 28).rotateY(Math.PI / 2)];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    wheelParts.push(new BoxGeometry(0.003, 0.32, 0.003).translate(0, 0.16, 0).rotateX(a));
  }
  return { frame: merge(frame, 'bike'), wheel: merge(wheelParts, 'bike wheel') };
}

function carMaterials(): Record<CarPart | 'taxiSign' | 'bike', MeshStandardNodeMaterial> {
  const paint = new MeshPhysicalNodeMaterial({ name: 'car paint', metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 });
  paint.colorNode = attribute('paint', 'vec3');
  const glass = new MeshStandardNodeMaterial({ name: 'car glass', color: 0x050608, roughness: 0.04, metalness: 0 });
  const trim = new MeshStandardNodeMaterial({ name: 'car trim', color: 0x0d0d0e, roughness: 0.6 });
  // Daytime running lights at dusk; tail lamps glow as position lights and brighten when braking.
  const headlamp = new MeshStandardNodeMaterial({ name: 'car headlamp', color: 0x9a9a9a, roughness: 0.1 });
  headlamp.emissiveNode = vec3(1, 0.97, 0.92).mul(SCENE.lanternNits.mul(0.8));
  const taillamp = new MeshStandardNodeMaterial({ name: 'car taillamp', color: 0x5a0606, roughness: 0.15 });
  taillamp.emissiveNode = vec3(1, 0.05, 0.02).mul(SCENE.lanternNits.mul(mix(float(0.05), float(0.5), attribute('brake', 'float'))));
  const plate = new MeshStandardNodeMaterial({ name: 'car plate', color: 0xd8d8d4, roughness: 0.4 });
  const tyre = new MeshStandardNodeMaterial({ name: 'tyre', color: 0x161616, roughness: 0.85 });
  const rim = new MeshStandardNodeMaterial({ name: 'rim', color: 0xa8aaad, roughness: 0.3, metalness: 0.9 });
  const taxiSign = new MeshStandardNodeMaterial({ name: 'taxi sign', color: 0xf0f0e8, roughness: 0.3 });
  taxiSign.emissiveNode = vec3(0.6, 1, 0.7).mul(SCENE.lanternNits.mul(0.12));
  const bike = new MeshStandardNodeMaterial({ name: 'bicycle', color: new Color(0x3d4a44), roughness: 0.45, metalness: 0.5 });
  return { paint, glass, trim, headlamp, taillamp, plate, tyre, rim, taxiSign, bike };
}

/** The bus's invented livery: pale grey above, a deep green skirt and a band under the windows. */
function busMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'bus', metalness: 0.2, roughness: 0.4, clearcoat: 0.6 });
  const y = positionGeometry.y;
  const green = vec3(...linearRgb(0x1f4a3a));
  const grey = vec3(...linearRgb(0xc9ccc6));
  m.colorNode = mix(green, grey, smoothstep(1.1, 1.14, y));
  return m;
}

const _car = new Matrix4();
const _w = new Matrix4();
const _r = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _y = new Vector3(0, 1, 0);
const _one = new Vector3(1, 1, 1);
