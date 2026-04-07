import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import type { ImageProps as SnapImageProps } from '@/types/snap';
import { colors } from '@/constants/theme';

const ASPECT_RATIOS: Record<string, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
};

export function SnapImage({ props }: { props: SnapImageProps }) {
  // Guard: only allow https URLs
  if (typeof props.url !== 'string' || !props.url.startsWith('https://')) {
    return <View style={[styles.placeholder, { aspectRatio: ASPECT_RATIOS[props.aspect] ?? 1 }]} />;
  }

  return (
    <Image
      source={{ uri: props.url }}
      style={[styles.image, { aspectRatio: ASPECT_RATIOS[props.aspect] ?? 1 }]}
      contentFit="cover"
      transition={150}
      accessibilityLabel={props.alt}
    />
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: colors.background.surface,
  },
  placeholder: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: colors.background.surface,
  },
});
