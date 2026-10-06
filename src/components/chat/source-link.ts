import * as Linking from 'expo-linking';
import { Alert } from 'react-native';

import { safeSourceUrl } from '@/chat/web-search-url';

/** Markdown links and provider citations share one external-web URL policy. */
export async function openExternalLink(value: string): Promise<void> {
  const url = safeSourceUrl(value);
  if (!url) return;
  try { await Linking.openURL(url); }
  catch { Alert.alert('Could not open link', 'Try opening this link again in a moment.'); }
}
