import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { usePreventScreenCapture } from "expo-screen-capture";
import { RecoveryPhraseStep } from "@/components/auth/RecoveryPhraseStep";
import { isSensitiveScreenActive } from "@/utils/sentryScrub";

jest.mock("expo-screen-capture", () => ({
  usePreventScreenCapture: jest.fn(),
}));
jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("@/hooks/useThemedStyles", () => ({
  // Styles are irrelevant here; return a proxy so any style key resolves.
  useThemedStyles: () => new Proxy({}, { get: () => ({ color: "#000" }) }),
}));

const PHRASE = "test test test test test test test test test test test junk";

function renderStep(onSubmit = jest.fn<(phrase: string) => void>()) {
  render(
    <RecoveryPhraseStep
      username="alice"
      error={null}
      onSubmit={onSubmit}
      onCancel={jest.fn()}
    />,
  );
  return { onSubmit, input: screen.getByTestId("recovery-phrase-input") };
}

describe("RecoveryPhraseStep", () => {
  it("is a secure, non-autocorrecting, non-autofilled field", () => {
    const { input } = renderStep();
    expect(input.props).toMatchObject({
      secureTextEntry: true,
      autoCorrect: false,
      autoComplete: "off",
      spellCheck: false,
      autoCapitalize: "none",
      textContentType: "none",
      importantForAutofill: "no",
    });
  });

  it("blocks screen capture and marks the screen sensitive while mounted", () => {
    const { unmount } = render(
      <RecoveryPhraseStep
        username="alice"
        error={null}
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(usePreventScreenCapture).toHaveBeenCalled();
    expect(isSensitiveScreenActive()).toBe(true);
    unmount();
    expect(isSensitiveScreenActive()).toBe(false);
  });

  it("explains this is the Farcaster recovery phrase, not the wallet phrase", () => {
    renderStep();
    expect(screen.getByText("Not your wallet phrase")).toBeTruthy();
  });

  it("shows only a word count, then clears the field on submit", () => {
    const { onSubmit, input } = renderStep();
    fireEvent.changeText(input, PHRASE);
    expect(screen.getByText("12 words")).toBeTruthy();
    expect(screen.queryByText(PHRASE)).toBeNull();

    fireEvent.press(screen.getByTestId("recovery-phrase-submit"));

    expect(onSubmit).toHaveBeenCalledWith(PHRASE);
    expect(screen.getByTestId("recovery-phrase-input").props.value).toBe("");
    expect(screen.getByText("0 words")).toBeTruthy();
  });

  it("wipes the clipboard after a pasted phrase is submitted", () => {
    const Clipboard = jest.requireMock("expo-clipboard") as {
      setStringAsync: jest.Mock;
    };
    const { input } = renderStep();
    fireEvent.changeText(input, PHRASE);
    fireEvent.press(screen.getByTestId("recovery-phrase-submit"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("");
  });
});
