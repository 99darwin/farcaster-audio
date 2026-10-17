import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { utf8ByteLength } from "@/utils/castText";

/** A media attachment on a compose segment. */
export type ComposeAttachment = {
  uri: string;
  type: "image" | "video";
  source?: "giphy" | "local" | "uploaded";
};

/** One additional cast in a thread being composed (segments after the first). */
export type ThreadSegment = {
  id: string;
  text: string;
  attachments: ComposeAttachment[];
};

const SEGMENT_INPUT_MIN_HEIGHT = 72;
/** Width of the avatar column in ComposeModal (Avatar size "md"). */
const RAIL_COLUMN_WIDTH = 48;

interface ThreadSegmentItemProps {
  segment: ThreadSegment;
  /** 1-based position of this segment within the whole thread. */
  displayIndex: number;
  totalSegments: number;
  maxCastLength: number;
  autoFocus: boolean;
  editable: boolean;
  onChangeText: (id: string, text: string) => void;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveAttachment: (id: string, attachmentIndex: number) => void;
}

export function ThreadSegmentItem({
  segment,
  displayIndex,
  totalSegments,
  maxCastLength,
  autoFocus,
  editable,
  onChangeText,
  onFocus,
  onRemove,
  onRemoveAttachment,
}: ThreadSegmentItemProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const byteCount = utf8ByteLength(segment.text);
  const isOverLimit = byteCount > maxCastLength;

  return (
    <View style={styles.row}>
      <View style={styles.railColumn}>
        <View style={styles.railLine} />
        <View style={styles.railDot} />
        <View style={styles.railLine} />
      </View>
      <View style={styles.content}>
        <View style={styles.segmentHeader}>
          <Text style={styles.segmentLabel}>
            {`Cast ${displayIndex} of ${totalSegments}`}
          </Text>
          <Pressable
            onPress={() => onRemove(segment.id)}
            hitSlop={10}
            disabled={!editable}
            accessibilityRole="button"
            accessibilityLabel={`Remove cast ${displayIndex} from thread`}
          >
            <Ionicons
              name="close-circle"
              size={20}
              color={colors.text.secondary}
            />
          </Pressable>
        </View>
        <TextInput
          style={styles.input}
          placeholder="Add another cast..."
          placeholderTextColor={colors.text.placeholder}
          multiline
          scrollEnabled={false}
          autoFocus={autoFocus}
          maxLength={maxCastLength + 50}
          value={segment.text}
          onChangeText={(t) => onChangeText(segment.id, t)}
          onFocus={() => onFocus(segment.id)}
          editable={editable}
        />
        {segment.attachments.length > 0 && (
          <ScrollView
            horizontal
            style={styles.imagePreviews}
            showsHorizontalScrollIndicator={false}
          >
            {segment.attachments.map((attachment, i) => (
              <View
                key={`${attachment.uri}-${i}`}
                style={styles.previewWrapper}
              >
                <Image
                  source={{ uri: attachment.uri }}
                  style={styles.previewImage}
                  contentFit="cover"
                />
                {attachment.type === "video" && (
                  <View style={styles.videoOverlay}>
                    <Ionicons name="play" size={20} color="#fff" />
                  </View>
                )}
                <Pressable
                  style={styles.removeImageButton}
                  onPress={() => onRemoveAttachment(segment.id, i)}
                  hitSlop={8}
                  disabled={!editable}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attachment"
                >
                  <Ionicons name="close-circle" size={20} color="#fff" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <Text
          style={[styles.charCount, isOverLimit && styles.charCountOver]}
        >
          {byteCount}/{maxCastLength}
        </Text>
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row",
      paddingHorizontal: 16,
      gap: 12,
    },
    railColumn: {
      width: RAIL_COLUMN_WIDTH,
      alignItems: "center",
    },
    railLine: {
      width: 2,
      flex: 1,
      borderRadius: 1,
      backgroundColor: colors.background.border,
    },
    railDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginVertical: 4,
      backgroundColor: colors.background.subtle,
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    content: {
      flex: 1,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
    },
    segmentHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 6,
    },
    segmentLabel: {
      color: colors.text.secondary,
      fontSize: 12,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    input: {
      // No explicit height: on Fabric a multiline TextInput auto-sizes to
      // its content when unconstrained; ComposeModal's ScrollView scrolls.
      minHeight: SEGMENT_INPUT_MIN_HEIGHT,
      color: colors.text.body,
      fontSize: 17,
      lineHeight: 24,
      textAlignVertical: "top",
      paddingTop: 0,
    },
    imagePreviews: {
      flexDirection: "row",
      marginTop: 12,
    },
    previewWrapper: {
      marginRight: 8,
      position: "relative",
    },
    previewImage: {
      width: 60,
      height: 60,
      borderRadius: 8,
    },
    videoOverlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.3)",
      borderRadius: 8,
    },
    removeImageButton: {
      position: "absolute",
      top: -6,
      right: -6,
    },
    charCount: {
      alignSelf: "flex-end",
      marginTop: 8,
      color: colors.text.secondary,
      fontSize: 12,
    },
    charCountOver: {
      color: colors.error,
    },
  }));
