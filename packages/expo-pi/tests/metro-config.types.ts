// Type-level check: the wrapper accepts Expo's Metro config and returns the same type.
import { getDefaultConfig } from 'expo/metro-config';
import { withPi } from '@automatalabs/expo-pi/metro';

const config = getDefaultConfig(__dirname);
export const wrapped: typeof config = withPi(config);
export const nested: typeof config = withPi(withPi(config));
