// why: the grace only bridges a contentSaved that may trail the completed event; the backstop must stay above the Core's own 300 second turn limit
export const COMPLETED_GRACE_MS = 5_000;
export const TURN_BACKSTOP_MS = 330_000;
export const TURN_BACKSTOP_CODE = "turn_backstop";

export interface TurnLimits {
  readonly graceMs: number;
  readonly backstopMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = { graceMs: COMPLETED_GRACE_MS, backstopMs: TURN_BACKSTOP_MS };
