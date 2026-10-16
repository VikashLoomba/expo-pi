import { useColorScheme } from 'react-native';

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

/** Both palettes, for colors the native side resolves itself. */
export const chatPalettes = { light, dark };

export function useChatColors() {
  return useColorScheme() === 'dark' ? dark : light;
}

export type ChatColors = typeof light;
