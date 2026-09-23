// Shell-textured turf (§7A.3b) — the animated grass.
//
// WHY SHELLS AND NOT BLADES. The honest way to draw grass is instanced blade
// geometry, and the honest way to make it affordable is a compute pass that
// this project does not have (WebGL2, no compute, no indirect draw). A pitch
// is 105x68m; even at a miserly 400 blades/m² that is three million quads,
// which is three times the triangle budget of the entire rest of the frame for
// something the tele cam resolves at two pixels a blade.
//
// Shell texturing buys the same silhouette for a hundredth of that. The turf is
// a stack of copies of one horizontal sheet, each lifted a few millimetres
// above the last; each shell keeps only the texels whose blade is at least that
// tall (TextureLab.grassShell bakes that height field), so the blades taper and
// thin out toward the tips on their own, from ONE texture and ONE draw call.
// At HIGH the stack is 7 sheets of a 67x67 grid: ~63k triangles on a frame that
// already draws 745k.
//
// SHELLS ARE PRICED PER PIXEL, NOT PER TRIANGLE, and the first version of this
// file cost 11.5ms a frame at 2940x1604 because it forgot that. Three things
// brought it down, each documented where it happens: the stack does not start
// at the ground (SHELL_BASE), it does not sample anything anisotropically
// (FRAG_MAP, and the 4x on the shell map in TextureLab), and it is lit with
// Lambert rather than the full physical BRDF seven times over.
//
// THE TRANSITION IS THE WHOLE TRICK. The shells are not a different pitch:
//
//  • they sample the SAME macro albedo the pitch plane wears, by world
//    position, so the markings, the worn goalmouths and the macro variation
//    line up to the texel;
//  • they run the SAME mowing-stripe shader the pitch runs, so a stripe
//    crossing the patch boundary does not change phase, brightness or lean;
//  • and they fade out by raising the shell threshold rather than by going
//    transparent — the top shells vanish first, then the next, until what is
//    left is one sheet 3mm above the plane with the plane's own colours on it.
//    There is no line to see, because there is no edge: the turf just gets
//    shorter until it is the pitch.
//
// The patch follows the camera's look point, snapped to the cell grid so the
// tessellation never crawls under a static shot, and everything it samples is
// in WORLD space, so moving the mesh moves nothing in the image.
//
// ANIMATION. A low-frequency wind field shears each shell horizontally by its
// own height (t^1.4, so the tips travel and the roots do not), with a slow gust
// envelope on top. The ball drags a wake: blades inside a speed-dependent
// radius get pushed radially outward, flattened where the ball is actually
// touching, and given a faster local tremor; the ball's contact shadow darkens
// the shells it is sitting on, which is the cue that makes it look like the
// ball is IN the grass instead of on a picture of it.

import * as THREE from 'three';
import { HALF_L, PITCH_LENGTH, PITCH_WIDTH } from '../sim/constants';
import { PITCH_MARGIN, SHELL_TILE_M, type TextureLab } from './TextureLab';
import { queueShaderPatch } from './materials';
import { TURF_PARS_GLSL } from './turf';
import type { QualityProfile } from './quality';

/** Mown match turf: 25-30mm. 42mm is a slightly generous read of that, which
 *  is what makes the wind visible at broadcast distance without the pitch
 *  looking like a meadow. */
const GRASS_H = 0.042;

// THE BOTTOM OF THE STACK IS NOT WORTH DRAWING, and that is the difference
// between a turf that fits and one that does not.
//
// A shell's cost is its COVERAGE — the fraction of its sheet that survives the
// blade-height test and goes on to be lit — and coverage falls roughly linearly
// with the shell's height, from ~80% at the roots to ~13% at the tips. So the
// three lowest shells of an evenly-spaced stack of eight are more than half of
// the entire cost of the turf. What they draw is a sheet of grass-coloured
// pixels three millimetres above a plane that is already there, wearing the
// same albedo, sampled from the same texture. They are invisible and they are
// the bill.
//
// So the stack starts at SHELL_BASE of the blade height and the pitch plane
// plays the part of everything below it. The gaps between blades then show the
// plane rather than a dark shell, which is why the plane gets its own matching
// darkening (see pitch.ts's ss26GrassAo) — one multiply on a surface that was
// being drawn anyway, instead of four more sheets of alpha-tested PBR.
const SHELL_BASE = 0.34;

// The patch, and the one decision in this file that took two passes to get
// right. The fade has to be measured from the CAMERA, not from the centre of
// the patch: a knee-height end-zone camera looks at a point thirty metres away
// and the grass that matters is the three metres in front of the lens. Fading
// from the look point put the boundary across the near foreground, which is
// the only place a shell renderer is ever caught.
//
// So the patch is centred on the camera's own ground position and the fade is
// a sphere around the camera. Half the sheet is then behind the lens and gets
// clipped for the cost of its vertices (they are 8 floats and no texture
// fetch), which is the cheap half of the trade.
//
// 46m out is where a 4cm blade is under a device pixel at DPR 2 on a 36° lens;
// the 16m-wide fade is deliberately far wider than it needs to be, because the
// thing that gives a shell renderer away is a ring, and a ring you can see is
// a ring that was too narrow.
/** The fade occupies the outer 40% of the radius: wide, because the thing that
 *  gives a shell renderer away is a ring, and a ring you can see is a ring that
 *  was too narrow. */
const FADE_FRACTION = 0.45;
/** Target cell size. The wake is ~1.5m across and has to be a shape, not a
 *  diamond; below ~1m nothing improves and the vertex count doubles. */
const TARGET_CELL = 0.95;

/** Metres of horizontal travel at the blade TIP in a full gust. 16mm on a 42mm
 *  blade is a ~21° lean, which is a stiff breeze and not a gale. */
const WIND_AMPLITUDE = 0.016;

/** The TS twin of the shader's ss26Gust(), used only by the debug probe — the
 *  point of the probe is to report what the GPU is being told, so the two have
 *  to be the same function. */
function gustAt(x: number, z: number, t: number): number {
  return Math.sin(x * 0.28 + t * 1.10) * 0.52
    + Math.sin(z * 0.21 - t * 0.83) * 0.31
    + Math.sin((x + z) * 0.13 + t * 1.63) * 0.17;
}

/** Slack over the fade radius before the camera is simply too high for any
 *  ground to be inside it — see update(). */
const HEIGHT_SLACK = 2;

const PITCH_SPAN_X = PITCH_LENGTH + PITCH_MARGIN * 2;
const PITCH_SPAN_Y = PITCH_WIDTH + PITCH_MARGIN * 2;

/**
 * What the PITCH PLANE has to know about the turf standing on it.
 *
 * The stack starts at SHELL_BASE (see above), so the plane is playing the part
 * of the bottom of the grass — and the bottom of a pile of grass is in shade.
 * Without this the gaps between the blades are lit as brightly as an open
 * pitch and the turf reads as confetti scattered on a lawn. `strength` is the
 * shell AO curve evaluated below the base of the stack; `from`/`to` are the
 * same fade window the shells use, so the two agree to the metre and there is
 * no ring where one ends and the other does not.
 */
export function grassPlaneAo(profile: { grassShells: number; grassRadius: number }):
{ strength: number; from: number; to: number } {
  if (profile.grassShells <= 0) return { strength: 0, from: 1, to: 2 };
  return {
    strength: 1 - shellAo(SHELL_BASE * 0.8),
    from: profile.grassRadius * FADE_FRACTION,
    to: profile.grassRadius,
  };
}

/**
 * The self-occlusion curve, in TS so the plane and the shells cannot drift.
 *
 * Two constraints, and they fight. The SPREAD has to be wide enough that the
 * stack reads as depth rather than as a decal; the MEAN over the shells a
 * camera actually sees has to land on 1.0, or the turf is a darker disc
 * painted on a lighter pitch and the patch boundary becomes the most visible
 * thing in the frame. 0.66..1.13 over t^0.7 puts the typical visible shell
 * (~0.75 of the stack) at 1.04 and the plane showing through the gaps at 0.85,
 * which is a 20% swing between blade and gap and only a ~9% drop in the mean.
 */
function shellAo(t: number): number {
  return 0.66 + (1.13 - 0.66) * t ** 0.70;
}

/** The ball's ground state, published by BallMesh through scene.userData so
 *  the turf does not have to know what a match is. */
export interface GrassBall {
  x: number;
  /** height above the pitch, metres */
  y: number;
  z: number;
  /** horizontal speed, m/s */
  speed: number;
}

export class GrassField {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private uniforms: Record<string, THREE.IUniform> = {};
  private center = new THREE.Vector2(0, 0);
  private tmpDir = new THREE.Vector3();
  private readonly radius: number;
  private readonly span: number;
  private readonly cell: number;
  private readonly shells: number;

  /** `stripePeriod` comes from the caller rather than from an import of
   *  pitch.ts, because pitch.ts is what builds this — a cycle here would put
   *  the module in a temporal dead zone for the sake of one number. */
  constructor(scene: THREE.Scene, lab: TextureLab, profile: QualityProfile,
    stripePeriod: number) {
    const maps = lab.pitchMaps();
    const shells = Math.max(1, Math.round(profile.grassShells));
    this.shells = shells;
    this.radius = profile.grassRadius;
    const seg = Math.max(8, Math.round((this.radius * 2 + 4) / TARGET_CELL));
    this.span = this.radius * 2 + 4;
    this.cell = this.span / seg;

    // LAMBERT, NOT STANDARD — the third and largest of the cost decisions in
    // this file, and the only one that is visible at all.
    //
    // MeshStandardMaterial's fragment shader is the most expensive one in the
    // game: a GGX lobe per light, the multiscatter environment BRDF, and a
    // PMREM cube lookup at a roughness-derived mip for the image-based
    // specular. That is the right shader for a ball, a shirt or a painted goal
    // frame. A shell stack runs it SEVEN TIMES PER PIXEL, for a surface that
    // is roughness 0.82 and metalness 0 — i.e. one whose entire specular
    // response is a broad, dim, shapeless lobe that no viewer could point to.
    //
    // Lambert keeps everything the turf actually needs (the cascade-shadowed
    // key, the hemisphere fill, the environment's diffuse irradiance) and
    // drops exactly the part being paid for seven times over. What it also
    // drops — the silvery sheen a real pitch shows when you look along it — is
    // put back by hand below at a cost of two instructions, and the PITCH
    // PLANE keeps its Standard material, so the far field, which is where that
    // sheen actually reads, is untouched.
    this.mat = new THREE.MeshLambertMaterial({
      // the pitch's own macro albedo, addressed by world position in the
      // vertex shader — this is what makes the markings line up
      map: maps.macro,
      // shells are opaque where they survive the threshold; the discard is
      // done by hand in the patch below, before any lighting is computed
      side: THREE.FrontSide,
    });

    this.uniforms = {
      ss26Shell: { value: lab.grassShell() },
      ss26ShellScale: { value: 1 / SHELL_TILE_M },
      ss26PitchSpan: { value: new THREE.Vector2(PITCH_SPAN_X, PITCH_SPAN_Y) },
      ss26StripeK: { value: Math.PI / stripePeriod },
      ss26HalfPitch: { value: new THREE.Vector2(HALF_L, PITCH_WIDTH / 2) },
      ss26GrassH: { value: GRASS_H },
      ss26Time: { value: 0 },
      ss26Fade: { value: new THREE.Vector2(this.radius * FADE_FRACTION, this.radius) },
      // x, y = height, z, w = horizontal speed
      ss26Ball: { value: new THREE.Vector4(0, 99, 0, 0) },
      // wind direction (unit) and strength in metres of tip travel
      ss26Wind: { value: new THREE.Vector3(0.82, 0.57, WIND_AMPLITUDE) },
    };
    queueShaderPatch(this.mat, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = patchVertex(shader.vertexShader);
      shader.fragmentShader = patchFragment(shader.fragmentShader);
    });

    this.mesh = new THREE.Mesh(buildShellGeometry(shells, seg, this.span, this.cell), this.mat);
    // Shells never cast. They would double the shadow pass for a 4cm feature
    // whose shadow is already in the pitch's own, and an alpha-tested caster is
    // the most expensive kind there is.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    // the patch is re-centred every frame; three's frustum cull uses a bounding
    // sphere computed once, in local space, which stays correct as it moves
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    scene.userData.ss26Grass = this;
    // A live read-out of the wind and the wake, for tooling (`npm run app:bench
    // -- --eval window.__ss26Grass`). Three numbers written into a fixed
    // object once a frame — the alternative is having no way at all to tell a
    // turf that is animating from one that is frozen, which is exactly the
    // class of bug a still cannot show.
    (window as unknown as Record<string, unknown>).__ss26Grass = this.probe;
  }

  /** see the constructor: a fixed object, mutated in place, never allocated */
  private probe = {
    shells: 0, radius: 0, t: 0, gust: 0, leanMm: 0,
    cx: 0, cz: 0, ballX: 0, ballY: 0, ballSpeed: 0, visible: true,
  };

  /**
   * Re-centre on what the camera is looking at and advance the wind.
   *
   * `now` is seconds from performance.now(), which the capture harness
   * replaces with a virtual clock — so a still of the turf is as reproducible
   * as every other still in the contract.
   */
  update(camera: THREE.PerspectiveCamera, now: number, ball: GrassBall | null): void {
    const cam = camera.position;
    // A camera higher than the fade radius has no ground inside it — the
    // nearest blade is already further away than the distance at which the
    // turf has become the plane again. This is not a heuristic, it is the
    // geometry: it takes the establishing crane, the beauty crane and the
    // kickoff wide off the bill exactly, and nothing else.
    if (cam.y > this.radius + HEIGHT_SLACK) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.probe.shells = this.shells;
    this.probe.radius = this.radius;

    // Centred on the CAMERA, nudged a little way along the view so the sheet
    // is not wasted symmetrically behind the lens. The nudge is bounded by the
    // slack SPAN has over the fade radius, or the far edge of the disc would
    // come off the end of the sheet and cut a straight line across the pitch.
    camera.getWorldDirection(this.tmpDir);
    const slack = this.span / 2 - this.radius;
    const flat = Math.hypot(this.tmpDir.x, this.tmpDir.z) || 1;
    const cx = cam.x + (this.tmpDir.x / flat) * slack;
    const cz = cam.z + (this.tmpDir.z / flat) * slack;
    // snap to the cell grid: a patch that slides by a third of a cell makes
    // every per-vertex wind sample slide with it, and a static shot shimmers
    this.center.set(Math.round(cx / this.cell) * this.cell,
      Math.round(cz / this.cell) * this.cell);
    this.mesh.position.set(this.center.x, 0, this.center.y);

    this.uniforms.ss26Time.value = now;
    // a slow gust envelope, so the pitch breathes instead of vibrating
    const gust = 0.72 + 0.28 * Math.sin(now * 0.23) * Math.sin(now * 0.091 + 1.7);
    (this.uniforms.ss26Wind.value as THREE.Vector3).z = WIND_AMPLITUDE * gust;
    const b = this.uniforms.ss26Ball.value as THREE.Vector4;
    if (ball) b.set(ball.x, ball.y, ball.z, ball.speed);
    else b.set(0, 99, 0, 0);

    const p = this.probe;
    p.t = Math.round(now * 100) / 100;
    p.gust = Math.round(gust * 1000) / 1000;
    // the tip excursion this frame at the centre of the patch, in millimetres:
    // the number that says "the grass is moving"
    p.leanMm = Math.round(gustAt(this.center.x, this.center.y, now)
      * WIND_AMPLITUDE * gust * 1000);
    p.cx = Math.round(this.center.x * 10) / 10;
    p.cz = Math.round(this.center.y * 10) / 10;
    p.ballX = Math.round(b.x * 10) / 10;
    p.ballY = Math.round(b.y * 100) / 100;
    p.ballSpeed = Math.round(b.w * 10) / 10;
    p.visible = this.mesh.visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
    const w = window as unknown as Record<string, unknown>;
    if (w.__ss26Grass === this.probe) w.__ss26Grass = null;
  }
}

/**
 * The stack: `shells` copies of one SEG x SEG grid, each carrying its own
 * normalized height in `aShell`.
 *
 * Emitted TOP DOWN. Every camera in this game looks down at the pitch, so at
 * any given square centimetre the tallest shell is the one nearest the lens,
 * and emitting the tips first gives an immediate-mode GPU a front-to-back
 * order its early-Z can use to reject the layers underneath.
 *
 * On THIS machine that buys nothing, and it is worth writing down why so the
 * next person does not spend an afternoon on it: Apple's tile-based deferred
 * renderer turns hidden-surface removal OFF for any draw whose shader can
 * `discard`, because it cannot know a fragment's coverage until the shader has
 * run. Measured on an M3, reversing this loop moved the frame time by less than
 * the noise. It is kept because it is free, it is right, and it is the
 * difference between a turf that fits and one that does not on the desktop
 * GPUs this will eventually meet. The cuts that DID work on Apple hardware are
 * the three above: start the stack at SHELL_BASE, sample cheaply, and light
 * with Lambert.
 *
 * The lowest shell sits at SHELL_BASE of the grass height above the pitch
 * plane rather than on it, which also happens to solve the z-fighting two
 * coplanar meshes would have at exactly the camera distance that matters.
 */
function buildShellGeometry(shells: number, SEG: number, SPAN: number, CELL: number):
THREE.BufferGeometry {
  const perLayer = (SEG + 1) * (SEG + 1);
  const total = perLayer * shells;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const shell = new Float32Array(total);
  const idx = new Uint32Array(SEG * SEG * 6 * shells);

  let v = 0;
  let i = 0;
  for (let k = shells - 1; k >= 0; k--) {
    // the stack spans [SHELL_BASE, 1]: everything below it is the pitch plane
    const t = SHELL_BASE + ((k + 0.5) / shells) * (1 - SHELL_BASE);
    const base = (shells - 1 - k) * perLayer;
    for (let z = 0; z <= SEG; z++) {
      for (let x = 0; x <= SEG; x++) {
        pos[v * 3] = -SPAN / 2 + x * CELL;
        pos[v * 3 + 1] = 0; // the lift is applied in the vertex shader
        pos[v * 3 + 2] = -SPAN / 2 + z * CELL;
        nor[v * 3] = 0; nor[v * 3 + 1] = 1; nor[v * 3 + 2] = 0;
        shell[v] = t;
        v++;
      }
    }
    for (let z = 0; z < SEG; z++) {
      for (let x = 0; x < SEG; x++) {
        const a = base + z * (SEG + 1) + x;
        const b = a + 1;
        const c = a + SEG + 1;
        const d = c + 1;
        idx[i++] = a; idx[i++] = c; idx[i++] = b;
        idx[i++] = b; idx[i++] = c; idx[i++] = d;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aShell', new THREE.BufferAttribute(shell, 1));
  // A material with a map declares `attribute vec2 uv` whether or not anyone
  // reads it. The real UV is computed from world position in the patch, but the
  // attribute still has to exist or the program link fails.
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(total * 2), 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, GRASS_H / 2, 0),
    SPAN * Math.SQRT1_2 + 1);
  return geo;
}

// --------------------------------------------------------------- the shaders

const VERT_PARS = /* glsl */ `
  attribute float aShell;
  uniform float ss26ShellScale;
  uniform vec2 ss26PitchSpan;
  uniform float ss26GrassH;
  uniform float ss26Time;
  uniform vec2 ss26Fade;
  uniform vec4 ss26Ball;
  uniform vec3 ss26Wind;

  varying float ss26vShell;
  varying float ss26vFade;
  varying vec2 ss26vShellUv;
  varying vec2 ss26vLean;
  varying vec3 ss26vWorld;

  // Three sines at incommensurate frequencies and directions. A hash-based
  // gradient noise would be prettier and costs a dozen texture-free ALU ops
  // per octave per vertex; at tens of thousands of vertices a frame that is
  // real money for a field whose entire job is to be low-frequency and smooth.
  float ss26Gust( vec2 p, float t ) {
    return sin( p.x * 0.28 + t * 1.10 ) * 0.52
         + sin( p.y * 0.21 - t * 0.83 ) * 0.31
         + sin( ( p.x + p.y ) * 0.13 + t * 1.63 ) * 0.17;
  }
`;

/**
 * Everything happens in `begin_vertex`, on the LOCAL position — the mesh is
 * axis-aligned and unrotated, so a world-space offset can be added straight to
 * it, and `modelMatrix` is a pure translation.
 */
const VERT_BODY = /* glsl */ `
  vec3 transformed = vec3( position );
  vec3 ss26Base = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;

  // the shell map and the pitch's macro map are both addressed by the BASE
  // position, never the swayed one: a texture that moves with the sway is a
  // sliding decal, not a blade of grass
  ss26vShellUv = ss26Base.xz * ss26ShellScale;
  vMapUv = vec2( ss26Base.x / ss26PitchSpan.x + 0.5, 0.5 - ss26Base.z / ss26PitchSpan.y );

  float ss26T = aShell;

  // ---- wind: a shear along the wind direction, scaled by shell height
  float ss26G = ss26Gust( ss26Base.xz, ss26Time );
  vec2 ss26Lean = ss26Wind.xy * ( ss26G * ss26Wind.z );
  // a cross-wind wobble so the whole pitch does not lean as one board
  ss26Lean += vec2( -ss26Wind.y, ss26Wind.x )
    * ( sin( ss26Base.x * 0.47 - ss26Time * 1.9 ) * ss26Wind.z * 0.35 );

  // ---- the ball's wake
  vec2 ss26Bd = ss26Base.xz - ss26Ball.xz;
  float ss26Br = length( ss26Bd );
  // grounded: a ball in the air disturbs nothing
  float ss26Grounded = 1.0 - smoothstep( 0.05, 0.85, ss26Ball.y );
  // a rolled ball parts the grass over a wider front the faster it goes
  float ss26R = 0.95 + clamp( ss26Ball.w, 0.0, 30.0 ) * 0.055;
  float ss26W = ( 1.0 - smoothstep( ss26R * 0.3, ss26R, ss26Br ) ) * ss26Grounded;
  vec2 ss26Away = ss26Bd / max( ss26Br, 1e-3 );
  ss26Lean += ss26Away * ( ss26W * 0.042 );
  // ...and a faster local tremor in the disturbed air behind it
  ss26Lean += vec2( -ss26Away.y, ss26Away.x )
    * ( ss26W * 0.022 * sin( ss26Time * 8.5 + ss26Br * 5.0 ) );

  // pressed flat where the ball is actually sitting on it
  float ss26Flat = 1.0 - 0.72 * ss26W * ( 1.0 - smoothstep( 0.0, ss26R * 0.42, ss26Br ) );

  float ss26Lift = ss26T * ss26GrassH * ss26Flat;
  // t^1.4: the tips travel, the roots do not. A linear shear is a sliding
  // stack of cards; the exponent is what makes it a bend.
  vec2 ss26Off = ss26Lean * pow( ss26T, 1.4 );

  transformed.y += ss26Lift;
  transformed.xz += ss26Off;

  ss26vShell = ss26T;
  ss26vLean = ss26Off;
  ss26vWorld = ss26Base + vec3( ss26Off.x, ss26Lift, ss26Off.y );
  // distance to the LENS, in three dimensions: a tele cam twenty-five metres
  // up is twenty-five metres from the grass under it however close the two
  // are on the map, and a blade at that range is a third of a pixel
  ss26vFade = smoothstep( ss26Fade.x, ss26Fade.y,
    distance( ss26Base, cameraPosition ) );
  // ...and the sheet now follows the CAMERA, which can stand behind the ad
  // boards. Grass belongs on the pitch plane and nowhere else, so the last
  // metre and a half before its edge fades the turf out as distance does.
  vec2 ss26Edge = abs( ss26Base.xz ) - ss26PitchSpan * 0.5;
  ss26vFade = max( ss26vFade,
    smoothstep( -1.5, 0.0, max( ss26Edge.x, ss26Edge.y ) ) );
`;

const FRAG_PARS = /* glsl */ `
  uniform sampler2D ss26Shell;
  uniform float ss26StripeK;
  uniform vec4 ss26Ball;
  uniform vec2 ss26HalfPitch;
  ${TURF_PARS_GLSL}

  varying float ss26vShell;
  varying float ss26vFade;
  varying vec2 ss26vShellUv;
  varying vec2 ss26vLean;
  varying vec3 ss26vWorld;

  // Per-fragment scratch, all filled once at the top of main(). The stripe
  // phase in particular is a sin plus an fwidth and is wanted by both the
  // albedo and the normal — computing it twice is the kind of thing that does
  // not show up in a profile and costs half a millisecond over seven shells.
  vec4 ss26Blade;
  float ss26Ph;
  vec3 ss26View;

  // Identical to the pitch plane's (see pitch.ts). It has to be identical: a
  // stripe that changes phase at the edge of the turf patch is the one artefact
  // that would make the whole transition visible.
  float ss26StripePhase() {
    float s = sin( ss26vWorld.x * ss26StripeK );
    float w = max( fwidth( s ) * 1.2, 0.012 );
    return smoothstep( -w, w, s ) * 2.0 - 1.0;
  }
  // ...and so is the fade of the pattern past the lines (pitch.ts)
  float ss26StripeAmp() {
    vec2 past = abs( ss26vWorld.xz ) - ss26HalfPitch;
    return 1.0 - smoothstep( 1.2, 2.8, max( past.x, past.y ) );
  }

`;

/**
 * The discard, hoisted to the very first thing the fragment shader does.
 *
 * Placement is the whole performance story. Eight shells over a patch that
 * fills the lower half of a 2940x1604 frame is ~8x overdraw; with the test
 * here, seven of those eight fragments cost one texture fetch and a compare,
 * and never touch the standard material's lighting loop, its three cascade
 * shadow lookups or its environment probe.
 *
 * The fade RAISES THE THRESHOLD instead of lowering an alpha: shells vanish
 * top-down as the patch edge approaches, so what survives longest is the
 * lowest sheet, which is a 3mm-thick copy of the pitch plane wearing the pitch
 * plane's own colours. That is why there is no seam.
 */
const FRAG_DISCARD = /* glsl */ `
  ss26Blade = texture2D( ss26Shell, ss26vShellUv );
  if ( ss26Blade.r < ss26vShell + ss26vFade * 1.15 ) discard;
  ss26Ph = ss26StripePhase() * ss26StripeAmp();
  ss26View = normalize( cameraPosition - ss26vWorld );
`;

/**
 * The macro albedo, fetched WITHOUT anisotropic filtering — and this is the
 * second half of the performance story.
 *
 * The pitch's macro map is 4096x2662 and carries the line markings, so it is
 * quite rightly set to 16x anisotropy: it is the one texture in the game that
 * is read edge-on across eighty metres. But a shell stack reads it SEVEN TIMES
 * PER PIXEL, and seven times sixteen taps is a hundred and twelve texture
 * fetches for a surface whose whole job is to be four centimetres tall. The
 * shells live in the near field where the anisotropy ratio is small and where
 * their own blade detail is the high-frequency content anyway.
 *
 * textureLod takes no derivatives, so the hardware cannot apply anisotropy to
 * it at all — one trilinear fetch, whatever the angle. The LOD is computed by
 * hand from the same derivatives the hardware would have used, so the mip
 * selection is still correct and a distant shell is still filtered; only the
 * angular refinement is given up, on the layer that can least afford it and
 * least needs it. The PLANE keeps its 16x, so the markings that actually go to
 * the horizon are untouched.
 */
const FRAG_MAP = /* glsl */ `
  {
    vec2 ss26TexPx = vec2( textureSize( map, 0 ) );
    vec2 ss26Dx = dFdx( vMapUv ) * ss26TexPx;
    vec2 ss26Dy = dFdy( vMapUv ) * ss26TexPx;
    float ss26Lod = 0.5 * log2( max( max( dot( ss26Dx, ss26Dx ), dot( ss26Dy, ss26Dy ) ), 1.0 ) );
    diffuseColor *= textureLod( map, vMapUv, ss26Lod );
    // the plane's own grade and paint treatment (turf.ts)
    diffuseColor.rgb = ss26TurfGrade( diffuseColor.rgb );
  }
`;

const FRAG_COLOR = /* glsl */ `
  {
    // ---- self-occlusion. Light does not reach the bottom of a pile of
    // grass; this is the single cue that turns eight flat sheets into depth.
    // The curve is centred so the AVERAGE visible shell (~0.7) lands on 1.0 —
    // otherwise the patch would read as a darker disc on a lighter pitch.
    float ss26Ao = mix( 0.66, 1.13, pow( ss26vShell, 0.70 ) );

    // ---- tips: drier, yellower, and different per blade
    float ss26Rnd = ss26Blade.g;
    vec3 ss26Tip = mix( vec3( 1.0 ), vec3( 1.085, 1.035, 0.845 ),
      ss26vShell * ss26Blade.b * ( 0.35 + 0.65 * ss26Rnd ) );
    float ss26Var = 0.90 + 0.20 * ss26Rnd;

    // ---- the mowing stripe, byte-for-byte the pitch's own treatment
    float ss26Graze = 1.0 - abs( ss26View.y );
    // lean along Z, the mower's direction of travel — see pitch.ts
    float ss26Into = -ss26View.z * ss26Ph;
    float ss26Band = ss26Ph * 0.045 + ss26Into * ( 0.05 + ss26Graze * 0.12 );
    vec3 ss26Stripe = 1.0 + ss26Band * vec3( 1.12, 1.0, 0.70 );

    // ---- the ball sitting IN the grass, not on it
    float ss26Grounded = 1.0 - smoothstep( 0.05, 0.85, ss26Ball.y );
    float ss26Contact = ( 1.0 - smoothstep( 0.0, 0.46, length( ss26vWorld.xz - ss26Ball.xz ) ) )
      * ss26Grounded;

    vec3 ss26Turf = ss26Ao * ss26Tip * ss26Var * ss26Stripe * ( 1.0 - 0.45 * ss26Contact );
    // and at the patch edge every one of those goes to nothing, so the last
    // surviving shell is indistinguishable from the plane underneath it
    diffuseColor.rgb *= mix( ss26Turf, vec3( 1.0 ), ss26vFade );
  }
`;

/**
 * The grazing sheen, standing in for the specular lobe Lambert does not have.
 *
 * A mown pitch goes silvery when you look ALONG it, because you are seeing the
 * lit flanks of a hundred thousand blade tips at once rather than their ends.
 * The pitch plane gets this through its roughness (see pitch.ts); on the
 * shells it is a fresnel-shaped add, cubed so it is absent looking straight
 * down and full strength only at the knee-height angles, scaled by shell
 * height so it lives on the tips where the real thing lives, and gated on how
 * lit the fragment already is so a shadowed patch of turf does not glow.
 */
const FRAG_SHEEN = /* glsl */ `
  {
    float ss26Sh = pow( 1.0 - abs( ss26View.y ), 3.0 ) * ss26vShell;
    float ss26Lit = saturate( dot( reflectedLight.directDiffuse,
      vec3( 0.2126, 0.7152, 0.0722 ) ) * 1.6 );
    outgoingLight += vec3( 0.058, 0.062, 0.070 ) * ( ss26Sh * ss26Lit * ( 1.0 - ss26vFade ) );
  }
`;

const FRAG_NORMAL = /* glsl */ `
  {
    // A shell's geometric normal is straight up, which lights a pile of bent
    // blades as if it were a billiard table. Tilt it along the sway — the tips
    // lean the most, so the tops of the blades catch a raking key and the
    // roots stay in their own shade, and a gust becomes a travelling band of
    // brightness instead of a silent geometry wobble.
    vec3 ss26LeanV = ( viewMatrix * vec4( ss26vLean.x, 0.0, ss26vLean.y, 0.0 ) ).xyz;
    normal = normalize( normal + ss26LeanV * ( 34.0 * ss26vShell ) );
    // ...plus the mowing lean, so a stripe reads across the turf and the plane
    // with one continuous shading gradient
    vec3 ss26Axis = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
    normal = normalize( normal + ss26Axis * ( ss26Ph * 0.20 ) );
  }
`;

function patchVertex(src: string): string {
  return src
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <begin_vertex>', VERT_BODY);
}

function patchFragment(src: string): string {
  return src
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\n${FRAG_DISCARD}`)
    .replace('#include <map_fragment>', `${FRAG_MAP}\n${FRAG_COLOR}`)
    .replace('#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${FRAG_SHEEN}`);
}
