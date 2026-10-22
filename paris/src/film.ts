import { MathUtils, Vector3 } from 'three/webgpu';
import { SHOT } from './config.ts';
import { buildBuildings } from './city/buildings.ts';
import { buildPlan, type Placed, type StreetPlan } from './city/plan.ts';
import { buildStreet } from './city/street.ts';
import { buildTrees } from './city/trees.ts';
import { buildFurniture } from './city/furniture.ts';
import { buildSkyline } from './city/skyline.ts';
import { Lighting } from './render/lighting.ts';
import { SCENE } from './render/nodes.ts';
import { Stage } from './render/stage.ts';
import { loadPhotos } from './render/photo.ts';
import { cloudDeck } from './render/clouds.ts';
import { boulevardRed, Crowd } from './life/crowd.ts';
import { PeopleView } from './life/people.ts';
import { placeOf, Traffic, type Vehicle } from './life/traffic.ts';
import { VehiclesView } from './life/vehicles.ts';
import { Pigeons } from './life/pigeons.ts';
import type { Person } from './life/crowd.ts';
import { loadMocap } from './render/mocap.ts';

// The ten seconds: the street built once, the life on it simulated forward at
// a fixed step, the camera on its dolly, rendered in real time or frame by
// frame for the recorder.

/** Simulation steps per video frame. */
const SUBSTEPS = 4;
const TRAFFIC_SEED = 1889;

export class Film {
  /** How frames come back: PNG for stills; the recorder asks for JPEG (supersampled frames are large). */
  frameFormat: 'image/png' | 'image/jpeg' = 'image/png';
  readonly stage: Stage;
  private lighting!: Lighting;
  private plan!: StreetPlan;
  private crowd!: Crowd;
  private people!: PeopleView;
  private traffic!: Traffic;
  private vehicles!: VehiclesView;
  private riders: { bike: Vehicle; person: Person }[] = [];
  private pigeons!: Pigeons;
  /** Clip time of the last drawn frame (for the gait's advance). */
  private drawnT: number | null = null;
  /** Seconds of the clip the simulation has reached (negative during the pre-roll). */
  private simT = -SHOT.prerollS;
  private readonly from = new Vector3(...SHOT.camFrom);
  private readonly to = new Vector3(...SHOT.camTo);
  private readonly lookFrom = new Vector3(...SHOT.lookFrom);
  private readonly lookTo = new Vector3(...SHOT.lookTo);
  private readonly look = new Vector3();

  constructor(canvas: HTMLCanvasElement, shutter: number) {
    this.stage = new Stage(canvas, shutter);
  }

  async init(width: number, height: number, pixelRatio: number): Promise<void> {
    await this.stage.init();
    this.stage.setSize(width, height, pixelRatio);
    const scene = this.stage.scene;
    this.lighting = new Lighting(this.stage.renderer, scene, 2048);
    await loadPhotos();
    this.plan = buildPlan(1859);
    scene.add(buildBuildings(this.plan));
    scene.add(buildStreet(), buildTrees(this.plan.trees), buildFurniture(this.plan), buildSkyline());
    await loadMocap();
    this.crowd = new Crowd(this.plan, 48, -SHOT.prerollS);
    this.traffic = new Traffic(TRAFFIC_SEED);
    this.riders = this.traffic.vehicles.filter((v) => v.kind === 'bike').map((bike) => ({ bike, person: this.crowd.addRider() }));
    // Full bodies for whoever is within ~70 m of the camera at the start (a walker covers ~14 m in the clip).
    const camZ = this.from.z;
    this.people = new PeopleView(this.crowd.people, (p) => p.mode === 'ride' || Math.abs(p.z - camZ) < 70);
    this.vehicles = new VehiclesView(this.traffic.vehicles, this.plan.parked, this.nearCamera());
    // The flock by the right kerb ahead of the camera, between the lamp posts and the trees; startled at 4.2 s.
    this.pigeons = new Pigeons(10.05, -15, 4.2);
    scene.add(this.people.group, this.vehicles.group, this.pigeons.mesh);
    await this.lighting.apply();
    scene.add(cloudDeck(this.lighting.preExposure));
    const debug = new URLSearchParams(location.search);
    if (debug.has('nofog')) scene.fogNode = null;
    this.stage.direct = debug.has('nopost');
    // `?hide=people,traffic`: leave groups out, to measure what each costs.
    for (const name of debug.get('hide')?.split(',') ?? []) scene.traverse((o) => {
      if (o.name === name) o.visible = false;
    });
    // A grey card in this light meters at the sheet's EV: pre-exposure takes it to 1/1.2, ACES wants a touch more.
    this.stage.setExposure(2 ** 0.6);
    this.placeCamera(0);
    await this.stage.renderer.compileAsync(scene, this.stage.camera);
  }

  /**
   * Which cars come within ~55 m of the camera during the clip (they get the full model): found by running
   * the same traffic once ahead, as it is deterministic.
   */
  private nearCamera(): (car: Vehicle | Placed) => boolean {
    const NEAR_M = 55;
    const ahead = new Traffic(TRAFFIC_SEED);
    const near = new Set<number>();
    const dt = 1 / (SHOT.fps * SUBSTEPS);
    const cam = new Vector3();
    for (let t = -SHOT.prerollS; t < SHOT.durationS; t += dt) {
      ahead.step(dt, t);
      if (t < 0) continue;
      cam.lerpVectors(this.from, this.to, MathUtils.smoothstep(t, -1, SHOT.durationS + 1));
      ahead.vehicles.forEach((v, i) => {
        const at = placeOf(v);
        if (Math.hypot(at.x - cam.x, at.z - cam.z) < NEAR_M) near.add(i);
      });
    }
    const index = new Map(this.traffic.vehicles.map((v, i) => [v, i]));
    const mid = (this.from.z + this.to.z) / 2;
    return (car) => ('lane' in car ? near.has(index.get(car) ?? -1) : Math.abs(car.z - mid) < NEAR_M);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.stage.setSize(width, height, pixelRatio);
    if (this.lighting.csm.camera) this.lighting.csm.updateFrustums();
  }

  /** Draw calls and triangles of the last frame (all passes: shadows, scene, post). */
  private lastFrame = { drawCalls: 0, triangles: 0 };

  info(): Record<string, unknown> {
    return { backend: this.stage.backendName, ...this.lastFrame, simT: this.simT };
  }

  /** The camera at clip time t: an eased dolly and pan. */
  private placeCamera(t: number): void {
    const u = MathUtils.smoothstep(t, -1, SHOT.durationS + 1);
    const cam = this.stage.camera;
    cam.position.lerpVectors(this.from, this.to, u);
    this.look.lerpVectors(this.lookFrom, this.lookTo, u);
    // Debug: `?cam=x,y,z,lx,ly,lz` looks from anywhere.
    const fixed = new URLSearchParams(location.search).get('cam')?.split(',').map(Number);
    if (fixed && fixed.length === 6) {
      cam.position.set(fixed[0] as number, fixed[1] as number, fixed[2] as number);
      this.look.set(fixed[3] as number, fixed[4] as number, fixed[5] as number);
    }
    cam.lookAt(this.look);
    cam.updateMatrixWorld();
    this.lighting.update(cam);
  }

  /** Steps the street's life forward to clip time t. */
  private simulateTo(t: number): void {
    const dt = 1 / (SHOT.fps * SUBSTEPS);
    while (this.simT < t - 1e-6) {
      this.simT += dt;
      this.crowd.step(dt, this.simT, boulevardRed(this.simT));
      this.traffic.step(dt, this.simT);
      this.pigeons.step(dt, this.simT, this.crowd.people);
    }
    for (const { bike, person } of this.riders) {
      const at = placeOf(bike);
      person.x = at.x;
      person.z = at.z;
      person.y = 0;
      person.yawRad = at.yawRad;
      person.crankRad = bike.crankRad;
    }
    SCENE.time.value = t;
  }

  private draw(t: number): void {
    this.simulateTo(t);
    this.people.update(this.drawnT === null ? 0 : Math.max(0, t - this.drawnT));
    if (this.drawnT === null) this.people.settle();
    this.vehicles.update();
    this.pigeons.update(t);
    this.drawnT = t;
    this.placeCamera(t);
    this.stage.render();
    const r = this.stage.renderer.info.render;
    this.lastFrame = { drawCalls: r.drawCalls, triangles: r.triangles };
  }

  /** Renders the clip's moment t (after a short TRAA history of the frames before it); returns the image as a PNG data URL. */
  async renderAt(t: number): Promise<string> {
    let image = '';
    for (let k = SHOT.warmFrames; k >= 0; k--) image = await this.drawFrame(t - k / SHOT.fps);
    return image;
  }

  /** Renders frame i of the clip (frames in order) and returns it as a PNG data URL. */
  async renderFrame(i: number): Promise<string> {
    const t = i / SHOT.fps;
    if (i === 0) for (let k = SHOT.warmFrames; k > 0; k--) await this.drawFrame(-k / SHOT.fps);
    return this.drawFrame(t);
  }

  /**
   * One frame of its own: TRAA keeps its history once per browser frame, so frames drawn back to back in one
   * task resolve to a smear; each waits for the next animation frame. The canvas is read in the same task
   * as the draw, before the browser composites (and clears) it.
   */
  private async drawFrame(t: number): Promise<string> {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    this.draw(t);
    return this.stage.canvas.toDataURL(this.frameFormat, 0.96);
  }

  /** Real-time playback, looping the clip. */
  play(): void {
    const t0 = performance.now();
    const tick = (): void => {
      const t = ((performance.now() - t0) / 1000) % SHOT.durationS;
      if (t < this.simT) this.simT = t - SHOT.prerollS;
      this.draw(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
