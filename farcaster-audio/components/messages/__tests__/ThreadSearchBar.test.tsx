import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { describe, expect, it, jest } from "@jest/globals";
import { ThreadSearchBar } from "@/components/messages/ThreadSearchBar";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

function renderBar(activeIndex: number, matchCount: number) {
  const props = {
    query: "coffee",
    activeIndex,
    matchCount,
    isSearching: false,
    onChangeQuery: jest.fn(),
    onOlder: jest.fn(),
    onNewer: jest.fn(),
    onClose: jest.fn(),
  };
  return { ...render(<ThreadSearchBar {...props} />), props };
}

describe("ThreadSearchBar", () => {
  it("shows the position and steps toward older matches", () => {
    const { getByTestId, props } = renderBar(0, 3);
    expect(getByTestId("thread-search-position")).toHaveTextContent("1 of 3");
    fireEvent.press(getByTestId("thread-search-newer"));
    expect(props.onNewer).not.toHaveBeenCalled();
    fireEvent.press(getByTestId("thread-search-older"));
    expect(props.onOlder).toHaveBeenCalledTimes(1);
  });

  it("disables older at the last match", () => {
    const { getByTestId, props } = renderBar(2, 3);
    fireEvent.press(getByTestId("thread-search-older"));
    expect(props.onOlder).not.toHaveBeenCalled();
    fireEvent.press(getByTestId("thread-search-newer"));
    expect(props.onNewer).toHaveBeenCalledTimes(1);
  });

  it("forwards query edits and close", () => {
    const { getByTestId, getByLabelText, props } = renderBar(0, 0);
    fireEvent.changeText(getByTestId("thread-search-input"), "tea");
    expect(props.onChangeQuery).toHaveBeenCalledWith("tea");
    fireEvent.press(getByLabelText("Close search"));
    expect(props.onClose).toHaveBeenCalled();
  });
});
