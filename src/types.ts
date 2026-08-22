export type PeakList = {
  id: string;
  peakbaggerListId: number;
  name: string;
  peakCount: number;
  sourceUrl: string;
};

export type Peak = {
  peakbaggerId: number;
  name: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  prominenceFt?: number;
  sourceUrl: string;
  listIds: string[];
};

export type MatchMode = "any" | "all";

export type AppData = {
  lists: PeakList[];
  peaks: Peak[];
};

export type ImportResult = {
  list: PeakList;
  addedPeaks: number;
  reusedPeaks: number;
  totalPeaks: number;
};
