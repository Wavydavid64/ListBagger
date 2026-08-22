export type PeakList = {
  id: string;
  name: string;
  branch?: string;
  peakCount?: number;
  sourceUrl?: string;
};

export type Peak = {
  peakbaggerId: number;
  name: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  prominenceFt?: number;
  sourceUrl?: string;
  listIds: string[];
};

export type MatchMode = "any" | "all";
