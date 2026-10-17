import {
  MEDIA_INPUT_ACCEPT,
  mediaKindForMime,
  planMediaSelection,
} from "@/lib/compose/media-files";

const file = (name: string, type: string) => ({ name, type });

describe("mediaKindForMime", () => {
  test.each([
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/gif", "image"],
    ["image/webp", "image"],
    ["video/mp4", "video"],
    ["video/quicktime", "video"],
    ["video/webm", "video"],
  ])("classifies %s", (mime, kind) => {
    expect(mediaKindForMime(mime)).toBe(kind);
    expect(MEDIA_INPUT_ACCEPT).toContain(mime);
  });

  it("rejects broad or spoof-prone MIME values", () => {
    expect(mediaKindForMime("image/svg+xml")).toBeNull();
    expect(mediaKindForMime("video/x-msvideo")).toBeNull();
    expect(mediaKindForMime("")).toBeNull();
  });
});

describe("planMediaSelection", () => {
  it("fills only the remaining image slots", () => {
    const plan = planMediaSelection(
      [file("a.jpg", "image/jpeg"), file("b.png", "image/png")],
      [{ kind: "gif" }],
      2,
    );

    expect(plan.accepted).toEqual([
      { file: file("a.jpg", "image/jpeg"), kind: "image" },
    ]);
    expect(plan.message).toMatch(/1 file was not added/);
  });

  it("keeps a video singular when mixed files are selected", () => {
    const video = file("clip.mov", "video/quicktime");
    const plan = planMediaSelection(
      [file("photo.webp", "image/webp"), video, file("notes.txt", "text/plain")],
      [],
      4,
    );

    expect(plan.accepted).toEqual([{ file: video, kind: "video" }]);
    expect(plan.message).toMatch(/Only one video/);
  });

  it("does not combine a video with an existing image or GIF", () => {
    const plan = planMediaSelection(
      [file("clip.mp4", "video/mp4")],
      [{ kind: "image" }],
      2,
    );

    expect(plan.accepted).toEqual([]);
    expect(plan.message).toBe("A video can't be combined with other attachments.");
  });

  it("does not add images while a video is attached", () => {
    const plan = planMediaSelection(
      [file("photo.jpg", "image/jpeg")],
      [{ kind: "video" }],
      4,
    );

    expect(plan.accepted).toEqual([]);
    expect(plan.message).toBe("Remove the video before adding images.");
  });

  it("reports an actionable error for an unsupported-only selection", () => {
    const plan = planMediaSelection([file("vector.svg", "image/svg+xml")], [], 2);

    expect(plan.accepted).toEqual([]);
    expect(plan.message).toMatch(/JPEG, PNG, GIF, WebP, MP4, MOV, or WebM/);
  });
});
