import * as Linking from 'expo-linking';
import { Alert } from 'react-native';

import { safeSourceUrl } from './web-search-presentation';

export async function openSourceLink(value: string): Promise<void> {
  const url = safeSourceUrl(value);
  if (!url) return;
  try { await Linking.openURL(url); }
  catch { Alert.alert('Could not open source', 'Try opening this source again in a moment.'); }
}
