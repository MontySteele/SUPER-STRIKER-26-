// Pitch geometry (metres, real proportions) and physics tuning.
// Sim space: x along length [-52.5, 52.5], y across width [-34, 34], z up.

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const HALF_L = PITCH_LENGTH / 2;
export const HALF_W = PITCH_WIDTH / 2;

export const GOAL_WIDTH = 7.32;
export const GOAL_HEIGHT = 2.44;
export const GOAL_HALF_W = GOAL_WIDTH / 2;
export const GOAL_DEPTH = 2.2;

export const BOX_DEPTH = 16.5;
export const BOX_HALF_W = 20.16;
export const SIX_DEPTH = 5.5;
export const SIX_HALF_W = 9.16;
export const PENALTY_SPOT = 11;
export const CENTER_CIRCLE_R = 9.15;

// Ball physics (§6.1). Slightly heavy gravity so lofted balls don't float at game scale.
export const BALL_RADIUS = 0.18;
export const GRAVITY = 12.5;
export const BALL_RESTITUTION = 0.62;
export const BALL_AIR_DRAG = 0.012;      // quadratic drag coefficient
export const BALL_ROLL_FRICTION = 1.35;  // linear decel while rolling, m/s^2
export const MAGNUS_COEFF = 0.9;

// Player movement.
export const PLAYER_CONTROL_RADIUS = 1.05; // can control ball inside this
export const PLAYER_TACKLE_RADIUS = 1.3;
export const BASE_SPEED = 5.4;             // m/s at pace 0 (jog)
export const PACE_SPEED = 0.031;           // + per pace point → pace 90 ≈ 8.2
export const SPRINT_MULT = 1.24;
export const PLAYER_ACCEL = 16;
export const KICK_COOLDOWN = 0.28;         // can't re-touch own kick, makes passes clean

// Timing
export const SIM_DT = 1 / 60;
export const CPU_DECISION_TICK = 0.3;      // §6.2
export const SHOT_MAX_HOLD = 0.8;          // §5 hold-to-power
