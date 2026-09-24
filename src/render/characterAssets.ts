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
import { luminance, shade, TextureLab, type KitColors, type KitLayout } from './TextureLab';
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
const CULL_MESHES = /teeth|tongue/i;

/**
 * Brows and lashes: kept at LOD0, dropped everywhere else.
 *
 * They used to be in CULL_MESHES, which was right when the closest the camera
 * ever got was ten metres and wrong the moment a celebration close-up put a
 * face across a third of the frame. A brow ridge with no brow on it is the
 * single loudest "this is a mannequin" tell there is, and the pair costs 560
 * triangles and two draws — at LOD0 only, which is at most a handful of players
 * in any frame. Past the first detail band they go, as before.
 */
const FINE_MESHES = /eyebrow|eyelash/i;

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

// ------------------------------------------------------------- garment maps
//
// WHY THE KIT IS NO LONGER PAINTED INTO HARD-CODED UV RECTANGLES.
//
// SHIRT_UV above is four numbers measured by hand off one particular garment
// (`crude_male_shirt`). Everything the kit painter could do was therefore
// limited to what those four numbers described, and the moment the pipeline
// swapped that garment for one with an actual collar, every number in it was
// wrong.
//
// So the layout is DERIVED from the mesh instead, once per archetype:
//
//   • every triangle is classified in 3D (torso front, torso back, sleeve,
//     cuff, collar) and rasterised into UV space, so the painter knows what
//     each texel IS rather than where somebody measured it;
//   • each texel also carries where it sits ON THE BODY — across (0 = one
//     flank, 1 = the other) and up (0 = hem, 1 = shoulder) — which is what
//     makes stripes, hoops, a sash and a hem trim one formula instead of five
//     hand-placed rectangles;
//   • the back and front panels each get a least-squares fit from body space to
//     UV space, which is how a number is printed upright and the right way
//     round on ANY garment without anybody working out which way the island was
//     flipped. (The old code had to rotate the back island 180° because that
//     one happened to be laid out upside down and mirrored.)
//
// It costs one software rasterisation of a ~3k-triangle mesh per archetype.

const GARMENT_PX = 1024;

/** smoothstep, for band edges that are a gradient and not a triangle. */
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/** Triangle classes, as stored in the map's blue channel (×51). */
const enum Part { Front = 0, Back = 1, Sleeve = 2, Collar = 3, Cuff = 4 }

/** Body space → UV pixels, as a canvas transform. */
interface TextFrame {
  /** d(uv pixels)/d(body x) and d(uv pixels)/d(body y) */
  m: [number, number, number, number];
  /** uv pixel position of the panel's centroid */
  cx: number;
  cy: number;
  /** half the panel's extent in metres, across the body and up it. Print
   *  positions are fractions of these, so a crest lands on the chest of any
   *  garment instead of wherever a number in this file happened to point. */
  halfW: number;
  halfH: number;
  /** uv pixels per metre along the body's x axis */
  ppm: number;
}

interface GarmentMap {
  n: number;
  /** R = across, G = up, B = part × 51, A = coverage */
  data: Uint8ClampedArray;
  /** body-space x, y in metres per covered texel (2 floats), unquantised */
  body: Float32Array;
  back: TextFrame | null;
  front: TextFrame | null;
  /** body-space extent of the confident front panel: [loX, hiX, loY, hiY] */
  frontBox: [number, number, number, number] | null;
}

/**
 * Rasterise one garment mesh into a map of what-and-where, in its own UV space.
 *
 * Written by hand rather than through the 2D canvas because two channels have
 * to interpolate independently across a triangle and a canvas gradient only
 * does one direction at a time. It is a flat barycentric fill over a few
 * thousand triangles — a couple of milliseconds — and it is exact.
 */
function buildGarmentMap(mesh: THREE.Mesh, classify: (
  cx: number, cy: number, cz: number, nz: number, across: number, up: number,
) => Part): GarmentMap | null {
  const pos = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const index = mesh.geometry.getIndex();
  if (!pos || !uv) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i));
    minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i));
    minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i));
  }
  const spanX = Math.max(1e-4, maxX - minX);
  const spanY = Math.max(1e-4, maxY - minY);
  const midZ = (minZ + maxZ) / 2;
  const halfZ = Math.max(1e-4, (maxZ - minZ) / 2);

  const N = GARMENT_PX;
  const data = new Uint8ClampedArray(N * N * 4);
  const body = new Float32Array(N * N * 2);
  const tri = index ? index.count / 3 : pos.count / 3;

  // least-squares accumulators for the two panel fits: u,v = a·x + b·y + c
  const fit = [0, 1].map(() => ({
    sx: 0, sy: 0, s1: 0, sxx: 0, sxy: 0, syy: 0,
    su: 0, sxu: 0, syu: 0, sv: 0, sxv: 0, syv: 0,
    lox: Infinity, hix: -Infinity, loy: Infinity, hiy: -Infinity,
  }));

  for (let f = 0; f < tri; f++) {
    const ia = index ? index.getX(f * 3) : f * 3;
    const ib = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const ic = index ? index.getX(f * 3 + 2) : f * 3 + 2;
    const px = [pos.getX(ia), pos.getX(ib), pos.getX(ic)];
    const py = [pos.getY(ia), pos.getY(ib), pos.getY(ic)];
    const pz = [pos.getZ(ia), pos.getZ(ib), pos.getZ(ic)];
    const cxw = (px[0] + px[1] + px[2]) / 3;
    const cyw = (py[0] + py[1] + py[2]) / 3;
    const czw = (pz[0] + pz[1] + pz[2]) / 3;
    const e1 = [px[1] - px[0], py[1] - py[0], pz[1] - pz[0]];
    const e2 = [px[2] - px[0], py[2] - py[0], pz[2] - pz[0]];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const across = (cxw - minX) / spanX;
    const up = (cyw - minY) / spanY;
    const part = classify(cxw, cyw, czw - midZ, nz, across, up);

    // Only CONFIDENTLY front-or-back triangles feed the panel fit. The sides of
    // a shirt wrap round at cz ≈ 0 and land in a different UV island from the
    // panel they are nearest; letting them into the least-squares skews the
    // basis, and a skewed basis prints a squad number diagonally across the
    // back at four times the size it should be. (It did.)
    if ((part === Part.Front || part === Part.Back) && Math.abs(czw - midZ) > 0.35 * halfZ) {
      const a = fit[part === Part.Back ? 1 : 0];
      for (const i of [ia, ib, ic]) {
        const x = pos.getX(i), y = pos.getY(i), u = uv.getX(i), v = uv.getY(i);
        a.sx += x; a.sy += y; a.s1 += 1;
        a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
        a.su += u; a.sxu += x * u; a.syu += y * u;
        a.sv += v; a.sxv += x * v; a.syv += y * v;
        a.lox = Math.min(a.lox, x); a.hix = Math.max(a.hix, x);
        a.loy = Math.min(a.loy, y); a.hiy = Math.max(a.hiy, y);
      }
    }

    // barycentric fill in UV pixel space
    const ux = [uv.getX(ia) * N, uv.getX(ib) * N, uv.getX(ic) * N];
    const uy = [uv.getY(ia) * N, uv.getY(ib) * N, uv.getY(ic) * N];
    const ax = [(px[0] - minX) / spanX, (px[1] - minX) / spanX, (px[2] - minX) / spanX];
    const ay = [(py[0] - minY) / spanY, (py[1] - minY) / spanY, (py[2] - minY) / spanY];
    const x0 = Math.max(0, Math.floor(Math.min(ux[0], ux[1], ux[2])) - 1);
    const x1 = Math.min(N - 1, Math.ceil(Math.max(ux[0], ux[1], ux[2])) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(uy[0], uy[1], uy[2])) - 1);
    const y1 = Math.min(N - 1, Math.ceil(Math.max(uy[0], uy[1], uy[2])) + 1);
    const det = (uy[1] - uy[2]) * (ux[0] - ux[2]) + (ux[2] - ux[1]) * (uy[0] - uy[2]);
    if (Math.abs(det) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const sx = x + 0.5, sy = y + 0.5;
        const l0 = ((uy[1] - uy[2]) * (sx - ux[2]) + (ux[2] - ux[1]) * (sy - uy[2])) / det;
        const l1 = ((uy[2] - uy[0]) * (sx - ux[2]) + (ux[0] - ux[2]) * (sy - uy[2])) / det;
        // strictly inside. An earlier version let each triangle paint a
        // one-texel skirt to close the gutter between UV islands, and clamping
        // the barycentrics to do it put out-of-range body coordinates along
        // every shared edge — which a stripe pattern turns into a black spike
        // through the middle of every band. dilate() closes the gutter instead,
        // with texels it knows are copies rather than extrapolations.
        if (l0 < 0 || l1 < 0 || l0 + l1 > 1) continue;
        const l2 = 1 - l0 - l1;
        const o = (y * N + x) * 4;
        if (data[o + 3] > 0) continue;   // first triangle wins, no blending
        data[o] = (ax[0] * l0 + ax[1] * l1 + ax[2] * l2) * 255;
        data[o + 1] = (ay[0] * l0 + ay[1] * l1 + ay[2] * l2) * 255;
        data[o + 2] = part * 51;
        data[o + 3] = 255;
        body[(y * N + x) * 2] = px[0] * l0 + px[1] * l1 + px[2] * l2;
        body[(y * N + x) * 2 + 1] = py[0] * l0 + py[1] * l1 + py[2] * l2;
      }
    }
  }

  const solve = (a: typeof fit[0]): TextFrame | null => {
    if (a.s1 < 12) return null;
    const M = [[a.sxx, a.sxy, a.sx], [a.sxy, a.syy, a.sy], [a.sx, a.sy, a.s1]];
    const det3 = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
      - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
      + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    if (Math.abs(det3) < 1e-12) return null;
    const inv = (r: number, c: number): number => {
      const m = [0, 1, 2].filter((i) => i !== c).map((i) => [0, 1, 2].filter((j) => j !== r)
        .map((j) => M[i][j]));
      const cof = m[0][0] * m[1][1] - m[0][1] * m[1][0];
      return ((r + c) % 2 ? -cof : cof) / det3;
    };
    const rhsU = [a.sxu, a.syu, a.su];
    const rhsV = [a.sxv, a.syv, a.sv];
    const cu = [0, 1, 2].map((r) => rhsU.reduce((s, q, c) => s + inv(r, c) * q, 0));
    const cv = [0, 1, 2].map((r) => rhsV.reduce((s, q, c) => s + inv(r, c) * q, 0));
    const rx = cu[0] * N, ry = cv[0] * N;      // d(uv px)/dx
    const bx = cu[1] * N, by = cv[1] * N;      // d(uv px)/dy
    const cxp = (cu[0] * (a.sx / a.s1) + cu[1] * (a.sy / a.s1) + cu[2]) * N;
    const cyp = (cv[0] * (a.sx / a.s1) + cv[1] * (a.sy / a.s1) + cv[2]) * N;
    return {
      m: [rx, ry, bx, by], cx: cxp, cy: cyp,
      halfW: (a.hix - a.lox) / 2, halfH: (a.hiy - a.loy) / 2,
      ppm: Math.hypot(rx, ry) || 1,
    };
  };
  const fr = fit[0];
  return {
    n: N, data, body, back: solve(fit[1]), front: solve(fit[0]),
    frontBox: fr.s1 >= 12 ? [fr.lox, fr.hix, fr.loy, fr.hiy] : null,
  };
}

/**
 * How a SHIRT's triangles are classified.
 *
 * Every threshold is a fraction of the garment's own bounding box, never a
 * measurement: the shirt is as wide as its sleeves, so the sleeves are the
 * outer fifth of that width and the cuffs the outer tenth, whatever garment the
 * pipeline is dressing these men in this week.
 */
const shirtParts = (cx: number, cy: number, cz: number, nz: number,
  across: number, up: number): Part => {
  if (across < 0.10 || across > 0.90) return Part.Cuff;
  if (across < 0.23 || across > 0.77) return Part.Sleeve;
  // the collar is what sits above the shoulder line AND near the midline: the
  // shoulder seam is just as high and is not a collar
  if (up > 0.86 && Math.abs(across - 0.5) < 0.22) return Part.Collar;
  return cz > 0 ? Part.Front : Part.Back;
};

/** Shorts have no sleeves and no collar; the hem band is decided in the painter
 *  off `up`, which keeps its edge smooth instead of on a triangle. */
const shortsParts = (cx: number, cy: number, cz: number, nz: number,
  across: number, up: number): Part => (cz > 0 ? Part.Front : Part.Back);

/** Build the map for whichever mesh the predicate picks out, at LOD0. */
function garmentOf(arch: Archetype, pick: (m: THREE.Mesh) => boolean,
  classify: Parameters<typeof buildGarmentMap>[1]): GarmentMap | null {
  let mesh: THREE.Mesh | null = null;
  arch.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!mesh && m.isMesh && pick(m)) mesh = m;
  });
  return mesh ? buildGarmentMap(mesh, classify) : null;
}

/** Two or three letters for a fictional club crest, from the kit's own seed. */
function crestInitials(seed: number): string {
  const A = 'ABCDEFGHIJKLMNOPRSTUVW';
  const r = seededRandom(seed ^ 0x9e37);
  return A[(r() * A.length) | 0] + A[(r() * A.length) | 0] + (r() < 0.4 ? A[(r() * A.length) | 0] : '');
}

/**
 * Fill the gutter. Texels just outside an island have no colour, and a mip
 * chain averages them into the island's edge — which is a dark fringe around
 * every seam of the shirt. Four passes of nearest-neighbour spread is plenty at
 * this resolution.
 */
function dilate(img: ImageData, passes: number): void {
  const { width: w, height: h, data } = img;
  for (let p = 0; p < passes; p++) {
    const copy = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (copy[o + 3] > 0) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = (ny * w + nx) * 4;
          if (copy[q + 3] === 0) continue;
          data[o] = copy[q]; data[o + 1] = copy[q + 1];
          data[o + 2] = copy[q + 2]; data[o + 3] = 255;
          break;
        }
      }
    }
  }
}

/**
 * Print onto a garment's FRONT in body space. `draw` gets a scratch canvas whose
 * pixels are body metres × `ppm` (x right = body +x, y down = body −y) and a
 * mapper from body metres to those pixels; the result is resampled, bilinear
 * and premultiplied, onto every covered front texel of `ctx` through the map's
 * body coordinates. `ppm` is 1.5× the garment's own texel density on the front,
 * so the resample neither aliases nor wastes a big canvas.
 */
function printFront(ctx: CanvasRenderingContext2D, map: GarmentMap,
  draw: (p: CanvasRenderingContext2D, at: (x: number, y: number) => [number, number],
    ppm: number) => void): void {
  const [lx, hx, ly, hy] = map.frontBox!;
  const N = map.n, d = map.data, b = map.body;
  let texels = 0;
  for (let i = 0; i < N * N; i++) {
    if (d[i * 4 + 3] && Math.round(d[i * 4 + 2] / 51) === Part.Front
      && b[i * 2] >= lx && b[i * 2] <= hx && b[i * 2 + 1] >= ly && b[i * 2 + 1] <= hy) texels++;
  }
  const ppm = 1.5 * Math.sqrt(texels / Math.max(1e-4, (hx - lx) * (hy - ly)));
  if (!(ppm > 1)) return;
  const pad = 0.02, x0 = lx - pad, y1 = hy + pad;
  const W = Math.ceil((hx - lx + 2 * pad) * ppm), H = Math.ceil((hy - ly + 2 * pad) * ppm);
  const [, pc] = canvas2d(W, H);
  draw(pc, (x, y) => [(x - x0) * ppm, (y1 - y) * ppm], ppm);
  const src = pc.getImageData(0, 0, W, H).data;
  const img = ctx.getImageData(0, 0, N, N);
  const out = img.data;
  for (let i = 0; i < N * N; i++) {
    const o = i * 4;
    if (d[o + 3] === 0 || Math.round(d[o + 2] / 51) !== Part.Front) continue;
    const fx = (b[i * 2] - x0) * ppm - 0.5, fy = (y1 - b[i * 2 + 1]) * ppm - 0.5;
    if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) continue;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    let r = 0, g = 0, bl = 0, a = 0;
    for (let k = 0; k < 4; k++) {
      const dx = k & 1, dy = k >> 1;
      const wt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
      const q = ((iy + dy) * W + ix + dx) * 4;
      const qa = (src[q + 3] / 255) * wt;
      r += src[q] * qa; g += src[q + 1] * qa; bl += src[q + 2] * qa; a += qa;
    }
    if (a < 0.002) continue;
    out[o] = out[o] * (1 - a) + r;
    out[o + 1] = out[o + 1] * (1 - a) + g;
    out[o + 2] = out[o + 2] * (1 - a) + bl;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Point the canvas at one panel of a garment, so everything printed after it is
 * in PIXELS on a body that is the right way up and the right way round.
 *
 * `mirror` is the back of the shirt: a viewer stood behind the player reads
 * left-to-right along the body's -x, which is the whole reason the old code had
 * to rotate the back island 180° by hand.
 *
 * The basis is scaled to unit length along the reading direction rather than
 * left in metres, and the callers multiply their sizes by `ppm` instead. That
 * is not a stylistic choice: a canvas font of "0.25px" is a sub-pixel size, and
 * what comes out of it is a smear.
 */
function panelFrame(ctx: CanvasRenderingContext2D, f: TextFrame, mirror: boolean): void {
  const s = (mirror ? -1 : 1) / f.ppm;
  // down the body is -y, always: the mirror only flips the reading direction
  ctx.setTransform(f.m[0] * s, f.m[1] * s, -f.m[2] / f.ppm, -f.m[3] / f.ppm, f.cx, f.cy);
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

// ------------------------------------------------------------- the face pool
//
// TWENTY-TWO FACES WITHOUT TWENTY-TWO CHARACTERS.
//
// Two players built from the same archetype differ only above the collar: same
// skeleton, same body, same kit, same 2048 skin atlas. Shipping a whole GLB per
// player to express that would be ~2.9 MB each — 64 MB for a match — to change
// a few thousand vertex positions.
//
// So the pipeline ships the positions and nothing else (make_player.py, "the
// face pool"): one array of head-region base positions per archetype, plus N
// arrays of int16 offsets from it. Each offset field is pre-multiplied by the
// Head bone's skin weight ramped smoothly to zero through the jaw, so it dies
// out before the neck and CANNOT crack the collar open however extreme the
// face targets behind it were.
//
// At load, each archetype matches pool vertex → buffer vertex ONCE, by
// position. Position is the right key because the glTF exporter splits a vertex
// in two at a UV seam: both copies carry the same position, so both pick up the
// same offset and the seam cannot open. At instance time a player's geometry is
// the archetype's with its own position and normal arrays — every other
// attribute, and the index, stay shared.
//
// What this buys, measured on the shipped roster: 4.1 MB of pool for 48 faces
// (12 per archetype), against ~64 MB for the GLB-per-player version, and not
// one extra draw call, skeleton, material or texture.

interface FaceSection {
  mesh: string;
  count: number;
  /** byte offset of this section's base positions (Float32, count × 3) */
  base: number;
  /** byte offset of this section's offsets (Int16, variants × count × 3) */
  delta: number;
}

interface FacePoolFile {
  name: string;
  variants: number;
  /** metres per int16 unit */
  scale: number;
  baseBytes: number;
  /** LOD0 mesh names of the hair pool, in pick order */
  hair: string[];
  sections: FaceSection[];
}

/** One mesh's re-index of the pool onto the geometry that actually loaded. */
interface FaceMap {
  sec: FaceSection;
  /** buffer vertex → pool vertex, -1 where the pool does not reach */
  map: Int32Array;
  /** buffer vertex → the lowest buffer vertex sharing its position */
  weld: Int32Array;
  /** triangles touching at least one mapped vertex */
  tris: Uint32Array;
  /** the mapped vertices, so a morph never walks the whole mesh */
  moved: Uint32Array;
  /** authored normal − normal re-derived from the unmoved mesh, so a zero
   *  offset reproduces the authored shading exactly */
  bias: Float32Array;
  /** the jaw/neck band the deltas are relaxed over (see relaxBand) */
  band: FaceBand | null;
  src: THREE.BufferGeometry;
}

/**
 * The pool's mask fades a face into the neck by the Head bone's SKIN WEIGHT,
 * and MPFB's weights step sharply under the jaw: a head-square or chin target
 * moved the jaw at full strength and the skin a centimetre below it not at all,
 * so every seeded face folded over its own neck in a hard crease. The band is
 * the welded vertices within BAND_RINGS edge-rings of the unmoved neck, with
 * CSR adjacency, so a morph can relax its offsets there into a gentle ramp
 * without a rebake, and without touching the eyes, nose or mouth further up.
 */
interface FaceBand {
  /** welded representative vertices in the band */
  verts: Uint32Array;
  /** relaxation strength per band vertex, 1 at the neck fading to 0 */
  weight: Float32Array;
  /** CSR adjacency over welded representatives (unmoved neighbours included) */
  nStart: Uint32Array;
  nIdx: Uint32Array;
}
const BAND_RINGS = 10;
const BAND_ITERS = 24;

export interface FacePool {
  file: FacePoolFile;
  base: Float32Array;
  delta: Int16Array;
}

/** Quantised position key. 1e-5 m is a hundredth of a millimetre: fine enough
 *  that two distinct vertices never collide, coarse enough that a float32
 *  round-trip through the exporter cannot miss. */
/** A mesh name as three's GLTFLoader will have rewritten it. */
const saneName = (s: string): string => s.replace(/\s/g, '_').replace(/[[\].:/]/g, '');

const posKey = (x: number, y: number, z: number): string =>
  `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;

/** FNV-1a. The per-player seed: his name, his number and his kit, so the same
 *  man in the same shirt is the same man every kick-off. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and the same everywhere, which is the only thing
 *  that matters: a man's face has to survive a reload and a replay. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything about a player that is HIS and not his archetype's. */
export interface Appearance {
  /** index into the archetype's face pool */
  variant: number;
  /** the LOD0 mesh name of the haircut he keeps */
  hair: string;
  /** multiplied onto the archetype's baked hair colour, never replacing it —
   *  the archetype already decided what is plausible for this man */
  hairColor: THREE.Color;
  skinTone: THREE.Color;
  /** 0 = shaved this morning, 1 = did not */
  stubble: number;
  stubbleColor: THREE.Color;
}

/**
 * One player's look, from his name, his number and his kit.
 *
 * Deterministic on purpose and in that order: the same man in the same shirt is
 * the same man in every match, every replay and every capture, and two men with
 * the same name in different squads are not twins.
 */
export function appearanceOf(data: PlayerData, kit: KitSpec, arch: Archetype): Appearance {
  const rnd = seededRandom(hashSeed(`${data.name}|${data.num}|${kit.shirt}|${kit.shorts}`));
  const variants = arch.faces?.file.variants ?? 1;
  const variant = Math.min(variants - 1, Math.floor(rnd() * variants));
  const hair = arch.hairNames.length
    ? arch.hairNames[Math.min(arch.hairNames.length - 1, Math.floor(rnd() * arch.hairNames.length))]
    : '';
  // hair colour: a multiply around 1, so a blond archetype stays blond and a
  // black-haired one cannot go ginger. Wide enough to separate two men side by
  // side, narrow enough that nobody's hair reads as dyed.
  // The archetype colour is now the hair's real albedo (the shader takes only
  // the map's clumping, not its brightness), so the multiply sits a little
  // UNDER 1: the specs were chosen against a black map, and at face value the
  // blond reads platinum.
  const hk = 0.62 + rnd() * 0.4;
  const hairColor = new THREE.Color(hk * (0.94 + rnd() * 0.14), hk, hk * (0.9 + rnd() * 0.12));
  // skin tone: a tenth of a stop either side of the archetype's atlas, with a
  // little warmth. Any wider and it stops reading as "this man" and starts
  // reading as "the wrong skin texture".
  const sk = 0.90 + rnd() * 0.16;
  const skinTone = new THREE.Color(sk * (1.0 + rnd() * 0.04), sk, sk * (0.95 + rnd() * 0.07));
  const stubble = rnd() < 0.42 ? 0 : 0.3 + rnd() * 0.65;
  const shade = 0.55 + rnd() * 0.5;
  const stubbleColor = new THREE.Color(0x2a2119).multiplyScalar(shade);
  return { variant, hair, hairColor, skinTone, stubble, stubbleColor };
}

async function loadFacePool(base: string): Promise<FacePool | null> {
  try {
    const [jr, br] = await Promise.all([fetch(`${base}_faces.json`), fetch(`${base}_faces.bin`)]);
    if (!jr.ok || !br.ok) return null;
    const file = (await jr.json()) as FacePoolFile;
    const buf = await br.arrayBuffer();
    return {
      file,
      base: new Float32Array(buf, 0, file.baseBytes / 4),
      delta: new Int16Array(buf, file.baseBytes, (buf.byteLength - file.baseBytes) / 2),
    };
  } catch {
    return null;
  }
}

/**
 * Re-index one pool section onto the loaded geometry, and pre-compute
 * everything a per-player morph needs so the morph itself is a gather and an
 * add.
 *
 * The normal bias is the subtle part. Re-deriving normals from face normals
 * does NOT reproduce three's authored smooth normals exactly (the exporter's
 * are area/angle weighted differently and the mesh is welded by position, not
 * by index). Storing `authored − rederived` here and adding it back after every
 * morph means a vertex whose offset happens to be zero comes out bit-identical
 * to the archetype, so the ramp into the neck is invisible instead of being a
 * faint shading step.
 */
function buildFaceMap(mesh: THREE.Mesh, pool: FacePool, sec: FaceSection): FaceMap | null {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const index = geo.getIndex();
  if (!pos || !nor || !index) return null;

  const byPos = new Map<string, number>();
  const b0 = sec.base / 4;
  for (let i = 0; i < sec.count; i++) {
    byPos.set(posKey(pool.base[b0 + i * 3], pool.base[b0 + i * 3 + 1], pool.base[b0 + i * 3 + 2]), i);
  }

  const n = pos.count;
  const map = new Int32Array(n).fill(-1);
  const weld = new Int32Array(n);
  const first = new Map<string, number>();
  const moved: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = posKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    const w = first.get(k);
    if (w === undefined) first.set(k, i);
    weld[i] = w ?? i;
    const p = byPos.get(k);
    if (p !== undefined) { map[i] = p; moved.push(i); }
  }
  if (!moved.length) return null;

  const isMoved = new Uint8Array(n);
  for (const i of moved) isMoved[i] = 1;
  const tris: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    if (isMoved[index.getX(t)] || isMoved[index.getX(t + 1)] || isMoved[index.getX(t + 2)]) {
      tris.push(t);
    }
  }

  const fm: FaceMap = {
    sec, map, weld,
    tris: Uint32Array.from(tris),
    moved: Uint32Array.from(moved),
    bias: new Float32Array(moved.length * 3),
    band: null,
    src: geo,
  };
  fm.band = buildFaceBand(fm);
  // rederive normals from the UNMOVED mesh and keep the difference
  const rederived = new Float32Array(n * 3);
  accumulateNormals(fm, pos.array as Float32Array, rederived);
  for (let k = 0; k < moved.length; k++) {
    const i = moved[k];
    fm.bias[k * 3] = nor.getX(i) - rederived[i * 3];
    fm.bias[k * 3 + 1] = nor.getY(i) - rederived[i * 3 + 1];
    fm.bias[k * 3 + 2] = nor.getZ(i) - rederived[i * 3 + 2];
  }
  return fm;
}

/** Ring distance from the unmoved mesh over welded vertices; see FaceBand. */
function buildFaceBand(fm: FaceMap): FaceBand | null {
  const index = fm.src.getIndex()!;
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    let s = adj.get(a);
    if (!s) { s = new Set(); adj.set(a, s); }
    s.add(b);
  };
  for (const t of fm.tris) {
    const v = [fm.weld[index.getX(t)], fm.weld[index.getX(t + 1)], fm.weld[index.getX(t + 2)]];
    for (let e = 0; e < 3; e++) { link(v[e], v[(e + 1) % 3]); link(v[(e + 1) % 3], v[e]); }
  }
  // a welded vertex counts as moved if any of its duplicates is
  const movedRep = new Set<number>();
  for (const i of fm.moved) movedRep.add(fm.weld[i]);
  const ring = new Map<number, number>();
  let frontier: number[] = [];
  for (const r of movedRep) {
    for (const nb of adj.get(r) ?? []) {
      if (!movedRep.has(nb)) { ring.set(r, 0); frontier.push(r); break; }
    }
  }
  if (!frontier.length) return null;          // eyes, brows: nothing to ramp into
  for (let d = 1; d < BAND_RINGS * 2 && frontier.length; d++) {
    const next: number[] = [];
    for (const r of frontier) {
      for (const nb of adj.get(r) ?? []) {
        if (movedRep.has(nb) && !ring.has(nb)) { ring.set(nb, d); next.push(nb); }
      }
    }
    frontier = next;
  }
  const verts = [...ring.keys()];
  const weight = new Float32Array(verts.length);
  const nStart = new Uint32Array(verts.length + 1);
  const nIdx: number[] = [];
  verts.forEach((r, k) => {
    const d = ring.get(r)!;
    // full strength through BAND_RINGS, then fading out over as many again
    weight[k] = d <= BAND_RINGS ? 1 : 1 - (d - BAND_RINGS) / BAND_RINGS;
    for (const nb of adj.get(r) ?? []) nIdx.push(nb);
    nStart[k + 1] = nIdx.length;
  });
  return { verts: Uint32Array.from(verts), weight, nStart, nIdx: Uint32Array.from(nIdx) };
}

/**
 * Relax one morph's offsets over the jaw/neck band: Jacobi-smoothed toward the
 * neighbour mean, with the unmoved neck pinned at zero, so the step the skin
 * weights left becomes a ramp several rings wide. `off` is indexed by welded
 * representative (buffer vertex), xyz.
 */
function relaxBand(band: FaceBand, off: Float32Array): void {
  const n = band.verts.length;
  const next = new Float32Array(n * 3);
  for (let it = 0; it < BAND_ITERS; it++) {
    for (let k = 0; k < n; k++) {
      const a = band.nStart[k], b = band.nStart[k + 1];
      let x = 0, y = 0, z = 0;
      for (let j = a; j < b; j++) {
        const o = band.nIdx[j] * 3;
        x += off[o]; y += off[o + 1]; z += off[o + 2];
      }
      const inv = 1 / Math.max(1, b - a);
      const w = band.weight[k] * 0.8;
      const o = band.verts[k] * 3;
      next[k * 3] = off[o] + (x * inv - off[o]) * w;
      next[k * 3 + 1] = off[o + 1] + (y * inv - off[o + 1]) * w;
      next[k * 3 + 2] = off[o + 2] + (z * inv - off[o + 2]) * w;
    }
    for (let k = 0; k < n; k++) {
      const o = band.verts[k] * 3;
      off[o] = next[k * 3]; off[o + 1] = next[k * 3 + 1]; off[o + 2] = next[k * 3 + 2];
    }
  }
}

/** Area-weighted face normals accumulated over the affected triangles and
 *  welded by position, then normalised into `out` at every moved vertex. */
function accumulateNormals(fm: FaceMap, positions: Float32Array, out: Float32Array): void {
  const index = fm.src.getIndex()!;
  const acc = new Map<number, [number, number, number]>();
  const get = (i: number): [number, number, number] => {
    const r = fm.weld[i];
    let v = acc.get(r);
    if (!v) { v = [0, 0, 0]; acc.set(r, v); }
    return v;
  };
  for (const t of fm.tris) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const i of [a, b, c]) {
      const v = get(i);
      v[0] += nx; v[1] += ny; v[2] += nz;
    }
  }
  for (const i of fm.moved) {
    const v = acc.get(fm.weld[i]);
    if (!v) continue;
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    out[i * 3] = v[0] / len;
    out[i * 3 + 1] = v[1] / len;
    out[i * 3 + 2] = v[2] / len;
  }
}

/**
 * One player's copy of one mesh: his own positions and normals, everybody
 * else's UVs, skin weights and index buffer.
 *
 * The attribute sharing is the point. A face is ~4k of a ~10.7k-vertex body, so
 * a full geometry clone would be 840 KB a player (18 MB a match) to change a
 * quarter of one attribute. Two arrays is 260 KB.
 */
function morphGeometry(fm: FaceMap, pool: FacePool, variant: number): THREE.BufferGeometry {
  const src = fm.src;
  const srcPos = src.getAttribute('position') as THREE.BufferAttribute;
  const srcNor = src.getAttribute('normal') as THREE.BufferAttribute;
  const pos = new Float32Array(srcPos.array as Float32Array);
  const nor = new Float32Array(srcNor.array as Float32Array);

  const d0 = fm.sec.delta / 2 + variant * fm.sec.count * 3;
  const s = pool.file.scale;
  // offsets gathered per welded representative (unmoved stay zero), relaxed
  // over the jaw/neck band, then scattered back to every duplicate
  const off = new Float32Array(pos.length);
  for (const i of fm.moved) {
    const p = fm.map[i] * 3, r = fm.weld[i] * 3;
    off[r] = pool.delta[d0 + p] * s;
    off[r + 1] = pool.delta[d0 + p + 1] * s;
    off[r + 2] = pool.delta[d0 + p + 2] * s;
  }
  if (fm.band && !NO_RELAX_DEBUG) relaxBand(fm.band, off);
  for (const i of fm.moved) {
    const r = fm.weld[i] * 3;
    pos[i * 3] += off[r];
    pos[i * 3 + 1] += off[r + 1];
    pos[i * 3 + 2] += off[r + 2];
  }
  accumulateNormals(fm, pos, nor);
  for (let k = 0; k < fm.moved.length; k++) {
    const i = fm.moved[k];
    const x = nor[i * 3] + fm.bias[k * 3];
    const y = nor[i * 3 + 1] + fm.bias[k * 3 + 1];
    const z = nor[i * 3 + 2] + fm.bias[k * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    nor[i * 3] = x / len; nor[i * 3 + 1] = y / len; nor[i * 3 + 2] = z / len;
  }

  const g = new THREE.BufferGeometry();
  for (const key of Object.keys(src.attributes)) {
    if (key !== 'position' && key !== 'normal') g.setAttribute(key, src.attributes[key]);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const idx = src.getIndex();
  if (idx) g.setIndex(idx);
  for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.setDrawRange(src.drawRange.start, src.drawRange.count);
  // a skinned mesh's bind-pose bounds never cover a posed limb anyway; the
  // meshes are frustumCulled = false, so this only has to be non-null
  g.boundingSphere = src.boundingSphere?.clone() ?? null;
  g.boundingBox = src.boundingBox?.clone() ?? null;
  return g;
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
  /** the per-player face offsets, or null if this archetype shipped without a
   *  pool (in which case every player of it wears the authored face) */
  faces: FacePool | null;
  /** LOD0 mesh name → its re-index of the pool, built once at load */
  faceMaps: Map<string, FaceMap>;
  /** the hair pool's LOD0 mesh names, in pick order. A player keeps one and
   *  the rest are dropped from his clone — see instance(). */
  hairNames: string[];
  /** R = lower-face coverage, G = height up the jaw. One per archetype, mixed
   *  into the body material's shader as per-player stubble (see queueSkinShading). */
  faceMask: THREE.CanvasTexture | null;
  /** what-and-where in the shirt's own UV space, so the kit bake needs no
   *  hand-measured island rectangles (see buildGarmentMap) */
  shirtGarment: GarmentMap | null;
  shortsGarment: GarmentMap | null;
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
    // the face pools ride alongside, in parallel: two small files per archetype
    // and a miss is not fatal (the archetype simply wears its authored face)
    const pools = await Promise.all(ARCHETYPES.map((base) => loadFacePool(base)));

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
      .map((levels, i) => prepareArchetype(ARCHETYPES[i], levels.map((l) => l?.scene ?? null),
        pools[i]))
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
function prepareArchetype(url: string, scenes: (THREE.Group | null)[],
  pool: FacePool | null): Archetype | null {
  if (!scenes[0]) return null;
  const levels: ArchetypeLevel[] = [];
  let li = -1;
  for (const scene of scenes) {
    if (!scene) continue;
    li++;
    const drop: THREE.Object3D[] = [];
    let triangles = 0;
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (CULL_MESHES.test(mesh.name)) { drop.push(mesh); return; }
      // brows and lashes survive only at the level a face is actually read on
      if (li > 0 && FINE_MESHES.test(mesh.name)) { drop.push(mesh); return; }
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
    faces: pool, faceMaps: new Map(), hairNames: [], faceMask: null,
    shirtGarment: null, shortsGarment: null,
  };

  // Re-index the pool onto the geometry that actually loaded, once.
  if (pool) {
    // Names go through saneName() on both sides. three's GLTFLoader runs every
    // node name through PropertyBinding.sanitizeNodeName, which STRIPS the dot —
    // so Blender's `v_afr_mid.short02` arrives as `v_afr_midshort02` and a
    // literal lookup finds the body (no dot in it) and nothing else. Same trap
    // the bone lookup at the top of this file exists to work around.
    const byName = new Map<string, THREE.Mesh>();
    levels[0].scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) byName.set(saneName(m.name), m);
    });
    let mapped = 0;
    for (const sec of pool.file.sections) {
      const key = saneName(sec.mesh);
      const mesh = byName.get(key);
      if (!mesh) { console.warn(`characters: face pool has no mesh ${sec.mesh}`); continue; }
      const fm = buildFaceMap(mesh, pool, sec);
      if (fm) { arch.faceMaps.set(key, fm); mapped += fm.moved.length; }
    }
    arch.hairNames = pool.file.hair.map(saneName).filter((h) => byName.has(h));
    // A player wears ONE cut; the other three are dropped from his clone the
    // moment it is made. Take them off the budget line too, or the LOD0 figure
    // reports a man wearing four wigs at once.
    let spare = 0;
    for (const h of arch.hairNames.slice(1)) {
      const g = byName.get(h)?.geometry;
      if (!g) continue;
      const i = g.getIndex();
      spare += (i ? i.count : g.getAttribute('position').count) / 3;
    }
    levels[0].triangles = Math.round(levels[0].triangles - spare);
    arch.triangles = levels[0].triangles;
    console.info(`characters: ${url} face pool ${pool.file.variants} variants,`
      + ` ${arch.faceMaps.size}/${pool.file.sections.length} meshes, ${mapped} vertices,`
      + ` ${arch.hairNames.length} haircuts`);
  }
  const shadow = buildShadowGeometry(levels[levels.length - 1].scene);
  arch.shadowGeometry = shadow;
  if (shadow) {
    const idx = shadow.getIndex();
    arch.shadowTriangles = Math.round(
      (idx ? idx.count : shadow.getAttribute('position').count) / 3);
  }
  arch.sockMask = buildSockMask(arch);
  arch.faceMask = buildFaceMask(arch);
  arch.shirtGarment = garmentOf(arch, isShirt, shirtParts);
  arch.shortsGarment = garmentOf(arch, isShorts, shortsParts);
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
  isBody(m) || isShirt(m) || isShorts(m) || isShoes(m) || (!HAIR_NO_SHADOW && isHairPart(m));
const isHairPart = (m: THREE.Mesh): boolean => /hair|afro|short0/i.test(nameOf(m));
/** `?hairshadow=0`: leave the hair out of the shadow proxy altogether (A/B). */
const HAIR_NO_SHADOW = typeof location !== 'undefined' && /[?&]hairshadow=0/.test(location.search);
/**
 * How far the proxy's hair is sunk into the skull, metres.
 *
 * The proxy is built from the LOWEST level, which wears cut ZERO decimated to
 * 15% — not the cut the player has on, and not the same surface even when it
 * is. Left where it was authored it enclosed the real hair (an afro01 proxy
 * over a short02 player, or just a decimated shell bulging out through the
 * cap), and the hair spent every frame in its own shadow: no key light, no
 * highlight, a dark helmet whatever the shading did. Sunk two centimetres it
 * sits under any cut in the pool and still gives an afro its volume on the
 * grass; a short cut's proxy lands inside the skull and costs nothing.
 */
const HAIR_SHADOW_SINK = 0.02;

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
    if (isHairPart(part)) {
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      if (nor) {
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(i, pos.getX(i) - nor.getX(i) * HAIR_SHADOW_SINK,
            pos.getY(i) - nor.getY(i) * HAIR_SHADOW_SINK, pos.getZ(i) - nor.getZ(i) * HAIR_SHADOW_SINK);
        }
      }
    }
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

/** `?kitmerge=0`: draw shirt and shorts separately, as before (A/B). */
const KIT_UNMERGED = typeof location !== 'undefined' && /[?&]kitmerge=0/.test(location.search);

/**
 * Shirt + shorts as one indexed geometry with a per-vertex `ss26Garment`
 * (0 = shirt, 1 = shorts) — see CharacterRig.mergeKit(). Only the attributes
 * both parts carry survive; null if that leaves them unmergeable.
 */
function mergeKitGeometry(shirt: THREE.BufferGeometry, shorts: THREE.BufferGeometry):
THREE.BufferGeometry | null {
  if (!shirt.getIndex() || !shorts.getIndex()) return null;
  if (Object.keys(shirt.morphAttributes).length || Object.keys(shorts.morphAttributes).length) return null;
  const parts = [shirt.clone(), shorts.clone()];
  const common = Object.keys(parts[0].attributes).filter((n) => parts[1].getAttribute(n));
  parts.forEach((g, i) => {
    for (const n of Object.keys(g.attributes)) if (!common.includes(n)) g.deleteAttribute(n);
    const count = g.getAttribute('position').count;
    g.setAttribute('ss26Garment', new THREE.BufferAttribute(new Float32Array(count).fill(i), 1));
    g.clearGroups();
  });
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (merged) merged.name = `${shirt.name || 'shirt'}+${shorts.name || 'shorts'}`;
  return merged;
}

/** The merged kit's one shader difference from a plain shirt: where
 *  `ss26Garment` says shorts, the diffuse comes from the team's shorts. */
function queueKitShorts(mat: THREE.MeshStandardMaterial, shortsTex: THREE.Texture): void {
  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26ShortsMap = { value: shortsTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float ss26Garment;
        varying float vSS26Garment;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vSS26Garment = ss26Garment;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D ss26ShortsMap;
        varying float vSS26Garment;`)
      // both taps every pixel: the choice is constant across a triangle but a
      // branch around texture2D would take the mip derivatives with it
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace(
        'vec4 sampledDiffuseColor = texture2D( map, vMapUv );',
        `vec4 sampledDiffuseColor = mix( texture2D( map, vMapUv ),
          texture2D( ss26ShortsMap, vMapUv ), step( 0.5, vSS26Garment ) );`));
  });
}

/** `?hairclear=0`: leave the hair where the face morph put it (A/B). */
const HAIR_NO_CLEAR = typeof location !== 'undefined' && /[?&]hairclear=0/.test(location.search);
/** How far outside the scalp every hair vertex must sit, metres. The body is
 *  ~1.5cm between head vertices, so a vertex's tangent plane under-reads a
 *  convex skull between them by a couple of millimetres; this covers that. */
const HAIR_CLEARANCE = 0.005;

/**
 * Push a haircut back out of the skull it is sitting on.
 *
 * The face pool reshapes the head per player (twelve variants of head shape
 * a body), and it carries deltas for the hair too — but the hair's were
 * fitted to the cap, not to the skull underneath, and on a rounder or taller
 * variant the crown rises straight through a short cut's cap. What you see
 * is skin where the hair should be: a bald spot, differently placed per head.
 *
 * So once both are morphed, every hair vertex is checked against the nearest
 * scalp vertex and, if it is inside the skull or within HAIR_CLEARANCE of it,
 * moved out along that vertex's normal. Hair that already clears the scalp
 * (the long tail of a cut, anything off the head) is untouched. A spatial
 * hash over the head vertices keeps it to a few ms a squad.
 */
function clearHairOfSkull(body: THREE.BufferGeometry, hair: THREE.BufferGeometry): void {
  const bp = body.getAttribute('position') as THREE.BufferAttribute;
  const bn = body.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const hp = hair.getAttribute('position') as THREE.BufferAttribute;
  if (!bn) return;
  hair.computeBoundingBox();
  const box = hair.boundingBox!.clone().expandByScalar(0.03);
  const CELL = 0.02;
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string =>
    `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  const v = new THREE.Vector3();
  for (let i = 0; i < bp.count; i++) {
    v.fromBufferAttribute(bp, i);
    if (!box.containsPoint(v)) continue;
    const k = key(v.x, v.y, v.z);
    const list = cells.get(k);
    if (list) list.push(i); else cells.set(k, [i]);
  }
  if (!cells.size) return;
  let moved = 0;
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let best = -1, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const j of list) {
        const d = (bp.getX(j) - x) ** 2 + (bp.getY(j) - y) ** 2 + (bp.getZ(j) - z) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    if (best < 0) continue;
    const nx = bn.getX(best), ny = bn.getY(best), nz = bn.getZ(best);
    const out = (x - bp.getX(best)) * nx + (y - bp.getY(best)) * ny + (z - bp.getZ(best)) * nz;
    if (out >= HAIR_CLEARANCE) continue;
    const push = HAIR_CLEARANCE - out;
    hp.setXYZ(i, x + nx * push, y + ny * push, z + nz * push);
    moved++;
  }
  if (moved) {
    hp.needsUpdate = true;
    hair.computeBoundingSphere();
  }
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

// ------------------------------------------------------------ face detail
//
// Three things separate a head that reads as a footballer from one that reads
// as a mannequin at three metres, and none of them is triangles:
//
//   1. PORES. The authored skin atlas is a photograph of a face at 2048 across
//      a whole body — about 180 texels down a cheek. That is enough for colour
//      and nothing else, so under a hard floodlight the cheek is a perfectly
//      smooth surface and reads as wax. A tiling micro-normal at a scale far
//      below the atlas's puts the surface back without touching the colour.
//   2. STUBBLE. Every one of these men shaved this morning or did not. It is
//      the single cheapest piece of individuality a face can carry, and it is
//      a mask and one uniform, not a texture per player.
//   3. SCATTER. Skin is not Lambert. The red channel goes furthest through it,
//      which is why the shadow terminator on a cheekbone is warm and soft and
//      not a grey line. queueSkinShading() below wraps the three channels by
//      three different amounts, which is the cheap honest version of that.

/** How far up the jaw stubble reaches, as a fraction of head-bone to crown. */
const BEARD_TOP = 0.46;
const FACE_MASK_PX = 512;

/**
 * Paint the lower face as a MASK in the body texture's own UV space, the same
 * way buildSockMask paints the shin: classify vertices off the MESH (the atlas
 * cannot tell you which texels are jaw), rasterise their triangles into UV
 * space, and let the shader decide the edge.
 *
 * Red is coverage, green is height up the jaw (0 under the chin, 1 at the
 * crown). The character faces +z in these files — Blender's -y through the
 * exporter's y-up swizzle — so the front half is simply z above the head
 * bone's, which keeps the back of the skull out of it.
 */
function buildFaceMask(arch: Archetype): THREE.CanvasTexture | null {
  let body: THREE.SkinnedMesh | null = null;
  arch.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!body && m.isSkinnedMesh && isBody(m)) body = m;
  });
  if (!body) return null;
  const mesh: THREE.SkinnedMesh = body;
  const pos = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const joints = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const index = mesh.geometry.getIndex();
  if (!uv || !joints || !weights) return null;

  arch.scene.updateMatrixWorld(true);
  const headBone = findBone(arch.scene, 'mixamorig:Head');
  if (!headBone) return null;
  const headIdx = mesh.skeleton.bones.indexOf(headBone as THREE.Bone);
  if (headIdx < 0) return null;
  const origin = headBone.getWorldPosition(new THREE.Vector3());

  const p = new THREE.Vector3();
  const cover = new Uint8Array(pos.count);
  const height = new Float32Array(pos.count);
  let crown = origin.y;
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (joints.getComponent(i, k) === headIdx) w = Math.max(w, weights.getComponent(i, k));
    }
    if (w < 0.5) continue;
    p.fromBufferAttribute(pos, i);
    crown = Math.max(crown, p.y);
  }
  const span = Math.max(1e-4, crown - origin.y);
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (joints.getComponent(i, k) === headIdx) w = Math.max(w, weights.getComponent(i, k));
    }
    p.fromBufferAttribute(pos, i);
    // height runs for EVERY vertex the triangle rasteriser can reach, for the
    // same reason the sock mask does: a triangle straddling the edge with one
    // corner at height zero ramps backwards and paints a detached band
    height[i] = THREE.MathUtils.clamp((p.y - origin.y) / span, 0, 1.6);
    if (w < 0.35) continue;
    // front half only, and never above the brow line
    if (p.z < origin.z - 0.005) continue;
    if (height[i] > BEARD_TOP + 0.1) continue;
    cover[i] = 1;
  }

  const N = FACE_MASK_PX;
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
    const style = heightGradient(ctx,
      uv.getX(a) * N, uv.getY(a) * N, height[a] / (BEARD_TOP + 0.1),
      uv.getX(b) * N, uv.getY(b) * N, height[b] / (BEARD_TOP + 0.1),
      uv.getX(d) * N, uv.getY(d) * N, height[d] / (BEARD_TOP + 0.1));
    ctx.fillStyle = style;
    ctx.strokeStyle = style;
    ctx.beginPath();
    ctx.moveTo(uv.getX(a) * N, uv.getY(a) * N);
    ctx.lineTo(uv.getX(b) * N, uv.getY(b) * N);
    ctx.lineTo(uv.getX(d) * N, uv.getY(d) * N);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (!painted) return null;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

/**
 * A tiling micro-normal: skin pores, baked once and shared by every player.
 *
 * Value noise at two octaves, differentiated into a tangent-space normal. It is
 * deliberately tiny (256²) and tiled about twenty times across the body atlas,
 * which puts the bumps at roughly a millimetre — below what the diffuse map can
 * resolve, which is the whole point: it adds surface, never colour, and it
 * cannot fight the photographed skin it sits on.
 */
const NO_RELAX_DEBUG = typeof location !== 'undefined' && /[?&]norelax=1/.test(location.search);
const NO_FACES_DEBUG = typeof location !== 'undefined' && /[?&]nofaces=1/.test(location.search);
/** Texels of the pore tile per octave-1 cell (256 / period 32). */
const PORE_PERIOD = 32;
/** Target size of one pore cell on the body, metres; the face lands here at 1x. */
const PORE_CELL_M = 0.0015;
let poreTexture: THREE.DataTexture | null = null;
function poreNormal(): THREE.Texture {
  if (poreTexture) return poreTexture;
  const N = 256;
  const h = new Float32Array(N * N);
  const hash = (x: number, y: number): number => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // two periodic value-noise octaves, so the tile joins seamlessly
  for (const [period, amp] of [[32, 0.65], [96, 0.35]] as const) {
    const cell = N / period;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x / cell, fy = y / cell;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const m = (a: number, b: number) => ((a % period) + period) % period;
        const v00 = hash(m(ix, period), m(iy, period));
        const v10 = hash(m(ix + 1, period), m(iy, period));
        const v01 = hash(m(ix, period), m(iy + 1, period));
        const v11 = hash(m(ix + 1, period), m(iy + 1, period));
        h[y * N + x] += amp * ((v00 * (1 - sx) + v10 * sx) * (1 - sy)
          + (v01 * (1 - sx) + v11 * sx) * sy);
      }
    }
  }
  const data = new Uint8Array(N * N * 4);
  const STRENGTH = 2.6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const l = h[y * N + ((x + N - 1) % N)];
      const r = h[y * N + ((x + 1) % N)];
      const u = h[((y + N - 1) % N) * N + x];
      const d = h[((y + 1) % N) * N + x];
      const nx = (l - r) * STRENGTH;
      const ny = (u - d) * STRENGTH;
      const len = Math.hypot(nx, ny, 1);
      const o = (y * N + x) * 4;
      data[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(22, 22);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  poreTexture = tex;
  return tex;
}

// -------------------------------------------------- the skin/hair lighting

/** three's direct-diffuse line, matched by shape rather than by literal text
 *  so a release that renames the struct member fails visibly, not silently. */
const DIRECT_DIFFUSE =
  /reflectedLight\.directDiffuse\s*\+=\s*irradiance\s*\*\s*BRDF_Lambert\(\s*material\.(\w+)\s*\);/;

/** Per-channel wrapped diffuse: the cheap pre-integrated skin. */
const SKIN_PARS = ((): string | null => {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const m = chunk.match(DIRECT_DIFFUSE);
  if (!m) {
    console.warn('characters: skin-scatter anchor not found; skin stays stock-lit');
    return null;
  }
  return chunk.replace(DIRECT_DIFFUSE, /* glsl */ `
    {
      float ss26NL = dot( geometryNormal, directLight.direction );
      // THREE wraps, not one. Red light travels furthest through skin before it
      // comes back out, green less, blue least — so the terminator on a cheek
      // goes warm and soft before it goes dark, which is the only part of
      // subsurface scattering the eye actually reads at broadcast distance.
      vec3 ss26W = saturate( ( vec3( ss26NL ) + ss26SkinWrap ) / ( vec3( 1.0 ) + ss26SkinWrap ) );
      vec3 ss26Lam = vec3( saturate( ss26NL ) );
      vec3 ss26Irr = directLight.color * ( ss26Lam + ( ss26W - ss26Lam ) * ss26SkinTint );
      reflectedLight.directDiffuse += ss26Irr * BRDF_Lambert( material.${m[1]} );
    }
  `);
})();

// ------------------------------------------------------------------ hair
//
// WHAT THE HAIR ACTUALLY IS. Every cut in the MPFB library that suits a
// footballer is a SCALP CAP: one shell hugging the skull, painted with a strand
// photo, with a soft alpha fringe at the hairline and — on a couple of them — a
// handful of tuft cards. Not strand geometry, not layered cards. And the bake
// multiplied that (already near-black) photo by a near-black hair colour, so the
// albedo that reached the screen was ~0.001: every strand the painter drew was
// multiplied out and what was left was a solid dark helmet with a 512-texel
// alpha-test contour for a hairline.
//
// So the hair is rebuilt at the shader, where it costs nothing to download:
//
//  • ALBEDO is the baked colour times the map's LUMINANCE NORMALISED BY ITS OWN
//    MEAN (hairMapMean). The photo's clumping survives, the colour is the
//    spec's, and a blond archetype comes out blond instead of dark brown.
//  • A STRAND FIELD in skull space: the bind-pose position is turned into
//    (azimuth, polar angle) about a crown pole, and anisotropic value noise is
//    laid along the meridians — thin across, long along — so every strand runs
//    from the crown down to the hairline the way a short cut lies. It lives on
//    the mesh (bind pose, morphed face included), so it cannot crawl as the man
//    moves, and it is filtered by its own screen derivative: past a couple of
//    pixels per strand it fades to its mean, so a tele-cam head is a clean
//    shape and never noise.
//  • Two KAJIYA-KAY lobes along that same flow (Scheuermann): an untinted
//    primary shifted toward the tip and a broader secondary tinted by the hair,
//    both jittered per strand so the highlight breaks into strands instead of
//    sitting on the skull as one plastic band. The old single lobe was tinted
//    by the albedo — i.e. multiplied by ~0.03 on dark hair, i.e. never seen.
//  • The HAIRLINE: the alpha contour is pushed in and out by the fine strands,
//    so the edge is broken into strands rather than cut along the map's
//    blurred 512-texel outline. An opaque alpha-test pass draws everything
//    above 0.5; at LOD0 a second, BLENDED pass (SS26_HAIR_FRINGE) draws only
//    what the first discarded, so the wisps fade out instead of stepping. No
//    TAA and no MSAA at DPR 2 means hashed alpha would crawl; this cannot.

/** Kajiya-Kay along the strand: the band of light that runs across a head of
 *  hair instead of the round plastic highlight a Blinn lobe puts there. */
const HAIR_PARS = ((): string | null => {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const m = chunk.match(DIRECT_DIFFUSE);
  if (!m) return null;
  const GGX = /reflectedLight\.directSpecular\s*\+=\s*irradiance\s*\*\s*BRDF_GGX_Multiscatter\(/;
  // The round GGX lobe is what makes a skull cap read as a helmet; hair keeps a
  // little of it (the cap is a surface too) and gets its shine from the strands.
  const body = GGX.test(chunk)
    ? chunk.replace(GGX, 'reflectedLight.directSpecular += ss26HairGgx * irradiance * BRDF_GGX_Multiscatter(')
    : chunk;
  return /* glsl */ `
    uniform vec2 ss26HairSpec;
    uniform vec2 ss26HairExp;
    uniform vec2 ss26HairShift;
    uniform float ss26HairGgx;
    // set in main() before the lights run (see HAIR_STRANDS)
    vec3 ss26HairT;
    vec3 ss26HairIrr = vec3( 0.0 );
    float ss26HairFine;
    float ss26HairClump;
    float ss26HairFar;
  ` + body.replace(DIRECT_DIFFUSE, /* glsl */ `
    reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.${m[1]} );
    {
      vec3 ss26T = ss26HairT - geometryNormal * dot( geometryNormal, ss26HairT );
      ss26T = normalize( ss26T + vec3( 1e-5 ) );
      float ss26J = ( ss26HairFine - 0.5 ) * 0.22 + ( ss26HairClump - 0.5 ) * 0.18;
      vec3 ss26T1 = normalize( ss26T + geometryNormal * ( ss26HairShift.x + ss26J ) );
      vec3 ss26T2 = normalize( ss26T + geometryNormal * ( ss26HairShift.y + ss26J ) );
      vec3 ss26H = normalize( directLight.direction + geometryViewDir );
      float ss26D1 = dot( ss26T1, ss26H );
      float ss26D2 = dot( ss26T2, ss26H );
      // Specular AA: once the head is too small for its clumps to resolve,
      // a tight lobe lands facet by facet on the decimated LODs and sparkles
      // as he turns — so it widens (and dims) into a soft sheen instead.
      vec2 ss26E = mix( ss26HairExp, vec2( 10.0, 6.0 ), ss26HairFar );
      float ss26S1 = pow( sqrt( max( 0.0, 1.0 - ss26D1 * ss26D1 ) ), ss26E.x );
      float ss26S2 = pow( sqrt( max( 0.0, 1.0 - ss26D2 * ss26D2 ) ), ss26E.y );
      ss26S1 *= mix( 1.0, 0.3, ss26HairFar );
      ss26S2 *= mix( 1.0, 0.5, ss26HairFar );
      ss26HairIrr += directLight.color * saturate( dot( geometryNormal, directLight.direction ) );
      // a strand lit from behind the skull still has its far side in shadow
      float ss26Vis = smoothstep( -0.1, 0.4, dot( geometryNormal, directLight.direction ) );
      vec3 ss26Alb = material.${m[1]};
      float ss26AlbL = max( dot( ss26Alb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
      // secondary lobe: the light that went INTO the fibre and came back out,
      // so it wears the hair's hue — and a dark fibre gives less of it back
      vec3 ss26Tint = mix( vec3( 1.0 ), ss26Alb / max( max( ss26Alb.r, max( ss26Alb.g, ss26Alb.b ) ), 1e-4 ), 0.85 );
      float ss26Back = clamp( sqrt( ss26AlbL ) * 2.2, 0.35, 1.0 );
      float ss26Spark = mix( 0.35, 1.65, ss26HairFine ) * mix( 0.7, 1.3, ss26HairClump );
      // the surface reflection is white in a textbook; on a head of light hair
      // with nothing else lighting it, white reads as silver — so a little of
      // the hue, and a little less of it the lighter the hair
      vec3 ss26P = mix( vec3( 1.0, 0.97, 0.94 ), ss26Tint, 0.3 )
        * mix( 1.0, 0.6, saturate( ss26AlbL * 3.0 ) );
      // Light from BEHIND the head: what comes over the crown then is light
      // that went through the fibres (hair-coloured), not a white reflection —
      // and a crown seen edge-on turns even a narrow white lobe into a grey
      // skullcap. Hand the primary over to the tinted lobe as the key goes round.
      float ss26Front = saturate( dot( directLight.direction, geometryViewDir ) * 0.6 + 0.6 );
      ss26P *= mix( 0.25, 1.0, ss26Front );
      reflectedLight.directSpecular += directLight.color * ss26Vis * ss26Spark * (
        ss26HairSpec.x * ss26S1 * ss26P
        + ss26HairSpec.y * ss26S2 * ss26Tint * ss26Back );
    }
  `);
})();

/** Vertex side of the strand field: the bind-pose offset from the skull centre
 *  (for the noise) and the flow direction, skinned and in view space (for the
 *  highlight). */
const HAIR_VERT_PARS = /* glsl */ `
  #ifdef SS26_HAIR_FRINGE
    varying float vSs26Shell;
    #ifdef SS26_HAIR_SHELLS
      attribute float ss26Shell;
      uniform float ss26ShellH;
    #endif
  #endif
  uniform vec3 ss26HairC;
  uniform vec3 ss26HairAxis;
  varying vec3 vSs26HairP;
  varying vec3 vSs26HairT;
`;
const HAIR_VERT = /* glsl */ `
  {
    vec3 ss26R = normalize( position - ss26HairC );
    // down the meridian, away from the crown pole
    vec3 ss26Tb = -( ss26HairAxis - ss26R * dot( ss26HairAxis, ss26R ) );
    ss26Tb = normalize( ss26Tb + vec3( 0.0, -1e-4, 0.0 ) );
    #ifdef USE_SKINNING
      ss26Tb = ( skinMatrix * vec4( ss26Tb, 0.0 ) ).xyz;
    #endif
    vSs26HairT = normalize( ( modelViewMatrix * vec4( ss26Tb, 0.0 ) ).xyz );
    vSs26HairP = position - ss26HairC;
  }
`;

/** Fragment side: the strand field itself, the albedo and the hairline. Runs
 *  right after map_fragment, before the alpha test. */
const HAIR_FRAG_PARS = /* glsl */ `
  #ifdef SS26_HAIR_FRINGE
    varying float vSs26Shell;
  #endif
  uniform vec3 ss26HairAxis;
  uniform vec3 ss26HairE1;
  uniform vec3 ss26HairE2;
  uniform float ss26HairMean;
  varying vec3 vSs26HairP;
  varying vec3 vSs26HairT;
  float ss26Hash( vec2 p ) {
    p = fract( p * vec2( 0.1031, 0.1030 ) );
    p += dot( p, p.yx + 33.33 );
    return fract( ( p.x + p.y ) * p.x );
  }
  // one strand column: a value that drifts slowly along its length
  float ss26Col( float i, float v ) {
    float vv = v + ss26Hash( vec2( i, 3.7 ) ) * 11.0;
    float j = floor( vv );
    float g = fract( vv );
    g = g * g * ( 3.0 - 2.0 * g );
    return mix( ss26Hash( vec2( i, j ) ), ss26Hash( vec2( i, j + 1.0 ) ), g );
  }
  // columns side by side, periodic in u so the azimuth seam is invisible
  float ss26Strands( float u, float v, float period ) {
    float i = floor( u );
    float f = fract( u );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( ss26Col( mod( i, period ), v ), ss26Col( mod( i + 1.0, period ), v ), f );
  }
`;
const HAIR_STRANDS = /* glsl */ `
  {
    vec3 ss26R = normalize( vSs26HairP );
    float ss26Up = dot( ss26R, ss26HairAxis );
    vec2 ss26Q = vec2( dot( ss26R, ss26HairE1 ), dot( ss26R, ss26HairE2 ) );
    float ss26QL = max( length( ss26Q ), 1e-3 );
    // azimuth in turns [0,1) and polar angle in half-turns [0,1]
    float ss26Phi = atan( ss26Q.y, ss26Q.x ) * 0.15915494 + 0.5;
    float ss26Th = acos( clamp( ss26Up, -1.0, 1.0 ) ) * 0.31830989;
    // derivative of the azimuth taken off the (seam-free) direction, in turns
    float ss26DPhi = ( abs( dFdx( ss26Q.x ) ) + abs( dFdy( ss26Q.x ) )
      + abs( dFdx( ss26Q.y ) ) + abs( dFdy( ss26Q.y ) ) ) / ss26QL * 0.15915494;
    float ss26DTh = fwidth( ss26Th );
    // a gentle comb wave, so the strands are not ruled lines
    float ss26W = sin( ss26Th * 41.0 + ss26Phi * 37.699 ) * 0.35;
    const float FINE = 300.0;
    const float CLUMP = 64.0;
    float ss26F = ss26Strands( ss26Phi * FINE + ss26W, ss26Th * 16.0, FINE );
    float ss26C = ss26Strands( ss26Phi * CLUMP + ss26W * 0.3, ss26Th * 6.0, CLUMP );
    // cells per pixel: past ~0.5 the fine layer aliases, past ~0.6 the clumps do
    float ss26FineK = 1.0 - smoothstep( 0.3, 0.65, max( ss26DPhi * FINE, ss26DTh * 16.0 ) );
    float ss26ClumpK = 1.0 - smoothstep( 0.3, 0.7, max( ss26DPhi * CLUMP, ss26DTh * 6.0 ) );
    ss26HairFine = mix( 0.5, ss26F, ss26FineK );
    ss26HairClump = mix( 0.5, ss26C, ss26ClumpK );
    ss26HairFar = 1.0 - ss26ClumpK;
    ss26HairT = vSs26HairT;

    #ifdef USE_MAP
      // albedo: the map's own brightness, normalised by its mean, so the
      // painter's clumps survive and the COLOUR is the spec's
      float ss26L = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      float ss26Ratio = ss26HairMean > 0.0
        ? clamp( mix( 1.0, ss26L / ss26HairMean, 0.45 ), 0.55, 1.3 ) : 1.0;
      // part-transparent texels bled the map's white background in: trust them less
      ss26Ratio = mix( 1.0, ss26Ratio, smoothstep( 0.4, 0.9, sampledDiffuseColor.a ) );
      diffuseColor.rgb = diffuse * ss26Ratio;
    #endif
    diffuseColor.rgb *= mix( 0.62, 1.38, ss26HairFine ) * mix( 0.8, 1.2, ss26HairClump );

    // the hairline: push the alpha contour in and out along the strands
    float ss26Break = ( smoothstep( 0.25, 0.75, ss26F ) - 0.5 ) * ss26FineK
      + ( ss26C - 0.5 ) * 0.5 * ss26ClumpK;
    float ss26A = diffuseColor.a + ss26Break * 0.55 * ( 1.0 - smoothstep( 0.75, 1.0, diffuseColor.a ) );
    #ifdef SS26_HAIR_FRINGE
      if ( vSs26Shell < 0.5 ) {
        // layer 0: only what the opaque pass threw away, faded, not stepped
        if ( ss26A >= 0.5 ) discard;
        diffuseColor.a = smoothstep( 0.06, 0.5, ss26A );
      }
      #ifdef SS26_HAIR_SHELLS
      else {
        // the shells: strand ends standing proud of the cap. Fewer of them
        // the further out, only where the cap itself is solid hair, and the
        // outer ones catch more light than the roots.
        float ss26Lv = vSs26Shell / SS26_HAIR_SHELLS;
        float ss26S = ss26F * 0.65 + ss26C * 0.35;
        float ss26Cut = 0.42 + 0.3 * ss26Lv;
        float ss26M = smoothstep( ss26Cut, ss26Cut + 0.12, ss26S );
        // past the strands' resolution the mask becomes its own average: a
        // soft halo, which is the right thing for an edge to become
        ss26M = mix( 0.5 - 0.3 * ss26Lv, ss26M, ss26FineK );
        diffuseColor.a = ss26M * smoothstep( 0.55, 0.95, sampledDiffuseColor.a ) * ( 1.0 - 0.35 * ss26Lv );
        diffuseColor.rgb *= 0.85 + 0.3 * ss26Lv;
      }
      #endif
      if ( diffuseColor.a < 0.01 ) discard;
    #else
      diffuseColor.a = ss26A;
    #endif
  }
`;

/** A haircut mesh, by mesh + material name (every cut the specs use). */
const HAIR_MESH = /hair|afro|short0|braid|cornrow|micky|messy/i;
/** `?hairdebug=1|2|3`: albedo / strand field / direct specular only. */
const HAIR_DEBUG = typeof location !== 'undefined'
  ? Number((/[?&]hairdebug=(\d)/.exec(location.search) ?? [])[1] ?? 0) : 0;
/** `?hairshade=0`: stock cutout hair — no strand shading, no fringe, no
 *  shells. The A/B baseline for the bench. */
const HAIR_PLAIN = typeof location !== 'undefined' && /[?&]hairshade=0/.test(location.search);
/** `?hairfringe=0`: no blended hairline pass (A/B and bench). */
const HAIR_NO_FRINGE = typeof location !== 'undefined' && /[?&]hairfringe=0/.test(location.search);

/** Per-archetype strand frame, in the meshes' own (bind-pose, y-up, face +z)
 *  space: the skull centre and the crown pole the strands flow away from. */
interface HairFrame {
  center: THREE.Vector3;
  axis: THREE.Vector3;
  e1: THREE.Vector3;
  e2: THREE.Vector3;
}

const HAIR_FRAMES = new WeakMap<object, HairFrame>();

/** Find the skull in the body mesh: its top, and the midline depth a little
 *  below it. Every cut in an archetype shares the skull, so one frame serves
 *  the whole pool. */
function hairFrameOf(arch: Archetype): HairFrame {
  const hit = HAIR_FRAMES.get(arch);
  if (hit) return hit;
  let body: THREE.Mesh | null = null;
  arch.levels[0].scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!body && m.isMesh && isBody(m)) body = m;
  });
  const center = new THREE.Vector3(0, 1.6, 0.05);
  const pos = (body as THREE.Mesh | null)?.geometry.getAttribute('position');
  if (pos) {
    let top = -Infinity;
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
    let zmin = Infinity; let zmax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = top - pos.getY(i);
      if (y < 0.07 || y > 0.12 || Math.abs(pos.getX(i)) > 0.025) continue;
      zmin = Math.min(zmin, pos.getZ(i));
      zmax = Math.max(zmax, pos.getZ(i));
    }
    if (Number.isFinite(top) && zmax > zmin) center.set(0, top - 0.1, (zmin + zmax) / 2);
  }
  // The whorl sits a little behind the top of the head. Not far: the flow
  // lines decide where the highlight band lands (where they cross the half
  // vector), and a pole tipped well back bends them down over the forehead,
  // which parks the band on the hairline as a pale halo.
  const axis = new THREE.Vector3(0, 1, -0.12).normalize();
  const e1 = new THREE.Vector3(1, 0, 0);
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize();
  const f = { center, axis, e1, e2 };
  HAIR_FRAMES.set(arch, f);
  return f;
}

const HAIR_MEANS = new WeakMap<THREE.Texture, number>();

/** Mean linear luminance of a hair map over its opaque texels — the number the
 *  shader divides by so the photo supplies clumping and not colour. Read once
 *  per map off a 64² thumbnail. 0 = unknown (the shader then leaves the map's
 *  brightness out of the albedo). */
function hairMapMean(tex: THREE.Texture | null): number {
  if (!tex) return 0;
  const hit = HAIR_MEANS.get(tex);
  if (hit !== undefined) return hit;
  let mean = 0;
  try {
    const img = tex.image as CanvasImageSource | undefined;
    if (img && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (g) {
        g.drawImage(img, 0, 0, 64, 64);
        const d = g.getImageData(0, 0, 64, 64).data;
        const lin = (v: number): number => Math.pow(v / 255, 2.2);
        let s = 0; let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          s += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
          n++;
        }
        mean = n > 32 ? s / n : 0;
      }
    }
  } catch {
    mean = 0;
  }
  HAIR_MEANS.set(tex, mean);
  return mean;
}

const SKIN_UNIFORMS = /* glsl */ `
  uniform vec3 ss26SkinWrap;
  uniform vec3 ss26SkinTint;
  uniform float ss26SkinRim;
`;

const SKIN_RIM = /* glsl */ `
  {
    float ss26F = pow( 1.0 - saturate( dot( normal, geometryViewDir ) ), 4.0 );
    float ss26Lit = saturate( dot( totalDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) * 1.8 );
    outgoingLight += vec3( 1.0, 0.78, 0.66 ) * ( ss26F * ss26SkinRim * ( 0.25 + 0.75 * ss26Lit ) );
  }
`;

export interface SkinShadingOptions {
  /** the archetype's sock mask and this team's sock colour */
  sockMask?: THREE.Texture | null;
  sockColor?: THREE.Color;
  /** the archetype's lower-face mask and this player's stubble */
  faceMask?: THREE.Texture | null;
  stubble?: number;
  stubbleColor?: THREE.Color;
}

/**
 * Everything the body material does that stock MeshStandardMaterial does not:
 * per-channel scatter, a warm rim, the team's socks and this player's stubble.
 *
 * It is ONE patch rather than four because they all want the same two
 * insertion points, and because a body material is cloned per player now (the
 * skin tone is his) — one shader variant is one program.
 */
function queueSkinShading(mat: THREE.MeshStandardMaterial, o: SkinShadingOptions): void {
  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26SkinWrap = { value: new THREE.Vector3(0.62, 0.34, 0.22) };
    shader.uniforms.ss26SkinTint = { value: new THREE.Vector3(1.0, 0.62, 0.42) };
    shader.uniforms.ss26SkinRim = { value: 0.05 };

    let frag = shader.fragmentShader.replace('#include <common>',
      `#include <common>\n${SKIN_UNIFORMS}`);
    if (SKIN_PARS) frag = frag.replace('#include <lights_physical_pars_fragment>', SKIN_PARS);
    frag = frag.replace('#include <opaque_fragment>', `${SKIN_RIM}\n  #include <opaque_fragment>`);
    // The pore tile repeats at one rate across the whole atlas, but the atlas
    // spends ~3x the texels per metre on the face that it does on a forearm, so
    // a millimetre pore on the cheek became a 3 mm scale on the arm and every
    // arm read as lizard skin. Measure metres per normal-map UV from the screen
    // derivatives and step the tile frequency up (1x, 2x, 4x, blended) until one
    // pore cell is back near PORE_CELL_M wherever it lands.
    shader.uniforms.ss26PoreCell = { value: PORE_CELL_M };
    frag = frag.replace('#include <common>', '#include <common>\nuniform float ss26PoreCell;')
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', `
        float ss26Dp = length( fwidth( vViewPosition ) );
        float ss26Duv = max( length( fwidth( vNormalMapUv ) ), 1e-7 );
        float ss26Cell = ( ss26Dp / ss26Duv ) / ${PORE_PERIOD.toFixed(1)};
        float ss26K = clamp( log2( max( ss26Cell / ss26PoreCell, 1.0 ) ), 0.0, 2.0 );
        float ss26F0 = exp2( floor( ss26K ) );
        vec3 mapN = mix( texture2D( normalMap, vNormalMapUv * ss26F0 ).xyz,
          texture2D( normalMap, vNormalMapUv * ss26F0 * 2.0 ).xyz, fract( ss26K ) ) * 2.0 - 1.0;`));

    if (o.sockMask && o.sockColor) {
      shader.uniforms.ss26SockMask = { value: o.sockMask };
      shader.uniforms.ss26SockColor = { value: o.sockColor };
      shader.uniforms.ss26SockTop = { value: SOCK_TOP };
      frag = frag.replace('#include <common>', `#include <common>
        uniform sampler2D ss26SockMask;
        uniform vec3 ss26SockColor;
        uniform float ss26SockTop;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec4 ss26Sock = texture2D( ss26SockMask, vMapUv );
          // Height is read as g/r, not g: the rasteriser antialiases the edge
          // of the shin island and fades BOTH channels toward the background
          // together, so raw g dips at the rim and drew a hairline of sock
          // across the knee. The ratio divides the coverage back out.
          float ss26H = ( ss26Sock.g / max( ss26Sock.r, 0.004 ) )
            / max( ss26SockTop, 0.001 );
          float ss26Cov = smoothstep( 0.35, 0.65, ss26Sock.r )
            * ( 1.0 - smoothstep( 0.985, 1.02, ss26H ) );
          if ( ss26Cov > 0.001 ) {
            vec3 ss26C = ss26SockColor * ( 0.86 + 0.18 * ss26H );
            float ss26Band = smoothstep( 0.80, 0.84, ss26H ) * ( 1.0 - smoothstep( 0.93, 0.97, ss26H ) );
            ss26C = mix( ss26C, ss26C * 1.22 + 0.04, ss26Band );
            diffuseColor.rgb = mix( diffuseColor.rgb, ss26C, ss26Cov );
          }
        }`);
    }

    // The block goes in whenever the archetype HAS a mask, even at strength
    // zero: three keys its program cache on onBeforeCompile.toString(), which
    // is identical for every material here, so two materials that generate
    // different source would share one compiled program. Same source, different
    // uniform, no collision.
    if (o.faceMask) {
      shader.uniforms.ss26FaceMask = { value: o.faceMask };
      shader.uniforms.ss26Stubble = { value: o.stubble ?? 0 };
      shader.uniforms.ss26StubbleColor = { value: o.stubbleColor ?? new THREE.Color(0x2a2119) };
      frag = frag.replace('#include <common>', `#include <common>
        uniform sampler2D ss26FaceMask;
        uniform float ss26Stubble;
        uniform vec3 ss26StubbleColor;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec4 ss26Face = texture2D( ss26FaceMask, vMapUv );
          float ss26FH = ss26Face.g / max( ss26Face.r, 0.004 );
          // dense along the jaw, thinning as it climbs the cheek — a beard
          // shadow that stops in a straight line is a chinstrap
          float ss26D = smoothstep( 0.02, 0.10, ss26FH ) * ( 1.0 - smoothstep( 0.55, 0.92, ss26FH ) );
          float ss26Amt = smoothstep( 0.35, 0.65, ss26Face.r ) * ss26D * ss26Stubble;
          diffuseColor.rgb = mix( diffuseColor.rgb,
            diffuseColor.rgb * 0.45 + ss26StubbleColor * 0.25, ss26Amt );
        }`)
        // stubble is matte: it is the reason a chin stops catching the key
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          vec4 ss26FaceR = texture2D( ss26FaceMask, vMapUv );
          float ss26FHR = ss26FaceR.g / max( ss26FaceR.r, 0.004 );
          float ss26DR = smoothstep( 0.02, 0.10, ss26FHR ) * ( 1.0 - smoothstep( 0.55, 0.92, ss26FHR ) );
          roughnessFactor = min( 1.0, roughnessFactor
            + 0.22 * smoothstep( 0.35, 0.65, ss26FaceR.r ) * ss26DR * ss26Stubble );
        }`);
    }
    shader.fragmentShader = frag;
  });
}

/** Hair response. Spec/Exp/Shift are (primary, secondary) Kajiya-Kay lobes;
 *  shifts are along the normal, negative = toward the root. */
const HAIR_TUNE = {
  spec: new THREE.Vector2(0.05, 0.035),
  exp: new THREE.Vector2(130, 24),
  /** Coily cuts (afros): a fibre that turns every millimetre has no one
   *  direction to reflect along, so a weak, broad lobe and no sharp band. */
  coilSpec: new THREE.Vector2(0.018, 0.02),
  coilExp: new THREE.Vector2(24, 10),
  shift: new THREE.Vector2(-0.06, 0.12),
  ggx: 0.1,
  /**
   * Blended strand shells over the cap at LOD0, and their spacing (m). OFF.
   * They work, and over skin they read — but a head's silhouette is where
   * they were meant to earn their keep, and there they are drawn over the
   * background without writing depth, so the depth-of-field pass files every
   * strand end under "far" and blurs it away with the crowd. Writing depth
   * instead leaves the crowd behind them unblurred: a sharp halo round the
   * head. Neither is worth three more copies of the hair's vertices.
   */
  shells: 0,
  shellStep: 0.0025,
};

/**
 * The cap, repeated: layer 0 is the cap itself (the blended hairline), layers
 * 1..n the same vertices tagged `ss26Shell` = n, which the fringe shader pushes
 * out along the normal. One geometry, so the whole soft edge of a player's hair
 * — hairline, silhouette fuzz, strand ends — is ONE extra draw. Layers go out
 * in index order, inner to outer, which is the right order to blend them in.
 */
function hairShellGeometry(src: THREE.BufferGeometry, layers: number): THREE.BufferGeometry {
  const n = src.getAttribute('position').count;
  const out = new THREE.BufferGeometry();
  const copies = layers + 1;
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute;
    if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return src;
    const Ctor = a.array.constructor as new (len: number) => THREE.TypedArray;
    const arr = new Ctor(a.array.length * copies);
    for (let l = 0; l < copies; l++) arr.set(a.array as ArrayLike<number>, l * a.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  const shell = new Float32Array(n * copies);
  for (let l = 0; l < copies; l++) shell.fill(l, l * n, (l + 1) * n);
  out.setAttribute('ss26Shell', new THREE.BufferAttribute(shell, 1));
  const idx = src.getIndex();
  const count = idx ? idx.count : n;
  const index = n * copies > 65535 ? new Uint32Array(count * copies) : new Uint16Array(count * copies);
  for (let l = 0; l < copies; l++) {
    for (let i = 0; i < count; i++) index[l * count + i] = (idx ? idx.getX(i) : i) + l * n;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.boundingSphere = src.boundingSphere?.clone() ?? null;
  out.boundingBox = src.boundingBox?.clone() ?? null;
  return out;
}

/** The hair look, queued on one hair material: strand field, albedo, hairline
 *  and the two-lobe sheen. See the block comment above HAIR_PARS. */
function queueHairShading(mat: THREE.MeshStandardMaterial, frame: HairFrame, mean: number,
  coily: boolean): void {
  if (!HAIR_PARS) return;
  const pars = HAIR_PARS;
  queueShaderPatch(mat, (shader) => {
    shader.uniforms.ss26HairSpec = { value: coily ? HAIR_TUNE.coilSpec : HAIR_TUNE.spec };
    shader.uniforms.ss26HairExp = { value: coily ? HAIR_TUNE.coilExp : HAIR_TUNE.exp };
    shader.uniforms.ss26HairShift = { value: HAIR_TUNE.shift };
    shader.uniforms.ss26HairGgx = { value: HAIR_TUNE.ggx };
    shader.uniforms.ss26HairC = { value: frame.center };
    shader.uniforms.ss26HairAxis = { value: frame.axis };
    shader.uniforms.ss26HairE1 = { value: frame.e1 };
    shader.uniforms.ss26HairE2 = { value: frame.e2 };
    shader.uniforms.ss26HairMean = { value: mean };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HAIR_VERT_PARS}`)
      .replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>\n${HAIR_VERT}`)
      // shells: pushed out along the BIND-pose normal, before skinning
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef SS26_HAIR_FRINGE
          #ifdef SS26_HAIR_SHELLS
            transformed += normal * ( ss26Shell * ss26ShellH );
            vSs26Shell = ss26Shell;
          #else
            vSs26Shell = 0.0;
          #endif
        #endif`);
    shader.uniforms.ss26ShellH = { value: HAIR_TUNE.shellStep };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HAIR_FRAG_PARS}`)
      .replace('#include <lights_physical_pars_fragment>', pars)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${HAIR_STRANDS}`)
      // the environment's round reflection is the helmet all over again:
      // keep a streaky third of it
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        #if defined( RE_IndirectSpecular )
          radiance *= 0.35 * mix( 0.4, 1.6, ss26HairFine );
        #endif`);
    if (HAIR_DEBUG) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        #if SS26_HAIR_DEBUG == 1
          outgoingLight = diffuseColor.rgb * 4.0;
        #elif SS26_HAIR_DEBUG == 2
          outgoingLight = vec3( ss26HairFine, ss26HairClump, 0.0 );
        #elif SS26_HAIR_DEBUG == 4
          outgoingLight = ss26HairIrr * 0.1;
        #else
          outgoingLight = reflectedLight.directSpecular;
        #endif
        #include <opaque_fragment>`);
    }
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
  /** the team's painted shorts, shared by the shorts material and the
   *  merged kit (see mergeKit) */
  private shortsTexs = new Map<string, THREE.CanvasTexture | null>();
  /** shirt+shorts geometry per archetype detail level, keyed on the pair */
  private kitGeos = new Map<string, THREE.BufferGeometry | null>();
  private bootMats = new Map<string, THREE.MeshStandardMaterial>();
  private owned: (THREE.Material | THREE.Texture | THREE.BufferGeometry)[] = [];
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
      // spread the BODIES deterministically across the squad rather than by
      // name hash: a hash gives one team four identical builds often enough
      // to be noticed. The FACE is hashed (see look below) — there are twelve
      // per archetype, so a collision inside one squad is a different head on
      // a different body, not a twin.
      this.nextArchetype++ % this.assets.archetypes.length
    ];
    const look = appearanceOf(data, kit, arch);
    const root = cloneSkeleton(arch.scene) as THREE.Group;

    // His own face, and only his own haircut. Both happen on the clone, before
    // anything is dressed: the geometry swap is cheap (two arrays), and the
    // three cuts he is not wearing have to go before they cost a draw call.
    const drop: THREE.Object3D[] = [];
    let body: THREE.SkinnedMesh | null = null;
    let hair: THREE.SkinnedMesh | null = null;
    root.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const sane = saneName(mesh.name);
      if (arch.hairNames.length && arch.hairNames.includes(sane) && sane !== look.hair) {
        drop.push(mesh);
        return;
      }
      const fm = arch.faces ? arch.faceMaps.get(sane) : undefined;
      if (fm && !NO_FACES_DEBUG) mesh.geometry = morphGeometry(fm, arch.faces!, look.variant);
      if (arch.faces && sane === saneName(arch.faces.file.name)) body = mesh;
      if (sane === look.hair) hair = mesh;
    });
    for (const d of drop) d.removeFromParent();
    // the face variant reshapes the skull, and on some head/cut pairs the
    // crown comes up THROUGH the hair cap: a bald spot. See clearHairOfSkull.
    if (body && hair && !NO_FACES_DEBUG && !HAIR_NO_CLEAR) {
      const b = body as THREE.SkinnedMesh, h = hair as THREE.SkinnedMesh;
      if (b.bindMatrix.equals(h.bindMatrix)) {
        if (!arch.faceMaps.has(saneName(h.name))) {
          // not morphed, so still the archetype's shared geometry: copy first
          h.geometry = h.geometry.clone();
          this.owned.push(h.geometry);
        }
        clearHairOfSkull(b.geometry, h.geometry);
      }
    }

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
      if (!KIT_UNMERGED) this.mergeKit(meshes, kit, arch);
      const fringes: THREE.SkinnedMesh[] = [];
      for (const mesh of meshes) {
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        const srcMat = mesh.material as THREE.Material;
        mesh.material = this.dress(mesh, kit, data, arch, look);
        // the soft hairline pass, near band only (see hairFringe)
        if (li === 0 && !HAIR_NO_FRINGE && !HAIR_PLAIN && !Array.isArray(srcMat)
          && HAIR_MESH.test(`${mesh.name} ${srcMat.name}`)) {
          const f = this.hairFringe(mesh, srcMat, arch, look);
          (mesh.parent ?? meshParent).add(f);
          fringes.push(f);
        }
      }
      meshes.push(...fringes);
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
      // by the cascades (scene.ts lends the view camera the layer for the
      // shadow pass only) and by nothing the player ever looks at
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

  /**
   * Shirt and shorts as ONE skinned draw.
   *
   * They were already one shading model — same weave normal, same cloth
   * roughness, both double-sided, both the 'ss26-kit' program — and differed
   * only in which picture they wore. So the pair is merged into one geometry
   * carrying a per-vertex `ss26Garment` (0 shirt, 1 shorts), and the shirt's
   * material samples the team's shorts texture where that is set: one draw a
   * player at every detail level, and no atlas, so no texture is repainted,
   * resized or duplicated. Boots stay apart on purpose — the glossy moulded
   * upper is a different material, and folding it into the cloth would cost
   * the one hard highlight a player's feet have.
   *
   * Anything unexpected (no painted shorts, the two parts on different
   * skeletons or binds, attribute sets that will not merge) leaves the pair
   * as it was: two draws, exactly as before.
   */
  private mergeKit(meshes: THREE.SkinnedMesh[], kit: KitSpec, arch: Archetype): void {
    const shirt = meshes.find((m) => m.isSkinnedMesh && isShirt(m));
    const shorts = meshes.find((m) => m.isSkinnedMesh && isShorts(m));
    if (!shirt || !shorts || !shirt.parent || shirt.parent !== shorts.parent) return;
    if (shirt.skeleton !== shorts.skeleton || !shirt.bindMatrix.equals(shorts.bindMatrix)) return;
    if (!this.shortsTexture(kit, arch)) return;

    const key = `${shirt.geometry.uuid}|${shorts.geometry.uuid}`;
    let geo = this.kitGeos.get(key);
    if (geo === undefined) {
      geo = mergeKitGeometry(shirt.geometry, shorts.geometry);
      this.kitGeos.set(key, geo);
      if (geo) this.owned.push(geo);
    }
    if (!geo) return;

    const m = new THREE.SkinnedMesh(geo, shirt.material as THREE.Material);
    m.name = `${shirt.name}+${shorts.name}`;
    m.userData.ss26Kit = true;
    m.bindMode = shirt.bindMode;
    m.bind(shirt.skeleton, shirt.bindMatrix);
    shirt.parent.add(m);
    shirt.removeFromParent();
    shorts.removeFromParent();
    meshes.splice(meshes.indexOf(shirt), 1, m);
    meshes.splice(meshes.indexOf(shorts), 1);
  }

  /** Which material a mesh wears. Kit parts are shared per team (the shirt per
   *  player, because of the number); everything else is the archetype's own
   *  material, copied once per match — except the body, which also carries the
   *  team's socks and is therefore copied per team. */
  private dress(mesh: THREE.SkinnedMesh, kit: KitSpec, data: PlayerData,
    arch: Archetype, look: Appearance): THREE.Material {
    if (mesh.userData.ss26Kit) return this.shirtMaterial(kit, data, arch, this.shortsTexture(kit, arch));
    if (isShirt(mesh)) return this.shirtMaterial(kit, data, arch);
    if (isShorts(mesh)) return this.shortsMaterial(kit, arch);
    if (isShoes(mesh)) return this.bootMaterial(kit, arch);
    return this.matchCopy(mesh.material as THREE.Material, mesh.name, kit, arch, look);
  }

  /** Turn a fresh clone of an archetype hair material into this player's hair:
   *  his colour, the strand shading, and — for the fringe pass — blending. */
  private dressHair(copy: THREE.MeshStandardMaterial, arch: Archetype, look: Appearance,
    fringe: boolean): void {
    copy.color.multiply(look.hairColor);
    // the sheen comes from the strands now; a strong IBL lobe on a skull cap is
    // the helmet all over again
    // (IBL DIFFUSE stays as it was — cut this and shaded hair loses its colour
    // and goes grey; the IBL SPECULAR is cut in the shader instead)
    copy.envMapIntensity = 0.5;
    copy.roughness = Math.max(copy.roughness, 0.62);
    if (fringe) {
      copy.transparent = true;
      copy.depthWrite = false;
      copy.alphaTest = 0;
      // one pass: a DoubleSide transparent material is otherwise drawn twice
      copy.forceSinglePass = true;
      copy.defines = { ...(copy.defines ?? {}), SS26_HAIR_FRINGE: '' };
      if (HAIR_TUNE.shells > 0) copy.defines.SS26_HAIR_SHELLS = HAIR_TUNE.shells.toFixed(1);
    }
    if (HAIR_DEBUG) copy.defines = { ...(copy.defines ?? {}), SS26_HAIR_DEBUG: String(HAIR_DEBUG) };
    copy.customProgramCacheKey = (): string => (fringe ? 'ss26-hair-fringe' : 'ss26-hair');
    if (!HAIR_PLAIN) queueHairShading(copy, hairFrameOf(arch), hairMapMean(copy.map), /afro|micky/i.test(copy.name));
    // a crown is seen edge-on in half the shots this game takes, so a fresnel
    // rim there is not an edge light, it is a grey skullcap: keep it faint
    queueBroadcastSkin(copy, { wrap: 0.3, wrapTint: 0xd8cec4, rim: 0.022, rimPower: 4.0 });
  }

  /** The blended hairline pass for one LOD0 haircut: same geometry, same
   *  skeleton, drawn after the opaques, only where the opaque pass discarded.
   *  One per player, near band only — past it the fringe is sub-pixel. */
  private hairFringe(mesh: THREE.SkinnedMesh, src: THREE.Material, arch: Archetype,
    look: Appearance): THREE.SkinnedMesh {
    const key = `${src.uuid}|${look.hairColor.getHexString()}|fringe`;
    let mat = this.matClones.get(key);
    if (!mat) {
      mat = (src as THREE.MeshStandardMaterial).clone();
      mat.userData = {};
      this.dressHair(mat, arch, look, true);
      this.matClones.set(key, mat);
      this.owned.push(mat);
    }
    // His own geometry (the face pool morphed it) — shared as it is, or, with
    // shells on, layered into a copy that is the match's and goes with it.
    const geo = HAIR_TUNE.shells > 0 ? hairShellGeometry(mesh.geometry, HAIR_TUNE.shells)
      : mesh.geometry;
    if (geo !== mesh.geometry) this.owned.push(geo);
    const f = new THREE.SkinnedMesh(geo, mat);
    f.name = `${mesh.name}.fringe`;
    f.bindMode = mesh.bindMode;
    f.bind(mesh.skeleton, mesh.bindMatrix);
    f.frustumCulled = false;
    f.castShadow = false;
    f.receiveShadow = true;
    return f;
  }

  /**
   * This match's copy of one archetype material.
   *
   * Three bands. SKIN is per PLAYER now — it carries his tone, his stubble and
   * his team's socks — so the key has all three in it; that is twenty-two
   * materials sharing one 2048 atlas and one compiled program, not twenty-two
   * textures. HAIR is per player too, for the colour, and takes the strand
   * sheen. Everything else (eyes) is one copy for the whole match.
   */
  private matchCopy(src: THREE.Material, meshName: string, kit: KitSpec,
    arch: Archetype, look: Appearance): THREE.MeshStandardMaterial {
    const id = `${meshName} ${src.name}`;
    const skin = /body|base|head|face/i.test(id);
    const hair = /hair|afro|short0|braid|cornrow|micky|messy/i.test(id);
    const eye = /low-poly|cornea|eyeball/i.test(id);
    const key = skin
      ? `${src.uuid}|${kit.socks}|${look.skinTone.getHexString()}|${look.stubble.toFixed(2)}`
      : hair ? `${src.uuid}|${look.hairColor.getHexString()}` : src.uuid;
    const hit = this.matClones.get(key);
    if (hit) return hit;
    const copy = (src as THREE.MeshStandardMaterial).clone();
    if (skin) {
      copy.color.multiply(look.skinTone);
      // pores: a tiling micro-normal far below the atlas's resolution, which is
      // what stops a floodlit cheek reading as wax. Only if the skin did not
      // already ship one — none of them do today.
      if (!copy.normalMap) {
        copy.normalMap = poreNormal();
        copy.normalScale = new THREE.Vector2(0.45, 0.45);
      }
      copy.customProgramCacheKey = (): string => 'ss26-skin';
      queueSkinShading(copy, {
        sockMask: arch.sockMask, sockColor: new THREE.Color(kit.socks),
        faceMask: arch.faceMask, stubble: look.stubble,
        stubbleColor: look.stubbleColor,
      });
    } else if (hair) {
      this.dressHair(copy, arch, look, false);
    } else if (eye) {
      // a cornea is the only wet thing on a player and the only real highlight
      // on a face; it is also the difference between eyes and two dark holes
      copy.roughness = 0.07;
      copy.metalness = 0;
      copy.envMapIntensity = 1.6;
      copy.customProgramCacheKey = (): string => 'ss26-eye';
      queueBroadcastSkin(copy, { wrap: 0.1, wrapTint: 0xffffff, rim: 0.12, rimPower: 2.4 });
    } else {
      copy.customProgramCacheKey = (): string => 'ss26-part';
      queueBroadcastSkin(copy, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.075, rimPower: 3.6 });
    }
    this.matClones.set(key, copy);
    this.owned.push(copy);
    return copy;
  }

  // ------------------------------------------------------------- kit textures
  //
  // A kit is now a CUT as well as two colours. TextureLab.kitLayoutFor() seeds
  // the pattern, the band count, the collar and cuff widths, the crest shape and
  // the sponsor off the kit itself, so two teams whose hexes happen to be close
  // still look like two teams. Everything is painted through the archetype's
  // garment map (buildGarmentMap), which is what lets a stripe follow the body
  // round a sleeve seam and a squad number land upright on a garment nobody
  // measured by hand.

  /** This match's kit bakery. The match scene has its own TextureLab for the
   *  pitch and the crowd; the characters take a second one rather than reach
   *  into the renderer, and report their own cost on the same console channel. */
  private lab = new TextureLab();
  private layouts = new Map<string, KitLayout>();
  /** REAL wall clock. The capture harness replaces performance.now with a
   *  virtual one so a still is reproducible, and a bake budget that always
   *  reports 0.0ms is worse than no budget at all. */
  private kitClock = Date.now.bind(Date);
  private kitMs = 0;
  /**
   * ONE garment map for the match, not one per archetype.
   *
   * All four archetypes wear the same authored garment, so their maps differ
   * only by the millimetres MPFB moved a vertex to fit a wider chest — the UV
   * islands, the classification and the panel fits are the same picture. Keying
   * the bake on the archetype as well as the kit meant ten 1024² shirts a match
   * instead of three, which measured 770ms of canvas work for nothing.
   */
  private sharedShirtMap: GarmentMap | null = null;
  private sharedShortsMap: GarmentMap | null = null;

  private shirtMap(arch: Archetype): GarmentMap | null {
    this.sharedShirtMap ??= arch.shirtGarment;
    return this.sharedShirtMap;
  }

  private shortsMap(arch: Archetype): GarmentMap | null {
    this.sharedShortsMap ??= arch.shortsGarment;
    return this.sharedShortsMap;
  }

  private layoutFor(kit: KitColors): KitLayout {
    const key = `${kit.shirt}|${kit.shorts}|${kit.socks}`;
    const hit = this.layouts.get(key);
    if (hit) return hit;
    const made = this.lab.kitLayoutFor(kit, hashSeed(key));
    this.layouts.set(key, made);
    return made;
  }

  /**
   * The team's shirt, painted once per (archetype, kit): pattern, collar, cuffs,
   * crest and sponsor. The per-player copy on top of it carries his number and
   * his name, which is the only part of a kit that is his.
   */
  private shirtBase(kit: KitColors, arch: Archetype): HTMLCanvasElement | null {
    const key = `${kit.shirt}|${kit.shorts}`;
    const hit = this.kitShirtBase.get(key);
    if (hit) return hit;
    const map = this.shirtMap(arch);
    if (!map) return null;
    const t0 = this.kitClock();
    const layout = this.layoutFor(kit);

    const N = map.n;
    const [c, ctx] = canvas2d(N, N);
    const base = new THREE.Color(kit.shirt);
    // the SECOND team colour, which is what a striped or hooped kit is made of.
    // If the two hexes are too close to separate at forty metres the accent
    // falls back to a shade of the first, because a stripe you cannot see is
    // just a dirty shirt.
    const other = new THREE.Color(kit.shorts);
    const far = Math.abs(luminance(kit.shirt) - luminance(kit.shorts)) > 0.18
      || Math.abs(base.r - other.r) + Math.abs(base.g - other.g) + Math.abs(base.b - other.b) > 0.45;
    const accent = far ? other
      : new THREE.Color(luminance(kit.shirt) > 0.5 ? shade(kit.shirt, -0.45) : shade(kit.shirt, 0.5));
    const trim = new THREE.Color(
      luminance(kit.shirt) > 0.55 ? shade(kit.shirt, -0.5) : shade(kit.shirt, 0.55));

    const img = ctx.createImageData(N, N);
    const out = img.data;
    const src = map.data;
    const bands = layout.bands;
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      if (src[o + 3] === 0) continue;
      const across = src[o] / 255, up = src[o + 1] / 255;
      const part = Math.round(src[o + 2] / 51) as Part;
      let col = base;
      switch (layout.pattern) {
        case 'stripes':
          if ((Math.floor(across * bands * 2) & 1) === 1) col = accent;
          break;
        case 'hoops':
          if ((Math.floor(up * bands) & 1) === 1) col = accent;
          break;
        case 'sash':
          if (Math.abs(((across + up) % 1) - 0.5) < 0.14) col = accent;
          break;
        case 'halves':
          if (across > 0.5) col = accent;
          break;
        case 'shoulders':
          if (part === Part.Sleeve || part === Part.Cuff || up > 0.82) col = accent;
          break;
        default:
          break;
      }
      // The collar band and the cuffs are computed PER TEXEL from where the
      // texel sits on the body, not from the triangle's class. Class is a step
      // function on a mesh whose triangles are a centimetre across, and a
      // collar whose edge is a row of triangle boundaries reads as a ragged
      // zig-zag yoke across the shoulders rather than as a collar. (It did.)
      const edge = Math.min(across, 1 - across);
      const collarAmt = smooth(0.87, 0.95, up) * (1 - smooth(0.20, 0.30, Math.abs(across - 0.5)));
      const cuffAmt = 1 - smooth(0.085, 0.125, edge);
      const band = Math.max(collarAmt * layout.collar, cuffAmt * layout.cuff);
      if (band > 0.002) col = col.clone().lerp(trim, band);
      // cloth does not light flat: a gentle top-to-bottom ramp plus a touch of
      // occlusion under the arms
      const k = (1.06 - 0.22 * (1 - up)) * (1 - 0.1 * Math.max(0, 1 - Math.abs(across - 0.5) * 4));
      out[o] = Math.min(255, col.r * 255 * k);
      out[o + 1] = Math.min(255, col.g * 255 * k);
      out[o + 2] = Math.min(255, col.b * 255 * k);
      out[o + 3] = 255;
    }
    dilate(img, 4);
    ctx.putImageData(img, 0, 0);

    // the weave, over everything: at broadcast distance this is the difference
    // between fabric and a coloured sticker
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = ctx.createPattern(this.lab.kitWeaveTile(), 'repeat')!;
    ctx.fillRect(0, 0, N, N);
    ctx.restore();

    // Crest, sponsor and maker's mark are printed in BODY space and pulled onto
    // the garment texel by texel through the map's own body coordinates.
    // Printing through one affine panel fit (as the back still does) assumes
    // the front is one UV island; the polo's front is several, split at the
    // placket, so the fit averaged them: the sponsor landed off-centre on the
    // belly, the crest skewed, and at walkout distance all three blurred into
    // one smudge. Body space has no seams to get wrong.
    if (map.frontBox) {
      const [lx, hx, ly, hy] = map.frontBox;
      const w = hx - lx, h = hy - ly, midX = (lx + hx) / 2;
      const chestY = ly + 0.76 * h;
      const ink = luminance(kit.shirt) > 0.5 ? '#141820' : '#f6f8fc';
      const edge = luminance(kit.shirt) > 0.5 ? '#f6f8fc' : '#141820';
      const crest = this.lab.kitCrestCanvas(kit, layout, crestInitials(layout.seed));
      printFront(ctx, map, (p, at, ppm) => {
        // crest on the wearer's left breast, which is the viewer's right (+x)
        const cs = 0.085 * ppm;
        const [cx, cy] = at(midX + 0.24 * w, chestY);
        p.drawImage(crest, cx - cs / 2, cy - cs / 2, cs, cs);
        // a fictional maker's mark opposite it: two stacked chevrons
        const mk = 0.02 * ppm;
        const [mx, my] = at(midX - 0.24 * w, chestY);
        p.strokeStyle = ink;
        p.lineWidth = mk * 0.34;
        p.lineCap = 'round';
        p.lineJoin = 'round';
        for (const dy of [-0.35, 0.35]) {
          p.beginPath();
          p.moveTo(mx - mk, my + (dy + 0.4) * mk);
          p.lineTo(mx, my + (dy - 0.4) * mk);
          p.lineTo(mx + mk, my + (dy + 0.4) * mk);
          p.stroke();
        }
        // the sponsor: the one print on a club shirt that reads from the
        // stand, so a bold block across the chest, fitted to its width
        const [sx, sy] = at(midX, ly + 0.55 * h);
        let fpx = 0.075 * ppm;
        p.font = `900 ${Math.round(fpx)}px Helvetica, Arial, sans-serif`;
        const wide = p.measureText(layout.sponsor).width;
        if (wide > 0.62 * w * ppm) fpx *= (0.62 * w * ppm) / wide;
        p.font = `900 ${Math.round(fpx)}px Helvetica, Arial, sans-serif`;
        p.textAlign = 'center';
        p.textBaseline = 'middle';
        p.strokeStyle = edge;
        p.lineWidth = fpx * 0.1;
        p.strokeText(layout.sponsor, sx, sy);
        p.fillStyle = ink;
        p.fillText(layout.sponsor, sx, sy);
      });
    }

    this.kitShirtBase.set(key, c);
    this.kitMs += this.kitClock() - t0;
    console.info(`characters: kit bake ${layout.pattern} ${layout.bands}-band`
      + ` "${layout.sponsor}" crest ${layout.crest} — ${this.kitMs.toFixed(1)}ms over`
      + ` ${this.kitShirtBase.size} team shirt(s)`);
    return c;
  }

  private shirtMaterial(kit: KitSpec, data: PlayerData, arch: Archetype,
    shortsTex: THREE.Texture | null = null): THREE.MeshStandardMaterial {
    const key = `${kit.shirt}|${kit.shorts}|${data.num}|${data.name}${shortsTex ? '|kit' : ''}`;
    const hit = this.shirtMats.get(key);
    if (hit) return hit;

    const base = this.shirtBase(kit, arch);
    const map = this.shirtMap(arch);
    const N = map?.n ?? SHIRT_PX;
    const [c, ctx] = canvas2d(N, N);
    if (base) ctx.drawImage(base, 0, 0);
    const ink = luminance(kit.shirt) > 0.5 ? '#141820' : '#f6f8fc';
    const outline = luminance(kit.shirt) > 0.5 ? '#f6f8fc' : '#141820';
    const short = (data.name.split(' ').pop() ?? '').toUpperCase().slice(0, 12);

    // BACK: surname under the collar, number under it, printed through the
    // panel's own fit — upright and the right way round on any garment.
    // Outlined as well as filled: half the kits this roster generates are
    // patterned, and a flat number vanishes into the stripe it lands on.
    if (map?.back) {
      const b = map.back;
      panelFrame(ctx, b, true);
      ctx.textAlign = 'center';
      ctx.fillStyle = ink;
      ctx.strokeStyle = outline;
      ctx.lineJoin = 'round';
      ctx.font = `bold ${Math.round(0.26 * b.halfW * b.ppm)}px Helvetica, Arial, sans-serif`;
      ctx.lineWidth = 0.022 * b.halfW * b.ppm;
      ctx.strokeText(short, 0, -0.52 * b.halfH * b.ppm);
      ctx.fillText(short, 0, -0.52 * b.halfH * b.ppm);
      ctx.font = `bold ${Math.round(0.86 * b.halfW * b.ppm)}px Helvetica, Arial, sans-serif`;
      ctx.lineWidth = 0.055 * b.halfW * b.ppm;
      ctx.strokeText(String(data.num), 0, 0.22 * b.halfH * b.ppm);
      ctx.fillText(String(data.num), 0, 0.22 * b.halfH * b.ppm);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // glTF UVs have their origin at the TOP left, so a canvas painted in the
    // same space must NOT be flipped on upload
    tex.flipY = false;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.84, metalness: 0, envMapIntensity: 0.45,
      normalMap: this.lab.kitWeaveNormalMap(),
      normalScale: new THREE.Vector2(0.55, 0.55),
      alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
    });
    mat.customProgramCacheKey = (): string => (shortsTex ? 'ss26-kit-merged' : 'ss26-kit');
    queueBroadcastSkin(mat, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.075, rimPower: 3.6 });
    if (shortsTex) queueKitShorts(mat, shortsTex);
    this.shirtMats.set(key, mat);
    this.owned.push(mat, tex);
    return mat;
  }

  /** The team's shorts, painted through the archetype's garment map: the
   *  kit colour, a contrast hem and the weave. Null when the archetype has
   *  no usable shorts map (the material then tints the neutral one). */
  private shortsTexture(kit: KitSpec, arch: Archetype): THREE.CanvasTexture | null {
    const key = `${kit.shorts}|${kit.shirt}`;
    const hit = this.shortsTexs.get(key);
    if (hit !== undefined) return hit;
    const map = this.shortsMap(arch);
    if (!map) {
      this.shortsTexs.set(key, null);
      return null;
    }
    const t0 = this.kitClock();
    const N = map.n;
    const [c, ctx] = canvas2d(N, N);
    const base = new THREE.Color(kit.shorts);
    const trim = new THREE.Color(kit.shirt);
    const img = ctx.createImageData(N, N);
    const out = img.data;
    const src = map.data;
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      if (src[o + 3] === 0) continue;
      const up = src[o + 1] / 255;
      // The hem band, and only the hem band. A side flash was tried and
      // dropped: `across` is the x extent of BOTH legs, and the outer few
      // per cent of that is a wide swath of a cylindrical surface, so a
      // "thin stripe" came out as a wedge across the whole hip.
      const col = up < 0.055 ? trim : base;
      const k = 1.04 - 0.16 * (1 - up);
      out[o] = Math.min(255, col.r * 255 * k);
      out[o + 1] = Math.min(255, col.g * 255 * k);
      out[o + 2] = Math.min(255, col.b * 255 * k);
      out[o + 3] = 255;
    }
    dilate(img, 4);
    ctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = ctx.createPattern(this.lab.kitWeaveTile(), 'repeat')!;
    ctx.fillRect(0, 0, N, N);
    ctx.restore();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = 8;
    this.kitMs += this.kitClock() - t0;
    this.owned.push(t);
    this.shortsTexs.set(key, t);
    return t;
  }

  /**
   * Shorts: the same garment map, the team's own colour and a contrast hem.
   * Painted rather than tinted now, because a multiply onto a neutralised
   * authored map could only ever produce one cut.
   */
  private shortsMaterial(kit: KitSpec, arch: Archetype): THREE.MeshStandardMaterial {
    const key = `${kit.shorts}|${kit.shirt}`;
    const hit = this.shortsMats.get(key);
    if (hit) return hit;
    const painted = this.shortsTexture(kit, arch);
    const tex: THREE.Texture | null = painted ?? arch.shortsMap;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      color: painted ? 0xffffff : new THREE.Color(kit.shorts),
      normalMap: this.lab.kitWeaveNormalMap(),
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.86, metalness: 0, envMapIntensity: 0.45,
      alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
    });
    mat.customProgramCacheKey = (): string => 'ss26-kit';
    queueBroadcastSkin(mat, { wrap: 0.24, wrapTint: 0xf2ece6, rim: 0.06, rimPower: 3.6 });
    this.shortsMats.set(key, mat);
    this.owned.push(mat);
    return mat;
  }

  /**
   * Boots and socks share one authored atlas (the trainers are a photo-scan of
   * a blue Nike, which no football team wears). The shoe is knocked back to
   * boot-black, the sock block is painted the kit's sock colour, and a seeded
   * ACCENT flash goes across the upper — because twenty-two identical black
   * boots is the one part of a broadcast frame that never happens in real
   * football.
   */
  private bootMaterial(kit: KitSpec, arch: Archetype): THREE.MeshStandardMaterial {
    // Per KIT, not per (archetype, kit): every archetype wears the same
    // shoes06 atlas, so keying on the archetype as well minted up to twelve
    // 1024² boot textures a match — sixty-odd megabytes of four identical
    // pictures. The first archetype's atlas is every archetype's atlas.
    const key = `${kit.socks}|${kit.shirt}`;
    const hit = this.bootMats.get(key);
    if (hit) return hit;
    const layout = this.layoutFor(kit);
    const img = sourceImageOf(arch, isShoes);
    // the authored shoes06 atlas is 1024²; painting it into a smaller canvas
    // threw away the lace and panel detail that is the only thing making a
    // boot read as a boot in a slide-tackle close-up
    const N = 1024;
    const [c, ctx] = canvas2d(N, N);
    if (img) recolour(ctx, img, N, N, '#191c22', 0.28);
    else { ctx.fillStyle = '#191c22'; ctx.fillRect(0, 0, N, N); }
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.85;
    const g = ctx.createLinearGradient(0, N * 0.30, 0, N * 0.52);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.35, layout.bootAccent);
    g.addColorStop(0.75, layout.bootAccent);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, N * 0.30, N * 0.775, N * 0.22);
    ctx.restore();
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
    mat.customProgramCacheKey = (): string => 'ss26-part';
    queueBroadcastSkin(mat, { wrap: 0.2, wrapTint: 0xf2ece6, rim: 0.08, rimPower: 3.2 });
    this.bootMats.set(key, mat);
    this.owned.push(mat, tex);
    return mat;
  }

  dispose(): void {
    this.lab.dispose();
    this.layouts.clear();
    this.sharedShirtMap = null;
    this.sharedShortsMap = null;
    for (const o of this.owned) o.dispose();
    this.owned = [];
    this.shadowMat = null;
    this.matClones.clear();
    this.shirtMats.clear();
    this.shortsMats.clear();
    this.shortsTexs.clear();
    this.kitGeos.clear();
    this.bootMats.clear();
    this.kitShirtBase.clear();
  }
}
