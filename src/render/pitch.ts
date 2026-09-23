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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  GOAL_DEPTH, GOAL_HALF_W, GOAL_HEIGHT, HALF_L, PITCH_LENGTH, PITCH_WIDTH,
} from '../sim/constants';
import { PITCH_MARGIN, TextureLab, paintMarkings } from './TextureLab';
import { GrassField, grassPlaneAo } from './grass';
import { queueShaderPatch } from './materials';
import type { QualityProfile } from './quality';
import { pitchsideEnabled } from './pitchside';
import { TURF_PARS_GLSL } from './turf';
import { weatherProfile } from './weather';

/** Mowing bands across the pitch length. 16 bands over 105m ≈ 6.5m each,
 *  which is what a real gang mower leaves. */
const STRIPES = 16;
export const STRIPE_PERIOD = PITCH_LENGTH / STRIPES;

export function buildPitch(scene: THREE.Scene, lab: TextureLab, profile: QualityProfile): void {
  const mat = profile.retro ? retroPitchMaterial(lab) : bakedPitchMaterial(lab, profile);

  // HIGH/MEDIUM: the plane runs all the way to the foot of the stands, so the
  // run-off, the area behind the boards and the walkway under the stand walls
  // are the SAME lit, shadowed, turf-shaded surface as the pitch (see the
  // runoff block in bakedPitchMaterial) instead of a flat dark void. The UVs
  // are remapped so the macro map still lands 1:1 on its own span; outside it
  // the map clamps and the shader paints plain turf over the clamp.
  const geo = profile.retro || !pitchsideEnabled()
    ? new THREE.PlaneGeometry(PITCH_LENGTH + PITCH_MARGIN * 2, PITCH_WIDTH + PITCH_MARGIN * 2)
    : runoffPlane();
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

  // one net material for both goals (its UVs are in tiles, see netMaterial)
  const net = netMaterial(makeNetTexture());
  buildGoal(scene, 1, net);
  buildGoal(scene, -1, net);
}

/** Where the stands' front walls stand (stadium.ts): the long stands sit 12m
 *  outside the touchlines, the ends 14m behind the goal lines. */
export const RUNOFF_HALF_X = HALF_L + 14;
export const RUNOFF_HALF_Z = PITCH_WIDTH / 2 + 12;
/** Metres beyond the lines where the perimeter boards stand (stadium.ts). */
const BOARDS_AT = 3;

/** The extended pitch plane: 8x6 segments (the geometry is flat; segments only
 *  keep the interpolated world position well-conditioned), UVs remapped so the
 *  macro span is 0..1. */
function runoffPlane(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(RUNOFF_HALF_X * 2, RUNOFF_HALF_Z * 2, 8, 6);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const sx = PITCH_LENGTH + PITCH_MARGIN * 2;
  const sy = PITCH_WIDTH + PITCH_MARGIN * 2;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / sx + 0.5, pos.getY(i) / sy + 0.5);
  }
  uv.needsUpdate = true;
  return geo;
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

  const wx = weatherProfile();
  if (wx.wet > 0) {
    // wet turf is DARKER and SMOOTHER before any shader gets involved: water
    // fills the gaps between the blades, so less light scatters back out and
    // more of it reflects off a near-flat film
    // 0.18, not 0.30: a wet pitch is a DARK GREEN pitch. Take a third off the
    // albedo as well and the hemisphere fill is all that is left, which is
    // blue — and a blue pitch reads as a swimming pool, not as turf.
    // ...and it stays GREEN while it does it. A flat scalar takes the blue
    // channel down by as much as the green, which under a blue hemisphere
    // fill leaves a teal pitch — the swimming-pool look. Take more off blue
    // than off green and it reads as soaked turf.
    mat.color.setRGB(1 - 0.20 * wx.wet, 1 - 0.14 * wx.wet, 1 - 0.28 * wx.wet);
    mat.roughness = 0.9 - 0.26 * wx.wet;
  }

  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26Detail = { value: maps.detail };
    shader.uniforms.ss26DetailRepeat = { value: maps.repeat.clone() };
    shader.uniforms.ss26StripeK = { value: Math.PI / STRIPE_PERIOD };
    shader.uniforms.ss26Wet = { value: wx.wet };
    shader.uniforms.ss26HalfPitch = {
      value: new THREE.Vector2(HALF_L, PITCH_WIDTH / 2),
    };
    // x/y: the stand fronts, z: the boards' offset beyond the lines
    shader.uniforms.ss26Runoff = {
      value: new THREE.Vector3(RUNOFF_HALF_X, RUNOFF_HALF_Z, BOARDS_AT),
    };
    shader.uniforms.ss26MacroHalf = {
      value: new THREE.Vector2(HALF_L + PITCH_MARGIN, PITCH_WIDTH / 2 + PITCH_MARGIN),
    };
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
      uniform float ss26Wet;
      uniform vec2 ss26HalfPitch;
      uniform vec3 ss26Runoff;
      uniform vec2 ss26MacroHalf;
      ${TURF_PARS_GLSL}

      // How much of the mowing pattern this point carries: the groundsman
      // stripes the field of play and the first couple of metres past the
      // lines, and the mower turns round well short of the boards.
      float ss26StripeAmp() {
        vec2 past = abs( ss26WorldPos.xz ) - ss26HalfPitch;
        return 1.0 - smoothstep( 1.2, 2.8, max( past.x, past.y ) );
      }

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

      // ---------------------------------------------------------- §7A.3d
      // MACRO VARIATION AND WEAR, ANALYTICALLY.
      //
      // Both of these used to live in the baked macro albedo, at ±3% and three
      // radial blobs. From the tele cam at 40m that map is being sampled six
      // mip levels down, and six mips of a ±3% field is a flat colour — which
      // is exactly the "reads as flat paint" this is fixing. Worse, the fix of
      // simply turning the bake up cannot work: the wear that survives to mip
      // 6 is wear that is a brown smear at mip 0.
      //
      // So it is evaluated PER PIXEL from world position instead. An analytic
      // field has no mip chain, so a 12-metre blotch is a 12-metre blotch at
      // 4m and at 90m, and the stripes, the wear paths and the mowing sheen
      // are all still there when the camera is in the gantry. It costs ~20 ALU
      // on a shader that is already doing three texture fetches.
      float ss26Hash2( vec2 p ) {
        p = fract( p * vec2( 0.3183099, 0.3678794 ) );
        p += dot( p, p + 19.19 );
        return fract( p.x * p.y * 95.4337 );
      }

      float ss26Noise2( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        vec2 u = f * f * ( 3.0 - 2.0 * f );
        return mix(
          mix( ss26Hash2( i ), ss26Hash2( i + vec2( 1.0, 0.0 ) ), u.x ),
          mix( ss26Hash2( i + vec2( 0.0, 1.0 ) ), ss26Hash2( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
      }

      /** How worn this square metre of turf is, 0..1. */
      float ss26Wear( vec2 w ) {
        float n = ss26Noise2( w * 0.075 ) * 0.66 + ss26Noise2( w * 0.31 ) * 0.34;
        float wear = 0.0;
        // the two goalmouths: an ellipse a keeper's area wide, scuffed to bare
        // earth in the middle of the six-yard box
        for ( int s = 0; s < 2; s++ ) {
          float sx = s == 0 ? -1.0 : 1.0;
          vec2 d = ( w - vec2( sx * ( ss26HalfPitch.x - 1.0 ), 0.0 ) ) / vec2( 7.5, 11.0 );
          wear = max( wear, 0.72 * pow( max( 1.0 - length( d ) * ( 0.82 + n * 0.45 ), 0.0 ), 1.5 ) );
        }
        // the penalty spots, which are a patch of dirt on any pitch in March
        for ( int s = 0; s < 2; s++ ) {
          float sx = s == 0 ? -1.0 : 1.0;
          float d = length( ( w - vec2( sx * ( ss26HalfPitch.x - 11.0 ), 0.0 ) ) / 2.2 );
          wear = max( wear, 0.5 * pow( max( 1.0 - d, 0.0 ), 1.2 ) );
        }
        // the centre circle: the kickoff scuff, plus the ring the circle
        // itself gets walked round
        float cd = length( w / vec2( 6.0, 6.0 ) );
        wear = max( wear, 0.30 * pow( max( 1.0 - cd * ( 0.9 + n * 0.4 ), 0.0 ), 1.4 ) );
        float ring = abs( length( w ) - 9.15 );
        wear = max( wear, 0.16 * ( 1.0 - smoothstep( 0.0, 2.4, ring ) ) * ( 0.55 + n * 0.9 ) );
        // the linesmen's paths: two worn strips a metre inside each touchline,
        // eaten into by the same noise so they are a path and not a stripe
        float tl = min( abs( abs( w.y ) - ( ss26HalfPitch.y - 1.1 ) ), 6.0 );
        wear = max( wear, 0.20 * ( 1.0 - smoothstep( 0.0, 1.8, tl ) )
          * smoothstep( 0.15, 0.75, n ) );
        return clamp( wear, 0.0, 1.0 );
      }
    `);

    // detail albedo (the same height field the normal map came from) + the
    // stripe's own small albedo delta, biased up at grazing angles the way a
    // real cut-grass sheen is
    frag = frag.replace('#include <map_fragment>', /* glsl */`
      #include <map_fragment>
      {
        // Past the macro map's own apron the fetch is a clamped edge texel,
        // i.e. a streak; replace it with the bake's base grass (the same
        // (44,112,52) the bake paints, decoded) times the material colour.
        {
          vec2 ss26Off = abs( ss26WorldPos.xz ) - ss26MacroHalf;
          float ss26Beyond = smoothstep( -1.0, 0.0, max( ss26Off.x, ss26Off.y ) );
          diffuseColor.rgb = mix( diffuseColor.rgb,
            diffuse * vec3( 0.0250, 0.162, 0.0343 ), ss26Beyond );
        }
        // broadcast olive + duller, grass-textured paint (turf.ts)
        diffuseColor.rgb = ss26TurfGrade( diffuseColor.rgb );
        vec3 ss26Det = texture2D( ss26Detail, vMapUv * ss26DetailRepeat ).rgb;
        diffuseColor.rgb *= ss26Det;

        // §7A.3d macro variation. Three octaves at 13m, 3.2m and 1.1m, ±9% —
        // three times what the bake carried, and it can afford to be, because
        // it is applied at pixel scale and nothing ever averages it away.
        // This is the difference between "a green rectangle" and "turf".
        {
          vec2 ss26W = ss26WorldPos.xz;
          float ss26M = ss26Noise2( ss26W * 0.077 ) * 0.62
                      + ss26Noise2( ss26W * 0.31 ) * 0.26
                      + ss26Noise2( ss26W * 0.9 ) * 0.12;
          // brightness AND hue: a lusher patch of a pitch is not a lighter
          // green, it is a BLUER, deeper one, and a thin patch is yellower.
          // Varying only the value gives a pitch that reads as one colour with
          // a cloud shadow on it, which is precisely the flat-paint failure.
          diffuseColor.rgb *= vec3( 1.0, 1.0, 1.0 )
            + ( ss26M - 0.5 ) * vec3( 0.20, 0.18, 0.09 ) * 0.9;
          // A 30cm clump octave for the mid-distance, which is where the tele
          // cam lives and where the 4m detail tile has already mipped to a
          // flat colour. Faded by its own screen footprint, so it is texture
          // at 40m and nothing (rather than a shimmer) at 90m.
          {
            vec2 ss26Fq = ss26W * 3.3;
            float ss26Fw = length( fwidth( ss26Fq ) );
            float ss26Fine = ss26Noise2( ss26Fq ) - 0.5;
            diffuseColor.rgb *= 1.0 + ss26Fine * 0.16 * ( 1.0 - smoothstep( 0.35, 0.9, ss26Fw ) );
          }
          // ...and the wear, toward bare earth. Warmer, lighter and much less
          // saturated than grass — the hue shift is what the eye reads as
          // "dirt", not the brightness.
          float ss26Wr = ss26Wear( ss26W );
          diffuseColor.rgb = mix( diffuseColor.rgb,
            diffuseColor.rgb * vec3( 1.85, 1.26, 0.86 ), ss26Wr * 0.52 );
        }

        float ss26Amp = ss26StripeAmp();
        float ss26Ph = ss26StripePhase() * ss26Amp;
        vec3 ss26V = normalize( cameraPosition - ss26WorldPos );
        // 0 looking straight down at the turf, 1 raking along it
        float ss26Graze = 1.0 - abs( ss26V.y );
        // How far the camera is looking INTO the lean of this band. The lean
        // is ±x, so this flips sign as the camera crosses the halfway line —
        // which is the actual broadcast behaviour: the same stripe is the
        // light one from one end and the dark one from the other. A stripe
        // seen end-on is a wall of sunlit blade tips; seen from behind it is a
        // wall of shaded blade backs.
        //
        // The lean is along world Z, not X. The bands run across the pitch
        // (they vary with x), which means the gang mower drove ACROSS it, from
        // touchline to touchline, and a mower lays the blades in the direction
        // it travels. So it is the touchline camera — the gameplay camera —
        // that looks along the lean and sees the strongest bands, and a camera
        // behind the goal looks across it and sees them faintly. v1 had it the
        // other way round: tele-cam stripes at 5% and a gold bar at knee
        // height from the goal line. Crossing to the far touchline flips
        // which band is light, which is the reverse-angle behaviour.
        float ss26Into = -ss26V.z * ss26Ph;
        // §7A.3d. The flat term went 3% -> 5.5% and the raking term 8.5% ->
        // 13%. The old numbers were tuned against the near shells, which carry
        // the stripe as real geometry inside 30m; past that the shells are
        // gone and 3% of albedo is all there is, which is why the tele cam saw
        // paint. A broadcast tele shot of a striped pitch is nearer 10% band
        // to band, and the whole point of the mowing is that you can see it
        // from the gantry.
        // A bright band is a touch yellower (sunlit blade flanks), a dark one
        // a touch bluer (shaded blade backs) — the hue half of the stripe.
        float ss26Band = ss26Ph * 0.045 + ss26Into * ( 0.05 + ss26Graze * 0.12 );
        diffuseColor.rgb *= 1.0 + ss26Band * vec3( 1.12, 1.0, 0.70 );

        // ---------------------------------------------------- the run-off
        // Out to the boards it is the same turf, unstriped. Behind them it
        // is the hard-wearing surround a stadium actually has there: denser,
        // darker, bluer, unmown turf that the stewards, cameramen and
        // warm-ups walk on, and at the foot of each stand a concrete apron
        // with a drainage channel along its pitch edge. At the tunnel a
        // rubber walk-out mat runs from the mouth to the boards.
        {
          vec2 ss26A = abs( ss26WorldPos.xz );
          vec2 ss26Past = ss26A - ss26HalfPitch;
          float ss26Out = max( ss26Past.x, ss26Past.y );
          float ss26Behind = smoothstep( ss26Runoff.z + 0.25, ss26Runoff.z + 0.9, ss26Out );
          vec3 ss26Surr = diffuseColor.rgb * vec3( 0.78, 0.80, 0.86 );
          // walked-in paths parallel to the boards, where the cameramen and
          // ball-boys actually go
          float ss26Trod = ss26Noise2( ss26WorldPos.xz * vec2( 0.9, 0.9 ) );
          ss26Surr *= 1.0 - 0.12 * smoothstep( 0.55, 0.9, ss26Trod )
            * ( 1.0 - smoothstep( 0.0, 1.6, abs( ss26Out - ( ss26Runoff.z + 1.6 ) ) ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, ss26Surr, ss26Behind );

          // concrete apron under the stand walls: 2.2m from the stand line, ~1.6m clear of the wall face
          vec2 ss26ToWall = ss26Runoff.xy - ss26A;
          float ss26Wall = min( ss26ToWall.x, ss26ToWall.y );
          float ss26Apron = 1.0 - smoothstep( 2.15, 2.25, ss26Wall );
          vec3 ss26Conc = vec3( 0.20, 0.195, 0.18 )
            * ( 0.82 + 0.36 * ss26Noise2( ss26WorldPos.xz * 1.7 ) )
            * mix( vec3( 1.0 ), ss26Det, 0.5 );
          // the drainage channel: a dark grate strip on the apron's edge
          float ss26Drain = 1.0 - smoothstep( 0.0, 0.03, abs( ss26Wall - 2.05 ) - 0.07 );
          ss26Conc *= 1.0 - 0.75 * ss26Drain;
          diffuseColor.rgb = mix( diffuseColor.rgb, ss26Conc, ss26Apron );

          // the walk-out mat (the tunnel is on the far, -z, touchline)
          float ss26Mat = ( 1.0 - smoothstep( 1.9, 1.96, ss26A.x ) )
            * step( ss26WorldPos.z, -( ss26HalfPitch.y + ss26Runoff.z + 0.3 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.022, 0.030, 0.026 )
            * ( 0.9 + 0.2 * ss26Det.g ), ss26Mat );
        }

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
        // Two sheens now, and the second one is §7A.3d's whole answer to "the
        // tele cam sees paint".
        //
        // The cubed term is the KNEE-HEIGHT one: absent from a helicopter
        // shot, full strength along the deck. The tele cam sits at 20m and
        // sees the far touchline at about 25° off the ground — pow(.,3) of
        // that is 0.07, i.e. nothing, which is why a 40m pitch had no sheen at
        // all. The squared term is a much broader lobe that is still there at
        // broadcast height, and it is MODULATED BY THE MOWING PHASE rather
        // than applied flat: bands leaning toward the lens go smoother and
        // catch the key, bands leaning away go rougher. That difference IS the
        // stripe at distance, and unlike an albedo delta it is a lighting
        // effect, so it survives into the shade and strengthens in the wet.
        float ss26Rake = 1.0 - abs( ss26Vr.y );
        float ss26Sheen = pow( ss26Rake, 3.0 );
        float ss26Broad = ss26Rake * ss26Rake;
        float ss26PhR = ss26StripePhase() * ss26StripeAmp();
        float ss26Into2 = -ss26Vr.z * ss26PhR;
        roughnessFactor = clamp(
          roughnessFactor
            // (0.85 in the wet, not 0.5: near the wet floor a ±0.06 swing
            // is a mirror band next to a matte one — the rain sheen banding)
            - ss26PhR * 0.12 * ( 1.0 - 0.85 * ss26Wet )
            - ss26Sheen * 0.26
            // 0.085, not the 0.16 this started at. A grazing key on a
            // roughness-0.36 band is a gold BAR, not a mowing stripe: at
            // knee height the broad lobe is already at full strength, so the
            // whole dial has to be sized for the low-sun shot and not for the
            // tele cam that cannot see it.
            //
            // ...and 0.070 -> 0.055, and faded OUT in the wet, when the lean
            // moved to Z (§7A.5c): the tele cam now looks straight along the
            // lean, and near the wet floor of 0.10 a ±0.08 swing is the
            // difference between a blur and a mirror — alternate bands
            // reflected the sky as pale teal stripes.
            - ss26Broad * ss26Into2 * 0.055 * ( 1.0 - 0.85 * ss26Wet )
            // wet turf is a film of water: the lobe tightens everywhere, and
            // hardest where the view rakes along it
            - ss26Wet * ( 0.16 + ss26Broad * 0.16 ),
          // DRY grass floors at 0.30. It is a mat of broken blades: it has a
          // sheen and it has never had a highlight, and letting the terms
          // above stack down to 0.10 turns the sunset sky's own reflection
          // into a gold bar lying across the mowing bands. Only water gets to
          // go glossy.
          mix( 0.30, 0.10, ss26Wet ), 1.0 );
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

        // along Z: the mower's direction of travel (see map_fragment)
        vec3 ss26Axis = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
        // Cut to a fifth in the wet: a film of water over a leaning band is a mirror
        // tilted toward the lens, and at full lean the tele cam sees alternate
        // bands reflect the sky as pale teal stripes.
        normal = normalize( normal + ss26Axis
          * ( ss26StripePhase() * ss26StripeAmp() * 0.20 * ( 1.0 - 0.8 * ss26Wet ) ) );
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

/**
 * The net material, shared by both goals. The net geometry carries its UVs in
 * TILES (metres / NET_TILE_M), so one texture at repeat 1 puts the same cord
 * pitch on every panel of both nets, and the whole net is one draw call.
 */
function netMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
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
  });
  // §7A.5c: DENSITY WITH ANGLE. A net seen face-on is mostly holes; the same
  // net seen edge-on is cords stacked behind cords, and reads nearly solid.
  // That is the one cue that makes a net read as a VOLUME rather than a grid
  // printed on glass — the side panels and the roof, which the gameplay
  // camera sees at a rake, go dense, and the back panel it sees square-on
  // stays open. Past the mip where the lattice has averaged to ~15% alpha it
  // is the only depth cue left, and it costs a dot product.
  queueShaderPatch(mat, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>', /* glsl */`
      #include <normal_fragment_begin>
      {
        float ss26Face = abs( dot( normalize( vViewPosition ), normal ) );
        float ss26Rake = 1.0 - ss26Face;
        diffuseColor.a = min( 1.0, diffuseColor.a * ( 1.0 + 2.4 * ss26Rake * ss26Rake ) );
      }
    `);
  });
  return mat;
}

/**
 * One net panel as a grid, from a bilinear patch through four corners plus a
 * displacement along `bulge` that is zero on every edge (sin·sin): the roof
 * bellies down, the back and sides belly out. UVs are in net tiles, measured
 * along the patch's own edges so the cord pitch stays honest when a panel is
 * not rectangular.
 */
function netPanel(p00: THREE.Vector3, p10: THREE.Vector3, p01: THREE.Vector3, p11: THREE.Vector3,
  nu: number, nv: number, bulge: THREE.Vector3, pool = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const lenU = (p00.distanceTo(p10) + p01.distanceTo(p11)) / 2 / NET_TILE_M;
  const lenV = (p00.distanceTo(p01) + p10.distanceTo(p11)) / 2 / NET_TILE_M;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      a.copy(p00).lerp(p10, u);
      b.copy(p01).lerp(p11, u);
      a.lerp(b, v);
      const s = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
      a.addScaledVector(bulge, s);
      // `pool`: the bottom rows (v near 0) gather on the turf behind the
      // frame, the way a net that is a little too long for its frame does
      if (pool > 0 && v < 0.25) {
        const k = 1 - v / 0.25;
        a.x += pool * k * k * Math.sin(Math.PI * (0.15 + 0.7 * u));
        a.y = Math.max(0.015, a.y * (1 - 0.6 * k));
      }
      pos.push(a.x, a.y, a.z);
      uv.push(u * lenU, v * lenV);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * (nu + 1) + i;
      idx.push(k, k + 1, k + nu + 1, k + 1, k + nu + 2, k + nu + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A tube between two points, for the frame and its stanchions, carrying a
 *  flat vertex colour so the painted frame and the galvanised stanchions can
 *  share one mesh and one material. */
function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8, shade = 1): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(shade), 3));
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function buildGoal(scene: THREE.Scene, side: number, netMat: THREE.Material): void {
  const group = new THREE.Group();
  const H = GOAL_HEIGHT, D = GOAL_DEPTH, hw = GOAL_HALF_W;
  // the back of the net's top edge, and how far its foot kicks out past it
  const topBack = new THREE.Vector3(D - 0.05, H - 0.12, 0);
  const FOOT = 0.18;
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  // ---- the frame, in ONE mesh: posts, bar, and the rear stanchions that
  // hold the net out. The stanchions are what tell the eye how deep the goal
  // is from the gameplay camera — without them the net is a hanging sheet.
  const r = 0.07;
  // the stanchions are thin grey tube, not a second white goal frame
  const rs = 0.017;
  const GALV = 0.46;
  const frameGeos: THREE.BufferGeometry[] = [
    tube(V(0, 0, -hw), V(0, H, -hw), r, 12),
    tube(V(0, 0, hw), V(0, H, hw), r, 12),
    tube(V(0, H, -hw - r), V(0, H, hw + r), r, 12),
  ];
  for (const sz of [-1, 1]) {
    // rear stanchion from the ground behind the post up to the back of the
    // roof, and the ground bar back to it
    frameGeos.push(tube(V(D + FOOT * 0.4, 0, sz * hw), V(topBack.x, topBack.y, sz * hw), rs, 6, GALV));
    frameGeos.push(tube(V(0.02, 0.02, sz * hw), V(D + FOOT * 0.4, 0.02, sz * hw), rs, 6, GALV));
    // the stay from the top of the post back to the stanchion head
    frameGeos.push(tube(V(0.02, H - 0.02, sz * (hw + 0.01)), V(topBack.x, topBack.y, sz * hw),
      rs * 0.8, 6, GALV));
  }
  frameGeos.push(tube(V(D + FOOT * 0.4, 0.02, -hw), V(D + FOOT * 0.4, 0.02, hw), rs, 6, GALV));
  frameGeos.push(tube(V(topBack.x, topBack.y, -hw), V(topBack.x, topBack.y, hw), rs * 0.8, 6, GALV));
  const frameGeo = mergeGeometries(frameGeos)!;
  for (const g of frameGeos) g.dispose();
  // painted metal: the classic thing in the frame that catches a floodlight
  // hard enough to clear the bloom threshold
  const frame = new THREE.Mesh(frameGeo, new THREE.MeshStandardMaterial({
    color: 0xf6f8fb, roughness: 0.26, metalness: 0.2, vertexColors: true,
  }));
  frame.castShadow = true;
  group.add(frame);

  // ---- the net: roof, back, two sides, merged, UVs in tiles (see netMaterial)
  const panels: THREE.BufferGeometry[] = [];
  // roof: crossbar -> back top edge, bellying DOWN
  panels.push(netPanel(V(0, H, -hw), V(0, H, hw), V(topBack.x, topBack.y, -hw),
    V(topBack.x, topBack.y, hw), 16, 6, V(0, -0.2, 0)));
  // back: foot on the turf, top on the stanchion bar, bellying OUT and
  // pooling at the bottom
  panels.push(netPanel(V(D + FOOT, 0.02, -hw), V(D + FOOT, 0.02, hw),
    V(topBack.x, topBack.y, -hw), V(topBack.x, topBack.y, hw), 16, 8, V(0.14, -0.04, 0), 0.16));
  // sides: post -> back, bellying outward and sagging a little
  for (const sz of [-1, 1]) {
    panels.push(netPanel(V(0, 0.02, sz * hw), V(D + FOOT, 0.02, sz * hw),
      V(0, H, sz * hw), V(topBack.x, topBack.y, sz * hw), 8, 8, V(0.03, -0.05, sz * 0.09)));
  }
  const netGeo = mergeGeometries(panels)!;
  for (const p of panels) p.dispose();
  const net = new THREE.Mesh(netGeo, netMat);
  // drawn after the opaque pass anyway; keep it after the players' shadows
  net.renderOrder = 1;
  group.add(net);

  group.position.x = HALF_L * side;
  if (side < 0) group.rotation.y = Math.PI;
  scene.add(group);
}
