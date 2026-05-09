#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(SelectableCastTextViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(text, NSString)
RCT_EXPORT_VIEW_PROPERTY(textColor, NSString)
RCT_EXPORT_VIEW_PROPERTY(linkColor, NSString)
RCT_EXPORT_VIEW_PROPERTY(fontSize, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(lineHeight, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(onLinkPress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSizeChange, RCTDirectEventBlock)

@end
