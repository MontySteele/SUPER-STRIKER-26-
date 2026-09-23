// Turf colour, shared by the pitch plane (pitch.ts) and the shell turf
// (grass.ts). The two surfaces must agree to the texel at the edge of the shell
// patch, so anything that changes what "grass" or "paint" looks like lives
// here, once, as GLSL both shaders paste in.
//
// Two things, both applied straight after the macro albedo is fetched:
//
//  • THE GRADE. The macro bake is a saturated, slightly blue green (44,112,52).
//    Broadcast turf is not: under a sodium-and-daylight mix, through a camera
//    whose colour science is tuned for skin, a Premier League pitch reads as a
//    yellow-leaning olive. The multiply is on the GRASS only (paint is white
//    and stays white) and is in linear space, so it is a hue shift, not a
//    brightness one.
//
//  • THE PAINT. The markings are baked vector-crisp at 0.92 white, which is
//    the brightest diffuse surface in the stadium: a 12cm line out-shines the
//    shirts and clips under the sun key. Real line paint is a thin
//    chalk-and-latex coat that the blades poke through, so it is (a) duller,
//    (b) faintly green, and (c) textured by the grass underneath it. (c) comes
//    free: the detail albedo multiplies after this. (a) and (b) are here.

/**
 * Linear-space grass tint. Takes the (44,112,52) bake to ≈ (62,116,40) — a
 * move of a few sRGB steps per channel, which is the whole distance between
 * "billiard cloth" and "turf".
 */
export const TURF_GRADE_GLSL = 'vec3( 2.05, 1.08, 0.62 )';

/** GLSL: paint mask from a linear macro albedo, and the grade that uses it.
 *  Grass has r,b < 0.1 linear (worn earth tops out near 0.3 in red but stays
 *  under 0.08 in blue), paint is > 0.7 in every channel, so min(r,b) is a
 *  clean separator with a wide dead band either side. */
export const TURF_PARS_GLSL = /* glsl */ `
  float ss26PaintMask( vec3 c ) {
    return smoothstep( 0.22, 0.55, min( c.r, c.b ) );
  }
  vec3 ss26TurfGrade( vec3 c ) {
    float p = ss26PaintMask( c );
    // paint: a fifth duller and a touch of the grass through it
    vec3 paint = c * vec3( 0.80, 0.84, 0.78 );
    return mix( c * ${TURF_GRADE_GLSL}, paint, p );
  }
`;
