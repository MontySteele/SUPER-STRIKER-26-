// Shared material surgery (§7A.4).
//
// Two things live here. First, a tiny queue so several independent patches can
// share one material's onBeforeCompile: CSM.setupMaterial() REPLACES the hook
// outright, so anything of ours has to be re-hung on top of it afterwards
// rather than installed first and silently thrown away.
//
// Second, the broadcast skin/fabric patch for the PLAYERS only. Stock Lambert
// falls off a cliff at the terminator, which is exactly what makes a plastic
// toy read as a plastic toy. Wrapped diffuse pushes a little light around the
// curve (tinted, the way blood and cloth actually scatter it) and a weak
// fresnel rim separates a shirt from the crowd behind it. Both are deliberately
// under-dialled: the moment you can *see* the rim it stops being broadcast and
// starts being cartoon.

import * as THREE from 'three';

export type ShaderPatch = (shader: THREE.WebGLProgramParametersWithUniforms) => void;

/** Queue a fragment-shader patch. Nothing happens until applyShaderPatches(). */
export function queueShaderPatch(mat: THREE.Material, patch: ShaderPatch): void {
  const list = (mat.userData.ss26Patches ?? (mat.userData.ss26Patches = [])) as ShaderPatch[];
  list.push(patch);
}

/**
 * Hang every queued patch on top of whatever onBeforeCompile is set *now*.
 * Call this after the shadow rig has had its go at the material — the lighting
 * rig's registration pass is the one place that knows the right order.
 */
export function applyShaderPatches(mat: THREE.Material): void {
  const list = mat.userData.ss26Patches as ShaderPatch[] | undefined;
  if (!list?.length || mat.userData.ss26PatchesLive) return;
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer): void {
    base?.call(this, shader, renderer);
    for (const p of list) p(shader);
  };
  mat.userData.ss26PatchesLive = true;
  mat.needsUpdate = true;
}

// ------------------------------------------------------- wrapped diffuse

// The direct-diffuse line inside three's physical lighting chunk. Matched by
// regex, not by literal text: the published build renames the struct member
// (material.diffuseContribution) relative to the source tree, and a hardcoded
// string would silently no-op on the next three release instead of failing
// loudly. If the match ever disappears we simply ship without the wrap.
const DIRECT_DIFFUSE =
  /reflectedLight\.directDiffuse\s*\+=\s*irradiance\s*\*\s*BRDF_Lambert\(\s*material\.(\w+)\s*\);/;

const WRAPPED_PARS = ((): string | null => {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const m = chunk.match(DIRECT_DIFFUSE);
  if (!m) {
    console.warn('ss26: wrapped-diffuse anchor not found; players stay stock-lit');
    return null;
  }
  const albedo = m[1];
  return chunk.replace(DIRECT_DIFFUSE, /* glsl */ `
    {
      float ss26NL = dot( geometryNormal, directLight.direction );
      float ss26Lam = saturate( ss26NL );
      float ss26W = saturate( ( ss26NL + ss26Wrap ) / ( 1.0 + ss26Wrap ) );
      // only the light the wrap term ADDS carries the subsurface tint; the
      // lit side stays exactly as bright and as neutral as it was
      vec3 ss26Irr = directLight.color * ( ss26Lam + ( ss26W - ss26Lam ) * ss26WrapTint );
      reflectedLight.directDiffuse += ss26Irr * BRDF_Lambert( material.${albedo} );
    }
  `);
})();

const UNIFORM_DECL = /* glsl */ `
  uniform float ss26Wrap;
  uniform vec3 ss26WrapTint;
  uniform float ss26Rim;
  uniform float ss26RimPower;
  uniform vec3 ss26RimColor;
`;

const RIM = /* glsl */ `
  {
    float ss26F = pow( 1.0 - saturate( dot( normal, geometryViewDir ) ), ss26RimPower );
    // gated on how lit the fragment already is — a rim that survives into full
    // shadow is the tell-tale of a cartoon shader
    float ss26Lit = saturate( dot( totalDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) * 1.8 );
    outgoingLight += ss26RimColor * ( ss26F * ss26Rim * ( 0.25 + 0.75 * ss26Lit ) );
  }
`;

export interface BroadcastSkinOptions {
  /** how far light bends around the terminator, 0 = stock Lambert */
  wrap?: number;
  /** tint of the wrapped light only (warm for skin, near-neutral for cloth) */
  wrapTint?: number;
  /** additive fresnel rim strength — keep this small */
  rim?: number;
  rimPower?: number;
  rimColor?: number;
}

/**
 * Queue the broadcast skin/fabric patch on one PLAYER material. Composes with
 * CSM: it only ever appends to whatever onBeforeCompile is installed later by
 * applyShaderPatches().
 */
export function queueBroadcastSkin(
  mat: THREE.MeshStandardMaterial, o: BroadcastSkinOptions = {},
): void {
  const wrap = o.wrap ?? 0.32;
  const wrapTint = new THREE.Color(o.wrapTint ?? 0xffd8c4);
  const rim = o.rim ?? 0.07;
  const rimPower = o.rimPower ?? 3.4;
  const rimColor = new THREE.Color(o.rimColor ?? 0xdbe6ff);

  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26Wrap = { value: wrap };
    shader.uniforms.ss26WrapTint = { value: wrapTint };
    shader.uniforms.ss26Rim = { value: rim };
    shader.uniforms.ss26RimPower = { value: rimPower };
    shader.uniforms.ss26RimColor = { value: rimColor };

    let frag = shader.fragmentShader.replace(
      '#include <common>', `#include <common>\n${UNIFORM_DECL}`,
    );
    if (WRAPPED_PARS) {
      frag = frag.replace('#include <lights_physical_pars_fragment>', WRAPPED_PARS);
    }
    frag = frag.replace('#include <opaque_fragment>', `${RIM}\n  #include <opaque_fragment>`);
    shader.fragmentShader = frag;
  });
}
