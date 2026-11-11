import * as Location from 'expo-location';
import { AppState } from 'react-native';

/**
 * The system's geocoder refuses many requests at a time (expo-location, `reverseGeocodeAsync`), and the device list
 * is read for every tool call; a city changes slowly, so one answer stands for this long.
 */
const FRESH_MS = 10 * 60_000;
let known: { city: string; at: number } | undefined;

/**
 * The city this iPhone is in, which InfiniChat's device list tells its agent while the user shares it: what the
 * app's location access is for, with the background work the same access keeps running. It is named from the
 * position iOS already has, without asking for a new fix, and only while the app is in front, since expo-location
 * discourages geocoding in the background; the last city found stands in there. Undefined without the permission or
 * before any position is known.
 */
export async function currentCity(): Promise<string | undefined> {
  const fresh = known !== undefined && Date.now() - known.at < FRESH_MS;
  if (fresh || AppState.currentState !== 'active') return known?.city;
  if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return undefined;
  const position = await Location.getLastKnownPositionAsync();
  if (!position) return known?.city;
  const address = (await Location.reverseGeocodeAsync(position.coords)).at(0);
  const city = [address?.city, address?.region, address?.country].filter((part): part is string => !!part).join(', ');
  if (city) known = { city, at: Date.now() };
  return known?.city;
}
