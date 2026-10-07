export type ZelloMapPosition = {
  username: string;
  displayName: string;
  latitude: number;
  longitude: number;
  speed: number;
  batteryLevel: number;
  lastReportDelay: number;
};

export function hasValidMapPosition(l: ZelloMapPosition): boolean {
  return Number.isFinite(l.latitude) && Number.isFinite(l.longitude)
    && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180
    && (l.latitude !== 0 || l.longitude !== 0);
}
