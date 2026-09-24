import { getRandomValues } from 'expo-crypto';
import { installGetRandomValues } from './install-get-random-values.js';

// Expo SDK 58 provides the other web APIs Pi uses, but Hermes has no global
// crypto. Pi calls crypto.getRandomValues for ids (utils/uuid).
installGetRandomValues(globalThis, getRandomValues);
