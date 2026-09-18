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
import { GrassField, grassPlaneAo } from './grass';
import { queueShaderPatch } from './materials';
import type { QualityProfile } from './quality';

/** Mowing bands across the pitch length. 16 bands over 105m ≈ 6.5m each,
 *  which is what a real gang mower leaves. */
const STRIPES = 16;
export const STRIPE_PERIOD = PITCH_LENGTH / STRIPES;

export function buildPitch(scene: THREE.Scene, lab: TextureLab, profile: QualityProfile): void {
  const mat = profile.retro ? retroPitchMaterial(lab) : bakedPitchMaterial(lab, profile);

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

  // §7A.3b: the shell turf sits ON this plane, within ~30m of wherever the
  // camera is looking, and is built from the same maps so the two are the same
  // pitch. RETRO does not get it — that level is the v1.1 renderer on purpose.
  if (!profile.retro && profile.grassShells > 0) {
    new GrassField(scene, lab, profile, STRIPE_PERIOD);
  }

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
function bakedPitchMaterial(lab: TextureLab, profile: QualityProfile):
THREE.MeshStandardMaterial {
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
    // catch a low key at a grazing angle, which is the whole low-sun shot.
    // 0.5 -> 0.62 with the 1024 detail map: the relief is finer now, so it can
    // be deeper before it reads as gravel.
    normalScale: new THREE.Vector2(0.62, 0.62),
    roughness: 0.9,
    metalness: 0,
  });

  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26Detail = { value: maps.detail };
    shader.uniforms.ss26DetailRepeat = { value: maps.repeat.clone() };
    shader.uniforms.ss26StripeK = { value: Math.PI / STRIPE_PERIOD };
    // §7A.3b: where the shell turf is standing, this plane IS the shaded floor
    // under it — see grassPlaneAo()
    const ao = grassPlaneAo(profile);
    shader.uniforms.ss26GrassAo = {
      value: new THREE.Vector3(ao.strength, ao.from, ao.to),
    };

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
      uniform vec3 ss26GrassAo;

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

        // the floor of the shell turf: inside the turf's radius the only part
        // of this plane anyone can see is the gaps BETWEEN the blades, and
        // those are in shade. Same fade window as the shells, so the two
        // surfaces arrive at the open pitch together.
        float ss26GrassNear = 1.0 - smoothstep( ss26GrassAo.y, ss26GrassAo.z,
          length( cameraPosition - ss26WorldPos ) );
        diffuseColor.rgb *= 1.0 - ss26GrassAo.x * ss26GrassNear;
      }
    `);

    // The specular half. Two terms:
    //
    //  • blades laid toward you scatter wider than blades laid away, so the
    //    two stripe phases must not share a roughness;
    //
    //  • and a real pitch goes SILVERY when you look along it — the grazing
    //    sheen every floodlit night broadcast has and this pitch did not,
    //    because roughness 0.9 has no lobe left to catch a key with. Cubed, so
    //    it is absent from the helicopter shot and full strength only at the
    //    knee-height angles (and the night game, where the key is the rig).
    frag = frag.replace('#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      {
        vec3 ss26Vr = normalize( cameraPosition - ss26WorldPos );
        float ss26Sheen = pow( 1.0 - abs( ss26Vr.y ), 3.0 );
        roughnessFactor = clamp(
          roughnessFactor - ss26StripePhase() * 0.12 - ss26Sheen * 0.26, 0.10, 1.0 );
      }
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
        // The fade window is texel-relative, so it moved in with the 1024
        // detail map: half the texel size means the footprint that swallows a
        // texel arrives at half the distance. 40/180 on a 1024 map is a pitch
        // that dithers from the halfway line out at DPR 2.
        vec3 ss26Vn = normalize( cameraPosition - ss26WorldPos );
        float ss26Foot = length( cameraPosition - ss26WorldPos ) / max( abs( ss26Vn.y ), 0.04 );
        normal = normalize( mix( normal, nonPerturbedNormal,
          smoothstep( 24.0, 120.0, ss26Foot ) ) );

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

// ------------------------------------------------------------------ the net
//
// The net used to be one 128px grid at opacity 0.5 on a MeshBasicMaterial,
// with `back.material.map.repeat.set(6, 2)` — and because all four planes
// SHARED that material and therefore that texture, the one repeat set for the
// 7.3m-wide back was also applied to the 2.2m-deep sides and roof. Nothing was
// at the right cord density anywhere, an unlit white at half alpha does not
// darken when the goalmouth is in shade, and the mip chain averaged a 1.5px
// line in a 10px cell down to a flat grey long before the corner camera got
// there. The result is the thing in captures/cam/setpiece_corner.png: a
// translucent grey slab hanging in the goal.
//
// What a net actually is: white nylon cord, ~2mm, knotted into a ~10cm mesh,
// hung diagonally so the cells read as diamonds. So:
//
//  • a SEAMLESS diamond lattice, drawn as ±45° cords with a period that divides
//    the tile, so a non-integer repeat has no seam to show;
//  • one tile = a fixed number of METRES, and every plane's repeat is computed
//    from its own world size, so the cord pitch is identical on the back, the
//    sides and the roof;
//  • a LIT material (MeshStandardMaterial, registered with the CSM rig like
//    everything else built before Atmosphere.register), because a net in the
//    shadow of the crossbar is grey and a net in the floodlights is white, and
//    an unlit basic material is neither;
//  • alpha BLENDED with depthWrite off, not alpha tested: the mip chain fades
//    a distant net toward its average alpha, which is ~0.15 here, and an alpha
//    test would simply delete the whole net the moment that average fell under
//    the threshold.

/** Metres covered by one tile of the net texture. Eight diamonds per tile at
 *  0.8m is a ~10cm mesh, which is what a match net is knotted at. */
const NET_TILE_M = 0.8;
/** Tile resolution and the cord period inside it (must divide it, or the
 *  lattice stops being seamless and every plane grows a visible grid of tile
 *  boundaries). */
const NET_PX = 256;
const NET_PERIOD_PX = NET_PX / 8;

function makeNetTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = NET_PX; c.height = NET_PX;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, NET_PX, NET_PX);
  ctx.lineCap = 'square';
  // Two passes per diagonal: a wide, dimmer pass for the shaded flank of the
  // cord and a narrow bright one for its lit crown. That is the whole of the
  // "it is a round cord, not a drawn line" cue, and it costs two strokes.
  const pass: [number, string][] = [[3.4, 'rgba(226,232,240,0.55)'], [1.6, 'rgba(255,255,255,0.96)']];
  for (const [width, style] of pass) {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    for (let k = -NET_PX; k <= NET_PX * 2; k += NET_PERIOD_PX) {
      ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + NET_PX, NET_PX); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(k, NET_PX); ctx.lineTo(k + NET_PX, 0); ctx.stroke();
    }
  }
  // the knots: a dot where two cords cross, which is what stops the lattice
  // reading as a printed pattern when the replay camera is two metres away
  ctx.fillStyle = 'rgba(255,255,255,0.98)';
  for (let y = 0; y <= NET_PX; y += NET_PERIOD_PX) {
    for (let x = (y / NET_PERIOD_PX) % 2 ? NET_PERIOD_PX / 2 : 0; x <= NET_PX; x += NET_PERIOD_PX) {
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** One net panel: its own texture clone (so its repeat is its own) over the
 *  shared canvas, at the shared cord pitch. */
function netMaterial(base: THREE.Texture, width: number, height: number):
THREE.MeshStandardMaterial {
  const tex = base.clone();
  tex.needsUpdate = true;
  tex.repeat.set(width / NET_TILE_M, height / NET_TILE_M);
  return new THREE.MeshStandardMaterial({
    map: tex,
    color: 0xeef3f8,
    // A flat plane is a bad model of a lattice of 2mm cords: a cord is lit from
    // every side at once, so a panel whose surface normal happens to face away
    // from the key goes black, which a real net never does. A small constant
    // stands in for that wrap — negligible against a sunlit pitch, and the
    // difference between "net" and "hole" in the far goal at night.
    emissive: 0x20262e,
    roughness: 0.92,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // nylon is thin enough that both faces of a cell take the key
    flatShading: false,
  });
}

/**
 * Hang a panel: push the interior vertices along the plane's own normal (local
 * +z, before the mesh is rotated into place) by a smooth bulge that is zero at
 * every edge. A net is rope, not canvas — the roof bellies down between the
 * crossbar and the back, and the back bulges out under its own weight.
 */
function sagPanel(geo: THREE.PlaneGeometry, depth: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) - bb.min.x) / Math.max(1e-6, bb.max.x - bb.min.x);
    const v = (pos.getY(i) - bb.min.y) / Math.max(1e-6, bb.max.y - bb.min.y);
    pos.setZ(i, pos.getZ(i) + depth * Math.sin(Math.PI * u) * Math.sin(Math.PI * v));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
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

  // --- net: back + two sides + roof, each at its own repeat (see makeNetTexture)
  const netTex = makeNetTexture();
  const W = GOAL_HALF_W * 2;

  // The back hangs off the top of the frame and bellies OUT under its own
  // weight — the local +z of this plane is world +x once it is rotated, i.e.
  // away from the pitch, which is the direction a ball pushes it too.
  const backGeo = new THREE.PlaneGeometry(W, GOAL_HEIGHT, 14, 6);
  sagPanel(backGeo, 0.10);
  const back = new THREE.Mesh(backGeo, netMaterial(netTex, W, GOAL_HEIGHT));
  back.rotation.y = Math.PI / 2;
  back.position.set(GOAL_DEPTH, GOAL_HEIGHT / 2, 0);
  group.add(back);

  // sides stay taut: they are pulled between the post and the back stanchion
  const sideMat = netMaterial(netTex, GOAL_DEPTH, GOAL_HEIGHT);
  for (const y of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HEIGHT), sideMat);
    sideNet.position.set(GOAL_DEPTH / 2, GOAL_HEIGHT / 2, y);
    group.add(sideNet);
  }

  // The roof is the panel the sag actually shows on, because a low replay
  // camera looks straight along it. One x-rotation (not the z-then-y pair this
  // used to use) puts the plane's own +z straight DOWN, so sagPanel's bulge is
  // the belly and nothing has to be sign-corrected.
  const roofGeo = new THREE.PlaneGeometry(GOAL_DEPTH, W, 8, 16);
  sagPanel(roofGeo, 0.16);
  const roof = new THREE.Mesh(roofGeo, netMaterial(netTex, GOAL_DEPTH, W));
  roof.rotation.x = Math.PI / 2;
  roof.position.set(GOAL_DEPTH / 2, GOAL_HEIGHT, 0);
  group.add(roof);

  group.position.x = HALF_L * side;
  if (side < 0) group.rotation.y = Math.PI;
  scene.add(group);
}
