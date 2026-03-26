import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '@/constants/theme';

interface AvatarProps {
  pfpUrl: string | null;
  displayName: string;
  size?: 'sm' | 'md' | 'lg';
  isLive?: boolean;
}

const SIZES = {
  sm: 32,
  md: 48,
  lg: 64,
};

const FONT_SIZES = {
  sm: 12,
  md: 16,
  lg: 22,
};

const LIVE_RING_COLOR = colors.accent;

export function Avatar({ pfpUrl, displayName, size = 'md', isLive = false }: AvatarProps) {
  const dimension = SIZES[size];
  const fontSize = FONT_SIZES[size];
  const initials = (displayName ?? '?')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <View
      accessibilityLabel={`${displayName}'s avatar`}
      accessibilityRole="image"
      style={[
        styles.container,
        {
          width: dimension + (isLive ? 6 : 0),
          height: dimension + (isLive ? 6 : 0),
          borderRadius: (dimension + (isLive ? 6 : 0)) / 2,
          borderWidth: isLive ? 3 : 0,
          borderColor: isLive ? LIVE_RING_COLOR : 'transparent',
        },
      ]}
    >
      {pfpUrl ? (
        <Image
          source={{ uri: pfpUrl }}
          style={{
            width: dimension,
            height: dimension,
            borderRadius: dimension / 2,
          }}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View
          style={[
            styles.fallback,
            {
              width: dimension,
              height: dimension,
              borderRadius: dimension / 2,
            },
          ]}
        >
          <Text style={[styles.initials, { fontSize }]}>{initials}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallback: {
    backgroundColor: colors.background.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  initials: {
    color: colors.text.primary,
    fontWeight: '600',
  },
});
