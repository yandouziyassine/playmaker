export interface Reason { text: string; effect: -1 | 0 | 1 }
export interface AnswerOption { k: number; score: number; p: number; share_top: number; points: number; reasons: Reason[] }
export interface Answer {
  schema: 1; id: string; options: AnswerOption[]; ai_pick: number; pro_pick: number;
  outcome: { kind: "goal" | "shot" | "kept" | "lost"; net_xg_15s: number };
  after?: After;
  models: { content_version: number; trained_without: string; refits: number };
}
export type Cm = [number, number] | null;
export interface After { fps: number; frames: Cm[][]; ball: Cm[] }
/** `guess`: the option the player thinks the pro chose (second question); null for clients that predate it. */
export interface PickRequest { player: string; moment: string; option: number; guess: number | null }
export interface PickResult {
  option: number; points: number; among_best: boolean; pro_instinct: boolean; ai_pick: number; pro_pick: number;
  outcome: Answer["outcome"]; reasons: Record<number, Reason[]>; crowd: Record<number, number> | null; repeat: boolean; all_points: Record<number, number>; after: After | null;
  /** The recorded guess of the pro's choice and whether it matches the real pass (null when no guess was sent). */
  guess: number | null; guess_right: boolean | null;
}
export interface StoredPick { option: number; points: number; at: string; guess?: number | null }
export interface Store {
  getPick(player: string, moment: string): Promise<StoredPick | null>;
  putPickIfAbsent(player: string, moment: string, pick: StoredPick): Promise<boolean>;
  addCount(moment: string, option: number): Promise<void>;
  counts(moment: string): Promise<Record<number, number>>;
  bumpRate(key: string): Promise<number>;
}
export interface Deps {
  store: Store;
  answer(moment: string): Promise<Answer | null>;
  momentDate(moment: string): Promise<string | null>; // the day (YYYY-MM-DD) the moment is published, null if none
  today(): string; // UTC date YYYY-MM-DD
  ipHash(ip: string): string;
}
