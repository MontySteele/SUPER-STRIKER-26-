// The pitch (§7.1/§7A.3): baked grass maps from the TextureLab, mowing stripes
// in the shader, painted line markings, worn goalmouths — plus goal frames
// with nets.
//
// The stripes are the interesting part. They used to be painted into the
// albedo as an 11% luminance step, which looks right from a helicopter and
// disappears entirely from a knee-height camera, because that is not how a
// real mowing stripe works: the mower bends the blades toward or away from
// you, so a stripe is a NORMAL difference that the light and the viewer sample
// differently, not a colour difference. So the bands moved into the shader and
// now tilt the shading normal along the pitch length. The albedo delta that
// remains is ~5%, which is roughly what a broadcast camera actually sees, and
// the visible contrast comes from the lighting instead.

import * as THREE from 'three';
import {
  GOAL_DEPTH, GOAL_HALF_W, GOAL_HEIGHT, HALF_L, PITCH_LENGTH, PITCH_WIDTH,
} from '../sim/constants';
import { PITCH_MARGIN, TextureLab, paintMarkings } from './TextureLab';
import { queueShaderPatch } from './materials';
import type { QualityProfile } from './quality';

/** Mowing bands across the pitch length. 16 bands over 105m ≈ 6.5m each,
 *  which is what a real gang mower leaves. */
const STRIPES = 16;
const STRIPE_PERIOD = PITCH_LENGTH / STRIPES;

export function buildPitch(scene: THREE.Scene, lab: TextureLab, profile: QualityProfile): void {
  const mat = profile.retro ? retroPitchMaterial(lab) : bakedPitchMaterial(lab);

  const geo = new THREE.PlaneGeometry(PITCH_LENGTH + PITCH_MARGIN * 2,
    PITCH_WIDTH + PITCH_MARGIN * 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // dark surround so the pitch reads as an island of light
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 480),
    new THREE.MeshStandardMaterial({ color: 0x101816, roughness: 0.95 }),
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.05;
  surround.receiveShadow = true;
  scene.add(surround);

  buildGoal(scene, 1);
  buildGoal(scene, -1);
}

/**
 * HIGH / MEDIUM: the baked set. `map` is the whole-pitch macro albedo (base
 * grass, ±3% low-frequency variation, procedural wear, crisp markings) at 1:1;
 * `normalMap` is the tiling blade-scale detail, repeated ~17x along the length.
 * The tiling albedo that agrees with that normal is sampled by the shader
 * patch, because three has no second albedo slot with its own UV transform.
 */
function bakedPitchMaterial(lab: TextureLab): THREE.MeshStandardMaterial {
  const maps = lab.pitchMaps();
  // three builds a per-map UV transform for the slots it knows about, so the
  // normal map tiles by simply asking it to. The detail ALBEDO has no slot of
  // its own — it rides a shader uniform, and the patch below applies the same
  // repeat by hand so the two stay locked together.
  maps.detailNormal.repeat.copy(maps.repeat);

  const mat = new THREE.MeshStandardMaterial({
    map: maps.macro,
    normalMap: maps.detailNormal,
    // the grass is not a rough sheet of paper: it has enough of a lobe left to
    // catch a low key at a grazing angle, which is the whole low-sun shot
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.9,
    metalness: 0,
  });

  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26Detail = { value: maps.detail };
    shader.uniforms.ss26DetailRepeat = { value: maps.repeat.clone() };
    shader.uniforms.ss26StripeK = { value: Math.PI / STRIPE_PERIOD };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 ss26WorldPos;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  ss26WorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');

    let frag = shader.fragmentShader.replace('#include <common>', /* glsl */`
      #include <common>
      varying vec3 ss26WorldPos;
      uniform sampler2D ss26Detail;
      uniform vec2 ss26DetailRepeat;
      uniform float ss26StripeK;

      // -1 in one band, +1 in the next. The crossing width is derivative-
      // driven: crisp where a band is metres of screen (the near half of a
      // knee-height shot, which is where stripes have to read) and softening
      // to a blur exactly where the band gets thinner than a pixel, instead of
      // strobing. One fixed width cannot do both — a low camera sees a 6.5m
      // band as half the frame and as three pixels in the same image.
      float ss26StripePhase() {
        float s = sin( ss26WorldPos.x * ss26StripeK );
        float w = max( fwidth( s ) * 1.2, 0.012 );
        return smoothstep( -w, w, s ) * 2.0 - 1.0;
      }
    `);

    // detail albedo (the same height field the normal map came from) + the
    // stripe's own small albedo delta, biased up at grazing angles the way a
    // real cut-grass sheen is
    frag = frag.replace('#include <map_fragment>', /* glsl */`
      #include <map_fragment>
      {
        vec3 ss26Det = texture2D( ss26Detail, vMapUv * ss26DetailRepeat ).rgb;
        diffuseColor.rgb *= ss26Det;

        float ss26Ph = ss26StripePhase();
        vec3 ss26V = normalize( cameraPosition - ss26WorldPos );
        // 0 looking straight down at the turf, 1 raking along it
        float ss26Graze = 1.0 - abs( ss26V.y );
        // How far the camera is looking INTO the lean of this band. The lean
        // is ±x, so this flips sign as the camera crosses the halfway line —
        // which is the actual broadcast behaviour: the same stripe is the
        // light one from one end and the dark one from the other. A stripe
        // seen end-on is a wall of sunlit blade tips; seen from behind it is a
        // wall of shaded blade backs.
        float ss26Into = -ss26V.x * ss26Ph;
        // ~3% flat (which is all a helicopter shot needs, because the normal
        // lean below carries it there) plus up to ~8% raking, which is the
        // only half of the effect that survives a shaded pitch
        diffuseColor.rgb *= 1.0 + ss26Ph * 0.030 + ss26Into * ss26Graze * 0.085;
      }
    `);

    // the specular half: blades laid toward you scatter wider than blades laid
    // away, so the two phases must not share a roughness
    frag = frag.replace('#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      roughnessFactor = clamp( roughnessFactor - ss26StripePhase() * 0.12, 0.04, 1.0 );
    `);

    // ...and the reason any of it reads: the shading normal leans along the
    // pitch length, in opposite directions per band. `normal` here is in VIEW
    // space, so the world +x axis has to come along for the ride.
    frag = frag.replace('#include <normal_fragment_maps>', /* glsl */`
      #include <normal_fragment_maps>
      {
        // Blade-scale relief is a CLOSE-UP feature, and what kills it is not
        // distance but FOOTPRINT: a knee-height camera fifteen metres out
        // covers a metre of turf with one pixel vertically and a centimetre
        // horizontally, an anisotropy far past the 16:1 the hardware will
        // filter. What is left over aliases in the LIGHTING rather than in the
        // fetch — at a grazing sun N·L is near zero, so a tiny normal wobble
        // is a large brightness wobble — and it reads as a dither across half
        // the pitch. dist / |view.y| is that footprint's vertical extent; fade
        // the detail normal out along it. The mowing lean below is a 6.5-metre
        // feature applied AFTER the fade, so it survives to the far touchline.
        vec3 ss26Vn = normalize( cameraPosition - ss26WorldPos );
        float ss26Foot = length( cameraPosition - ss26WorldPos ) / max( abs( ss26Vn.y ), 0.04 );
        normal = normalize( mix( normal, nonPerturbedNormal,
          smoothstep( 40.0, 180.0, ss26Foot ) ) );

        vec3 ss26Axis = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
        normal = normalize( normal + ss26Axis * ( ss26StripePhase() * 0.20 ) );
      }
    `);

    shader.fragmentShader = frag;
  });

  return mat;
}

/**
 * RETRO (§7A.7): the v1.1 pitch, kept alive on purpose. One canvas, stripes
 * painted into the albedo, seeded grain instead of the old Math.random spray
 * so a capture of the retro level is reproducible too.
 */
function retroPitchMaterial(lab: TextureLab): THREE.MeshStandardMaterial {
  const TEX_W = 2048;
  const TEX_H = Math.round(TEX_W * (PITCH_WIDTH + PITCH_MARGIN * 2)
    / (PITCH_LENGTH + PITCH_MARGIN * 2));
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;

  for (let i = 0; i < STRIPES; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#2c7a35' : '#256d2e';
    ctx.fillRect((TEX_W / STRIPES) * i, 0, TEX_W / STRIPES + 1, TEX_H);
  }
  lab.retroGrain(ctx, TEX_W, TEX_H);

  const mPx = TEX_W / (PITCH_LENGTH + PITCH_MARGIN * 2);
  const wear = (wx: number, wy: number, r: number, a: number): void => {
    const cx = ((wx + HALF_L + PITCH_MARGIN) / (PITCH_LENGTH + PITCH_MARGIN * 2)) * TEX_W;
    const cy = ((wy + PITCH_WIDTH / 2 + PITCH_MARGIN) / (PITCH_WIDTH + PITCH_MARGIN * 2)) * TEX_H;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * mPx);
    g.addColorStop(0, `rgba(148,124,72,${a})`);
    g.addColorStop(0.6, `rgba(148,124,72,${a * 0.4})`);
    g.addColorStop(1, 'rgba(148,124,72,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r * mPx, cy - r * mPx, r * mPx * 2, r * mPx * 2);
  };
  wear(-HALF_L, 0, 8, 0.55);
  wear(HALF_L, 0, 8, 0.55);
  wear(0, 0, 5, 0.3);

  paintMarkings(ctx, TEX_W, TEX_H);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 });
}

function makeNetTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 128; i += 10) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildGoal(scene: THREE.Scene, side: number): void {
  const group = new THREE.Group();
  // painted metal: the classic thing in the frame that catches a floodlight
  // hard enough to clear the bloom threshold
  const postMat = new THREE.MeshStandardMaterial({
    color: 0xf6f8fb, roughness: 0.26, metalness: 0.2,
  });
  const r = 0.07;
  const postGeo = new THREE.CylinderGeometry(r, r, GOAL_HEIGHT, 10);
  for (const y of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(0, GOAL_HEIGHT / 2, y);
    post.castShadow = true;
    group.add(post);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, GOAL_HALF_W * 2 + r * 2, 10), postMat);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(0, GOAL_HEIGHT, 0);
  bar.castShadow = true;
  group.add(bar);

  // net: back + sides + roof, semi-transparent grid
  const netTex = makeNetTexture();
  const netMat = new THREE.MeshBasicMaterial({
    map: netTex, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_HALF_W * 2, GOAL_HEIGHT), netMat);
  (back.material as THREE.MeshBasicMaterial).map!.repeat.set(6, 2);
  back.rotation.y = Math.PI / 2;
  back.position.set(GOAL_DEPTH, GOAL_HEIGHT / 2, 0);
  group.add(back);
  for (const y of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HEIGHT), netMat);
    sideNet.position.set(GOAL_DEPTH / 2, GOAL_HEIGHT / 2, y);
    group.add(sideNet);
  }
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HALF_W * 2), netMat);
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = Math.PI / 2;
  roof.position.set(GOAL_DEPTH / 2, GOAL_HEIGHT, 0);
  group.add(roof);

  group.position.x = HALF_L * side;
  if (side < 0) group.rotation.y = Math.PI;
  scene.add(group);
}
