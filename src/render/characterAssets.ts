// Skinned-character assets (§7A.2, character pipeline).
//
// One place that knows how to turn the authored glTF characters and the
// retargeted CMU clips into something the match scene can draw twenty-two of.
// Everything here is loaded ONCE per page, shared across matches, and cloned
// per player with SkeletonUtils so twenty-two players cost four geometry sets
// and one skeleton template each.
//
// What lives here and why:
//
//  • fixCharacterMaterial() — the material surgery the model lab proved out
//    (alphaTest cutouts instead of BLEND, explicit colour spaces, sane
//    roughness). modellab.ts imports it rather than keeping its own copy, so
//    the studio plate and the match are lit by the same rules.
//
//  • the clip pipeline — clips arrive with hip root motion, because that is
//    how mocap is. The SIM owns position in this game, so the drift is
//    detrended out of the hips track at load and recorded as the clip's
//    natural ground speed, which is what lets playback rate track the sim's
//    speed and keep the feet off the ice. findAnchor() then locates the frame
//    a strike or a jump actually happens on, so a clip added to CLIP_TABLE
//    needs no offline measurement to be timed against the sim.
//
//  • CharacterRig — the per-match object: kit textures painted onto the
//    authored UV islands, per-player back numbers, and instance().
//
// Adding clips is DATA: one row in CLIP_TABLE. Adding a character is one URL
// in ARCHETYPES. Neither needs a code change anywhere else.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PlayerData } from '../data/types';
import { SHADOW_LAYER, queueBroadcastSkin, queueShaderPatch } from './materials';
import { luminance, shade, type KitColors } from './TextureLab';
import type { KitSpec } from './playerMesh';

// --------------------------------------------------------------- the asset list

/** The authored characters. Adding one is a line here and nothing else. */
export const ARCHETYPES = [
  'models/players/v_cauc_blond',
  'models/players/v_asian',
  'models/players/v_afr_mid',
  'models/players/v_mixed',
];

/**
 * The detail levels, in order, as filename suffixes. Each sibling is the same
 * character decimated — SAME skeleton, same material names, same UVs — which
 * is what lets one skeleton drive all three and a level change be nothing but
 * a visibility toggle.
 */
export const LEVEL_SUFFIX = ['', '_lod1', '_lod2'];

// SHADOW_LAYER lives in materials.ts (the leaf module the lighting rig already
// imports). Shadows, not silhouettes, were the cost here: a 28k-triangle player
// who casts into three cascades is drawn four times. The lowest detail level is
// parked on that layer, which the cascade shadow cameras render and the game
// camera does not — so every player throws a shadow off ~1.5k triangles no
// matter what the camera is looking at, and the expensive mesh casts nothing.

/**
 * Where a clip comes from. Each animation ships as its own small GLB
 * (`models/anim/<name>.glb`, tens of kilobytes now that they are
 * animation-only), and that is what the loader fetches: the library is four
 * hundred clips and thirty-five megabytes, of which this game plays
 * seventeen. The all-in-one bundle is only opened if some row cannot be found
 * any other way.
 */
export const CLIP_DIR = 'models/anim/';
export const CLIP_BUNDLE = 'models/anim/all_clips.glb';

export interface ClipSpec {
  /**
   * Animation name inside the GLB, or a list of candidates tried in order.
   * The list is what lets the table name the clip it WANTS first and the clip
   * it can live with second — the animation library is being rebuilt
   * underneath this file, and a row that resolves to the best thing present is
   * worth more than a row that is right on one particular day.
   */
  anim: string | string[];
  /** GLB to look in; defaults to the bundle */
  file?: string;
  /** trim the source to [start, end] seconds — hand-picked, wins over anchor */
  range?: [number, number];
  /**
   * Trim around a frame the loader FINDS instead of one somebody measured:
   *   'strike' — the frame the right toe's speed relative to the hips peaks,
   *              i.e. the frame the foot goes through the ball;
   *   'apex'   — the frame the hips are highest, i.e. the top of a jump;
   *   'sink'   — the frame the hips are lowest, i.e. the body of a slide.
   * The anchor becomes the clip's contact time, and the hips' yaw at that
   * frame becomes yawAtContact. This is what makes a new kick clip DATA.
   */
  anchor?: 'strike' | 'apex' | 'sink';
  /** seconds kept before the anchor (default 0: animT = 0 IS the contact) */
  lead?: number;
  /** seconds kept after the anchor */
  tail?: number;
  /** seconds INTO THE TRIMMED clip at which the ball leaves the foot (§8). */
  contact?: number;
  /** radians the actor's hips are off +z at the contact frame — cancelled on
   *  the root while the action plays, so the kick goes where the sim aimed. */
  yawAtContact?: number;
  /** hand-set natural ground speed (m/s); otherwise measured from the hips. */
  groundSpeed?: number;
}

export type ClipId =
  | 'idle' | 'trudge' | 'walk' | 'jog' | 'run' | 'sprint'
  | 'gkIdle' | 'gkHold' | 'gkStepL' | 'gkStepR' | 'gkGetUp'
  | 'gkThrow' | 'gkPunt'
  | 'kickA' | 'kickB' | 'kickC' | 'kickD' | 'header' | 'trap'
  | 'slide' | 'diveL' | 'diveR' | 'collect' | 'celebrate' | 'dejected'
  // --- the keeper's save repertoire, picked by ball height at the save point
  // (KeeperBrain / PenaltyController set the row; SkinnedPlayerMesh plays it)
  | 'diveLowL' | 'diveLowR' | 'catchHigh' | 'catchHighRun' | 'collectLow'
  // --- presentation (§7, src/present): the cutscene set. These are never
  // reached by the sim's ActionAnim table — a scripted scene names them.
  | 'strut' | 'happyWalk' | 'happyRun'
  | 'standA' | 'standB' | 'standC'
  | 'clap' | 'cheer' | 'jumpCheer'
  | 'celebB' | 'celebC' | 'celebD'
  | 'victoryIdle' | 'sadIdle' | 'frustrated';

/**
 * WHAT PLAYS WHEN — the whole animation set, as data.
 *
 * Every row names the clip it wants first and whatever it can live with after
 * that, because the retargeted library is a moving target: the `mx_` names are
 * the football-specific Mixamo set, the `cmu_` names the general motion-capture
 * set that came before it. Whichever is on disk wins, in that order.
 *
 * Nothing here is a hand-measured frame number. `anchor` tells the loader to
 * FIND the frame that matters — the strike (peak toe speed relative to the
 * hips) or the apex of a jump — and to trim the clip so that frame is at
 * animT = 0, because the sim kicks the ball and calls playAnim in the same
 * tick: animT = 0 IS the contact, and what the renderer owes from there is the
 * follow-through (§8). The hips' yaw at that same frame is recorded too and
 * taken back out on the root, so a kick goes where the SIM aimed rather than
 * wherever the mocap actor happened to be facing.
 *
 * ADDING A CLIP IS ADDING A ROW.
 */
export const CLIP_TABLE: Record<ClipId, ClipSpec> = {
  // --- locomotion, ordered by the speed they were captured at
  idle: {
    anim: ['mx_Offensive_Soccer_Idle', 'mx_Standing_Idle', 'mx_Breathing_Idle', 'cmu_09_12'],
    groundSpeed: 0,
  },
  trudge: { anim: ['mx_Walking_Forward_In_A_Sad_Disposition', 'mx_Careful_Walk', 'cmu_16_33'] },
  walk: { anim: ['mx_Walking_Forward', 'mx_Walking', 'cmu_16_15'] },
  jog: { anim: ['mx_Soccer_Jog_Forward', 'mx_Jogging', 'cmu_16_21'] },
  run: { anim: ['mx_Running_Forwards', 'mx_Running_Forward_Quickly', 'cmu_16_45'] },
  sprint: { anim: ['mx_Sprinting_Forward', 'mx_Running_With_Intention'] },

  // --- the keeper. `idle` above is an OUTFIELD idle: a crouched, on-the-toes
  // ready stance, which is exactly right for a keeper facing a shot and
  // exactly wrong for one watching play at the other end. The sim's keeper
  // state machine (§6.3) already says which is which, so it picks.
  gkIdle: { anim: ['mx_Goalkeeper_Idle_Without_Ball'], groundSpeed: 0 },
  gkHold: { anim: ['mx_Goalkeeper_Idle_Holding_Ball'], groundSpeed: 0 },
  gkStepL: {
    anim: ['mx_Goalkeeper_Left_Sidestep', 'mx_Walking_Strafe_To_The_Left',
      'mx_Strafe_Walking_To_The_Left', 'mx_Soccer_Strafe_Left'],
  },
  gkStepR: {
    anim: ['mx_Goalkeeper_Right_Sidestep', 'mx_Walking_Strafe_To_The_Right',
      'mx_Strafe_Walking_To_The_Right', 'mx_Soccer_Strafe_Right'],
  },
  // After a dive he is on the grass, and the thing that used to happen next —
  // standing up in one frame and skating back to the line — is exactly the
  // artefact this row exists to kill. Anchored on 'sink' (hips lowest = flat
  // on the deck) so animT = 0 is the moment he starts to push up.
  gkGetUp: {
    anim: ['mx_Getting_Up_From_Being_Knocked_Down_On_The_Ground',
      'mx_Getting_Up_From_Stomach', 'mx_Getting_Up_From_Back'],
    anchor: 'sink', lead: 0, tail: 1.1, contact: 0, groundSpeed: 0,
  },
  // Distribution. The punt anchors on 'strike' for free — peak right-toe speed
  // relative to the hips IS the boot going through the dropped ball. A throw
  // has no foot contact to find, so it anchors on the hips' apex, which on an
  // overhand throw is the step-through, a frame or two either side of release.
  // No `contact`: it defaults to the anchor, which is what this row wants —
  // the sim calls ball.kick() and playAnim('loft') in the same tick, so animT 0
  // is the RELEASE. (A dive is the other way round: there, playAnim fires at
  // the launch, which is why diveL/diveR pin contact to 0 and keep `lead` as
  // visible push-off.)
  gkThrow: {
    anim: ['mx_Goalkeeper_Far_Overhand_Throw', 'mx_Goalie_Overhand_Throw'],
    anchor: 'apex', lead: 0.12, tail: 0.6, groundSpeed: 0,
  },
  gkPunt: {
    anim: ['mx_Goalkeeper_Drop_Kicking_Ball'], anchor: 'strike', tail: 0.6,
    groundSpeed: 0,
  },

  // --- strikes: trimmed to start on the frame the foot goes through the ball.
  // Four so a team does not strike the ball in unison; the two CMU ones are
  // captured facing back down the volume, which is exactly what yawAtContact
  // is measured for.
  kickA: { anim: ['mx_Male_Soccer_Penalty_Kick', 'cmu_74_03'], anchor: 'strike', tail: 0.6 },
  kickB: { anim: ['mx_Jogging_And_Kicking_A_Soccerball_Forward', 'cmu_74_04'], anchor: 'strike', tail: 0.6 },
  kickC: { anim: ['cmu_74_05'], anchor: 'strike', tail: 0.6 },
  kickD: { anim: ['cmu_74_06'], anchor: 'strike', tail: 0.6 },

  // The first touch that kills a pass dead (§6.1, ballContact.ts). The sim
  // plays this on the tick the ball is brought under control, so the same rule
  // as a strike applies: animT = 0 is the TOUCH. 'strike' finds it — on a
  // receive, the frame the foot is moving fastest relative to the hips is the
  // foot going out to meet the ball, not a plant step — and the 0.12s of lead
  // is there for the blend to come out of rather than to be played.
  trap: {
    anim: ['mx_Receiving_A_Soccerball_And_Playing_With_It', 'mx_Soccer_Idle_Chest_Receive',
      'mx_Soccer_Header_In_Place'],
    anchor: 'strike', lead: 0.12, tail: 0.45,
  },

  // --- everything else; each falls back to a procedural pose if absent
  header: { anim: ['mx_Soccer_Header_In_Place', 'mx_Idle_Soccer_Header', 'cmu_16_01'], anchor: 'apex', tail: 0.5 },
  // the tackle clip opens with a run-in the sim has already played; anchor on
  // the body of the slide (hips lowest) and keep a third of a second of launch
  slide: {
    anim: ['mx_Soccer_Slide_Tackle', 'mx_Running_To_Slide_And_Back_To_Running'],
    anchor: 'sink', lead: 0.35, tail: 0.45, contact: 0,
  },
  // same idea for a keeper: anchor on the top of the leap, keep the push-off
  diveL: {
    anim: ['mx_Goalkeeper_Left_Diving_Save', 'mx_Goalkeeper_Left_Body_Block'],
    anchor: 'apex', lead: 0.5, tail: 0.9, contact: 0,
  },
  diveR: {
    anim: ['mx_Goalkeeper_Right_Diving_Save', 'mx_Goalkeeper_Right_Body_Block'],
    anchor: 'apex', lead: 0.5, tail: 0.9, contact: 0,
  },
  // The low dive is a different ACTION, not a shorter version of the same one:
  // the body block is the keeper going down behind the ball with his chest,
  // which is what a shot at his feet or from close range gets. Anchored on
  // 'sink' — the hips are lowest at the block — so animT = 0 is the save.
  diveLowL: {
    anim: ['mx_Goalkeeper_Left_Body_Block', 'mx_Goalkeeper_Left_Diving_Save'],
    anchor: 'sink', lead: 0.45, tail: 0.9, contact: 0,
  },
  diveLowR: {
    anim: ['mx_Goalkeeper_Right_Body_Block', 'mx_Goalkeeper_Right_Diving_Save'],
    anchor: 'sink', lead: 0.45, tail: 0.9, contact: 0,
  },
  // Above the crossbar-ish and near enough to reach standing: he goes up, not
  // sideways. 'apex' is the top of the leap, i.e. the frame the hands close.
  // animT 0 is the CATCH, not the crouch before it: KeeperBrain.pickUp puts the
  // ball in his gloves and calls playAnim in the same tick, so `contact` is left
  // to default to the anchor and the 0.45s of lead is there for the blend to
  // come out of, not to be played.
  catchHigh: {
    anim: ['mx_Goalkeeper_Jump_Catching_Ball_High_Height', 'mx_Jump_And_Catch_With_One_Hand',
      'mx_Goalkeeper_Jump_And_Miss'],
    anchor: 'apex', lead: 0.45, tail: 1.1,
  },
  // Same catch off a run-up: what a cross claimed on the move actually looks
  // like. The sim only picks this when the keeper is travelling.
  catchHighRun: {
    anim: ['mx_Goalkeeper_Running_Jump_Catch_Ball_High_Height',
      'mx_Goalkeeper_Jump_Catching_Ball_High_Height'],
    anchor: 'apex', lead: 0.45, tail: 1.1,
  },
  // Collects. Both were UNANCHORED, which is where the float came from: with
  // contact 0 and no trim, animT = 0 was the clip's first frame — the actor
  // still upright, mid-approach, hips several millimetres above the stance the
  // archetype's groundOffset was measured on (the walk's frame 0). Anchoring
  // on 'sink' puts animT = 0 on the frame he is down over the ball, which is
  // both the moment of contact and the frame his feet are most firmly planted;
  // what is left is the clip's own residual (6.7mm on the medium catch, 7.2 on
  // the low one, measured by the pipeline's ground pass into ground_stats.json).
  collect: {
    anim: ['mx_Goalkeeper_Catching_Ball_Medium_Height', 'mx_Goalkeeper_Catching_Ball_Low_Height'],
    anchor: 'sink', lead: 0.22, tail: 0.5,
  },
  collectLow: {
    anim: ['mx_Goalkeeper_Catching_Ball_Low_Height', 'mx_Goalkeeper_Catching_Ball_Medium_Height'],
    anchor: 'sink', lead: 0.22, tail: 0.5,
  },
  celebrate: { anim: ['mx_Celebrating_After_A_Win', 'mx_Aj_Victory_Idle', 'mx_Big_Vegas_Victory_Idle'] },
  dejected: { anim: ['mx_Aj_Defeat_Idle', 'mx_Big_Vegas_Defeat_Idle', 'mx_Standing_In_A_Sad_Disposition'] },

  // --- the presentation set (§7, driven from src/present).
  //
  // Two kinds live here and the difference matters. The first three are
  // LOCOMOTION: they go into a blend chain (WALKOUT_CHAIN / CELEBRATE_CHAIN)
  // and their measured ground speed is what rate-matches playback to the
  // distance the actor actually covers, so a man walking out of the tunnel
  // plants his feet instead of skating. Everything after them is an OVERLAY
  // played in place at weight over the chain's idle, so every one of those is
  // pinned to groundSpeed 0 — a mocap actor who drifts 20cm while clapping
  // would otherwise be read as "this clip travels" and slow the whole chain.
  strut: { anim: ['mx_Walking_With_A_Swagger', 'mx_Male_Strut_Walk', 'mx_Male_Standard_Walk'] },
  happyWalk: { anim: ['mx_Happy_Walking_Forward', 'mx_Male_Happy_Walk'] },
  happyRun: { anim: ['mx_Happy_Run_Forward', 'mx_Running_Forward'] },

  // lineup idles: three of them, handed out round-robin and started at
  // different phases, because eleven men fidgeting in unison is the single
  // tell that gives a line-up away
  standA: { anim: ['mx_Idle_Stand_Looking_Around', 'mx_Looking_Around'], groundSpeed: 0 },
  standB: { anim: ['mx_Standing_Idle_Looking_Around', 'mx_Looking_Over_Both_Shoulders'], groundSpeed: 0 },
  standC: { anim: ['mx_Weight_Shift_Idle', 'mx_Shifting_Weight_From_Side_To_Side'], groundSpeed: 0 },

  clap: { anim: ['mx_Clap_While_Standing'], groundSpeed: 0 },
  cheer: { anim: ['mx_Male_Cheering_With_Two_Fists_Pump', 'mx_High_Enthusiasm_Fist_Pump'], groundSpeed: 0 },
  jumpCheer: { anim: ['mx_Ecstatic_Jumping_With_Both_Legs_And_Arms', 'mx_Cross_Jumps'], groundSpeed: 0 },

  // scorer celebrations, picked per goal from a seed so the same man does not
  // do the same thing twice ('celebrate' above is the fourth of the set)
  celebB: { anim: ['mx_Super_Excited', 'mx_Angrily_Pumping_Fists_Forward'], groundSpeed: 0 },
  celebC: { anim: ['mx_Male_Cheering_Head_Banging', 'mx_Pumping_A_Fist'], groundSpeed: 0 },
  celebD: { anim: ['mx_Basic_Northern_Soul_Step', 'mx_Boogaloo'], groundSpeed: 0 },

  victoryIdle: { anim: ['mx_Aj_Victory_Idle', 'mx_Big_Vegas_Victory_Idle'], groundSpeed: 0 },
  sadIdle: { anim: ['mx_Sad_Idle_Variation_1', 'mx_Standing_In_A_Sad_Disposition'], groundSpeed: 0 },
  frustrated: {
    anim: ['mx_Showing_Frustration_After_A_Loss', 'mx_Disappointed_Awe_Shucks'],
    groundSpeed: 0,
  },
};

/**
 * The locomotion blend chain, slowest first (missing rows drop out, and the
 * list is re-sorted by MEASURED speed at load, so a clip that turns out to be
 * faster than the one after it cannot break the blend). The state machine
 * finds the pair that brackets the sim's speed and crossfades between them;
 * playback rate is then the sim's speed over the blended pair's natural speed,
 * which is the thing that stops the feet skating.
 */
export const LOCO_CHAIN: ClipId[] = ['idle', 'trudge', 'walk', 'jog', 'run', 'sprint'];

/**
 * The keeper's chain when the sim says he is not under threat: a standing
 * goalkeeper idle instead of the outfield crouch, and the same run set above
 * it for when he has to sprint out.
 */
export const GK_CHAIN: ClipId[] = ['gkIdle', 'walk', 'jog', 'run', 'sprint'];

/** Lateral shuffle, picked by which way the sim is sliding him. */
export const GK_SIDESTEP: { left: ClipId; right: ClipId } = { left: 'gkStepL', right: 'gkStepR' };

/**
 * Chains a CUTSCENE can swap in (SkinnedPlayerMesh.setLocoChain). A scripted
 * actor still moves through the normal blend machinery — same bracketing pair,
 * same speed ÷ natural-speed playback rate — so the only thing a cutscene
 * changes is WHICH cycles the chain is made of. That is the whole reason a man
 * can swagger out of the tunnel or sprint away in delight without his boots
 * skating: the rate matching is untouched.
 */
//
// Each of these keeps the ORDINARY cycles either side of its flavour clip on
// purpose. Natural ground speed is MEASURED at load, and a retarget that
// happened to arrive without root motion would measure zero — which in a chain
// of [idle, strut, jog] leaves a 1.7 m/s walk with nothing below the jog to
// blend against and the playback rate pinned at its floor. Keeping `walk` and
// `jog` in the chain means the bracket is always sane whatever the flavour
// clip turns out to be worth, and the flavour simply contributes where it can.
export const WALKOUT_CHAIN: ClipId[] = ['idle', 'strut', 'walk', 'jog', 'run'];
export const CELEBRATE_CHAIN: ClipId[] = ['idle', 'happyWalk', 'jog', 'happyRun', 'sprint'];
/** Heads down, off the pitch: the sad walk is already in the default chain. */
export const TRUDGE_CHAIN: ClipId[] = ['idle', 'trudge', 'walk', 'jog'];

/** Meshes that are never visible at broadcast distance and cost a draw call
 *  each, times twenty-two, times every shadow cascade. The mouth interior is
 *  7.5k triangles of a CLOSED MOUTH. */
const CULL_MESHES = /teeth|tongue|eyelash|eyebrow/i;

/** Shorter than this and it is a failed retarget, not an animation. */
const MIN_CLIP_SECONDS = 0.2;

// ------------------------------------------------------- material surgery

/** Brows and lashes are painted with soft, mostly-low alpha; a 0.5 test eats
 *  them entirely, so they get a gentler threshold than hair and cloth. */
const FINE_CUTOUT = /eyebrow|eyelash/i;
/** Parts that genuinely have two visible sides: cloth shells and hair cards. */
const TWO_SIDED = /eyebrow|eyelash|hair|afro|short0|t-shirt|shirt|shorts|jeans/i;

/**
 * The model lab's material fix, verbatim, as the one shared copy.
 *
 * EVERY material in these GLBs ships as alphaMode BLEND, which in three means
 * "sort per object, write no depth": hair draws over the face, lashes vanish
 * behind the eyeballs, and the whole head swims as the camera moves. None of
 * these parts is actually see-through — they are cutouts. So: alpha TEST,
 * depth write on, blending off, everywhere.
 *
 * Forcing them fully opaque instead is wrong and was visibly so: the t-shirt
 * and shorts atlases (both RGBA) zero out the alpha along the hem and sleeve
 * rims, and with the test disabled those rim polygons show up as a row of
 * black jagged teeth around the hem. The test discards them, as authored.
 */
export function fixCharacterMaterial(mat: THREE.Material, meshName: string,
  anisotropy = 8): void {
  const std = mat as THREE.MeshStandardMaterial;
  const id = `${meshName} ${mat.name}`;

  const tex = (t: THREE.Texture | null | undefined, srgb: boolean): void => {
    if (!t) return;
    // GLTFLoader already flags base-colour maps sRGB; normal/roughness maps
    // must stay linear. Being explicit means a re-export with a stale
    // colorSpace cannot quietly wash the skin out.
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
  };
  tex(std.map, true);
  tex(std.emissiveMap, true);
  tex(std.normalMap, false);
  tex(std.roughnessMap, false);
  tex(std.metalnessMap, false);
  tex(std.aoMap, false);

  std.transparent = false;
  std.depthWrite = true;
  std.depthTest = true;
  std.alphaTest = FINE_CUTOUT.test(id) ? 0.3 : 0.5;
  std.side = TWO_SIDED.test(id) ? THREE.DoubleSide : THREE.FrontSide;
  std.shadowSide = std.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide;

  // Surface response, per PART.
  //
  // The MPFB GAMEENGINE tree used to ship everything at roughness ~0.5 /
  // metalness 0, which under ACES plus a bright environment reads as damp
  // plastic on every one of them; make_player.py now writes a sensible number
  // per material into the file, and these clamps are the renderer's floor under
  // it (Math.max, so a re-bake that chooses something rougher still wins).
  //
  // The bands are the ones the eye actually separates at broadcast distance:
  // a cornea is wet, a moulded boot is glossy, cloth is not, and skin sits
  // between cloth and boot — barely specular, but NOT matte, because the one
  // thing that stops a face reading as putty is the sheen down the nose and the
  // cheekbones catching the key.
  if (/low-poly|cornea|eyeball/i.test(id)) {
    std.roughness = 0.16;
    std.metalness = 0;
    std.envMapIntensity = 1.0;
  } else if (/shoes|boot/i.test(id)) {
    std.roughness = Math.min(Math.max(std.roughness, 0.3), 0.42);
    std.metalness = 0.04;              // synthetic upper, not leather
    std.envMapIntensity = 0.85;
  } else if (/hair|afro|short0/i.test(id)) {
    std.roughness = Math.max(std.roughness, 0.6);
    std.metalness = 0;
    std.envMapIntensity = 0.5;
  } else if (/shirt|jersey|shorts|trunks|jeans/i.test(id)) {
    std.roughness = Math.max(std.roughness, 0.82);
    std.metalness = 0;
    std.envMapIntensity = 0.45;
  } else if (/base|body|teeth|tongue/i.test(id)) {
    std.roughness = Math.max(std.roughness, 0.54);
    std.metalness = 0;
    std.envMapIntensity = 0.5;
  } else {
    std.roughness = Math.max(std.roughness, 0.7);
    std.metalness = 0;
    std.envMapIntensity = 0.55;
  }
  std.needsUpdate = true;
}

/**
 * Pull an inner garment inward, along its own normals, above the point where
 * an outer garment covers it.
 *
 * A stopgap for an ASSET defect: the cut-off denim waistband is modelled up to
 * 12.7mm wider than the crude t-shirt hem that is supposed to cover it. The
 * source GLB hid that by shipping every material as alphaMode BLEND with depth
 * writes off; the instant the materials are corrected to depth-writing cutouts
 * (which they must be, or the hair draws through the face) the waistband erupts
 * through the hem as a row of dark jagged teeth. Nothing above the outer hem is
 * ever meant to be seen, so sinking it inside the body is free.
 */
export function tuckUnder(inner: THREE.Mesh, outer: THREE.Mesh,
  depth: number, ramp: number): void {
  outer.geometry.computeBoundingBox();
  const hem = outer.geometry.boundingBox?.min.y;
  if (hem === undefined) return;
  const pos = inner.geometry.getAttribute('position') as THREE.BufferAttribute;
  const nor = inner.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nor) return;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp((y - hem) / ramp, 0, 1);
    if (t <= 0) continue;
    const k = depth * t * t * (3 - 2 * t);
    pos.setXYZ(i, pos.getX(i) - nor.getX(i) * k, y - nor.getY(i) * k, pos.getZ(i) - nor.getZ(i) * k);
  }
  pos.needsUpdate = true;
  inner.geometry.computeBoundingBox();
  inner.geometry.computeBoundingSphere();
}

// ------------------------------------------------------------- bone lookup

/**
 * three's GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName,
 * which STRIPS the colon: `mixamorig:LeftArm` in the file arrives as
 * `mixamorigLeftArm` in the scene graph, so a literal getObjectByName of the
 * authored name silently finds nothing. Match on a normalised key instead, and
 * ignore the rig prefix entirely.
 */
export const normaliseBoneName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^mixamorig/, '');

export function findBone(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  const want = normaliseBoneName(name);
  let hit: THREE.Object3D | undefined;
  root.traverse((o) => { if (!hit && normaliseBoneName(o.name) === want) hit = o; });
  return hit;
}

/**
 * Point every track in a clip at the joint of the SAME NAME in another rig.
 * Usually a no-op — both GLBs came out of the same retarget. It earns its keep
 * on a clip GLB that names tracks by node uuid, and on a future animation-only
 * GLB whose armature node names drift. Anything unresolved is REPORTED, not
 * dropped: an unbound track is a limb that will not move.
 */
export function rebindClip(clip: THREE.AnimationClip, charRoot: THREE.Object3D,
  clipRoot?: THREE.Object3D): string[] {
  const unbound: string[] = [];
  for (const track of clip.tracks) {
    const cut = track.name.indexOf('.');
    if (cut < 0) { unbound.push(track.name); continue; }
    const nodeName = track.name.slice(0, cut);
    const prop = track.name.slice(cut);
    let target = findBone(charRoot, nodeName);
    if (!target && clipRoot) {
      const byUuid = clipRoot.getObjectByProperty('uuid', nodeName);
      if (byUuid) target = findBone(charRoot, byUuid.name);
    }
    if (target) track.name = target.name + prop;
    else unbound.push(track.name);
  }
  return unbound;
}

/** Pick the clip a name asked for out of a GLB that may hold several. */
export function pickClip(clips: THREE.AnimationClip[], want: string):
THREE.AnimationClip | undefined {
  return clips.find((c) => c.name === want)
    ?? clips.find((c) => normaliseBoneName(c.name) === normaliseBoneName(want))
    ?? clips[0];
}

// -------------------------------------------------------------- clip surgery

export interface PreparedClip {
  id: string;
  /** which animation in the library this row actually resolved to */
  source: string;
  clip: THREE.AnimationClip;
  /** metres per second the source clip travelled before it was made in-place */
  groundSpeed: number;
  /** seconds into this clip at which the ball leaves the foot */
  contact: number;
  /** radians the hips are off +z at the contact frame */
  yawAtContact: number;
}

/**
 * Cut a clip down to [t0, t1].
 *
 * RESAMPLED, not sliced. The obvious implementation — keep the keyframes that
 * fall inside the window — is wrong on these files and wrong in a way that
 * looks like it works: the retarget compresses a bone that barely moves down
 * to two keys spanning the WHOLE clip, so a slice keeps both of them and
 * AnimationClip.resetDuration(), which takes the maximum end time over every
 * track, hands back the full original length. One constant track is enough to
 * un-trim the entire animation.
 *
 * So: evaluate every track through its own interpolant (which slerps the
 * quaternion tracks properly) at a fixed rate across the window. `start` comes
 * back because the contact time has to be expressed relative to it.
 */
const RESAMPLE_HZ = 60;

/** KeyframeTrack.createInterpolant is assigned by setInterpolation() at
 *  runtime and is missing from @types/three, so it needs naming here. It is
 *  the only correct way to sample a quaternion track — the default for one is
 *  a slerping interpolant, and lerping four floats by hand is not it. */
type Interpolating = { createInterpolant: () => { evaluate(t: number): ArrayLike<number> } };

function trimClip(clip: THREE.AnimationClip, t0: number, t1: number):
{ clip: THREE.AnimationClip; start: number } {
  const end = Math.min(t1, clip.duration);
  const begin = Math.max(0, Math.min(t0, end - 1 / RESAMPLE_HZ));
  const n = Math.max(2, Math.round((end - begin) * RESAMPLE_HZ) + 1);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const stride = track.getValueSize();
    const interp = (track as unknown as Interpolating).createInterpolant();
    const times = new Float32Array(n);
    const values = new Float32Array(n * stride);
    for (let i = 0; i < n; i++) {
      const t = begin + ((end - begin) * i) / (n - 1);
      times[i] = t - begin;
      const v = interp.evaluate(t);
      for (let k = 0; k < stride; k++) values[i * stride + k] = v[k];
    }
    const Ctor = track.constructor as new (
      name: string, times: ArrayLike<number>, values: ArrayLike<number>,
    ) => THREE.KeyframeTrack;
    tracks.push(new Ctor(track.name, times, values));
  }
  const out = new THREE.AnimationClip(clip.name, -1, tracks);
  out.resetDuration();
  return { clip: out, start: begin };
}

/**
 * Find the frame that matters, by playing the clip on a real skeleton.
 *
 * 'strike' is the frame the right toe is moving fastest RELATIVE TO THE HIPS —
 * on a kick that is the instant the foot goes through the ball, and it does not
 * care how fast the actor was running at the time. 'apex' is simply the highest
 * the hips get, which is the top of a jump.
 *
 * Doing this at load rather than in a spreadsheet is the whole point: a clip
 * dropped into CLIP_TABLE tomorrow is timed correctly without anyone opening
 * a motion editor.
 */
function findAnchor(rig: THREE.Object3D, clip: THREE.AnimationClip,
  kind: 'strike' | 'apex' | 'sink'): { time: number; yaw: number } {
  const mixer = new THREE.AnimationMixer(rig);
  const action = mixer.clipAction(clip);
  // LoopOnce, and never sample the final instant: a repeating action wraps
  // back to frame 0 at exactly `duration`, and the jump from the last pose to
  // the first is by far the biggest "toe movement" in any clip — it wins the
  // strike search every time and anchors the trim on the very last frame.
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const hips = findBone(rig, 'mixamorig:Hips');
  const toe = findBone(rig, 'mixamorig:RightToeBase') ?? findBone(rig, 'mixamorig:RightFoot');
  const lUp = findBone(rig, 'mixamorig:LeftUpLeg');
  const rUp = findBone(rig, 'mixamorig:RightUpLeg');
  const pH = new THREE.Vector3(), pT = new THREE.Vector3();
  const pL = new THREE.Vector3(), pR = new THREE.Vector3();

  const STEP = 1 / 60;
  const n = Math.max(2, Math.ceil(clip.duration / STEP));
  let best = -Infinity, bestT = 0, bestYaw = 0;
  let prev: THREE.Vector3 | null = null;
  for (let i = 0; i < n; i++) {
    const t = (clip.duration * i) / n;
    mixer.setTime(t);
    rig.updateMatrixWorld(true);
    hips?.getWorldPosition(pH);
    toe?.getWorldPosition(pT);
    // the hips' facing, read off the pelvis rather than assumed from a bone
    // axis: right hip → left hip crossed with up is the direction the actor
    // is pointing, whatever the rig's local conventions are
    lUp?.getWorldPosition(pL);
    rUp?.getWorldPosition(pR);
    const yaw = Math.atan2(pR.z - pL.z, -(pR.x - pL.x));
    const rel = pT.clone().sub(new THREE.Vector3(pH.x, 0, pH.z));
    let score: number;
    if (kind === 'apex') {
      score = pH.y;
    } else if (kind === 'sink') {
      score = -pH.y;
    } else {
      score = prev ? rel.distanceTo(prev) / STEP : -Infinity;
    }
    prev = rel;
    if (score > best) { best = score; bestT = t; bestYaw = yaw; }
  }
  action.stop();
  mixer.uncacheClip(clip);
  return { time: bestT, yaw: bestYaw };
}

/**
 * Make a clip in-place and measure what it was worth.
 *
 * The drift is DETRENDED rather than flattened: a walk cycle's hips sway
 * side to side by a couple of centimetres and that sway is the walk. Removing
 * the straight line between the first and last key takes the travel out and
 * leaves the sway, and because a clean loop starts and ends at the same phase
 * it stays a clean loop.
 */
function makeInPlace(clip: THREE.AnimationClip, hipsTrackName: string): number {
  const track = clip.tracks.find((t) => t.name === hipsTrackName);
  if (!track) return 0;
  const v = track.values;
  const n = track.times.length;
  if (n < 2) return 0;
  const x0 = v[0], z0 = v[2];
  const x1 = v[(n - 1) * 3], z1 = v[(n - 1) * 3 + 2];
  const span = track.times[n - 1] - track.times[0];
  const travel = Math.hypot(x1 - x0, z1 - z0);
  if (span <= 1e-6) return 0;
  for (let i = 0; i < n; i++) {
    const a = (track.times[i] - track.times[0]) / span;
    v[i * 3] -= (x1 - x0) * a;
    v[i * 3 + 2] -= (z1 - z0) * a;
  }
  return travel / span;
}

// --------------------------------------------------------------- kit painting

/**
 * Where the authored t-shirt UVs put the two islands, measured off the mesh
 * (crude_male_shirt). These are UV FRACTIONS, not pixels, and every painter
 * below multiplies them by the canvas it is given — so the kit canvas can be
 * resized (it has been: 512 → 1024) and the authored map re-baked at any
 * resolution without a number in here changing. glTF v = canvas y from the top.
 *
 * The BACK island is the top half and is laid out UPSIDE DOWN AND MIRRORED —
 * v rises with body height and u rises with body +x, which for a viewer stood
 * behind the player is both flips at once. A number drawn the obvious way is
 * therefore upside down on the shirt; the fix is to draw it through a 180°
 * rotation, which is exactly the two flips composed. (Checked in a capture —
 * this is the thing the eye catches instantly if it is wrong.)
 */
const SHIRT_UV = {
  /** [u0, v0, u1, v1] of the back torso panel (not the sleeves) */
  back: [0.147, 0.0, 0.384, 0.520],
  front: [0.170, 0.559, 0.394, 0.989],
  /** neck holes, for the collar band */
  backNeck: [0.265, 0.455],
  frontNeck: [0.282, 0.585],
} as const;

/** The sock block inside the shared shoes06 atlas (same UVs on all four
 *  archetypes — the shoe mesh and its texture are identical across them). */
const SOCK_UV = [0.775, 0.850, 1.0, 1.0] as const;

/**
 * The kit canvas, in pixels square.
 *
 * This is the ONE number that decides how crisp a squad number is, because the
 * back panel is only 0.237 × 0.520 of it: at 512 the number was 69 px tall and
 * the surname 18, which is a grey smudge the moment a replay camera gets inside
 * ten metres. At 1024 they are 138 and 36, which holds up at the celebration
 * close-up (the shot that shows a back at ~3 m).
 *
 * The cost is per PLAYER, not per team — the number is his — so it is 22
 * textures a match: 1024² RGBA with mips is ~5.6 MB each, ~123 MB of the
 * unified memory on the target machine, which is the single biggest line this
 * pipeline spends and still comfortably inside a 16 GB box. Anything above
 * 1024 does not survive the anisotropic filtering at broadcast distance and is
 * not worth four times that.
 */
const SHIRT_PX = 1024;

/** One 2D canvas, sized. */
const canvas2d = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
};

/**
 * Recolour an authored garment texture while KEEPING ITS ALPHA. The source
 * images zero their alpha outside the island rims; lose that and every hem
 * grows a fringe of ragged black teeth. Draw the source, then composite the
 * colour with 'source-atop' so only lit texels are touched, at an opacity that
 * leaves a little of the original weave and stitching showing through.
 */
function recolour(ctx: CanvasRenderingContext2D, img: CanvasImageSource,
  w: number, h: number, color: string, keep: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = 1 - keep;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** Fill a uv rect, respecting the island alpha already on the canvas. */
function atopRect(ctx: CanvasRenderingContext2D, r: readonly number[],
  w: number, h: number, style: string | CanvasPattern | CanvasGradient, alpha = 1): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = style;
  ctx.fillRect(r[0] * w, r[1] * h, (r[2] - r[0]) * w, (r[3] - r[1]) * h);
  ctx.restore();
}

// --------------------------------------------------------------- loading

export interface ArchetypeLevel {
  scene: THREE.Group;
  triangles: number;
}

export interface Archetype {
  url: string;
  /** detail levels, highest first; [0] owns the skeleton every level shares */
  levels: ArchetypeLevel[];
  /** shorthand for levels[0].scene — the rig clips are bound against */
  scene: THREE.Group;
  /** metres the root has to rise so the boots sit ON the grass, not in it */
  groundOffset: number;
  triangles: number;
  /** R = sock coverage, G = height up the shin; painted once, shared by every
   *  kit and mixed in by the body material's shader (see sockMask) */
  sockMask: THREE.CanvasTexture | null;
  /**
   * ONE geometry that is the whole player's silhouette at the lowest detail
   * level: body, shirt, shorts and boots merged, skin weights kept, UVs and
   * everything else thrown away. This is what casts every shadow — see
   * buildShadowGeometry() and CharacterRig.instance().
   */
  shadowGeometry: THREE.BufferGeometry | null;
  /** triangles in shadowGeometry, for the budget line */
  shadowTriangles: number;
  /** the shorts map, flattened to a neutral cloth so a kit colour can be
   *  multiplied onto it without the authored garment's own colour surviving */
  shortsMap: THREE.CanvasTexture | null;
  /**
   * The authored shorts NORMAL map, kept when the pipeline found one.
   *
   * The kit colour has to be repainted, so the diffuse is thrown away and
   * rebuilt — but the weave, the seams and the drawstring fold are geometry,
   * not colour, and survive a recolour untouched. MPFB's GAMEENGINE tree only
   * wires a normal map when the .mhmat spells the key `normalmapTexture`, and
   * the asset packs mostly spell it `bumpTexture`, so this was null until
   * make_player.py started wiring the branch itself (see NORMAL_KEYS there).
   * Still null for an archetype whose garment never shipped one.
   */
  shortsNormal: THREE.Texture | null;
}

export interface CharacterAssets {
  archetypes: Archetype[];
  clips: Map<ClipId, PreparedClip>;
  /** total load + prepare cost, for the budget line */
  loadMs: number;
}

let assetPromise: Promise<CharacterAssets> | null = null;
let assetsReady: CharacterAssets | null = null;

/** Non-blocking accessor: null until preloadCharacters() has resolved. */
export function charactersReady(): CharacterAssets | null {
  return assetsReady;
}

function loadGLTF(loader: GLTFLoader, url: string): Promise<{
  scene: THREE.Group; animations: THREE.AnimationClip[];
}> {
  return new Promise((resolve, reject) => {
    loader.load(url, (g) => resolve({ scene: g.scene, animations: g.animations }),
      undefined, (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * Load every character and every clip, once per page. Idempotent: the promise
 * is cached, so the attract match, the real match and the capture harness all
 * share one download.
 */
export function preloadCharacters(): Promise<CharacterAssets> {
  if (assetPromise) return assetPromise;
  const t0 = performance.now();
  const loader = new GLTFLoader();

  assetPromise = (async (): Promise<CharacterAssets> => {
    // Every archetype at every detail level. A missing sibling is not fatal:
    // the level list simply gets shorter and the LOD picker clamps to it.
    const chars = await Promise.all(ARCHETYPES.map(async (base) => {
      const levels = await Promise.all(LEVEL_SUFFIX.map(async (sfx) => {
        try {
          return await loadGLTF(loader, `${base}${sfx}.glb`);
        } catch {
          if (sfx !== '') console.warn(`characters: no ${base}${sfx}.glb — level dropped`);
          return null;
        }
      }));
      return levels;
    }));

    // Fetch every row's clip in parallel, each row walking its own candidate
    // list until one resolves. A miss is a 404 and costs nothing; the
    // alternative — one bundle with four hundred clips in it — is twenty-five
    // megabytes to play seventeen.
    type Src = { clip: THREE.AnimationClip; scene: THREE.Group; name: string };
    const sources = new Map<ClipId, Src>();
    const bundleWanted: ClipId[] = [];
    await Promise.all((Object.entries(CLIP_TABLE) as [ClipId, ClipSpec][]).map(async ([id, spec]) => {
      const names = Array.isArray(spec.anim) ? spec.anim : [spec.anim];
      for (const name of names) {
        try {
          const g = await loadGLTF(loader, spec.file ?? `${CLIP_DIR}${name}.glb`);
          const hit = pickClipExact(g.animations, name) ?? g.animations[0];
          // A retarget that produced two keyframes is a failed retarget, not a
          // clip. Taking it would leave a player frozen on one pose; falling
          // through to the next candidate is always better.
          if (hit && hit.duration >= MIN_CLIP_SECONDS) {
            sources.set(id, { clip: hit, scene: g.scene, name });
            return;
          }
          if (hit) console.warn(`characters: ${name} is only ${hit.duration.toFixed(2)}s — skipped`);
        } catch { /* next candidate */ }
      }
      bundleWanted.push(id);
    }));

    // Last resort for anything still missing: the all-in-one bundle.
    if (bundleWanted.length) {
      try {
        const g = await loadGLTF(loader, CLIP_BUNDLE);
        for (const id of bundleWanted) {
          const spec = CLIP_TABLE[id];
          const names = Array.isArray(spec.anim) ? spec.anim : [spec.anim];
          for (const name of names) {
            const hit = pickClipExact(g.animations, name);
            if (hit && hit.duration >= MIN_CLIP_SECONDS) {
              sources.set(id, { clip: hit, scene: g.scene, name });
              break;
            }
          }
        }
      } catch { /* reported by the missing list below */ }
    }

    const archetypes: Archetype[] = chars
      .map((levels, i) => prepareArchetype(ARCHETYPES[i], levels.map((l) => l?.scene ?? null)))
      .filter((a): a is Archetype => a !== null);
    if (!archetypes.length) throw new Error('characters: no archetype loaded');

    const clips = new Map<ClipId, PreparedClip>();
    const rig = archetypes[0].scene;
    const hipsName = findBone(rig, 'mixamorig:Hips')?.name ?? 'mixamorigHips';
    const missing: string[] = [];
    for (const [id, spec] of Object.entries(CLIP_TABLE) as [ClipId, ClipSpec][]) {
      const src = sources.get(id);
      if (!src) {
        const names = Array.isArray(spec.anim) ? spec.anim : [spec.anim];
        missing.push(`${id}(${names[0]})`);
        continue;
      }
      const used = src.name;

      let clip = src.clip.clone();
      const unbound = rebindClip(clip, rig, src.scene);
      if (unbound.length) {
        console.warn(`characters: ${unbound.length} unbound track(s) in ${used}`);
      }

      let contact = spec.contact ?? 0;
      let yaw = spec.yawAtContact ?? 0;
      if (spec.range) {
        const cut = trimClip(clip, spec.range[0], spec.range[1]);
        clip = cut.clip;
      } else if (spec.anchor) {
        const full = clip.duration;
        const found = findAnchor(rig, clip, spec.anchor);
        const lead = spec.lead ?? 0;
        const tail = spec.tail ?? 0.6;
        const cut = trimClip(clip, Math.max(0, found.time - lead), found.time + tail);
        console.info(`characters: ${id} ${spec.anchor} at ${found.time.toFixed(2)}s`
          + ` of ${full.toFixed(2)}s (${used}) → ${cut.clip.duration.toFixed(2)}s`);
        // A trim that collapsed means the anchor landed on the last frame,
        // which means the detector found nothing useful. A whole clip playing
        // from the top is wrong but watchable; one frame is a statue.
        if (cut.clip.duration < 0.1) {
          console.warn(`characters: ${id} anchor produced a ${cut.clip.duration.toFixed(3)}s`
            + ' clip — keeping the untrimmed animation');
        } else {
          clip = cut.clip;
          contact = spec.contact ?? Math.max(0, found.time - cut.start);
          // Only a STRIKE carries a facing error worth cancelling: the ball
          // has to leave along the sim's aim. A slide or a dive is turned
          // because the movement itself is turned, and squaring it up to +z
          // would twist the whole action sideways.
          yaw = spec.yawAtContact ?? (spec.anchor === 'strike' ? found.yaw : 0);
        }
      }
      clip.name = id;
      const measured = makeInPlace(clip, `${hipsName}.position`);
      clips.set(id, {
        id, source: used, clip, contact, yawAtContact: yaw,
        groundSpeed: spec.groundSpeed ?? measured,
      });
    }
    if (missing.length) {
      console.warn(`characters: no clip for ${missing.join(', ')}`
        + ' — those actions fall back to the procedural placeholders');
    }

    // Ground each archetype off the idle pose (walk, first frame): a fixed lift
    // is all the sim's flat pitch needs, and it costs nothing per frame.
    const idle = clips.get('walk') ?? clips.values().next().value;
    let height = 0;
    for (const a of archetypes) {
      const g = groundOffsetFor(a.scene, idle?.clip);
      a.groundOffset = g.offset;
      height = Math.max(height, g.height);
    }

    const loadMs = Math.round((performance.now() - t0) * 10) / 10;
    const tris = archetypes.reduce((s, a) => s + a.triangles, 0) / archetypes.length;
    console.info(`characters: ${archetypes.length} archetypes (~${Math.round(tris)} tris each,`
      + ` ${height.toFixed(2)}m tall), ${clips.size}/${Object.keys(CLIP_TABLE).length} clips,`
      + ` ${loadMs}ms`);
    for (const c of clips.values()) {
      console.info(`  clip ${c.id.padEnd(10)}${c.clip.duration.toFixed(2)}s`
        + ` ${c.groundSpeed.toFixed(2)}m/s contact ${c.contact.toFixed(2)}s`
        + ` yaw ${(c.yawAtContact * 180 / Math.PI).toFixed(0)}deg  ← ${c.source}`);
    }

    // A character with no clips is a character stuck in his bind pose, which
    // is the single worst thing this pipeline can put on screen. Refuse to
    // declare ready without at least the two ends of the locomotion chain, and
    // the renderer quietly keeps the capsules.
    const locoHave = LOCO_CHAIN.filter((id) => clips.has(id)).length;
    if (locoHave < 2) {
      throw new Error(`characters: only ${locoHave} locomotion clip(s) loaded`
        + ' — refusing the skinned path rather than shipping A-posed players');
    }

    assetsReady = { archetypes, clips, loadMs };
    return assetsReady;
  })();

  assetPromise.catch((err) => {
    console.error('characters: preload failed, falling back to the capsule path', err);
    assetPromise = null;
  });
  return assetPromise;
}

function pickClipExact(clips: THREE.AnimationClip[], want: string):
THREE.AnimationClip | undefined {
  return clips.find((c) => c.name === want)
    ?? clips.find((c) => normaliseBoneName(c.name) === normaliseBoneName(want));
}

/**
 * Materials fixed, mouth interiors dropped, garment maps neutralised, sock
 * mask painted — once per archetype, before anything is cloned off it. Every
 * detail level goes through the same pass, and levels 1 and 2 hand their
 * materials over to level 0's so all three draw with one set.
 */
function prepareArchetype(url: string, scenes: (THREE.Group | null)[]): Archetype | null {
  if (!scenes[0]) return null;
  const levels: ArchetypeLevel[] = [];
  for (const scene of scenes) {
    if (!scene) continue;
    const drop: THREE.Object3D[] = [];
    let triangles = 0;
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (CULL_MESHES.test(mesh.name)) { drop.push(mesh); return; }
      mesh.castShadow = false;   // the shadow proxy does all the casting
      mesh.receiveShadow = true;
      // a skinned mesh's bind-pose bounds do not cover a posed limb, and three
      // then culls the whole player out of a close shot
      mesh.frustumCulled = false;
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      triangles += (idx ? idx.count : pos.count) / 3;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        fixCharacterMaterial(m, mesh.name);
      }
    });
    for (const d of drop) d.removeFromParent();

    // sink the waistband under the shirt hem (see tuckUnder for why)
    let outerTop: THREE.Mesh | undefined;
    let innerBottom: THREE.Mesh | undefined;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (isShirt(m)) outerTop ??= m;
      if (isShorts(m)) innerBottom ??= m;
    });
    if (outerTop && innerBottom) tuckUnder(innerBottom, outerTop, 0.02, 0.015);

    levels.push({ scene, triangles: Math.round(triangles) });
  }

  // Every level hands its materials over to level 0's, matched by mesh name.
  //
  // This is what the class comment has always claimed and what the code did
  // not do: each LOD sibling is a separate GLB, so it arrived with its own
  // Material objects and its own decoded copies of the same skin, hair and boot
  // maps — three sets per archetype, twelve for the roster. Nothing downstream
  // wanted them: dress() replaces the kit parts outright, and matchCopy() keys
  // its per-match clone on the SOURCE material's uuid, so three uuids meant
  // three clones of one body material and three shader patches to compile.
  //
  // Names are stable across levels because the decimator only edits geometry,
  // and the only thing that changes with detail is the triangle count — a
  // material is not a detail level. A level whose name does not match (a
  // re-bake that renamed a mesh) simply keeps its own, blurrier, map.
  const byName = new Map<string, THREE.Material | THREE.Material[]>();
  levels[0].scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) byName.set(m.name, m.material);
  });
  for (let li = 1; li < levels.length; li++) {
    levels[li].scene.traverse((o) => {
      const m = o as THREE.Mesh;
      const hit = m.isMesh ? byName.get(m.name) : undefined;
      if (hit) m.material = hit;
    });
  }

  const arch: Archetype = {
    url, levels, scene: levels[0].scene, groundOffset: 0,
    triangles: levels[0].triangles, sockMask: null,
    shadowGeometry: null, shadowTriangles: 0, shortsMap: null,
    shortsNormal: null,
  };
  const shadow = buildShadowGeometry(levels[levels.length - 1].scene);
  arch.shadowGeometry = shadow;
  if (shadow) {
    const idx = shadow.getIndex();
    arch.shadowTriangles = Math.round(
      (idx ? idx.count : shadow.getAttribute('position').count) / 3);
  }
  arch.sockMask = buildSockMask(arch);
  arch.shortsMap = neutralGarmentMap(arch, isShorts, 0.78);
  arch.shortsNormal = sourceMaterialOf(arch, isShorts)?.normalMap ?? null;
  return arch;
}

// ------------------------------------------------------------ shadow proxy
//
// THE BUG THIS EXISTS TO KILL: the shadow caster used to BE the lowest detail
// level's meshes, parked on SHADOW_LAYER by updateLOD(). But updateLOD also
// hides every level except the one being drawn — so the moment a player was
// near enough for lod0 or lod1, his caster was `visible = false`, and three's
// shadow pass skips invisible objects before it looks at layers, materials or
// anything else. With two players at lod0 and twenty at lod1 that is
// twenty-two players casting nothing at all. Players had no shadows.
//
// The fix is to stop overloading one mesh with two jobs. A proxy is its own
// mesh: bound to the same skeleton (so it is posed for free, every frame, with
// no extra mixer and no second bone texture), never touched by the LOD picker,
// permanently visible, permanently on SHADOW_LAYER — which the game camera
// does not draw, so "permanently visible" costs the beauty pass nothing.
//
// And since it is its own mesh, it can be ONE mesh. Merging the lowest level's
// body, shirt, shorts and boots into a single geometry takes a player's shadow
// from four skinned draws per cascade to one, which is 66 draw calls a frame
// back across a 22-man squad and three cascades.

/** Parts whose silhouette a shadow actually needs. Hair is in: a shadow with a
 *  flat skull reads as a bald man. Eyes, teeth and brows are not. */
const SHADOW_PARTS = (m: THREE.Mesh): boolean =>
  isBody(m) || isShirt(m) || isShorts(m) || isShoes(m) || /hair|afro|short0/i.test(nameOf(m));

/** Attributes a depth-only draw needs. Everything else (uv, uv2, tangent,
 *  colour) is buffer the shadow pass never reads. */
const SHADOW_ATTRS = ['position', 'normal', 'skinIndex', 'skinWeight'];

/**
 * Merge one detail level's silhouette parts into a single skinned geometry.
 *
 * Returns null — and the caller falls back to per-part proxies — if the parts
 * do not agree on a bind matrix or an attribute set, because a merge across
 * two different bind poses is a player whose shadow is inside out.
 */
function buildShadowGeometry(scene: THREE.Group): THREE.BufferGeometry | null {
  const parts: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && SHADOW_PARTS(m)) parts.push(m);
  });
  if (!parts.length) return null;

  const bind = parts[0].bindMatrix;
  const geos: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    if (!part.bindMatrix.equals(bind)) {
      console.warn(`characters: ${part.name} has its own bind matrix`
        + ' — shadow proxy falls back to per-part meshes');
      return null;
    }
    const g = part.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (!SHADOW_ATTRS.includes(name)) g.deleteAttribute(name);
    }
    if (SHADOW_ATTRS.some((n) => !g.getAttribute(n))) return null;
    if (!g.getIndex()) return null;
    g.clearGroups();
    g.morphAttributes = {};
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

/** Which garment a mesh is, tolerant of the asset pipeline renaming things
 *  underneath us: the mesh name and the material name both get a look. */
const nameOf = (m: THREE.Mesh): string => {
  const mat = Array.isArray(m.material) ? m.material[0] : m.material;
  return `${m.name} ${mat?.name ?? ''}`;
};
const isShirt = (m: THREE.Mesh): boolean => /shirt|jersey/i.test(nameOf(m));
const isShorts = (m: THREE.Mesh): boolean => /shorts|trunks|jeans|trouser/i.test(nameOf(m));
const isShoes = (m: THREE.Mesh): boolean => /shoes|boot/i.test(nameOf(m));
const isBody = (m: THREE.Mesh): boolean => /\bbase\b|body/i.test(nameOf(m));

/**
 * Flatten a garment map to neutral cloth, keeping its weave and its alpha.
 *
 * The kit colour is applied by MULTIPLY (material.color), which is the cheap
 * and correct way to tint cloth — but multiply only works on a map that is
 * roughly WHITE. The authored shorts have been blue denim and are becoming a
 * pale speckled cloth. Dropping the map to luminance and then dividing through
 * by its own mean makes both of them behave the same: the weave and the seams
 * survive, the garment's own colour does not, and white shorts come out white
 * instead of faintly denim.
 */
function neutralGarmentMap(arch: Archetype, pick: (m: THREE.Mesh) => boolean,
  target: number): THREE.CanvasTexture | null {
  const img = sourceImageOf(arch, pick);
  if (!img) return null;
  // 512, not 256: the map is multiplied by the kit colour and is therefore the
  // only thing carrying the crease and seam detail of the shorts. At 256 the
  // seams were a suggestion; the normal map now sitting alongside it is 1024
  // and wants a diffuse that can keep up.
  const N = 512;
  const [c, ctx] = canvas2d(N, N);
  ctx.drawImage(img, 0, 0, N, N);
  const data = ctx.getImageData(0, 0, N, N);
  const px = data.data;
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    sum += (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    n++;
  }
  const mean = n ? sum / n : 1;
  const gain = THREE.MathUtils.clamp(target / Math.max(mean, 0.02), 1, 12);
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * gain;
    px[i] = px[i + 1] = px[i + 2] = Math.min(255, lum);
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;
  return tex;
}

/** The first material on a mesh the predicate likes, at any detail level. */
function sourceMaterialOf(arch: Archetype, pick: (m: THREE.Mesh) => boolean):
THREE.MeshStandardMaterial | null {
  let found: THREE.MeshStandardMaterial | null = null;
  let any: THREE.MeshStandardMaterial | null = null;
  for (const level of arch.levels) {
    level.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (found || !m.isMesh || !pick(m)) return;
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      any ??= mat;
      // prefer one that actually carries the authored map: that is what every
      // caller is really after
      if (mat?.map) found = mat;
    });
    if (found) break;
  }
  return found ?? any;
}

/** The first image on a mesh the predicate likes, at any detail level. */
function sourceImageOf(arch: Archetype, pick: (m: THREE.Mesh) => boolean):
CanvasImageSource | null {
  return (sourceMaterialOf(arch, pick)?.map?.image as CanvasImageSource | undefined) ?? null;
}

// ------------------------------------------------------------------- socks

/** How far up the shin the sock reaches, as a fraction of knee-to-ankle. */
const SOCK_TOP = 0.94;
/** Mask resolution. The shin is a small island in the body atlas; 512 puts
 *  roughly a hundred texels across it, which is more than the sock edge needs. */
const SOCK_MASK_PX = 512;

/**
 * Paint the sock as a MASK in the body texture's own UV space.
 *
 * Which texels are shin is not guessable from the atlas — it has to come off
 * the mesh. So: take every vertex whose heaviest skin weight is the left or
 * right LOWER LEG bone (mixamorig:LeftLeg / RightLeg, which in a Mixamo rig is
 * knee-to-ankle and NOT the thigh and NOT the foot), work out how far up that
 * bone each one sits, and rasterise the triangles they form into UV space.
 *
 * Red carries coverage, green carries the height up the shin. The body
 * material's shader then mixes the kit's sock colour in wherever red is set,
 * shades it with green and puts the turnover band near the top — which means
 * ONE mask per archetype serves every team instead of one repainted 1024²
 * skin per (archetype, kit), and the authored skin texture is never touched.
 */
function buildSockMask(arch: Archetype): THREE.CanvasTexture | null {
  let body: THREE.SkinnedMesh | null = null;
  arch.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!body && m.isSkinnedMesh && isBody(m)) body = m;
  });
  if (!body) return null;
  const mesh: THREE.SkinnedMesh = body;
  const skeleton = mesh.skeleton;
  const pos = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const joints = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const index = mesh.geometry.getIndex();
  if (!uv || !joints || !weights) return null;

  // bone indices of the two shins, and the knee/ankle they run between
  const shin: Record<number, { knee: THREE.Vector3; ankle: THREE.Vector3 }> = {};
  arch.scene.updateMatrixWorld(true);
  for (const side of ['Left', 'Right']) {
    const leg = findBone(arch.scene, `mixamorig:${side}Leg`);
    const foot = findBone(arch.scene, `mixamorig:${side}Foot`);
    if (!leg || !foot) continue;
    const i = skeleton.bones.indexOf(leg as THREE.Bone);
    if (i < 0) continue;
    shin[i] = {
      knee: leg.getWorldPosition(new THREE.Vector3()),
      ankle: foot.getWorldPosition(new THREE.Vector3()),
    };
  }
  if (!Object.keys(shin).length) return null;

  // Per vertex: how much of it is shin, and how far up the shin it sits
  // (0 ankle → 1 knee, and past 1 for the thigh above it).
  //
  // Coverage is deliberately generous — ANY meaningful weight on a lower-leg
  // bone counts, not just a dominant one — and every triangle with a single
  // covered corner gets painted. The first attempt at this required all three
  // corners, which meant the mask simply stopped at the last all-shin
  // triangle: the sock top was then a row of triangle edges, and it read as a
  // saw-tooth around the calf from ten metres. The shader decides where the
  // sock ends; the mask only has to reach past there.
  const cover = new Uint8Array(pos.count);
  const height = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const shins = Object.entries(shin).map(([k, v]) => ({ bone: Number(k), ...v }));
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    // HEIGHT IS COMPUTED FOR EVERY VERTEX, not just the covered ones. A
    // triangle straddling the knee has one corner on the thigh, and if that
    // corner's height defaults to zero the ramp across the triangle runs
    // backwards — which paints a detached band of sock across the thigh and
    // leaves a gap below it. (It did, in a capture, and that is how this
    // comment came to exist.)
    let best = Infinity;
    for (const s of shins) {
      axis.copy(s.knee).sub(s.ankle);
      const len2 = axis.lengthSq();
      if (len2 < 1e-8) continue;
      const t = p.clone().sub(s.ankle).dot(axis) / len2;
      // distance to the bone's own line, so the nearer leg wins
      const d = p.clone().sub(s.ankle).addScaledVector(axis, -t).length();
      if (d >= best) continue;
      best = d;
      // HEIGHT IS PLAIN WORLD Y between ankle and knee, not the projection
      // onto the shin axis. The axis is tilted, so a knee-cap vertex can
      // project back DOWN the shin and come out with a low height — which
      // paints a stray hoop of sock across the knee, above where the sock
      // has already been cut. In a bind pose the character is standing up;
      // height off the floor is the thing that actually means "up the leg".
      const span = s.knee.y - s.ankle.y;
      height[i] = span > 1e-4
        ? THREE.MathUtils.clamp((p.y - s.ankle.y) / span, 0, 1.6) : 0;
    }
    // coverage, though, is skin weights: ANY meaningful weight on a lower-leg
    // bone counts, and a triangle with a single covered corner gets painted.
    // Requiring all three put the sock's top edge on triangle boundaries,
    // which read as a saw-tooth around the calf.
    let shinW = 0;
    for (let k = 0; k < 4; k++) {
      if (shin[joints.getComponent(i, k)]) {
        shinW = Math.max(shinW, weights.getComponent(i, k));
      }
    }
    // ...and cut the coverage a little above where the sock ends. Triangles
    // that straddle the cut still get painted (one covered corner is enough),
    // so the shader keeps its smooth edge; triangles entirely above it never
    // do, which is what stops a stray ring of sock appearing on the thigh
    // where the knee's own UV island happens to sit.
    if (shinW >= 0.15 && height[i] <= SOCK_TOP + 0.08) cover[i] = 1;
  }

  const N = SOCK_MASK_PX;
  const [c, ctx] = canvas2d(N, N);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, N, N);
  const tri = index ? index.count / 3 : pos.count / 3;
  let painted = 0;
  for (let f = 0; f < tri; f++) {
    const a = index ? index.getX(f * 3) : f * 3;
    const b = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const d = index ? index.getX(f * 3 + 2) : f * 3 + 2;
    if (!cover[a] && !cover[b] && !cover[d]) continue;
    painted++;
    // The height channel has to interpolate ACROSS each triangle, or the sock
    // top lands on triangle edges and reads as a saw-tooth. Height is a linear
    // function of the UV position over a triangle, and a linear function is
    // exactly what a canvas linear gradient evaluates — so solve for it and
    // let the rasteriser do the interpolation.
    const style = heightGradient(ctx,
      uv.getX(a) * N, uv.getY(a) * N, height[a],
      uv.getX(b) * N, uv.getY(b) * N, height[b],
      uv.getX(d) * N, uv.getY(d) * N, height[d]);
    ctx.fillStyle = style;
    ctx.strokeStyle = style;
    ctx.beginPath();
    ctx.moveTo(uv.getX(a) * N, uv.getY(a) * N);
    ctx.lineTo(uv.getX(b) * N, uv.getY(b) * N);
    ctx.lineTo(uv.getX(d) * N, uv.getY(d) * N);
    ctx.closePath();
    ctx.fill();
    // the rasteriser leaves hairline gaps between adjacent triangles, which
    // show up as a grid of skin-coloured threads through the sock
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (!painted) return null;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;   // data, not colour
  tex.flipY = false;                     // glTF UV origin is the top left
  return tex;
}

/**
 * A fill style that paints `h` into the green channel, interpolated linearly
 * across the triangle. h(u,v) = a·u + b·v + c is solved from the three
 * corners; the gradient axis is (a, b) and the two stops are placed where h
 * would be 0 and 1, so the canvas's own interpolation reproduces it exactly.
 * Degenerate triangles (h constant, or zero area) fall back to a flat fill.
 */
function heightGradient(ctx: CanvasRenderingContext2D,
  x0: number, y0: number, h0: number, x1: number, y1: number, h1: number,
  x2: number, y2: number, h2: number): string | CanvasGradient {
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  const flat = (h: number): string => `rgb(255,${Math.round(THREE.MathUtils.clamp(h, 0, 1) * 255)},0)`;
  if (Math.abs(det) < 1e-9) return flat((h0 + h1 + h2) / 3);
  const a = ((h1 - h0) * (y2 - y0) - (h2 - h0) * (y1 - y0)) / det;
  const b = ((x1 - x0) * (h2 - h0) - (x2 - x0) * (h1 - h0)) / det;
  const len = Math.hypot(a, b);
  if (len < 1e-9) return flat((h0 + h1 + h2) / 3);
  // walk from the first corner to where h hits 0, then one full unit of h
  const nx = a / len, ny = b / len;
  const ax = x0 - (h0 / len) * nx, ay = y0 - (h0 / len) * ny;
  const g = ctx.createLinearGradient(ax, ay, ax + nx / len, ay + ny / len);
  g.addColorStop(0, 'rgb(255,0,0)');
  g.addColorStop(1, 'rgb(255,255,0)');
  return g;
}

/**
 * Mix the sock into a body material. Coverage and the height ramp come out of
 * the mask; the colour, the cloth shading and the turnover band are all
 * computed here, so a team is one uniform and not a repainted skin.
 */
function queueSockPatch(mat: THREE.MeshStandardMaterial,
  mask: THREE.Texture, color: THREE.Color): void {
  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26SockMask = { value: mask };
    shader.uniforms.ss26SockColor = { value: color };
    shader.uniforms.ss26SockTop = { value: SOCK_TOP };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D ss26SockMask;
        uniform vec3 ss26SockColor;
        uniform float ss26SockTop;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec4 ss26Sock = texture2D( ss26SockMask, vMapUv );
          // The mask covers the whole shin; where the sock STOPS is decided
          // here, so the top edge is a smooth line and not a row of triangles.
          //
          // Height is read as g/r, not g. The rasteriser antialiases the edge
          // of the shin island, which fades BOTH channels toward the black
          // background together — so raw g dips at the island rim and drew a
          // stray hairline of sock across the knee, above the cut. The ratio
          // divides the coverage back out and is exact wherever r > 0.
          float ss26H = ( ss26Sock.g / max( ss26Sock.r, 0.004 ) )
            / max( ss26SockTop, 0.001 );
          float ss26Cov = smoothstep( 0.35, 0.65, ss26Sock.r )
            * ( 1.0 - smoothstep( 0.985, 1.02, ss26H ) );
          if ( ss26Cov > 0.001 ) {
            // cloth: a touch darker down the shin where the sock creases
            vec3 ss26C = ss26SockColor * ( 0.86 + 0.18 * ss26H );
            // turnover band: the fold at the top of a football sock, one
            // shade brighter and a hard edge above it
            float ss26Band = smoothstep( 0.80, 0.84, ss26H ) * ( 1.0 - smoothstep( 0.93, 0.97, ss26H ) );
            ss26C = mix( ss26C, ss26C * 1.22 + 0.04, ss26Band );
            diffuseColor.rgb = mix( diffuseColor.rgb, ss26C, ss26Cov );
          }
        }`);
  });
}

/** Lowest skinned vertex under the idle pose, negated: the lift that puts the
 *  boots on the grass. Walks the skinned vertices once, at load. */
function groundOffsetFor(scene: THREE.Group, clip: THREE.AnimationClip | undefined):
{ offset: number; height: number } {
  if (!clip) return { offset: 0, height: 0 };
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.setTime(0);
  scene.updateMatrixWorld(true);
  let minY = Infinity;
  let maxY = -Infinity;
  const v = new THREE.Vector3();
  scene.traverse((obj) => {
    const sk = obj as THREE.SkinnedMesh;
    if (!sk.isSkinnedMesh) return;
    const n = sk.geometry.getAttribute('position').count;
    // every 3rd vertex: the boot sole is hundreds of vertices and this only
    // has to find the lowest one to a millimetre
    for (let i = 0; i < n; i += 3) {
      sk.getVertexPosition(i, v);
      v.applyMatrix4(sk.matrixWorld);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
  });
  action.stop();
  mixer.uncacheClip(clip);
  // put the skeleton back where it was so the template is not left posed
  scene.updateMatrixWorld(true);
  return Number.isFinite(minY)
    ? { offset: -minY, height: maxY - minY }
    : { offset: 0, height: 0 };
}

// ------------------------------------------------------------------ the rig

export interface CharacterInstance {
  root: THREE.Group;
  /** one entry per detail level, highest detail first */
  levels: { meshes: THREE.SkinnedMesh[] }[];
  /** the lowest level, parked on SHADOW_LAYER as the shadow caster */
  shadowMeshes: THREE.SkinnedMesh[];
  bones: {
    hips?: THREE.Object3D;
    spine?: THREE.Object3D;
    spine1?: THREE.Object3D;
    head?: THREE.Object3D;
    armL?: THREE.Object3D;
    armR?: THREE.Object3D;
    foreArmL?: THREE.Object3D;
    foreArmR?: THREE.Object3D;
  };
  groundOffset: number;
}

/**
 * Everything twenty-two skinned players share: the loaded archetypes, the
 * prepared clips, and one set of kit materials per KIT (four per match, not
 * twenty-two). The only thing minted per player is a 512² shirt texture with
 * his number on it, painted on top of the team's shared base canvas.
 */
export class CharacterRig {
  /**
   * Source material → this match's copy.
   *
   * The archetypes are page-level and survive a match; their materials must
   * not. CSM.setupMaterial() REPLACES onBeforeCompile, and applyShaderPatches()
   * refuses to re-hang a patch it has already installed once — so a material
   * that lived through two Atmospheres would come out of the second one with
   * CSM's hook and none of ours, i.e. no broadcast skin and shadows that only
   * half work. One cheap clone per material per match makes the registration
   * dance idempotent again. Textures are shared and deliberately NOT cloned.
   */
  private matClones = new Map<string, THREE.MeshStandardMaterial>();
  /** one depth-only material for every shadow proxy in the match */
  private shadowMat: THREE.MeshBasicMaterial | null = null;
  private kitShirtBase = new Map<string, HTMLCanvasElement>();
  private shirtMats = new Map<string, THREE.MeshStandardMaterial>();
  private shortsMats = new Map<string, THREE.MeshStandardMaterial>();
  private bootMats = new Map<string, THREE.MeshStandardMaterial>();
  private owned: (THREE.Material | THREE.Texture)[] = [];
  private nextArchetype = 0;

  constructor(readonly assets: CharacterAssets) {}

  clip(id: ClipId): PreparedClip | undefined {
    return this.assets.clips.get(id);
  }

  /**
   * The shadow proxies' material: one, shared by all 22.
   *
   * three does not draw this — it DERIVES a depth material from it for the
   * shadow pass — so the only things that matter are the ones that change that
   * derivation: no map and no alphaTest means the cheapest skinned depth
   * shader there is, and one material across the squad means one shader
   * program and no per-player state change between cascades.
   */
  private shadowMaterial(): THREE.MeshBasicMaterial {
    if (!this.shadowMat) {
      this.shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
      this.owned.push(this.shadowMat);
    }
    return this.shadowMat;
  }

  /** Triangles per player at each detail level, for the budget line. */
  budget(): number[] {
    const n = Math.max(...this.assets.archetypes.map((a) => a.levels.length));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const lv = this.assets.archetypes.map((a) => a.levels[i]?.triangles ?? 0).filter(Boolean);
      out.push(Math.round(lv.reduce((x, y) => x + y, 0) / Math.max(1, lv.length)));
    }
    return out;
  }

  /**
   * One player, at every detail level, on ONE skeleton.
   *
   * Only level 0 is cloned properly; levels 1 and 2 contribute their meshes,
   * rebound to level 0's skeleton. That is the whole trick behind LOD here:
   * there is a single bone hierarchy and a single mixer, all three levels are
   * always correctly posed, and switching detail is a visibility flag rather
   * than a re-bind, a re-pose or a frame of A-pose.
   */
  instance(data: PlayerData, kit: KitSpec): CharacterInstance {
    const arch = this.assets.archetypes[
      // spread the faces deterministically across the squad rather than by
      // name hash: a hash gives one team four identical faces often enough
      // to be noticed
      this.nextArchetype++ % this.assets.archetypes.length
    ];
    const root = cloneSkeleton(arch.scene) as THREE.Group;

    // SkeletonUtils.clone() gives every SkinnedMesh its OWN Skeleton, and a
    // Skeleton is a bone texture: ten meshes a player, twenty-two players, two
    // hundred and twenty bone textures re-uploaded every frame. All the meshes
    // reference the same glTF skin (one `skins` entry in the file) and sit
    // under the same armature node, so they can and should share one.
    let shared: THREE.Skeleton | null = null;
    let meshParent: THREE.Object3D = root;
    root.traverse((obj) => {
      const sk = obj as THREE.SkinnedMesh;
      if (!sk.isSkinnedMesh) return;
      if (!shared) { shared = sk.skeleton; meshParent = sk.parent ?? root; }
      else if (shared.bones.length === sk.skeleton.bones.length) sk.skeleton = shared;
    });

    const levels: { meshes: THREE.SkinnedMesh[] }[] = [];
    for (let li = 0; li < arch.levels.length; li++) {
      const meshes: THREE.SkinnedMesh[] = [];
      if (li === 0) {
        root.traverse((obj) => {
          const mesh = obj as THREE.SkinnedMesh;
          if (mesh.isMesh) meshes.push(mesh);
        });
      } else if (shared) {
        // the lower levels bring geometry and nothing else: a fresh
        // SkinnedMesh over the SHARED geometry, bound to the skeleton that is
        // already here. No clone, no second skeleton, no second bone texture.
        arch.levels[li].scene.traverse((obj) => {
          const src = obj as THREE.SkinnedMesh;
          if (!src.isSkinnedMesh) return;
          const m = new THREE.SkinnedMesh(src.geometry, src.material as THREE.Material);
          m.name = src.name;
          m.bindMode = src.bindMode;
          m.bind(shared as THREE.Skeleton, src.bindMatrix);
          meshParent.add(m);
          meshes.push(m);
        });
      }
      for (const mesh of meshes) {
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.material = this.dress(mesh, kit, data, arch);
      }
      levels.push({ meshes });
    }

    // The shadow proxy: its own mesh, its own geometry, never a detail level.
    // See the buildShadowGeometry() block for why this is not the lod2 mesh
    // wearing a second hat — that arrangement meant no player cast a shadow
    // unless he happened to be past the last band.
    const shadowMeshes: THREE.SkinnedMesh[] = [];
    if (shared && arch.shadowGeometry) {
      const proxy = new THREE.SkinnedMesh(arch.shadowGeometry, this.shadowMaterial());
      proxy.name = 'shadowProxy';
      proxy.bindMode = levels[0].meshes[0]?.bindMode ?? proxy.bindMode;
      proxy.bind(shared as THREE.Skeleton, levels[0].meshes[0]?.bindMatrix);
      meshParent.add(proxy);
      shadowMeshes.push(proxy);
    } else {
      // fallback: the lowest level's silhouette parts, CLONED so the LOD
      // picker's visibility flags cannot reach them
      for (const src of levels[levels.length - 1].meshes.filter(SHADOW_PARTS)) {
        const m = new THREE.SkinnedMesh(src.geometry, this.shadowMaterial());
        m.name = `${src.name}.shadow`;
        m.bindMode = src.bindMode;
        m.bind(src.skeleton, src.bindMatrix);
        meshParent.add(m);
        shadowMeshes.push(m);
      }
    }
    for (const m of shadowMeshes) {
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      // permanently visible and permanently invisible: SHADOW_LAYER is drawn
      // by the cascade cameras and by scene.ts's shadow probe, and by nothing
      // the player ever looks at
      m.visible = true;
      m.layers.set(SHADOW_LAYER);
    }

    return {
      root,
      levels,
      shadowMeshes,
      bones: {
        hips: findBone(root, 'mixamorig:Hips'),
        spine: findBone(root, 'mixamorig:Spine'),
        spine1: findBone(root, 'mixamorig:Spine1'),
        head: findBone(root, 'mixamorig:Head'),
        armL: findBone(root, 'mixamorig:LeftArm'),
        armR: findBone(root, 'mixamorig:RightArm'),
        foreArmL: findBone(root, 'mixamorig:LeftForeArm'),
        foreArmR: findBone(root, 'mixamorig:RightForeArm'),
      },
      groundOffset: arch.groundOffset,
    };
  }

  /** Which material a mesh wears. Kit parts are shared per team (the shirt per
   *  player, because of the number); everything else is the archetype's own
   *  material, copied once per match — except the body, which also carries the
   *  team's socks and is therefore copied per team. */
  private dress(mesh: THREE.SkinnedMesh, kit: KitSpec, data: PlayerData,
    arch: Archetype): THREE.Material {
    if (isShirt(mesh)) return this.shirtMaterial(kit, data, arch);
    if (isShorts(mesh)) return this.shortsMaterial(kit, arch);
    if (isShoes(mesh)) return this.bootMaterial(kit, arch);
    return this.matchCopy(mesh.material as THREE.Material, mesh.name, kit, arch);
  }

  /** This match's copy of one archetype material, with the §7A.4 broadcast
   *  skin/fabric patch queued on it. Skin wraps further and warmer (that is
   *  what subsurface scattering looks like from ten metres); everything else
   *  barely wraps and keeps its own colour. */
  private matchCopy(src: THREE.Material, meshName: string, kit: KitSpec,
    arch: Archetype): THREE.MeshStandardMaterial {
    const skin = /body|base|head|face/i.test(`${meshName} ${src.name}`);
    // the body wears the socks, so it is per TEAM; everything else (hair,
    // eyes) is the same for everyone in the match
    const key = skin ? `${src.uuid}|${kit.socks}` : src.uuid;
    const hit = this.matClones.get(key);
    if (hit) return hit;
    const copy = (src as THREE.MeshStandardMaterial).clone();
    queueBroadcastSkin(copy, skin
      ? { wrap: 0.42, wrapTint: 0xffbfa0, rim: 0.05, rimPower: 4.0 }
      : { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.075, rimPower: 3.6 });
    if (skin && arch.sockMask) {
      queueSockPatch(copy, arch.sockMask, new THREE.Color(kit.socks));
    }
    this.matClones.set(key, copy);
    this.owned.push(copy);
    return copy;
  }

  // ------------------------------------------------------------- kit textures


  /**
   * The team's shirt, painted once: the authored islands recoloured to the kit,
   * with a contrasting collar band around both neck holes and cuffs at the
   * sleeve lobes. Per player, this canvas is copied and his number and name are
   * printed on the BACK island — rotated 180°, because that island is laid out
   * upside down and mirrored (see SHIRT_UV).
   */
  private shirtBase(kit: KitColors, arch: Archetype): HTMLCanvasElement | null {
    const key = `${arch.url}|${kit.shirt}`;
    const hit = this.kitShirtBase.get(key);
    if (hit) return hit;
    const img = sourceImageOf(arch, isShirt);
    if (!img) return null;

    const N = SHIRT_PX;
    const [c, ctx] = canvas2d(N, N);
    // 0.14 of the authored weave survives: it is what separates "fabric" from
    // "a coloured sticker" at broadcast distance
    recolour(ctx, img, N, N, kit.shirt, 0.14);

    const trim = luminance(kit.shirt) > 0.55 ? shade(kit.shirt, -0.5) : shade(kit.shirt, 0.55);
    // collar: a ring around each neck hole
    for (const [cx, cy] of [SHIRT_UV.backNeck, SHIRT_UV.frontNeck]) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.strokeStyle = trim;
      ctx.lineWidth = N * 0.022;
      ctx.beginPath();
      ctx.arc(cx * N, cy * N, N * 0.075, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // cuffs: the sleeve lobes run off both outer edges of each island
    atopRect(ctx, [0.0, 0.0, 0.028, 1.0], N, N, trim);
    atopRect(ctx, [0.536, 0.0, 0.575, 1.0], N, N, trim);
    // a soft top-to-bottom light ramp so the shirt is not flat
    for (const island of [SHIRT_UV.back, SHIRT_UV.front]) {
      const g = ctx.createLinearGradient(0, island[1] * N, 0, island[3] * N);
      g.addColorStop(0, 'rgba(255,255,255,0.10)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.16)');
      atopRect(ctx, [0, island[1], 1, island[3]], N, N, g);
    }

    this.kitShirtBase.set(key, c);
    return c;
  }

  private shirtMaterial(kit: KitSpec, data: PlayerData, arch: Archetype):
  THREE.MeshStandardMaterial {
    const key = `${arch.url}|${kit.shirt}|${data.num}|${data.name}`;
    const hit = this.shirtMats.get(key);
    if (hit) return hit;

    const base = this.shirtBase(kit, arch);
    const N = SHIRT_PX;
    const [c, ctx] = canvas2d(N, N);
    if (base) ctx.drawImage(base, 0, 0);

    // number + name on the back island. The island is upside down AND mirrored
    // relative to a viewer stood behind the player, which composes to exactly a
    // 180° rotation — so print through one.
    const r = SHIRT_UV.back;
    const cx = (r[0] + r[2]) / 2 * N;
    const cy = (r[1] + r[3]) / 2 * N;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'center';
    ctx.fillStyle = luminance(kit.shirt) > 0.5 ? '#141820' : '#f6f8fc';
    const short = (data.name.split(' ').pop() ?? '').toUpperCase().slice(0, 12);
    ctx.font = `bold ${Math.round(N * 0.035)}px Helvetica, Arial, sans-serif`;
    ctx.fillText(short, 0, -N * 0.055);
    ctx.font = `bold ${Math.round(N * 0.135)}px Helvetica, Arial, sans-serif`;
    ctx.fillText(String(data.num), 0, N * 0.06);
    ctx.restore();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // glTF UVs have their origin at the TOP left, so a canvas painted in the
    // same space must NOT be flipped on upload (this is the difference between
    // a shirt and a shirt turned inside out)
    tex.flipY = false;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.82, metalness: 0, envMapIntensity: 0.45,
      alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
    });
    queueBroadcastSkin(mat, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.075, rimPower: 3.6 });
    this.shirtMats.set(key, mat);
    this.owned.push(mat, tex);
    return mat;
  }

  /**
   * Shorts: the authored garment map flattened to neutral cloth (once per
   * archetype) and MULTIPLIED by the kit colour.
   *
   * Multiply is how cloth takes a colour — it keeps every crease and seam the
   * texture has, for the price of one float3 — but it only works on a map that
   * is roughly white, and the authored shorts have been near-black denim.
   * neutralGarmentMap() divides that out at load, so this stays one material
   * per kit with one colour set on it, and it will keep working when the
   * pipeline swaps the denim for a pale cloth.
   */
  private shortsMaterial(kit: KitSpec, arch: Archetype): THREE.MeshStandardMaterial {
    const key = `${arch.url}|${kit.shorts}`;
    const hit = this.shortsMats.get(key);
    if (hit) return hit;
    const mat = new THREE.MeshStandardMaterial({
      map: arch.shortsMap, color: new THREE.Color(kit.shorts),
      // the authored weave survives the recolour as a normal map even though
      // the colour does not (see Archetype.shortsNormal)
      normalMap: arch.shortsNormal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.84, metalness: 0, envMapIntensity: 0.45,
      alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
    });
    queueBroadcastSkin(mat, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.06, rimPower: 3.6 });
    this.shortsMats.set(key, mat);
    this.owned.push(mat);
    return mat;
  }

  /**
   * Boots and socks share one authored atlas (the trainers are a photo-scan of
   * a blue Nike, which no football team wears). The shoe is knocked back to
   * boot-black and the sock block — a small patch in the bottom-right corner of
   * the atlas, identical on all four archetypes — is painted the kit's sock
   * colour on top.
   */
  private bootMaterial(kit: KitSpec, arch: Archetype): THREE.MeshStandardMaterial {
    const key = `${arch.url}|${kit.socks}`;
    const hit = this.bootMats.get(key);
    if (hit) return hit;
    const img = sourceImageOf(arch, isShoes);
    // the authored shoes06 atlas is 1024²; painting it into a smaller canvas
    // threw away the lace and panel detail that is the only thing making a
    // boot read as a boot in a slide-tackle close-up
    const N = 1024;
    const [c, ctx] = canvas2d(N, N);
    if (img) recolour(ctx, img, N, N, '#191c22', 0.28);
    else { ctx.fillStyle = '#191c22'; ctx.fillRect(0, 0, N, N); }
    atopRect(ctx, SOCK_UV, N, N, kit.socks, 0.9);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    // A moulded synthetic boot is the glossiest thing on a player: it is the
    // only part that takes a hard highlight off the floodlights, and it is what
    // separates "wearing boots" from "feet painted black".
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.34, metalness: 0.04, envMapIntensity: 0.85,
      alphaTest: 0.5, side: THREE.FrontSide,
    });
    queueBroadcastSkin(mat, { wrap: 0.2, wrapTint: 0xf2ece6, rim: 0.08, rimPower: 3.2 });
    this.bootMats.set(key, mat);
    this.owned.push(mat, tex);
    return mat;
  }

  /** Free what the rig minted. The loaded archetypes and clips are page-level
   *  and deliberately survive the match. */
  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned = [];
    this.shadowMat = null;
    this.matClones.clear();
    this.shirtMats.clear();
    this.shortsMats.clear();
    this.bootMats.clear();
    this.kitShirtBase.clear();
  }
}
