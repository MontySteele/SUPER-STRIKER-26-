export type Pos = 'GK' | 'DF' | 'MF' | 'FW';
export type Style = 'possession' | 'counter' | 'balanced' | 'defensive';
export type FormationName = '4-4-2' | '4-3-3' | '3-5-2' | '5-3-2' | '4-2-3-1';

export interface PlayerData {
  name: string;
  num: number;
  pos: Pos;
  pace: number;
  shooting: number;
  passing: number;
  defending: number;
  keeping: number;
  stamina: number;
  star: boolean;
}

export interface TeamData {
  id: string;
  code: string;
  name: string;
  group: string;
  tier: number;
  style: Style;
  formation: FormationName;
  kit: { home: string; away: string };
  players: PlayerData[];
}

export interface FormationDef {
  GK: [number, number][];
  DF: [number, number][];
  MF: [number, number][];
  FW: [number, number][];
}

export interface FormationsFile {
  meta: {
    pull: Record<Pos, number>;
    phase_shift_x: { attacking: number; defending: number };
  };
  formations: Record<string, FormationDef>;
}
