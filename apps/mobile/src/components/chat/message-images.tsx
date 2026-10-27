import type { ChatImage } from '@pi-agent/infinichat/pi/user-input';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';

/** The images of a saved message, as the model received them. */
export function MessageImages({ images, messageId, size = 180 }: {
  images: readonly ChatImage[]; messageId: string; size?: number;
}) {
  const colors = useChatColors();
  return <View style={styles.row}>
    {images.map((image, index) => <Image key={index} testID={`image-${messageId}-${index}`}
      accessibilityLabel={images.length === 1 ? 'Attached image' : `Attached image ${index + 1} of ${images.length}`}
      source={{ uri: `data:${image.mimeType};base64,${image.data}` }} contentFit="cover"
      style={[styles.image, { width: size, height: size, backgroundColor: colors.subtle }]} />)}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  image: { borderRadius: 14 },
});
