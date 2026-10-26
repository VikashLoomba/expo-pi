import { AccessibilityInfo, useColorScheme } from 'react-native';
import { useSyncExternalStore } from 'react';

const light = {
  dark: false,
  background: '#F8F8F4',
  surface: '#FFFFFF',
  subtle: '#F0F1EB',
  user: '#E7EEE4',
  text: '#232B26',
  secondary: '#626D64',
  muted: '#858E85',
  border: '#E1E5DD',
  accent: '#426A4B',
  accentSoft: '#E8EFE5',
  onAccent: '#FFFFFF',
  danger: '#AC4A3D',
  dangerSoft: '#F8EDE9',
  scrim: 'rgba(18, 26, 20, 0.32)',
};

const dark: typeof light = {
  dark: true,
  background: '#171C18',
  surface: '#222923',
  subtle: '#29312A',
  user: '#303F31',
  text: '#EDF0E8',
  secondary: '#B0BAAE',
  muted: '#869482',
  border: '#354035',
  accent: '#B6D6A9',
  accentSoft: '#2C3C2B',
  onAccent: '#1D301D',
  danger: '#EDAA9D',
  dangerSoft: '#3C2C28',
  scrim: 'rgba(0, 0, 0, 0.6)',
};

/** Light with Increase Contrast: darker text, borders and accent, and fills that separate more. */
const lightContrast: typeof light = {
  ...light,
  subtle: '#E8EAE2',
  user: '#DAE5D6',
  text: '#121813',
  secondary: '#3E4840',
  muted: '#566057',
  border: '#AAB2A5',
  accent: '#2D5235',
  accentSoft: '#DBE7D7',
  danger: '#8C3326',
  dangerSoft: '#F5E1DC',
};

/** Dark with Increase Contrast: brighter text, borders and accent on a deeper background. */
const darkContrast: typeof light = {
  ...dark,
  background: '#0F1310',
  surface: '#1B211C',
  subtle: '#252D26',
  user: '#2E402F',
  text: '#FFFFFF',
  secondary: '#D4DCD2',
  muted: '#ABB7A8',
  border: '#5A695A',
  accent: '#CBE9BE',
  accentSoft: '#2F432E',
  onAccent: '#0F1F0F',
  danger: '#FFC3B7',
  dangerSoft: '#48302B',
};

/** Every palette, for colors the native side resolves itself. */
export const chatPalettes = { light, dark, lightContrast, darkContrast };

// iOS's Increase Contrast setting, read once and then followed through its change event.
let increasedContrast = false;
const listeners = new Set<() => void>();
const setIncreasedContrast = (enabled: boolean) => {
  increasedContrast = enabled;
  listeners.forEach((listener) => listener());
};
void AccessibilityInfo.isDarkerSystemColorsEnabled().then(setIncreasedContrast);
AccessibilityInfo.addEventListener('darkerSystemColorsChanged', setIncreasedContrast);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getIncreasedContrast = () => increasedContrast;

export function useChatColors() {
  const scheme = useColorScheme();
  const contrast = useSyncExternalStore(subscribe, getIncreasedContrast, getIncreasedContrast);
  if (scheme === 'dark') return contrast ? darkContrast : dark;
  return contrast ? lightContrast : light;
}

export type ChatColors = typeof light;
